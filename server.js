const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth REST API ────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { loginId, nickname, password } = req.body || {};
  res.json(db.register(loginId, nickname, password));
});

app.post('/api/login', (req, res) => {
  const { loginId, password } = req.body || {};
  res.json(db.login(loginId, password));
});

app.get('/api/leaderboard', (_req, res) => {
  res.json(db.getLeaderboard());
});

// ─── Constants ────────────────────────────────────────────────────────────────
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const INITIAL_HAND = 7;
const MAX_PLAYERS = 5;
const NORMAL_RANKS = ['3', '4', '5', '6', '7', '8', '9', '10'];
const ONE_CARD_DELAY = 2000;

function penaltyOf(card) {
  if (card.rank === 'A' && card.suit === 'spades') return 5;
  if (card.rank === 'A') return 3;
  if (card.rank === '2') return 2;
  if (card.rank === 'BW') return 5;
  if (card.rank === 'COLOR') return 10;
  return 0;
}

function isPenaltyCard(card) { return penaltyOf(card) > 0; }
function suitIsBlack(suit) { return suit === 'spades' || suit === 'clubs'; }

// ─── Deck ─────────────────────────────────────────────────────────────────────
function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ id: `${suit}_${rank}`, suit, rank });
  deck.push({ id: 'joker_BW', suit: null, rank: 'BW' });
  deck.push({ id: 'joker_COLOR', suit: null, rank: 'COLOR' });
  return deck;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Game State ───────────────────────────────────────────────────────────────
function makeGameState() {
  return {
    phase: 'lobby',
    players: {},
    playerOrder: [],
    deck: [],
    discardPile: [],
    fieldCard: null,
    currentIndex: 0,
    direction: 1,
    penaltyStack: 0,
    penaltyActive: false,
    extraTurnActive: false,
    extraTurnSuit: null,
    sevenSuit: null,
    waitingSuitChange: false,
    hasPlayedThisTurn: false,
    pendingSkips: 0,
    rankings: [],
    finished: new Set(),
    oneCardChallenge: null,
    oneCardTimer: null,
    oneCardTimerPlayerId: null,
  };
}

// ─── Room Registry ────────────────────────────────────────────────────────────
const rooms = new Map();        // roomId → { id, name, password, game, rematchVotes }
const socketRoom = new Map();   // socketId → roomId
const socketName = new Map();   // socketId → name
const socketUserId = new Map(); // socketId → db user id

function generateRoomId() {
  let id;
  do { id = Math.random().toString(36).substr(2, 6).toUpperCase(); }
  while (rooms.has(id));
  return id;
}

function getRoomList() {
  const list = [];
  rooms.forEach(room => {
    if (room.game.phase === 'playing') return;
    list.push({
      id: room.id,
      name: room.name,
      hasPassword: !!room.password,
      playerCount: Object.keys(room.game.players).length,
      maxPlayers: MAX_PLAYERS,
      phase: room.game.phase,
    });
  });
  return list;
}

function broadcastRoomList() {
  io.emit('room_list', { rooms: getRoomList() });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function currentPlayerId(game) {
  return game.playerOrder[game.currentIndex];
}

function drawFromDeck(game, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (game.deck.length === 0) reshuffleDeck(game);
    if (game.deck.length === 0) break;
    drawn.push(game.deck.pop());
  }
  return drawn;
}

function reshuffleDeck(game) {
  if (game.discardPile.length <= 1) return;
  const toShuffle = game.discardPile.slice(0, -1);
  game.deck = shuffle(toShuffle);
  game.discardPile = game.discardPile.slice(-1);
}

function advanceTurn(game, extraSkips = 0) {
  const n = game.playerOrder.length;
  const steps = 1 + extraSkips;
  let idx = game.currentIndex;
  let moved = 0;
  while (moved < steps) {
    idx = ((idx + game.direction) % n + n) % n;
    if (!game.finished.has(game.playerOrder[idx])) moved++;
  }
  game.currentIndex = idx;
  game.hasPlayedThisTurn = false;
  game.pendingSkips = 0;
}

function buildLobbyState(game) {
  return {
    players: Object.values(game.players).map(p => ({
      id: p.id, name: p.name, isHost: p.isHost,
    })),
  };
}

function buildPublicPlayerInfo(game) {
  return game.playerOrder.map(id => {
    const p = game.players[id];
    return { id, name: p.name, cardCount: p.hand.length, oneCardDeclared: p.oneCardDeclared, isFinished: game.finished.has(id) };
  });
}

function broadcastGameState(game, roomId) {
  const base = {
    fieldCard: game.fieldCard,
    currentPlayerId: currentPlayerId(game),
    direction: game.direction,
    penaltyStack: game.penaltyStack,
    penaltyActive: game.penaltyActive,
    extraTurnActive: game.extraTurnActive,
    extraTurnSuit: game.extraTurnSuit,
    sevenSuit: game.sevenSuit,
    waitingSuitChange: game.waitingSuitChange,
    hasPlayedThisTurn: game.hasPlayedThisTurn,
    playerInfo: buildPublicPlayerInfo(game),
    deckCount: game.deck.length,
    rankings: game.rankings,
    oneCardChallenge: game.oneCardChallenge
      ? { playerName: game.oneCardChallenge.playerName, requiredKey: game.oneCardChallenge.requiredKey }
      : null,
  };
  const allHands = {};
  game.playerOrder.forEach(id => { allHands[id] = game.players[id].hand; });

  Object.values(game.players).forEach(p => {
    const sock = io.sockets.sockets.get(p.id);
    if (!sock) return;
    if (game.finished.has(p.id)) {
      sock.emit('game_update', { ...base, myHand: p.hand, allHands, isSpectator: true });
    } else {
      sock.emit('game_update', { ...base, myHand: p.hand });
    }
  });
}

// ─── Card Validation ──────────────────────────────────────────────────────────
function canDefend(card, fieldCard) {
  const { suit: fs, rank: fr } = fieldCard;
  if (fr === 'A' && fs !== 'spades') {
    if (card.rank === 'A') return true;
    if (card.rank === '2' && card.suit === fs) return true;
    if (card.rank === 'COLOR' && !suitIsBlack(fs)) return true;
    if (card.rank === 'BW' && suitIsBlack(fs)) return true;
    return false;
  }
  if (fr === '2') {
    if (card.rank === '2') return true;
    if (card.rank === 'A' && card.suit === fs) return true;
    if (card.rank === 'COLOR' && !suitIsBlack(fs)) return true;
    if (card.rank === 'BW' && suitIsBlack(fs)) return true;
    return false;
  }
  if (fr === 'BW') {
    if (card.rank === 'A' && card.suit === 'spades') return true;
    if (card.rank === 'COLOR') return true;
    return false;
  }
  if (fr === 'A' && fs === 'spades') return card.rank === 'BW';
  if (fr === 'COLOR') return false;
  return false;
}

function canPlayNormal(card, fieldCard, extraTurnActive, extraTurnSuit, sevenSuit) {
  if (extraTurnActive) {
    if (card.rank === 'K') return true;
    if (card.suit === extraTurnSuit) return true;
    if (card.rank === 'BW') return suitIsBlack(extraTurnSuit);
    if (card.rank === 'COLOR') return !suitIsBlack(extraTurnSuit);
    return false;
  }
  if (sevenSuit) {
    if (card.suit === sevenSuit || card.rank === '7') return true;
    if (card.rank === 'BW') return suitIsBlack(sevenSuit);
    if (card.rank === 'COLOR') return !suitIsBlack(sevenSuit);
    return false;
  }
  if (fieldCard.rank === 'BW') {
    return card.rank === 'BW' || card.rank === 'COLOR' || (card.suit !== null && suitIsBlack(card.suit));
  }
  if (fieldCard.rank === 'COLOR') {
    return card.rank === 'COLOR' || card.rank === 'BW' || (card.suit !== null && !suitIsBlack(card.suit));
  }
  if (card.rank === 'BW') return suitIsBlack(fieldCard.suit);
  if (card.rank === 'COLOR') return !suitIsBlack(fieldCard.suit);
  return card.suit === fieldCard.suit || card.rank === fieldCard.rank;
}

function validatePlay(game, cards) {
  if (cards.length === 0) return { valid: false, reason: '카드를 선택하세요.' };
  const player = game.players[currentPlayerId(game)];
  const handIds = new Set(player.hand.map(c => c.id));
  if (!cards.every(c => handIds.has(c.id))) return { valid: false, reason: '손패에 없는 카드입니다.' };
  if (cards.length > 1) {
    const ranks = new Set(cards.map(c => c.rank));
    if (ranks.size > 1) return { valid: false, reason: '같은 숫자의 카드만 여러 장 낼 수 있습니다.' };
    if (cards[0].rank === 'BW' || cards[0].rank === 'COLOR')
      return { valid: false, reason: '조커는 1장만 낼 수 있습니다.' };
  }
  if (game.penaltyActive && game.penaltyStack > 0) {
    if (!cards.every(c => canDefend(c, game.fieldCard)))
      return { valid: false, reason: '방어할 수 없는 카드입니다.' };
    return { valid: true };
  }
  if (!canPlayNormal(cards[0], game.fieldCard, game.extraTurnActive, game.extraTurnSuit, game.sevenSuit))
    return { valid: false, reason: '낼 수 없는 카드입니다.' };
  return { valid: true };
}

// ─── Game Start ───────────────────────────────────────────────────────────────
function startGame(game, roomId) {
  game.phase = 'playing';
  game.playerOrder = shuffle(Object.keys(game.players));

  let deck = shuffle(createDeck());
  game.playerOrder.forEach(id => {
    game.players[id].hand = deck.splice(0, INITIAL_HAND);
    game.players[id].oneCardDeclared = false;
  });

  let fi = deck.findIndex(c => NORMAL_RANKS.includes(c.rank));
  if (fi === -1) fi = deck.findIndex(c => c.rank !== 'BW' && c.rank !== 'COLOR');
  if (fi === -1) fi = 0;
  game.fieldCard = deck.splice(fi, 1)[0];
  game.discardPile = [game.fieldCard];
  game.deck = deck;

  game.currentIndex = 0;
  game.direction = 1;
  game.penaltyStack = 0;
  game.penaltyActive = false;
  game.extraTurnActive = false;
  game.extraTurnSuit = null;
  game.sevenSuit = null;
  game.waitingSuitChange = false;
  game.hasPlayedThisTurn = false;
  game.pendingSkips = 0;
  game.rankings = [];
  game.finished = new Set();
  game.oneCardChallenge = null;

  broadcastRoomList();
  io.to(roomId).emit('game_started');
  broadcastGameState(game, roomId);
}

// ─── Card Effects ─────────────────────────────────────────────────────────────
function processCards(game, roomId, cards) {
  const player = game.players[currentPlayerId(game)];
  const cardIds = new Set(cards.map(c => c.id));
  player.hand = player.hand.filter(c => !cardIds.has(c.id));

  const lastCard = cards[cards.length - 1];
  game.discardPile.push(...cards);
  game.fieldCard = lastCard;
  game.hasPlayedThisTurn = true;

  if (game.penaltyActive) {
    game.penaltyStack += cards.reduce((s, c) => s + penaltyOf(c), 0);
    game.extraTurnActive = false;
    game.extraTurnSuit = null;
    updateOneCardState(game, roomId, player);
    return;
  }

  const rank = cards[0].rank;
  const count = cards.length;

  if (game.sevenSuit) game.sevenSuit = null;

  switch (rank) {
    case '7':
      game.waitingSuitChange = true;
      break;
    case 'J':
      game.pendingSkips += count;
      break;
    case 'Q':
      if (count % 2 === 1) game.direction *= -1;
      break;
    case 'K':
      game.extraTurnActive = true;
      game.extraTurnSuit = lastCard.suit;
      break;
    default:
      if (isPenaltyCard(cards[0])) {
        game.penaltyStack += cards.reduce((s, c) => s + penaltyOf(c), 0);
        game.penaltyActive = true;
      }
  }

  if (rank !== 'K' && game.extraTurnActive) {
    game.extraTurnActive = false;
    game.extraTurnSuit = null;
  }

  updateOneCardState(game, roomId, player);
}

function updateOneCardState(game, roomId, player) {
  if (player.hand.length === 1 && !player.oneCardDeclared) {
    if (!game.oneCardChallenge && !game.oneCardTimer) {
      const keyCodes = [
        ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(k => 'Key' + k),
        ...'0123456789'.split('').map(k => 'Digit' + k),
      ];
      const key = keyCodes[Math.floor(Math.random() * keyCodes.length)];
      game.oneCardTimerPlayerId = player.id;
      game.oneCardTimer = setTimeout(() => {
        game.oneCardTimer = null;
        game.oneCardTimerPlayerId = null;
        if (player.hand.length === 1 && !player.oneCardDeclared && game.phase === 'playing') {
          game.oneCardChallenge = { playerId: player.id, playerName: player.name, requiredKey: key };
          io.to(roomId).emit('one_card_challenge', { playerName: player.name, requiredKey: key });
        }
      }, ONE_CARD_DELAY);
    }
  }
  if (player.hand.length !== 1) {
    player.oneCardDeclared = false;
    if (game.oneCardTimer && game.oneCardTimerPlayerId === player.id) {
      clearTimeout(game.oneCardTimer);
      game.oneCardTimer = null;
      game.oneCardTimerPlayerId = null;
    }
  }
}

function checkForUnchallengedOneCards(game, roomId) {
  if (game.oneCardChallenge || game.oneCardTimer) return;
  for (const id of game.playerOrder) {
    if (game.finished.has(id)) continue;
    const p = game.players[id];
    if (p && p.hand.length === 1 && !p.oneCardDeclared) {
      updateOneCardState(game, roomId, p);
      break;
    }
  }
}

// ─── Finish Check ─────────────────────────────────────────────────────────────
function checkFinish(game, roomId) {
  const playerId = currentPlayerId(game);
  const player = game.players[playerId];
  if (!player || player.hand.length !== 0) return;
  if (game.waitingSuitChange) return;

  game.finished.add(playerId);
  game.extraTurnActive = false;
  game.extraTurnSuit = null;
  if (game.oneCardChallenge?.playerId === playerId) game.oneCardChallenge = null;
  game.rankings.push({ id: playerId, name: player.name, rank: game.rankings.length + 1 });
  const rankNum = game.rankings.length;
  io.to(roomId).emit('chat_msg', { name: null, msg: `${rankNum}위: ${player.name} 완주!`, sys: true });

  const activePlayers = game.playerOrder.filter(id => !game.finished.has(id));
  if (activePlayers.length <= 1) {
    game.phase = 'ended';
    const finalRankings = [...game.rankings];
    activePlayers.forEach(id => {
      finalRankings.push({ id, name: game.players[id].name, rank: finalRankings.length + 1 });
    });
    const winner = finalRankings[0];
    const totalPlayers = game.playerOrder.length;
    finalRankings.forEach(({ id, rank }) => {
      const uid = socketUserId.get(id);
      if (uid) db.saveResult(uid, rank, totalPlayers);
    });
    io.to(roomId).emit('game_over', {
      winnerId: winner.id,
      winnerName: winner.name,
      rankings: finalRankings,
      results: game.playerOrder.map(id => {
        const pl = game.players[id];
        const r = finalRankings.find(fr => fr.id === id);
        return { id, name: pl.name, cardCount: pl.hand.length, rank: r?.rank || game.playerOrder.length, won: id === winner.id };
      }),
    });
    broadcastRoomList();
  }
}

// ─── Leave Room ───────────────────────────────────────────────────────────────
function handleLeaveRoom(socket) {
  const roomId = socketRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) { socketRoom.delete(socket.id); return; }

  const game = room.game;
  const p = game.players[socket.id];
  const pName = p?.name;

  socket.leave(roomId);
  socketRoom.delete(socket.id);
  delete game.players[socket.id];
  room.rematchVotes.delete(socket.id);
  if (game.oneCardTimer && game.oneCardTimerPlayerId === socket.id) {
    clearTimeout(game.oneCardTimer);
    game.oneCardTimer = null;
    game.oneCardTimerPlayerId = null;
  }

  if (game.finished.has(socket.id)) {
    game.finished.delete(socket.id);
    game.rankings = game.rankings.filter(r => r.id !== socket.id);
    game.rankings.forEach((r, i) => { r.rank = i + 1; });
  }

  socket.emit('left_room');

  if (Object.keys(game.players).length === 0) {
    rooms.delete(roomId);
    broadcastRoomList();
    return;
  }

  if (game.phase === 'lobby' || game.phase === 'ended') {
    const ids = Object.keys(game.players);
    if (!Object.values(game.players).some(pl => pl.isHost))
      game.players[ids[0]].isHost = true;
    io.to(roomId).emit('lobby_update', buildLobbyState(game));
    broadcastRoomList();
    return;
  }

  // playing phase
  const wasCurrentPlayer = socket.id === currentPlayerId(game);
  game.playerOrder = game.playerOrder.filter(id => id !== socket.id);

  if (game.playerOrder.length === 0) { rooms.delete(roomId); broadcastRoomList(); return; }
  if (game.currentIndex >= game.playerOrder.length) game.currentIndex = 0;

  if (pName) io.to(roomId).emit('chat_msg', { name: null, msg: `${pName} 님이 나갔습니다.`, sys: true });

  const activePlayers = game.playerOrder.filter(id => !game.finished.has(id));
  if (activePlayers.length <= 1) {
    game.phase = 'ended';
    const finalRankings = [...game.rankings];
    activePlayers.forEach(id => {
      finalRankings.push({ id, name: game.players[id].name, rank: finalRankings.length + 1 });
    });
    const winner = finalRankings[0];
    const totalPlayers = finalRankings.length;
    finalRankings.forEach(({ id, rank }) => {
      const uid = socketUserId.get(id);
      if (uid) db.saveResult(uid, rank, totalPlayers);
    });
    io.to(roomId).emit('game_over', {
      winnerId: winner?.id,
      winnerName: winner?.name,
      rankings: finalRankings,
      results: game.playerOrder.map(id => {
        const pl = game.players[id];
        const r = finalRankings.find(fr => fr.id === id);
        return { id, name: pl.name, cardCount: pl.hand.length, rank: r?.rank || game.playerOrder.length, won: id === winner?.id };
      }),
    });
    broadcastRoomList();
    return;
  }

  if (wasCurrentPlayer) {
    game.hasPlayedThisTurn = false;
    game.extraTurnActive = false;
    game.penaltyActive = false;
    game.penaltyStack = 0;
    advanceTurn(game, 0);
  }
  broadcastGameState(game, roomId);
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', socket => {

  socket.on('join', ({ userId }) => {
    const user = db.getUserById(userId);
    if (!user) { socket.emit('auth_error', { msg: '인증 정보가 올바르지 않습니다.' }); return; }
    socketUserId.set(socket.id, user.id);
    socketName.set(socket.id, user.nickname);
    socket.emit('join_ok', { name: user.nickname });
    socket.emit('room_list', { rooms: getRoomList() });
  });

  socket.on('update_nickname', ({ nickname }) => {
    const uid = socketUserId.get(socket.id);
    if (!uid) return;
    const result = db.updateNickname(uid, nickname);
    if (!result.ok) { socket.emit('profile_error', { msg: result.error }); return; }
    socketName.set(socket.id, result.nickname);
    const roomId = socketRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.game.players[socket.id]) room.game.players[socket.id].name = result.nickname;
    }
    socket.emit('profile_ok', { nickname: result.nickname });
  });

  socket.on('update_password', ({ currentPassword, newPassword }) => {
    const uid = socketUserId.get(socket.id);
    if (!uid) return;
    const result = db.updatePassword(uid, currentPassword, newPassword);
    if (!result.ok) { socket.emit('profile_error', { msg: result.error }); return; }
    socket.emit('profile_ok', {});
  });

  socket.on('get_rooms', () => {
    socket.emit('room_list', { rooms: getRoomList() });
  });

  socket.on('create_room', ({ roomName, password }) => {
    const name = socketName.get(socket.id);
    if (!name || socketRoom.has(socket.id)) return;

    const id = generateRoomId();
    const rName = (roomName || '').trim().slice(0, 30) || `${name}의 방`;
    const rPass = (password || '').trim().slice(0, 20) || null;

    const game = makeGameState();
    game.players[socket.id] = { id: socket.id, name, hand: [], oneCardDeclared: false, isHost: true };

    const room = { id, name: rName, password: rPass, game, rematchVotes: new Set() };
    rooms.set(id, room);
    socketRoom.set(socket.id, id);
    socket.join(id);

    socket.emit('room_joined', { roomId: id, roomName: rName });
    socket.emit('lobby_update', buildLobbyState(game));
    broadcastRoomList();
  });

  socket.on('join_room', ({ roomId, password }) => {
    const name = socketName.get(socket.id);
    if (!name || socketRoom.has(socket.id)) return;

    const room = rooms.get(roomId);
    if (!room) { socket.emit('room_error', { msg: '존재하지 않는 방입니다.' }); return; }
    if (room.game.phase !== 'lobby' && room.game.phase !== 'ended') {
      socket.emit('room_error', { msg: '게임이 진행 중인 방입니다.' }); return;
    }
    if (Object.keys(room.game.players).length >= MAX_PLAYERS) {
      socket.emit('room_error', { msg: '방이 꽉 찼습니다. (최대 5명)' }); return;
    }
    if (room.password && room.password !== (password || '').trim()) {
      socket.emit('room_error', { msg: '비밀번호가 틀렸습니다.', code: 'WRONG_PASSWORD' }); return;
    }

    room.game.players[socket.id] = { id: socket.id, name, hand: [], oneCardDeclared: false, isHost: false };
    socketRoom.set(socket.id, roomId);
    socket.join(roomId);

    socket.emit('room_joined', { roomId, roomName: room.name });
    io.to(roomId).emit('lobby_update', buildLobbyState(room.game));
    broadcastRoomList();
  });

  socket.on('leave_room', () => { handleLeaveRoom(socket); });

  socket.on('start_game', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.game.players[socket.id];
    if (!p?.isHost || room.game.phase !== 'lobby') return;
    if (Object.keys(room.game.players).length < 2) return;
    startGame(room.game, roomId);
  });

  socket.on('play_cards', ({ cardIds }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const game = room.game;
    if (game.phase !== 'playing') return;
    if (socket.id !== currentPlayerId(game)) return;
    if (game.waitingSuitChange) return;
    const player = game.players[socket.id];
    if (!player) return;

    const handMap = new Map(player.hand.map(c => [c.id, c]));
    const cards = (cardIds || []).map(id => handMap.get(id)).filter(Boolean);

    const { valid, reason } = validatePlay(game, cards);
    if (!valid) { socket.emit('play_error', { reason }); return; }

    processCards(game, roomId, cards);
    checkFinish(game, roomId);
    if (game.phase === 'playing') {
      if (!game.extraTurnActive && !game.waitingSuitChange) {
        let skips = game.pendingSkips;
        if (skips > 0) {
          const opponents = game.playerOrder.filter(id => !game.finished.has(id) && id !== socket.id).length;
          if (opponents > 0) {
            skips = skips % opponents || opponents;
          }
        }
        advanceTurn(game, skips);
      }
      broadcastGameState(game, roomId);
    }
  });

  socket.on('draw_card', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const game = room.game;
    if (game.phase !== 'playing') return;
    if (socket.id !== currentPlayerId(game)) return;
    if (game.hasPlayedThisTurn && !game.extraTurnActive) return;
    const player = game.players[socket.id];
    if (!player) return;

    if (game.penaltyActive && game.penaltyStack > 0) {
      const drawn = drawFromDeck(game, game.penaltyStack);
      player.hand.push(...drawn);
      game.penaltyStack = 0;
      game.penaltyActive = false;
    } else {
      const drawn = drawFromDeck(game, 1);
      player.hand.push(...drawn);
    }

    if (player.hand.length !== 1) player.oneCardDeclared = false;
    if (game.oneCardChallenge?.playerId === socket.id) {
      game.oneCardChallenge = null;
      checkForUnchallengedOneCards(game, roomId);
    }
    if (game.oneCardTimer && game.oneCardTimerPlayerId === socket.id) {
      clearTimeout(game.oneCardTimer);
      game.oneCardTimer = null;
      game.oneCardTimerPlayerId = null;
      checkForUnchallengedOneCards(game, roomId);
    }

    game.extraTurnActive = false;
    game.extraTurnSuit = null;
    advanceTurn(game, 0);
    broadcastGameState(game, roomId);
  });

  socket.on('choose_suit', ({ suit }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const game = room.game;
    if (game.phase !== 'playing') return;
    if (socket.id !== currentPlayerId(game)) return;
    if (!game.waitingSuitChange) return;
    if (!SUITS.includes(suit)) return;

    game.sevenSuit = suit;
    game.waitingSuitChange = false;

    const suitName = { spades: '스페이드', hearts: '하트', diamonds: '다이아', clubs: '클로버' }[suit];
    const suitSym  = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[suit];
    const pName = game.players[socket.id]?.name || '';
    io.to(roomId).emit('chat_msg', { name: null, msg: `${pName} 님이 ${suitSym} ${suitName}로 무늬를 선언했습니다.`, sys: true });

    checkFinish(game, roomId);
    if (game.phase === 'playing') {
      advanceTurn(game, game.pendingSkips);
      broadcastGameState(game, roomId);
    }
  });

  socket.on('one_card_key', ({ key }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const game = room.game;
    if (game.phase !== 'playing') return;
    if (!game.oneCardChallenge) return;
    if (key !== game.oneCardChallenge.requiredKey) return;

    const { playerId, playerName } = game.oneCardChallenge;
    const presser = game.players[socket.id];
    if (!presser) return;
    const target = game.players[playerId];
    if (!target || target.hand.length !== 1) {
      game.oneCardChallenge = null;
      checkForUnchallengedOneCards(game, roomId);
      broadcastGameState(game, roomId);
      return;
    }

    game.oneCardChallenge = null;

    if (socket.id === playerId) {
      target.oneCardDeclared = true;
      io.to(roomId).emit('one_card_result', { type: 'declare', targetId: playerId, targetName: playerName, byName: presser.name });
    } else {
      const drawn = drawFromDeck(game, 1);
      target.hand.push(...drawn);
      target.oneCardDeclared = false;
      io.to(roomId).emit('one_card_result', { type: 'callout', targetId: playerId, targetName: playerName, byName: presser.name });
    }
    checkForUnchallengedOneCards(game, roomId);
    broadcastGameState(game, roomId);
  });

  socket.on('chat', ({ msg }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const name = room.game.players[socket.id]?.name || socketName.get(socket.id);
    if (!name) return;
    const text = (msg || '').trim().slice(0, 200);
    if (!text) return;
    io.to(roomId).emit('chat_msg', { name, msg: text });
  });

  socket.on('rematch_vote', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.game.phase !== 'ended') return;

    room.rematchVotes.add(socket.id);
    const total = Object.keys(room.game.players).length;
    io.to(roomId).emit('rematch_status', { votes: room.rematchVotes.size, total });

    if (room.rematchVotes.size >= total) {
      const saved = Object.values(room.game.players).map(p => ({ id: p.id, name: p.name }));
      room.game = makeGameState();
      room.rematchVotes = new Set();
      saved.forEach((p, i) => {
        room.game.players[p.id] = { id: p.id, name: p.name, hand: [], oneCardDeclared: false, isHost: i === 0 };
      });
      io.to(roomId).emit('lobby_update', buildLobbyState(room.game));
      broadcastRoomList();
    }
  });

  socket.on('disconnect', () => {
    handleLeaveRoom(socket);
    socketName.delete(socket.id);
    socketUserId.delete(socket.id);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  return 'localhost';
}

let currentPort = 3000;

function listen(port) {
  currentPort = port;
  server.listen(port, '0.0.0.0');
}

server.on('listening', () => {
  console.log(`Server running at http://${getLocalIp()}:${currentPort}`);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    listen(currentPort + 1);
  } else {
    throw e;
  }
});

listen(3000);

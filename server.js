const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const INITIAL_HAND = 7;
const MAX_PLAYERS = 5;
const NORMAL_RANKS = ['3', '4', '5', '6', '7', '8', '9', '10'];

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

// ─── State ────────────────────────────────────────────────────────────────────
function makeState() {
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
    rematchVotes: new Set(),
    rankings: [],      // [{id, name, rank}] — 완주 순서
    finished: new Set(), // 완주한 플레이어 id
    oneCardChallenge: null, // { playerId, playerName, requiredKey }
  };
}

let state = makeState();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function currentPlayerId() {
  return state.playerOrder[state.currentIndex];
}

function drawFromDeck(n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) reshuffleDeck();
    if (state.deck.length === 0) break;
    drawn.push(state.deck.pop());
  }
  return drawn;
}

function reshuffleDeck() {
  if (state.discardPile.length <= 1) return;
  const toShuffle = state.discardPile.slice(0, -1);
  state.deck = shuffle(toShuffle);
  state.discardPile = state.discardPile.slice(-1);
}

function advanceTurn(extraSkips = 0) {
  const n = state.playerOrder.length;
  const steps = 1 + extraSkips;
  const fromName = state.players[state.playerOrder[state.currentIndex]]?.name || '?';
  let idx = state.currentIndex;
  let moved = 0;
  while (moved < steps) {
    idx = ((idx + state.direction) % n + n) % n;
    if (!state.finished.has(state.playerOrder[idx])) moved++;
  }
  state.currentIndex = idx;
  state.hasPlayedThisTurn = false;
  state.pendingSkips = 0;
  const toName = state.players[state.playerOrder[state.currentIndex]]?.name || '?';
  console.log(`[TURN] ${fromName} → ${toName}  (dir:${state.direction} steps:${steps} order:[${state.playerOrder.map(id=>(state.finished.has(id)?'X':'')+state.players[id]?.name).join(',')}])`);
}

function buildLobbyState() {
  return {
    players: Object.values(state.players).map(p => ({
      id: p.id, name: p.name, isHost: p.isHost,
    })),
  };
}

function buildPublicPlayerInfo() {
  return state.playerOrder.map(id => {
    const p = state.players[id];
    return { id, name: p.name, cardCount: p.hand.length, oneCardDeclared: p.oneCardDeclared, isFinished: state.finished.has(id) };
  });
}

function broadcastGameState() {
  const base = {
    fieldCard: state.fieldCard,
    currentPlayerId: currentPlayerId(),
    direction: state.direction,
    penaltyStack: state.penaltyStack,
    penaltyActive: state.penaltyActive,
    extraTurnActive: state.extraTurnActive,
    extraTurnSuit: state.extraTurnSuit,
    sevenSuit: state.sevenSuit,
    waitingSuitChange: state.waitingSuitChange,
    hasPlayedThisTurn: state.hasPlayedThisTurn,
    playerInfo: buildPublicPlayerInfo(),
    deckCount: state.deck.length,
    rankings: state.rankings,
    oneCardChallenge: state.oneCardChallenge
      ? { playerName: state.oneCardChallenge.playerName, requiredKey: state.oneCardChallenge.requiredKey }
      : null,
  };
  const allHands = {};
  state.playerOrder.forEach(id => { allHands[id] = state.players[id].hand; });

  Object.values(state.players).forEach(p => {
    const sock = io.sockets.sockets.get(p.id);
    if (!sock) return;
    if (state.finished.has(p.id)) {
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
    return card.suit === sevenSuit || card.rank === '7';
  }
  // BW joker field: black suits (♠♣) or BW joker
  if (fieldCard.rank === 'BW') {
    return card.rank === 'BW' || (card.suit !== null && suitIsBlack(card.suit));
  }
  // COLOR joker field: red suits (♥♦) or COLOR joker
  if (fieldCard.rank === 'COLOR') {
    return card.rank === 'COLOR' || (card.suit !== null && !suitIsBlack(card.suit));
  }
  // Joker play conditions (on normal field)
  if (card.rank === 'BW') return suitIsBlack(fieldCard.suit);
  if (card.rank === 'COLOR') return !suitIsBlack(fieldCard.suit);
  return card.suit === fieldCard.suit || card.rank === fieldCard.rank;
}

function validatePlay(cards) {
  if (cards.length === 0) return { valid: false, reason: '카드를 선택하세요.' };
  const player = state.players[currentPlayerId()];
  const handIds = new Set(player.hand.map(c => c.id));
  if (!cards.every(c => handIds.has(c.id))) return { valid: false, reason: '손패에 없는 카드입니다.' };
  if (cards.length > 1) {
    const ranks = new Set(cards.map(c => c.rank));
    if (ranks.size > 1) return { valid: false, reason: '같은 숫자의 카드만 여러 장 낼 수 있습니다.' };
    if (cards[0].rank === 'BW' || cards[0].rank === 'COLOR')
      return { valid: false, reason: '조커는 1장만 낼 수 있습니다.' };
  }
  if (state.penaltyActive && state.penaltyStack > 0) {
    if (!cards.every(c => canDefend(c, state.fieldCard)))
      return { valid: false, reason: '방어할 수 없는 카드입니다.' };
    return { valid: true };
  }
  if (!canPlayNormal(cards[0], state.fieldCard, state.extraTurnActive, state.extraTurnSuit, state.sevenSuit))
    return { valid: false, reason: '낼 수 없는 카드입니다.' };
  return { valid: true };
}

// ─── Game Start ───────────────────────────────────────────────────────────────
function startGame() {
  state.phase = 'playing';
  state.playerOrder = shuffle(Object.keys(state.players));

  let deck = shuffle(createDeck());

  state.playerOrder.forEach(id => {
    state.players[id].hand = deck.splice(0, INITIAL_HAND);
    state.players[id].oneCardDeclared = false;
  });

  // Prefer a normal number card as the starting field card
  let fi = deck.findIndex(c => NORMAL_RANKS.includes(c.rank));
  if (fi === -1) fi = deck.findIndex(c => c.rank !== 'BW' && c.rank !== 'COLOR');
  if (fi === -1) fi = 0;
  state.fieldCard = deck.splice(fi, 1)[0];
  state.discardPile = [state.fieldCard];
  state.deck = deck;

  state.currentIndex = 0;
  state.direction = 1;
  state.penaltyStack = 0;
  state.penaltyActive = false;
  state.extraTurnActive = false;
  state.extraTurnSuit = null;
  state.sevenSuit = null;
  state.waitingSuitChange = false;
  state.hasPlayedThisTurn = false;
  state.pendingSkips = 0;
  state.rankings = [];
  state.finished = new Set();
  state.oneCardChallenge = null;

  io.emit('game_started');
  broadcastGameState();
}

// ─── Card Effects ─────────────────────────────────────────────────────────────
function processCards(cards) {
  const player = state.players[currentPlayerId()];
  const cardIds = new Set(cards.map(c => c.id));
  player.hand = player.hand.filter(c => !cardIds.has(c.id));

  const lastCard = cards[cards.length - 1];
  state.discardPile.push(...cards);
  state.fieldCard = lastCard;
  state.hasPlayedThisTurn = true;

  if (state.penaltyActive) {
    state.penaltyStack += cards.reduce((s, c) => s + penaltyOf(c), 0);
    state.extraTurnActive = false;
    state.extraTurnSuit = null;
    updateOneCardState(player);
    return;
  }

  const rank = cards[0].rank;
  const count = cards.length;

  if (state.sevenSuit) state.sevenSuit = null;

  switch (rank) {
    case '7':
      state.waitingSuitChange = true;
      break;
    case 'J':
      state.pendingSkips += count;
      break;
    case 'Q':
      if (count % 2 === 1) state.direction *= -1;
      break;
    case 'K':
      state.extraTurnActive = true;
      state.extraTurnSuit = lastCard.suit;
      break;
    default:
      if (isPenaltyCard(cards[0])) {
        state.penaltyStack += cards.reduce((s, c) => s + penaltyOf(c), 0);
        state.penaltyActive = true;
      }
  }

  // Consuming K extra turn with a non-K card (including penalty/attack cards)
  if (rank !== 'K' && state.extraTurnActive) {
    state.extraTurnActive = false;
    state.extraTurnSuit = null;
  }

  updateOneCardState(player);
}

function updateOneCardState(player) {
  if (player.hand.length === 1 && !player.oneCardDeclared) {
    if (!state.oneCardChallenge || state.oneCardChallenge.playerId !== player.id) {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const key = chars[Math.floor(Math.random() * chars.length)];
      state.oneCardChallenge = { playerId: player.id, playerName: player.name, requiredKey: key };
      io.emit('one_card_challenge', { playerName: player.name, requiredKey: key });
    }
  }
  if (player.hand.length !== 1) {
    player.oneCardDeclared = false;
  }
}

// ─── Finish Check ─────────────────────────────────────────────────────────────
function checkFinish() {
  const playerId = currentPlayerId();
  const player = state.players[playerId];
  if (!player || player.hand.length !== 0) return;
  if (state.waitingSuitChange) return;

  state.finished.add(playerId);
  state.extraTurnActive = false;
  state.extraTurnSuit = null;
  if (state.oneCardChallenge?.playerId === playerId) state.oneCardChallenge = null;
  state.rankings.push({ id: playerId, name: player.name, rank: state.rankings.length + 1 });
  const rankNum = state.rankings.length;
  io.emit('chat_msg', { name: null, msg: `${rankNum}위: ${player.name} 완주!`, sys: true });

  const activePlayers = state.playerOrder.filter(id => !state.finished.has(id));
  if (activePlayers.length <= 1) {
    state.phase = 'ended';
    const finalRankings = [...state.rankings];
    activePlayers.forEach(id => {
      finalRankings.push({ id, name: state.players[id].name, rank: finalRankings.length + 1 });
    });
    const winner = finalRankings[0];
    io.emit('game_over', {
      winnerId: winner.id,
      winnerName: winner.name,
      rankings: finalRankings,
      results: state.playerOrder.map(id => {
        const pl = state.players[id];
        const r = finalRankings.find(fr => fr.id === id);
        return { id, name: pl.name, cardCount: pl.hand.length, rank: r?.rank || state.playerOrder.length, won: id === winner.id };
      }),
    });
  }
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', ({ name }) => {
    if (state.phase !== 'lobby') { socket.emit('join_error', { msg: '게임이 진행 중입니다.' }); return; }
    if (Object.keys(state.players).length >= MAX_PLAYERS) { socket.emit('join_error', { msg: '방이 꽉 찼습니다. (최대 5명)' }); return; }
    const isHost = Object.keys(state.players).length === 0;
    state.players[socket.id] = {
      id: socket.id, name: name.trim().slice(0, 12) || '익명',
      hand: [], oneCardDeclared: false, isHost,
    };
    io.emit('lobby_update', buildLobbyState());
  });

  socket.on('start_game', () => {
    const p = state.players[socket.id];
    if (!p?.isHost || state.phase !== 'lobby') return;
    if (Object.keys(state.players).length < 2) return;
    startGame();
  });

  socket.on('play_cards', ({ cardIds }) => {
    if (state.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;
    if (state.waitingSuitChange) return;
    const player = state.players[socket.id];
    if (!player) return;

    const handMap = new Map(player.hand.map(c => [c.id, c]));
    const cards = (cardIds || []).map(id => handMap.get(id)).filter(Boolean);

    const { valid, reason } = validatePlay(cards);
    if (!valid) { socket.emit('play_error', { reason }); return; }

    processCards(cards);
    checkFinish();
    if (state.phase === 'playing') {
      if (!state.extraTurnActive && !state.waitingSuitChange) {
        const skips = state.pendingSkips;
        advanceTurn(skips);
      }
      broadcastGameState();
    }
  });

  socket.on('draw_card', () => {
    if (state.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;
    if (state.hasPlayedThisTurn && !state.extraTurnActive) return;
    const player = state.players[socket.id];
    if (!player) return;

    if (state.penaltyActive && state.penaltyStack > 0) {
      const drawn = drawFromDeck(state.penaltyStack);
      player.hand.push(...drawn);
      state.penaltyStack = 0;
      state.penaltyActive = false;
    } else {
      const drawn = drawFromDeck(1);
      player.hand.push(...drawn);
    }

    if (player.hand.length !== 1) player.oneCardDeclared = false;
    if (state.oneCardChallenge?.playerId === socket.id) state.oneCardChallenge = null;

    state.extraTurnActive = false;
    state.extraTurnSuit = null;
    advanceTurn(0);
    broadcastGameState();
  });

  socket.on('choose_suit', ({ suit }) => {
    console.log(`[CHOOSE_SUIT] by=${state.players[socket.id]?.name} currentPlayer=${state.players[currentPlayerId()]?.name} waitingSuit=${state.waitingSuitChange} suit=${suit}`);
    if (state.phase !== 'playing') return;
    if (socket.id !== currentPlayerId()) return;
    if (!state.waitingSuitChange) return;
    if (!SUITS.includes(suit)) return;

    state.sevenSuit = suit;
    state.waitingSuitChange = false;

    const suitName = { spades:'스페이드', hearts:'하트', diamonds:'다이아', clubs:'클로버' }[suit];
    const suitSym  = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' }[suit];
    const pName = state.players[socket.id]?.name || '';
    io.emit('chat_msg', { name: null, msg: `${pName} 님이 ${suitSym} ${suitName}로 무늬를 선언했습니다.`, sys: true });

    checkFinish();
    if (state.phase === 'playing') {
      const skips = state.pendingSkips;
      console.log(`[CHOOSE_SUIT] calling advanceTurn(${skips})`);
      advanceTurn(skips);
      broadcastGameState();
    } else {
      console.log(`[CHOOSE_SUIT] phase=${state.phase}, skipping advanceTurn`);
    }
  });

  socket.on('one_card_key', ({ key }) => {
    if (state.phase !== 'playing') return;
    if (!state.oneCardChallenge) return;
    if (key !== state.oneCardChallenge.requiredKey) return;

    const { playerId, playerName } = state.oneCardChallenge;
    const presser = state.players[socket.id];
    if (!presser) return;
    const target = state.players[playerId];
    if (!target || target.hand.length !== 1) { state.oneCardChallenge = null; broadcastGameState(); return; }

    state.oneCardChallenge = null;

    if (socket.id === playerId) {
      target.oneCardDeclared = true;
      io.emit('one_card_result', { type: 'declare', targetId: playerId, targetName: playerName, byName: presser.name });
    } else {
      const drawn = drawFromDeck(1);
      target.hand.push(...drawn);
      target.oneCardDeclared = false;
      io.emit('one_card_result', { type: 'callout', targetId: playerId, targetName: playerName, byName: presser.name });
    }
    broadcastGameState();
  });

  socket.on('chat', ({ msg }) => {
    const p = state.players[socket.id];
    if (!p) return;
    const text = msg.trim().slice(0, 200);
    if (!text) return;
    io.emit('chat_msg', { name: p.name, msg: text });
  });

  socket.on('rematch_vote', () => {
    if (state.phase !== 'ended') return;
    state.rematchVotes.add(socket.id);
    io.emit('rematch_status', { votes: state.rematchVotes.size, total: Object.keys(state.players).length });
    if (state.rematchVotes.size >= Object.keys(state.players).length) {
      const saved = Object.values(state.players).map(p => ({ id: p.id, name: p.name }));
      state = makeState();
      saved.forEach((p, i) => {
        state.players[p.id] = { id: p.id, name: p.name, hand: [], oneCardDeclared: false, isHost: i === 0 };
      });
      io.emit('lobby_update', buildLobbyState());
    }
  });

  socket.on('disconnect', () => {
    const p = state.players[socket.id];
    if (!p) return;
    const pName = p.name;
    delete state.players[socket.id];
    state.rematchVotes.delete(socket.id);
    if (state.finished.has(socket.id)) {
      state.finished.delete(socket.id);
      state.rankings = state.rankings.filter(r => r.id !== socket.id);
      state.rankings.forEach((r, i) => { r.rank = i + 1; });
    }

    if (state.phase === 'lobby') {
      const ids = Object.keys(state.players);
      if (ids.length > 0 && !Object.values(state.players).some(pl => pl.isHost))
        state.players[ids[0]].isHost = true;
      io.emit('lobby_update', buildLobbyState());
      return;
    }

    const wasCurrentPlayer = socket.id === currentPlayerId();
    state.playerOrder = state.playerOrder.filter(id => id !== socket.id);

    if (state.playerOrder.length === 0) { state = makeState(); return; }

    if (state.currentIndex >= state.playerOrder.length)
      state.currentIndex = 0;

    io.emit('player_left', { name: pName });

    const activePlayers = state.playerOrder.filter(id => !state.finished.has(id));

    if (activePlayers.length <= 1) {
      state.phase = 'ended';
      const finalRankings = [...state.rankings];
      activePlayers.forEach(id => {
        finalRankings.push({ id, name: state.players[id].name, rank: finalRankings.length + 1 });
      });
      const winner = finalRankings[0];
      io.emit('game_over', {
        winnerId: winner?.id,
        winnerName: winner?.name,
        rankings: finalRankings,
        results: state.playerOrder.map(id => {
          const pl = state.players[id];
          const r = finalRankings.find(fr => fr.id === id);
          return { id, name: pl.name, cardCount: pl.hand.length, rank: r?.rank || state.playerOrder.length, won: id === winner?.id };
        }),
      });
      return;
    }

    if (wasCurrentPlayer) {
      state.hasPlayedThisTurn = false;
      state.extraTurnActive = false;
      state.penaltyActive = false;
      state.penaltyStack = 0;
      advanceTurn(0);
    }
    broadcastGameState();
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  let ip = 'localhost';
  for (const iface of Object.values(nets))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) { ip = addr.address; break; }
  console.log(`Server running at http://${ip}:${PORT}`);
});

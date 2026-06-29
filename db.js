const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'onecard.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    login_id      TEXT UNIQUE NOT NULL,
    nickname      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS game_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    rank          INTEGER NOT NULL,
    total_players INTEGER NOT NULL,
    points        INTEGER NOT NULL,
    week_start    TEXT,
    played_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// 기존 DB에 week_start 컬럼이 없을 경우 마이그레이션
try { db.exec('ALTER TABLE game_results ADD COLUMN week_start TEXT'); } catch (_) {}

function getWeekStart() {
  const now = new Date();
  const day = now.getDay(); // 0=일, 1=월 ...
  const diff = day === 0 ? -6 : 1 - day; // 이번 주 월요일까지의 차이
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return monday.toISOString().slice(0, 10); // YYYY-MM-DD
}

const stmts = {
  findByLoginId:  db.prepare('SELECT * FROM users WHERE login_id = ?'),
  findById:       db.prepare('SELECT id, login_id, nickname FROM users WHERE id = ?'),
  insert:         db.prepare('INSERT INTO users (login_id, nickname, password_hash) VALUES (?, ?, ?)'),
  updateNickname: db.prepare('UPDATE users SET nickname = ? WHERE id = ?'),
  updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  insertResult:   db.prepare('INSERT INTO game_results (user_id, rank, total_players, points, week_start) VALUES (?, ?, ?, ?, ?)'),
};

function getLeaderboardStmt(weekStart) {
  return db.prepare(`
    SELECT u.nickname,
           COALESCE(SUM(CASE WHEN r.week_start = ? THEN r.points ELSE 0 END), 0) AS week_points,
           COUNT(CASE WHEN r.week_start = ? AND r.rank = 1 THEN 1 END)            AS week_wins,
           COUNT(CASE WHEN r.week_start = ? THEN 1 END)                            AS week_games,
           COALESCE(SUM(r.points), 0)                                               AS total_points
    FROM users u
    JOIN game_results r ON u.id = r.user_id
    GROUP BY u.id
    HAVING week_games > 0 OR total_points > 0
    ORDER BY week_points DESC, week_wins DESC
    LIMIT 50
  `);
}

function register(loginId, nickname, password) {
  if (!loginId || loginId.length < 3) return { ok: false, error: '아이디는 3자 이상이어야 합니다.' };
  if (!nickname || nickname.length < 1) return { ok: false, error: '닉네임을 입력해주세요.' };
  if (!password || password.length < 4) return { ok: false, error: '비밀번호는 4자 이상이어야 합니다.' };
  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = stmts.insert.run(loginId.trim(), nickname.trim().slice(0, 12), hash);
    return { ok: true, userId: result.lastInsertRowid, nickname: nickname.trim().slice(0, 12) };
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return { ok: false, error: '이미 사용 중인 아이디입니다.' };
    throw e;
  }
}

function login(loginId, password) {
  const user = stmts.findByLoginId.get(loginId);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return { ok: false, error: '아이디 또는 비밀번호가 틀렸습니다.' };
  return { ok: true, userId: user.id, nickname: user.nickname };
}

function getUserById(id) {
  return stmts.findById.get(id) || null;
}

function updateNickname(userId, nickname) {
  const nick = (nickname || '').trim().slice(0, 12);
  if (!nick) return { ok: false, error: '닉네임을 입력해주세요.' };
  stmts.updateNickname.run(nick, userId);
  return { ok: true, nickname: nick };
}

function updatePassword(userId, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 4) return { ok: false, error: '새 비밀번호는 4자 이상이어야 합니다.' };
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash))
    return { ok: false, error: '현재 비밀번호가 틀렸습니다.' };
  stmts.updatePassword.run(bcrypt.hashSync(newPassword, 10), userId);
  return { ok: true };
}

function saveResult(userId, rank, totalPlayers) {
  const points = Math.max(0, totalPlayers - rank);
  stmts.insertResult.run(userId, rank, totalPlayers, points, getWeekStart());
}

function getLeaderboard() {
  const weekStart = getWeekStart();
  return { weekStart, rows: getLeaderboardStmt(weekStart).all(weekStart, weekStart, weekStart) };
}

module.exports = { register, login, getUserById, updateNickname, updatePassword, saveResult, getLeaderboard };

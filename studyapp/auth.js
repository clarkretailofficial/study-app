// auth.js
// Minimal auth: scrypt password hashing + cookie sessions, all via node:crypto (no libraries needed).
const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createUser(email, name, password) {
  const { hash, salt } = hashPassword(password);
  const stmt = db.prepare(
    "INSERT INTO users (email, name, password_hash, password_salt, agreed_to_terms_at) VALUES (?, ?, ?, ?, datetime('now'))"
  );
  const info = stmt.run(email.toLowerCase().trim(), name.trim(), hash, salt);
  return getUserById(Number(info.lastInsertRowid));
}

function getUserByEmail(email) {
  return db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email.toLowerCase().trim());
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(id, userId, expiresAt);
  return { id, expiresAt };
}

function destroySession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function getUserBySession(sessionId) {
  if (!sessionId) return null;
  const session = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    destroySession(sessionId);
    return null;
  }
  return getUserById(session.user_id);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function sessionCookieHeader(sessionId, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Expires=${expires}; SameSite=Lax`;
}

function clearCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function createPasswordReset(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO password_resets (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(token, userId, expiresAt);
  return { token, expiresAt };
}

function getValidPasswordReset(token) {
  const row = db.prepare('SELECT * FROM password_resets WHERE id = ?').get(token);
  if (!row) return null;
  if (row.used) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

function markPasswordResetUsed(token) {
  db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(token);
}

function updateUserPassword(userId, newPassword) {
  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, userId);
}

module.exports = {
  SESSION_COOKIE,
  createUser,
  getUserByEmail,
  getUserById,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserBySession,
  parseCookies,
  sessionCookieHeader,
  clearCookieHeader,
  createPasswordReset,
  getValidPasswordReset,
  markPasswordResetUsed,
  updateUserPassword,
};

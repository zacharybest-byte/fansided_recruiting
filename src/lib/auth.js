'use strict';
// Sessions (database rows keyed by the SHA-256 of the cookie token) and route guards.
const { randomHex, sha256Hex } = require('./crypto');
const { HttpError } = require('./http');
const { internalToken } = require('./csrf');
const { nowIso } = require('./db');

const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 14;

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// A new random session token with the statements that store it and prune expired rows.
// `guard` (optional) is extra SQL appended to the INSERT's WHERE, with `guardArgs`, so a caller can make
// the new session depend on an earlier statement of its own batch.
function newSession(userId, { guard = '', guardArgs = [] } = {}) {
  const token = randomHex(32);
  const now = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  return {
    token,
    statements: [
      { sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [now] },
      {
        sql: `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) SELECT ?, ?, ?, ? WHERE 1 = 1 ${guard}`,
        args: [sha256Hex(token), userId, now, expires, ...guardArgs],
      },
    ],
  };
}

function setSessionCookie(ctx, token) {
  ctx.setCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, httpOnly: true, secure: true, sameSite: 'Lax' });
}

// The user is always loaded from the database: a deactivated user's session stops working at once.
// password_hash is deliberately not selected.
async function loadSession(ctx) {
  const sid = ctx.cookies[SESSION_COOKIE];
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return;
  const tokenHash = sha256Hex(sid);
  const row = await ctx.app.db.get(
    `SELECT s.expires_at, u.id, u.email, u.name, u.role, u.active, u.dashboard_seen_at, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [tokenHash]
  );
  if (!row) return;
  if (row.expires_at < nowIso() || !row.active) {
    await ctx.app.db.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    return;
  }
  const { expires_at, ...user } = row; // eslint-disable-line no-unused-vars
  ctx.session = { tokenHash, csrfToken: internalToken(ctx.app.config.secret, sid) };
  ctx.user = user;
}

async function destroySession(ctx) {
  if (ctx.session) await ctx.app.db.run('DELETE FROM sessions WHERE token_hash = ?', [ctx.session.tokenHash]);
  ctx.clearCookie(SESSION_COOKIE);
}

function requireUser(ctx) {
  if (ctx.user) return;
  if (ctx.method === 'GET' || ctx.method === 'HEAD') {
    const next = ctx.path + (ctx.query.toString() ? `?${ctx.query}` : '');
    ctx.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
  } else {
    ctx.redirect('/login', 302);
  }
}

function requireAdmin(ctx) {
  if (!ctx.user) return requireUser(ctx);
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'Admins only');
}

// Only allow redirects back into the internal app: "/app" paths, no "//", no backslash, no control characters.
function safeNext(value) {
  const v = String(value || '');
  // eslint-disable-next-line no-control-regex
  return /^\/app(\/|\?|$)/.test(v) && !v.includes('//') && !v.includes('\\') && !/[\x00-\x1f\x7f]/.test(v) ? v : '/app';
}

module.exports = { newSession, setSessionCookie, loadSession, destroySession, requireUser, requireAdmin, normaliseEmail, safeNext, SESSION_COOKIE };

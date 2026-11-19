'use strict';
// Sessions, sign-in allowlist and route guards.
const { randomHex } = require('./crypto');
const { HttpError } = require('./http');
const { nowIso } = require('./db');

const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 14;

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Decides whether a Google identity may sign in. Returns { user } or { reason }.
function checkAllowed(db, config, { email, email_verified }) {
  const e = normaliseEmail(email);
  if (!e) return { reason: 'no email' };
  if (email_verified !== true && email_verified !== 'true') return { reason: 'email not verified' };
  if (config.allowedEmailDomains.length) {
    const domain = e.split('@')[1] || '';
    if (!config.allowedEmailDomains.includes(domain)) return { reason: 'domain not allowed' };
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(e);
  if (!user) return { reason: 'not an active user' };
  return { user };
}

function createSession(ctx, userId) {
  const { db } = ctx.app;
  const id = randomHex(32);
  const csrf = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  db.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(id, userId, csrf, expires);
  ctx.setCookie(SESSION_COOKIE, id, { maxAge: SESSION_DAYS * 86400, httpOnly: true, secure: true, sameSite: 'Lax' });
  return id;
}

function loadSession(ctx) {
  const sid = ctx.cookies[SESSION_COOKIE];
  if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return;
  const row = ctx.app.db
    .prepare(
      `SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`
    )
    .get(sid);
  if (!row) return;
  if (row.expires_at < nowIso() || !row.active) {
    ctx.app.db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return;
  }
  ctx.session = { id: row.session_id, csrfToken: row.csrf_token };
  const { session_id, csrf_token, expires_at, google_refresh_token_enc, ...user } = row; // eslint-disable-line no-unused-vars
  user.hasGoogleToken = Boolean(google_refresh_token_enc);
  ctx.user = user;
}

function destroySession(ctx) {
  if (ctx.session) ctx.app.db.prepare('DELETE FROM sessions WHERE id = ?').run(ctx.session.id);
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

// Only allow redirects back into the internal app.
function safeNext(value) {
  const v = String(value || '');
  return /^\/app(\/|\?|$)/.test(v) && !v.includes('//') && !v.includes('\\') ? v : '/app';
}

module.exports = { checkAllowed, createSession, loadSession, destroySession, requireUser, requireAdmin, normaliseEmail, safeNext, SESSION_COOKIE };

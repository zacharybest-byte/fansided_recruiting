'use strict';
// Password sign-in, sign-out, first-admin setup, set-password (invite / reset links) and the account page.
const { html } = require('../lib/render');
const { page, setFlash, errorPage } = require('../lib/layout');
const { HttpError, readForm } = require('../lib/http');
const { newSession, setSessionCookie, destroySession, requireUser, safeNext, normaliseEmail } = require('../lib/auth');
const { publicField, verifyPublic, internalForm } = require('../lib/csrf');
const { safeEqual, sha256Hex } = require('../lib/crypto');
const { hashPassword, verifyPassword, validatePassword, dummyHash, MIN_LENGTH, MAX_LENGTH } = require('../lib/password');
const { rateKey, reserve, releaseStatement } = require('../lib/ratelimit');
const { csrfField } = require('../lib/csrf');
const { nowIso } = require('../lib/db');

const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURES_PER_EMAIL = 5;
const LOGIN_FAILURES_PER_IP = 20;
const TOKEN_POSTS_PER_IP = 10;
const BAD_LOGIN = 'Email or password is incorrect.';
const TOO_MANY = 'Too many attempts. Try again later.';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function passwordFields({ label = 'New password', name = 'password', confirm = true } = {}) {
  return html`<label>${label} <span class="muted">(${MIN_LENGTH}-${MAX_LENGTH} characters)</span>
      <input type="password" name="${name}" minlength="${MIN_LENGTH}" maxlength="${MAX_LENGTH}" autocomplete="new-password" required>
    </label>
    ${confirm
      ? html`<label>Repeat the password
          <input type="password" name="${name}_confirm" minlength="${MIN_LENGTH}" maxlength="${MAX_LENGTH}" autocomplete="new-password" required>
        </label>`
      : ''}`;
}

// Shared check for the two "new password" fields of setup, set-password and account.
function checkNewPassword(form, name = 'password') {
  const pw = form.get(name);
  if (pw !== form.get(`${name}_confirm`)) return 'The two passwords do not match.';
  return validatePassword(pw);
}

// ---------- Login ----------

function loginPage(ctx, { error, status = 200, email = '', next } = {}) {
  page(ctx, {
    title: 'Sign in',
    status,
    body: html`<div class="narrow">
      <h1>FanSided Recruit</h1>
      ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
      <form method="post" action="/login" class="stacked">
        ${publicField(ctx)}
        <input type="hidden" name="next" value="${next === undefined ? safeNext(ctx.query.get('next')) : next}">
        <label>Email <input type="email" name="email" maxlength="254" value="${email}" autocomplete="username" required></label>
        <label>Password <input type="password" name="password" maxlength="${MAX_LENGTH}" autocomplete="current-password" required></label>
        <p><button type="submit" class="primary">Sign in</button></p>
      </form>
      <p class="muted">Forgot your password? Ask an admin for a reset link.</p>
    </div>`,
  });
}

async function loginSubmit(ctx) {
  const { db, config } = ctx.app;
  const form = await readForm(ctx.req);
  verifyPublic(ctx, form);
  const email = normaliseEmail(form.get('email')).slice(0, 254);
  const password = form.get('password');
  const next = safeNext(form.get('next'));

  // Rate limit BEFORE any password work. The attempt is reserved atomically in the database (so a burst of
  // parallel requests cannot all slip under the limit) and released again on success: only failures stay recorded.
  // The IP comes first: an IP that is over its limit cannot add new email keys to the table.
  const guard = await reserve(db, [
    { key: rateKey(config.secret, 'login-ip', ctx.ip), limit: LOGIN_FAILURES_PER_IP, windowMs: WINDOW_MS },
    { key: rateKey(config.secret, 'login-email', email), limit: LOGIN_FAILURES_PER_EMAIL, windowMs: WINDOW_MS },
  ]);
  if (!guard.ok) return loginPage(ctx, { error: TOO_MANY, status: 429, email, next });

  const user = email ? await db.get('SELECT id, active, password_hash FROM users WHERE email = ?', [email]) : undefined;
  const usable = Boolean(user && user.active && user.password_hash);
  // Always exactly one scrypt: against the real hash, or against a dummy so timing does not reveal accounts.
  const matches = await verifyPassword(password.length <= MAX_LENGTH ? password : '', usable ? user.password_hash : await dummyHash());
  if (!usable || !matches) return loginPage(ctx, { error: BAD_LOGIN, status: 401, email, next });

  const session = newSession(user.id);
  await db.batch([...session.statements, ...guard.keys.map((key) => releaseStatement(key, guard.at))]);
  setSessionCookie(ctx, session.token);
  ctx.redirect(next);
}

// ---------- Setup (first admin) ----------

async function setupAvailable(ctx, token) {
  const { config, db } = ctx.app;
  if (!config.adminEmail || !config.setupToken || !safeEqual(token, config.setupToken)) return false;
  const row = await db.get("SELECT 1 AS x FROM users WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL LIMIT 1");
  return !row;
}

function setupPage(ctx, token, { error, status = 200 } = {}) {
  page(ctx, {
    title: 'Set up',
    status,
    body: html`<div class="narrow">
      <h1>Set up FanSided Recruit</h1>
      <p>Choose a password for <strong>${ctx.app.config.adminEmail}</strong>. This becomes the first admin account.</p>
      ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
      <form method="post" action="/setup" class="stacked">
        ${publicField(ctx)}
        <input type="hidden" name="token" value="${token}">
        ${passwordFields()}
        <p><button type="submit" class="primary">Create admin account</button></p>
      </form>
    </div>`,
  });
}

// One request budget per IP for the token-bearing POSTs (setup and set-password).
async function tokenPostBudget(ctx) {
  const { db, config } = ctx.app;
  const r = await reserve(db, [{ key: rateKey(config.secret, 'token-post', ctx.ip), limit: TOKEN_POSTS_PER_IP, windowMs: WINDOW_MS }]);
  if (!r.ok) throw new HttpError(429, TOO_MANY);
}

async function setupSubmit(ctx) {
  const { db, config } = ctx.app;
  await tokenPostBudget(ctx);
  const form = await readForm(ctx.req);
  verifyPublic(ctx, form);
  const token = form.get('token');
  if (!(await setupAvailable(ctx, token))) throw new HttpError(404, 'Page not found.');
  const error = checkNewPassword(form);
  if (error) return setupPage(ctx, token, { error, status: 400 });

  const hash = await hashPassword(form.get('password'));
  const now = nowIso();
  // One guarded batch: the upsert only happens while no active admin has a password, so of two concurrent
  // POSTs only one can win. Sessions of the (possibly pre-existing) row are removed only if our hash was written.
  const results = await db.batch([
    {
      sql: `INSERT INTO users (email, name, role, active, password_hash, password_changed_at, created_at)
            SELECT ?, '', 'admin', 1, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL)
            ON CONFLICT(email) DO UPDATE SET role = 'admin', active = 1,
              password_hash = excluded.password_hash, password_changed_at = excluded.password_changed_at`,
      args: [config.adminEmail, hash, now, now],
    },
    {
      sql: 'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ? AND password_hash = ?)',
      args: [config.adminEmail, hash],
    },
  ]);
  if (results[0].changes !== 1) throw new HttpError(404, 'Page not found.');
  setFlash(ctx, 'ok', 'Your password is set. Sign in below.');
  ctx.redirect('/login');
}

// ---------- Set password (invite / reset link) ----------

function invalidLink(ctx) {
  errorPage(ctx, 404, 'This link is no longer valid. Ask an admin for a new one.');
}

// A token row is usable when it exists, is unused, unexpired and its user is active.
async function findToken(db, token) {
  if (!TOKEN_SHAPE.test(token)) return null;
  return db.get(
    `SELECT t.id, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.active = 1`,
    [sha256Hex(token), nowIso()]
  );
}

function setPasswordPage(ctx, token, email, { error, status = 200 } = {}) {
  page(ctx, {
    title: 'Set your password',
    status,
    body: html`<div class="narrow">
      <h1>Set your password</h1>
      <p>Account: <strong>${email}</strong></p>
      ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
      <form method="post" action="/set-password" class="stacked">
        ${publicField(ctx)}
        <input type="hidden" name="token" value="${token}">
        ${passwordFields()}
        <p><button type="submit" class="primary">Save password</button></p>
      </form>
    </div>`,
  });
}

async function setPasswordSubmit(ctx) {
  const { db } = ctx.app;
  await tokenPostBudget(ctx);
  const form = await readForm(ctx.req);
  verifyPublic(ctx, form);
  const token = form.get('token');
  const row = await findToken(db, token);
  if (!row) return invalidLink(ctx);
  const error = checkNewPassword(form);
  if (error) return setPasswordPage(ctx, token, row.email, { error, status: 400 });

  const hash = await hashPassword(form.get('password'));
  const now = nowIso();
  const tokenHash = sha256Hex(token);
  const usable = 'token_hash = ? AND used_at IS NULL AND expires_at > ?';
  // One atomic batch. The user update is the guard (unused + unexpired token, active user); every later
  // statement is keyed on "this user now has our (random-salted, hence unique) hash", so a second or
  // concurrent use of the same link changes nothing. The token is marked used last, while still matching.
  const results = await db.batch([
    {
      sql: `UPDATE users SET password_hash = ?, password_changed_at = ?
             WHERE active = 1 AND id = (SELECT user_id FROM auth_tokens WHERE ${usable})`,
      args: [hash, now, tokenHash, now],
    },
    {
      sql: `DELETE FROM sessions WHERE user_id IN (
              SELECT u.id FROM users u JOIN auth_tokens t ON t.user_id = u.id
               WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.password_hash = ?)`,
      args: [tokenHash, now, hash],
    },
    {
      sql: `UPDATE auth_tokens SET used_at = ?
             WHERE ${usable} AND EXISTS (SELECT 1 FROM users u WHERE u.id = auth_tokens.user_id AND u.password_hash = ?)`,
      args: [now, tokenHash, now, hash],
    },
  ]);
  if (results[0].changes !== 1) return invalidLink(ctx);
  setFlash(ctx, 'ok', 'Your password is set. Sign in below.');
  ctx.redirect('/login');
}

// ---------- Account (change own password) ----------

function accountPage(ctx, { error, status = 200 } = {}) {
  page(ctx, {
    title: 'Account',
    status,
    body: html`<div class="narrow">
      <h1>Account</h1>
      <p>Signed in as <strong>${ctx.user.email}</strong>.</p>
      <h2>Change password</h2>
      ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
      <form method="post" action="/app/account" class="stacked">
        ${csrfField(ctx)}
        <label>Current password <input type="password" name="current_password" maxlength="${MAX_LENGTH}" autocomplete="current-password" required></label>
        ${passwordFields()}
        <p><button type="submit" class="primary">Change password</button></p>
      </form>
    </div>`,
  });
}

async function accountSubmit(ctx) {
  const { db, config } = ctx.app;
  const error = checkNewPassword(ctx.form);
  if (error) return accountPage(ctx, { error, status: 400 });
  const current = ctx.form.get('current_password');

  // Guessing the current password from a stolen session counts against the same per-email limit as login.
  const guard = await reserve(db, [{ key: rateKey(config.secret, 'login-email', ctx.user.email), limit: LOGIN_FAILURES_PER_EMAIL, windowMs: WINDOW_MS }]);
  if (!guard.ok) return accountPage(ctx, { error: TOO_MANY, status: 429 });
  const row = await db.get('SELECT password_hash FROM users WHERE id = ? AND active = 1', [ctx.user.id]);
  const oldHash = row && row.password_hash;
  const matches = await verifyPassword(current.length <= MAX_LENGTH ? current : '', oldHash || (await dummyHash()));
  if (!oldHash || !matches) return accountPage(ctx, { error: 'The current password is not correct.', status: 400 });

  const hash = await hashPassword(ctx.form.get('password'));
  const session = newSession(ctx.user.id, {
    guard: 'AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)',
    guardArgs: [ctx.user.id, hash],
  });
  // One batch: compare-and-swap on the old hash, then (keyed on our new hash) kill every session of the user,
  // drop pending invite/reset links and add a fresh session for this browser.
  const results = await db.batch([
    { sql: 'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ? AND active = 1 AND password_hash = ?', args: [hash, nowIso(), ctx.user.id, oldHash] },
    { sql: 'DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)', args: [ctx.user.id, ctx.user.id, hash] },
    { sql: 'DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND password_hash = ?)', args: [ctx.user.id, ctx.user.id, hash] },
    ...session.statements,
    ...guard.keys.map((key) => releaseStatement(key, guard.at)),
  ]);
  if (results[0].changes !== 1) return accountPage(ctx, { error: 'Your password was changed elsewhere at the same moment. Please try again.', status: 409 });
  setSessionCookie(ctx, session.token);
  setFlash(ctx, 'ok', 'Password changed. Other sessions were signed out.');
  ctx.redirect('/app/account');
}


function register(router) {
  router.get('/login', (ctx) => {
    if (ctx.user) return ctx.redirect(safeNext(ctx.query.get('next')));
    loginPage(ctx);
  });
  router.post('/login', loginSubmit);

  router.get('/setup', async (ctx) => {
    const token = ctx.query.get('token') || '';
    if (!(await setupAvailable(ctx, token))) throw new HttpError(404, 'Page not found.');
    setupPage(ctx, token);
  });
  router.post('/setup', setupSubmit);

  router.get('/set-password', async (ctx) => {
    const token = ctx.query.get('token') || '';
    const row = await findToken(ctx.app.db, token);
    if (!row) return invalidLink(ctx);
    setPasswordPage(ctx, token, row.email);
  });
  router.post('/set-password', setPasswordSubmit);

  router.get('/app/account', requireUser, (ctx) => accountPage(ctx));
  router.post('/app/account', requireUser, internalForm, accountSubmit);

  router.post('/logout', async (ctx) => {
    if (!ctx.user) return ctx.redirect('/login');
    await internalForm(ctx);
    await destroySession(ctx);
    ctx.redirect('/login');
  });
}

module.exports = { register, BAD_LOGIN, TOO_MANY };

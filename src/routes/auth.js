'use strict';
// Password sign-in, sign-out, first-admin setup, set-password (invite / reset links) and the account page.
const { html } = require('../lib/render');
const { page, setFlash, errorPage } = require('../lib/layout');
const { HttpError, readForm } = require('../lib/http');
const { newSession, setSessionCookie, destroySession, requireUser, safeNext, normaliseEmail } = require('../lib/auth');
const { publicField, verifyPublic, internalForm } = require('../lib/csrf');
const { safeEqual, sha256Hex } = require('../lib/crypto');
const { hashPassword, verifyPassword, validatePassword, dummyHash, MIN_LENGTH, MAX_LENGTH } = require('../lib/password');
const { rateKey, reserve, release, releaseStatement, clearGroupStatement } = require('../lib/ratelimit');
const { csrfField } = require('../lib/csrf');
const { nowIso } = require('../lib/db');

const WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LOGIN_FAILURES_PER_PAIR = 5; // one email from one address: strict, so a typo-ing user is slowed down...
const LOGIN_FAILURES_PER_EMAIL = 50; // ...but a stranger cannot lock the real user out: the per-email ceiling is loose
const LOGIN_FAILURES_PER_IP = 20;
const TOKEN_POSTS_PER_IP = 10;
const TOKEN_GUESSES_PER_IP = 30; // GETs of /setup and /set-password with a token that is not valid
const BAD_LOGIN = 'Email or password is incorrect.';
const TOO_MANY = 'Too many attempts. Try again later.';
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function passwordFields({ label = 'New password', name = 'password', confirm = true } = {}) {
  return html`<div class="field">
      <label for="f-${name}">${label}</label>
      <p class="help" id="help-${name}">${MIN_LENGTH} to ${MAX_LENGTH} characters.</p>
      <input type="password" id="f-${name}" name="${name}" aria-describedby="help-${name}" minlength="${MIN_LENGTH}" maxlength="${MAX_LENGTH}" autocomplete="new-password" required>
    </div>
    ${confirm
      ? html`<div class="field">
          <label for="f-${name}-confirm">Repeat the password</label>
          <input type="password" id="f-${name}-confirm" name="${name}_confirm" minlength="${MIN_LENGTH}" maxlength="${MAX_LENGTH}" autocomplete="new-password" required>
        </div>`
      : ''}`;
}

const errorBox = (error) => (error ? html`<p class="flash flash-error" role="alert">${error}</p>` : '');

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
    auth: true,
    body: html`<h1>Sign in</h1>
      ${errorBox(error)}
      <form method="post" action="/login">
        ${publicField(ctx)}
        <input type="hidden" name="next" value="${next === undefined ? safeNext(ctx.query.get('next')) : next}">
        <div class="field">
          <label for="f-email">Email</label>
          <input type="email" id="f-email" name="email" maxlength="254" value="${email}" autocomplete="username" required>
        </div>
        <div class="field">
          <label for="f-password">Password</label>
          <input type="password" id="f-password" name="password" maxlength="${MAX_LENGTH}" autocomplete="current-password" required>
        </div>
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Sign in</button></div>
      </form>
      <p class="muted small">Forgot your password? Ask an admin for a reset link.</p>`,
  });
}

// The three login buckets. `group` ties the email's rows together so an admin reset can clear them.
function loginSpecs(secret, email, ip) {
  const group = rateKey(secret, 'login-group', email);
  return [
    { key: rateKey(secret, 'login-ip', ip), limit: LOGIN_FAILURES_PER_IP, windowMs: WINDOW_MS },
    { key: rateKey(secret, 'login-pair', `${email}|${ip}`), limit: LOGIN_FAILURES_PER_PAIR, windowMs: WINDOW_MS, group },
    { key: rateKey(secret, 'login-email', email), limit: LOGIN_FAILURES_PER_EMAIL, windowMs: HOUR_MS, group },
  ];
}

// Statement that forgets every recorded login failure of an email, guarded by `exists` (SQL + args) so it only
// runs when the same batch changed that account.
function clearLoginFailures(secret, email, exists) {
  const s = clearGroupStatement(rateKey(secret, 'login-group', email));
  return { sql: `${s.sql} AND ${exists.sql}`, args: [...s.args, ...exists.args] };
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
  // All-or-nothing: an attempt that any limit refuses is recorded against no bucket (a locked-out victim's retries
  // cannot burn anything). Failures from one address for one email are limited strictly; the per-email ceiling is
  // loose, so attackers elsewhere cannot lock the real user out.
  const guard = await reserve(db, loginSpecs(config.secret, email, ctx.ip));
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
  // The refusal reason goes to the log (never to the page) so a failed first setup can be diagnosed.
  // It contains lengths only, never the token or the email.
  const given = String(token || '');
  let reason = '';
  if (!config.adminEmail) reason = 'ADMIN_EMAIL is missing or not a valid address';
  else if (!config.setupToken) reason = 'SETUP_TOKEN is missing, shorter than 32 characters or has fewer than 10 distinct characters';
  else if (!given) reason = 'the link has no token (expected /setup?token=...)';
  else if (!safeEqual(given, config.setupToken)) reason = `the token in the link (${given.length} characters) does not match SETUP_TOKEN (${config.setupToken.length} characters)`;
  if (reason) {
    ctx.app.log(`[setup] refused: ${reason}`);
    return false;
  }
  const row = await db.get("SELECT 1 AS x FROM users WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL LIMIT 1");
  if (row) ctx.app.log('[setup] refused: an admin with a password already exists (sign in at /login)');
  return !row;
}

function setupPage(ctx, token, { error, status = 200 } = {}) {
  page(ctx, {
    title: 'Set up',
    status,
    auth: true,
    body: html`<h1>Set up FanSided Recruit</h1>
      <p>Choose a password for <strong>${ctx.app.config.adminEmail}</strong>. This becomes the first admin account.</p>
      ${errorBox(error)}
      <form method="post" action="/setup">
        ${publicField(ctx)}
        <input type="hidden" name="token" value="${token}">
        ${passwordFields()}
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Create admin account</button></div>
      </form>`,
  });
}

// One request budget per IP for the token-bearing POSTs (setup and set-password).
// Throttle for GETs that check a token: the budget is reserved BEFORE the token is looked at (so an address over
// its limit learns nothing), and given back when the token turned out to be valid. Returns the validity.
async function guessGuard(ctx, check) {
  const { db, config } = ctx.app;
  const g = await reserve(db, [{ key: rateKey(config.secret, 'token-get', ctx.ip), limit: TOKEN_GUESSES_PER_IP, windowMs: WINDOW_MS }]);
  if (!g.ok) throw new HttpError(429, TOO_MANY);
  const result = await check();
  if (result) await release(db, g);
  return result;
}

async function tokenPostBudget(ctx) {
  const { db, config } = ctx.app;
  const r = await reserve(db, [{ key: rateKey(config.secret, 'token-post', ctx.ip), limit: TOKEN_POSTS_PER_IP, windowMs: WINDOW_MS }]);
  if (!r.ok) throw new HttpError(429, TOO_MANY);
}

async function setupSubmit(ctx) {
  const { db, config } = ctx.app;
  const form = await readForm(ctx.req);
  verifyPublic(ctx, form);
  await tokenPostBudget(ctx); // only a request that passed the CSRF check uses up the budget
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
    clearLoginFailures(config.secret, config.adminEmail, {
      sql: 'EXISTS (SELECT 1 FROM users WHERE email = ? AND password_hash = ?)',
      args: [config.adminEmail, hash],
    }),
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
    auth: true,
    body: html`<h1>Set your password</h1>
      <p>Account: <strong>${email}</strong></p>
      ${errorBox(error)}
      <form method="post" action="/set-password">
        ${publicField(ctx)}
        <input type="hidden" name="token" value="${token}">
        ${passwordFields()}
        <div class="form-actions"><button type="submit" class="btn btn-primary btn-block">Save password</button></div>
      </form>`,
  });
}

async function setPasswordSubmit(ctx) {
  const { db, config } = ctx.app;
  const form = await readForm(ctx.req);
  verifyPublic(ctx, form);
  await tokenPostBudget(ctx); // only a request that passed the CSRF check uses up the budget
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
    // A successful password reset also forgets the account's recorded login failures (the lock).
    clearLoginFailures(config.secret, normaliseEmail(row.email), {
      sql: 'EXISTS (SELECT 1 FROM users u WHERE u.email = ? AND u.password_hash = ?)',
      args: [row.email, hash],
    }),
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
    body: html`<div class="page-header">
        <div>
          <h1>Account</h1>
          <dl class="meta-list">
            <div><dt>Signed in as</dt><dd>${ctx.user.email}</dd></div>
            <div><dt>Role</dt><dd>${ctx.user.role === 'admin' ? 'Admin' : 'Rep'}</dd></div>
          </dl>
        </div>
      </div>
      <section class="card wrap-narrow" aria-labelledby="change-password">
        <h2 id="change-password">Change password</h2>
        <p class="muted">Changing your password signs you out of other devices.</p>
        ${errorBox(error)}
        <form method="post" action="/app/account">
          ${csrfField(ctx)}
          <div class="field">
            <label for="f-current_password">Current password</label>
            <input type="password" id="f-current_password" name="current_password" maxlength="${MAX_LENGTH}" autocomplete="current-password" required>
          </div>
          ${passwordFields()}
          <div class="form-actions"><button type="submit" class="btn btn-primary">Change password</button></div>
        </form>
      </section>`,
  });
}

async function accountSubmit(ctx) {
  const { db, config } = ctx.app;
  const error = checkNewPassword(ctx.form);
  if (error) return accountPage(ctx, { error, status: 400 });
  const current = ctx.form.get('current_password');

  // Guessing the current password from a stolen session counts against the same email limits as login.
  const guard = await reserve(db, loginSpecs(config.secret, ctx.user.email, ctx.ip).slice(1));
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
    if (!(await guessGuard(ctx, () => setupAvailable(ctx, token)))) throw new HttpError(404, 'Page not found.');
    setupPage(ctx, token);
  });
  router.post('/setup', setupSubmit);

  router.get('/set-password', async (ctx) => {
    const token = ctx.query.get('token') || '';
    const row = await guessGuard(ctx, () => findToken(ctx.app.db, token));
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

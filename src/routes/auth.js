'use strict';
// Sign-in (Google OIDC, or DEV_LOGIN in development) and sign-out.
const { html } = require('../lib/render');
const { page, setFlash } = require('../lib/layout');
const { readForm } = require('../lib/http');
const { checkAllowed, createSession, destroySession, safeNext } = require('../lib/auth');
const { publicField, verifyPublic, internalForm } = require('../lib/csrf');
const { randomHex, safeEqual, encrypt, decrypt } = require('../lib/crypto');
const { SCOPES } = require('../lib/google');

const STATE_COOKIE = 'oauth_state';
const NOT_AUTHORISED = "Your account isn't authorised. Ask an admin.";

function loginPage(ctx, { error, status = 200 } = {}) {
  const { config, google, db } = ctx.app;
  const next = safeNext(ctx.query.get('next'));
  const devUsers = config.devLogin ? db.prepare('SELECT email, name, role FROM users WHERE active = 1 ORDER BY role, email').all() : [];
  page(ctx, {
    title: 'Sign in',
    status,
    body: html`<div class="narrow">
      <h1>FanSided Recruit</h1>
      ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
      ${google.configured
        ? html`<form method="get" action="/auth/google">
            <input type="hidden" name="next" value="${next}">
            <button type="submit" class="primary">Sign in with Google</button>
          </form>`
        : html`<p class="muted">Google sign-in is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).</p>`}
      ${config.devLogin
        ? html`<hr><h2>Development sign-in</h2>
          <p class="muted">DEV_LOGIN=1 is on. Never enable this in production.</p>
          <form method="post" action="/auth/dev" class="stacked">
            ${publicField(ctx)}
            <input type="hidden" name="next" value="${next}">
            <label>Email
              <input type="email" name="email" list="dev-users" required>
              <datalist id="dev-users">${devUsers.map((u) => html`<option value="${u.email}">${u.name} (${u.role})</option>`)}</datalist>
            </label>
            <p><button type="submit">Sign in (dev)</button></p>
          </form>`
        : ''}
    </div>`,
  });
}

function startGoogle(ctx, { forceConsent = false, next } = {}) {
  const state = randomHex(24);
  const value = JSON.stringify({ s: state, n: safeNext(next ?? ctx.query.get('next')), c: forceConsent ? 1 : 0 });
  ctx.setCookie(STATE_COOKIE, value, { path: '/auth', maxAge: 600, httpOnly: true, secure: true, sameSite: 'Lax' });
  ctx.redirect(ctx.app.google.authorizationUrl({ state, forceConsent }), 302);
}

async function googleCallback(ctx) {
  const { db, config, google, log } = ctx.app;
  let saved = null;
  try {
    saved = JSON.parse(ctx.cookies[STATE_COOKIE] || 'null');
  } catch {
    saved = null;
  }
  ctx.clearCookie(STATE_COOKIE, { path: '/auth' });
  if (ctx.query.get('error')) return loginPage(ctx, { error: `Google sign-in was cancelled (${ctx.query.get('error')}).`, status: 400 });
  if (!saved || !safeEqual(saved.s, ctx.query.get('state'))) {
    return loginPage(ctx, { error: 'Your sign-in attempt expired. Please try again.', status: 400 });
  }
  const code = ctx.query.get('code');
  if (!code) return loginPage(ctx, { error: 'Google did not return an authorisation code.', status: 400 });

  let tokens;
  let info;
  try {
    tokens = await google.exchangeCode(code);
    info = await google.userinfo(tokens.access_token);
  } catch (err) {
    log(`[auth] Google sign-in failed: ${err.message}`);
    return loginPage(ctx, { error: 'Google sign-in failed. Please try again.', status: 502 });
  }

  const { user, reason } = checkAllowed(db, config, info);
  if (!user) {
    log(`[auth] refused sign-in for ${info.email}: ${reason}`);
    return loginPage(ctx, { error: NOT_AUTHORISED, status: 403 });
  }

  if (tokens.refresh_token) {
    db.prepare('UPDATE users SET google_refresh_token_enc = ? WHERE id = ?').run(encrypt(tokens.refresh_token, config.tokenKey), user.id);
  } else {
    let usable = false;
    if (user.google_refresh_token_enc) {
      try {
        decrypt(user.google_refresh_token_enc, config.tokenKey);
        usable = true;
      } catch {
        usable = false;
      }
    }
    // No refresh token on file: go round once more with prompt=consent to get one.
    if (!usable && !saved.c) return startGoogle(ctx, { forceConsent: true, next: saved.n });
  }

  if (!user.name && info.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(info.name).slice(0, 200), user.id);

  createSession(ctx, user.id);
  const granted = String(tokens.scope || '').split(/\s+/);
  if (tokens.scope && !granted.includes(SCOPES[3])) {
    setFlash(ctx, 'error', 'Gmail permission was not granted, so you cannot send email. Sign out and in again and allow "Send email on your behalf".');
  }
  ctx.redirect(safeNext(saved.n));
}

async function devLogin(ctx) {
  const { db, config } = ctx.app;
  if (!config.devLogin || config.production) return ctx.send(404, 'Not found');
  const form = await readForm(ctx.req, 64 * 1024);
  verifyPublic(ctx, form);
  const { user } = checkAllowed(db, config, { email: form.get('email'), email_verified: true });
  if (!user) return loginPage(ctx, { error: NOT_AUTHORISED, status: 403 });
  createSession(ctx, user.id);
  ctx.redirect(safeNext(form.get('next')));
}

function register(router) {
  router.get('/login', (ctx) => {
    if (ctx.user) return ctx.redirect(safeNext(ctx.query.get('next')));
    loginPage(ctx);
  });
  router.get('/auth/google', (ctx) => {
    if (!ctx.app.google.configured) return loginPage(ctx, { error: 'Google sign-in is not configured.', status: 503 });
    startGoogle(ctx);
  });
  router.get('/auth/google/callback', googleCallback);
  router.post('/auth/dev', devLogin);
  router.post('/logout', async (ctx) => {
    if (!ctx.user) return ctx.redirect('/login');
    await internalForm(ctx);
    destroySession(ctx);
    ctx.redirect('/login');
  });
}

module.exports = { register, NOT_AUTHORISED };

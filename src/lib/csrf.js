'use strict';
// CSRF protection with no server-side state.
// - Internal forms: hidden field = HMAC-SHA256(SESSION_SECRET, "csrf:" + session token), compared in constant time.
// - Pre-session forms (apply, login, setup, set-password): double-submit cookie "pcsrf" = nonce.HMAC(nonce).
//   The field must equal the cookie AND the HMAC must verify, so a cookie planted by an attacker is useless.
const { randomHex, hmacHex, safeEqual } = require('./crypto');
const { HttpError, readForm } = require('./http');
const { html } = require('./render');

const PUBLIC_COOKIE = 'pcsrf';

function internalToken(secret, sessionToken) {
  return hmacHex(secret, `csrf:${sessionToken}`);
}

function csrfField(ctx) {
  return html`<input type="hidden" name="csrf" value="${ctx.session ? ctx.session.csrfToken : ''}">`;
}

// Middleware for internal POST routes: parses the form, then checks the token.
async function internalForm(ctx) {
  ctx.form = await readForm(ctx.req);
  if (!ctx.session || !safeEqual(ctx.form.get('csrf'), ctx.session.csrfToken)) {
    throw new HttpError(403, 'Invalid or missing CSRF token');
  }
}

function validPublicToken(secret, value) {
  const m = /^([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(String(value || ''));
  return Boolean(m) && safeEqual(m[2], hmacHex(secret, `pcsrf:${m[1]}`));
}

function publicToken(ctx) {
  const { secret } = ctx.app.config;
  let token = ctx.cookies[PUBLIC_COOKIE];
  if (!validPublicToken(secret, token)) {
    const nonce = randomHex(16);
    token = `${nonce}.${hmacHex(secret, `pcsrf:${nonce}`)}`;
    ctx.cookies[PUBLIC_COOKIE] = token;
    ctx.setCookie(PUBLIC_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7 * 86400 });
  }
  return token;
}

function publicField(ctx) {
  return html`<input type="hidden" name="csrf" value="${publicToken(ctx)}">`;
}

function verifyPublic(ctx, form) {
  const cookie = ctx.cookies[PUBLIC_COOKIE];
  if (!safeEqual(form.get('csrf'), cookie) || !validPublicToken(ctx.app.config.secret, cookie)) {
    throw new HttpError(403, 'This form expired. Please go back, reload the page and try again.');
  }
}

module.exports = { csrfField, internalForm, internalToken, publicField, publicToken, verifyPublic, PUBLIC_COOKIE };

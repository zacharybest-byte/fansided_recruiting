'use strict';
// CSRF protection.
// - Internal forms: the session's csrf_token must be echoed in a hidden "csrf" field.
// - Public forms (apply, dev login): double-submit cookie; the "pcsrf" cookie must match the field.
const { randomHex, safeEqual } = require('./crypto');
const { HttpError, readForm } = require('./http');
const { html } = require('./render');

const PUBLIC_COOKIE = 'pcsrf';
const INTERNAL_BODY_LIMIT = 1024 * 1024;

function csrfField(ctx) {
  return html`<input type="hidden" name="csrf" value="${ctx.session ? ctx.session.csrfToken : ''}">`;
}

// Middleware for internal POST routes: parses the form, then checks the token.
async function internalForm(ctx) {
  ctx.form = await readForm(ctx.req, INTERNAL_BODY_LIMIT);
  if (!ctx.session || !safeEqual(ctx.form.get('csrf'), ctx.session.csrfToken)) {
    throw new HttpError(403, 'Invalid or missing CSRF token');
  }
}

function publicToken(ctx) {
  let token = ctx.cookies[PUBLIC_COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    token = randomHex(32);
    ctx.cookies[PUBLIC_COOKIE] = token;
    ctx.setCookie(PUBLIC_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7 * 86400 });
  }
  return token;
}

function publicField(ctx) {
  return html`<input type="hidden" name="csrf" value="${publicToken(ctx)}">`;
}

function verifyPublic(ctx, form) {
  if (!safeEqual(form.get('csrf'), ctx.cookies[PUBLIC_COOKIE])) {
    throw new HttpError(403, 'This form expired. Please go back, reload the page and try again.');
  }
}

module.exports = { csrfField, internalForm, publicField, publicToken, verifyPublic, PUBLIC_COOKIE };

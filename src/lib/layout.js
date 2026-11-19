'use strict';
// Page shell, flash messages and small shared view helpers.
const { html } = require('./render');
const { formatDateTime, formatDate } = require('./time');

const STAGES = ['new', 'reviewing', 'trial', 'onboarded', 'passed'];
const STAGE_LABELS = { new: 'New', reviewing: 'Reviewing', trial: 'Trial', onboarded: 'Onboarded', passed: 'Passed' };
const HEARD_FROM = ['LinkedIn', 'Indeed', 'X/Twitter', 'FanSided site', 'Referral', 'Other'];

function setFlash(ctx, type, message) {
  ctx.setCookie('flash', JSON.stringify({ type, message }), { maxAge: 60, httpOnly: true, secure: true });
}

function takeFlash(ctx) {
  const raw = ctx.cookies.flash;
  if (!raw) return null;
  ctx.clearCookie('flash');
  try {
    const f = JSON.parse(raw);
    return { type: f.type === 'error' ? 'error' : 'ok', message: String(f.message || '') };
  } catch {
    return null;
  }
}

function page(ctx, { title, body, status = 200 }) {
  const user = ctx.user;
  const flash = takeFlash(ctx);
  const internal = Boolean(user) && ctx.path.startsWith('/app');
  const nav = internal
    ? html`<nav class="topnav">
        <a href="/app" class="brand">FanSided Recruit</a>
        <a href="/app">Dashboard</a>
        <a href="/app/export">Export</a>
        ${user.role === 'admin'
          ? html`<a href="/app/admin/roles">Roles</a><a href="/app/admin/templates">Templates</a><a href="/app/admin/users">Users</a>`
          : ''}
        <span class="spacer"></span>
        <span class="muted">${user.name || user.email}${user.role === 'admin' ? ' (admin)' : ''}</span>
        <form method="post" action="/logout" class="inline">
          <input type="hidden" name="csrf" value="${ctx.session.csrfToken}">
          <button type="submit" class="link">Sign out</button>
        </form>
      </nav>`
    : html`<nav class="topnav"><a href="/" class="brand">FanSided</a><span class="spacer"></span></nav>`;

  ctx.html(
    html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ` : ''}FanSided${internal ? ' Recruit' : ''}</title>
<link rel="stylesheet" href="/public/style.css">
<script src="/public/app.js" defer></script>
</head>
<body>
${nav}
<main>
${flash ? html`<p class="flash flash-${flash.type}" role="status">${flash.message}</p>` : ''}
${body}
</main>
</body>
</html>`,
    status
  );
}

function errorPage(ctx, status, message) {
  const titles = { 400: 'Bad request', 403: 'Forbidden', 404: 'Not found', 405: 'Method not allowed', 413: 'Too large', 415: 'Unsupported', 429: 'Too many requests', 500: 'Something went wrong' };
  page(ctx, {
    title: titles[status] || 'Error',
    status,
    body: html`<h1>${titles[status] || 'Error'}</h1><p>${message}</p><p><a href="${ctx.user ? '/app' : '/'}">Go back</a></p>`,
  });
}

const fmtDateTime = (ctx, iso) => formatDateTime(iso, ctx.app.config.timezone);
const fmtDate = (ctx, iso) => formatDate(iso, ctx.app.config.timezone);

module.exports = { page, errorPage, setFlash, STAGES, STAGE_LABELS, HEARD_FROM, fmtDateTime, fmtDate };

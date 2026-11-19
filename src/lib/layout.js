'use strict';
// Page shell, flash messages and small shared view helpers.
const { html } = require('./render');
const { hmacHex, safeEqual } = require('./crypto');
const { formatDateTime, formatDateFriendly } = require('./time');

const STAGES = ['new', 'reviewing', 'trial', 'onboarded', 'passed'];
const STAGE_LABELS = { new: 'New', reviewing: 'Reviewing', trial: 'Trial', onboarded: 'Onboarded', passed: 'Passed' };
const HEARD_FROM = ['LinkedIn', 'Indeed', 'X/Twitter', 'FanSided site', 'Referral', 'Other'];

// The flash cookie is signed (base64url(JSON).HMAC-SHA256 under SESSION_SECRET): anything unsigned or altered is ignored,
// so a cookie set from a sibling subdomain or by script cannot put text on a page.
function flashMac(ctx, payload) {
  return hmacHex(ctx.app.config.secret, `flash:${payload}`);
}

function setFlash(ctx, type, message) {
  const payload = Buffer.from(JSON.stringify({ type, message }), 'utf8').toString('base64url');
  ctx.setCookie('flash', `${payload}.${flashMac(ctx, payload)}`, { maxAge: 60, httpOnly: true, secure: true });
}

function takeFlash(ctx) {
  const raw = ctx.cookies.flash;
  if (!raw) return null;
  ctx.clearCookie('flash');
  const m = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(raw);
  if (!m || !safeEqual(m[2], flashMac(ctx, m[1]))) return null;
  try {
    const f = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return { type: f.type === 'error' ? 'error' : 'ok', message: String(f.message || '') };
  } catch {
    return null;
  }
}

// Which primary nav item a path belongs to (marked with aria-current and the accent bar).
function navActive(path) {
  if (path === '/app' || path.startsWith('/app/roles')) return '/app';
  if (path.startsWith('/app/candidates') || path.startsWith('/app/applications')) return '/app/candidates';
  if (path.startsWith('/app/export')) return '/app/export';
  if (path.startsWith('/app/admin/roles')) return '/app/admin/roles';
  if (path.startsWith('/app/admin/templates')) return '/app/admin/templates';
  if (path.startsWith('/app/admin/users')) return '/app/admin/users';
  if (path.startsWith('/app/admin/sample')) return '/app/admin/sample';
  return '';
}

function navLink(active, href, label) {
  return html`<a href="${href}"${active === href ? html` aria-current="page"` : ''}>${label}</a>`;
}

const wordmark = (href, tag, extra = '') => html`<a href="${href}" class="wordmark${extra}">FanSided${tag ? html`<span class="wordmark-tag">${tag}</span>` : ''}</a>`;

function internalMasthead(ctx, user) {
  const active = navActive(ctx.path);
  return html`<header class="masthead masthead-app">
  <div class="masthead-inner">
    ${wordmark('/app', 'Recruit')}
    <nav class="nav" aria-label="Main">
      ${navLink(active, '/app', 'Dashboard')}
      ${navLink(active, '/app/candidates', 'Candidates')}
      ${navLink(active, '/app/export', 'Export')}
      ${user.role === 'admin'
        ? html`<div class="nav-group" role="group" aria-label="Manage">
            <span class="nav-label">Manage</span>
            ${navLink(active, '/app/admin/roles', 'Roles')}
            ${navLink(active, '/app/admin/templates', 'Templates')}
            ${navLink(active, '/app/admin/users', 'Users')}
            ${navLink(active, '/app/admin/sample', 'Sample data')}
          </div>`
        : ''}
    </nav>
    <div class="masthead-user">
      <a href="/app/account" class="user-name"${active === '' && ctx.path.startsWith('/app/account') ? html` aria-current="page"` : ''}>${user.name || user.email}</a>
      <form method="post" action="/logout">
        <input type="hidden" name="csrf" value="${ctx.session.csrfToken}">
        <button type="submit" class="link">Sign out</button>
      </form>
    </div>
  </div>
</header>`;
}

const publicMasthead = html`<header class="masthead masthead-public">
  <div class="masthead-inner">
    ${wordmark('/')}
    <a href="/" class="masthead-context">Write for FanSided</a>
  </div>
</header>`;

// options: title, body, status, auth (true: centred card on the field background, no masthead, used by sign-in pages)
function page(ctx, { title, body, status = 200, auth = false }) {
  const user = ctx.user;
  const flash = takeFlash(ctx);
  const internal = Boolean(user) && ctx.path.startsWith('/app');
  const flashHtml = flash ? html`<p class="flash flash-${flash.type}" role="${flash.type === 'error' ? 'alert' : 'status'}">${flash.message}</p>` : '';
  const variant = auth ? 'is-auth' : internal ? 'is-internal' : 'is-public';
  const year = new Date().getFullYear();

  const main = auth
    ? html`<main id="main" class="auth-main"><div class="auth-wrap">${wordmark('/', 'Recruit', ' auth-wordmark')}<div class="auth-card">${flashHtml}${body}</div></div></main>`
    : html`<main id="main">${flashHtml}${body}</main>`;
  const footer = internal
    ? ''
    : html`<footer class="footer"><div class="footer-inner"><span>FanSided Recruit, ${year}</span>${auth ? '' : html`<a href="/">See open roles</a>`}</div></footer>`;

  ctx.html(
    html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} | ` : ''}FanSided${internal ? ' Recruit' : ''}</title>
<link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
<link rel="stylesheet" href="/public/style.css">
<script src="/public/app.js" defer></script>
</head>
<body class="${variant}">
<a class="skip-link" href="#main">Skip to content</a>
${auth ? '' : internal ? internalMasthead(ctx, user) : publicMasthead}
${main}
${footer}
</body>
</html>`,
    status
  );
}

function errorPage(ctx, status, message) {
  const titles = { 400: 'Bad request', 403: 'Forbidden', 404: 'Page not found', 405: 'Method not allowed', 413: 'Too large', 415: 'Unsupported', 429: 'Too many requests', 500: 'Something went wrong' };
  const internal = Boolean(ctx.user) && ctx.path.startsWith('/app');
  page(ctx, {
    title: titles[status] || 'Error',
    status,
    body: html`<div class="wrap-read">
      <p class="muted">Error ${status}</p>
      <h1 class="display">${titles[status] || 'Error'}</h1>
      ${String(message).replace(/\.$/, '').toLowerCase() === (titles[status] || '').toLowerCase() ? '' : html`<p class="lede">${message}</p>`}
      <p><a class="btn btn-primary" href="${internal ? '/app' : '/'}">${internal ? 'Back to the dashboard' : 'See open roles'}</a></p>
    </div>`,
  });
}

const fmtDateTime = (ctx, iso) => formatDateTime(iso, ctx.app.config.timezone);
const fmtDate = (ctx, iso) => formatDateFriendly(iso, ctx.app.config.timezone);

// Source tags are free text from ?source=; the common ones read as labels, anything else is shown as typed.
const SOURCE_LABELS = { linkedin: 'LinkedIn', indeed: 'Indeed', x: 'X', twitter: 'X', 'x/twitter': 'X', referral: 'Referral', site: 'FanSided site', 'fansided site': 'FanSided site', other: 'Other' };
const sourceLabel = (tag) => {
  const t = String(tag || '').trim();
  return SOURCE_LABELS[t.toLowerCase()] || t;
};

module.exports = { page, errorPage, setFlash, STAGES, STAGE_LABELS, HEARD_FROM, fmtDateTime, fmtDate, sourceLabel };

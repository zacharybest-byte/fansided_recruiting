'use strict';
// Page shell, flash messages and small shared view helpers.
const { html } = require('./render');
const { hmacHex, safeEqual } = require('./crypto');
const { formatDateFriendly, formatDateTimeFriendly } = require('./time');

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

// "● Name" badge for a stage ({ name, kind }). The colour comes from the kind; the name is always printed.
function stageBadge(stage) {
  return html`<span class="stage-badge stage-${stage.kind}">${stage.name}</span>`;
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

const NAV_LABELS = {
  '/app': 'Dashboard',
  '/app/candidates': 'Candidates',
  '/app/export': 'Export',
  '/app/admin/roles': 'Roles',
  '/app/admin/templates': 'Templates',
  '/app/admin/users': 'Users',
  '/app/admin/sample': 'Sample data',
};

// The official wordmark (public/logo.png, 368x96 = the source file's 6906x1800 ratio). Only scaled proportionally by CSS
// (height set, width auto); the width/height attributes carry the intrinsic ratio so the layout does not jump.
const logoImg = html`<img class="logo" src="/public/logo.png" width="368" height="96" alt="FanSided">`;
const wordmark = (href, tag, extra = '') => html`<a href="${href}" class="wordmark${extra}">${logoImg}${tag ? html`<span class="wordmark-tag">${tag}</span>` : ''}</a>`;

// The links, in one place, for both the desktop bar and the small-screen menu.
function navLinks(active, isAdmin) {
  return html`${navLink(active, '/app', 'Dashboard')}
      ${navLink(active, '/app/candidates', 'Candidates')}
      ${navLink(active, '/app/export', 'Export')}
      ${isAdmin
        ? html`<div class="nav-group" role="group" aria-label="Manage">
            <span class="nav-label">Manage</span>
            ${navLink(active, '/app/admin/roles', 'Roles')}
            ${navLink(active, '/app/admin/templates', 'Templates')}
            ${navLink(active, '/app/admin/users', 'Users')}
            ${navLink(active, '/app/admin/sample', 'Sample data')}
          </div>`
        : ''}`;
}

function internalMasthead(ctx, user) {
  const active = navActive(ctx.path);
  const isAdmin = user.role === 'admin';
  const onAccount = active === '' && ctx.path.startsWith('/app/account');
  const current = NAV_LABELS[active] || (onAccount ? 'Account' : '');
  // Two renderings of the same links, no JavaScript: the bar (wide screens) and a <details> menu (small screens).
  // CSS shows exactly one of them, so a screen reader only ever meets one "Main" navigation.
  return html`<header class="masthead masthead-app">
  <div class="masthead-inner">
    ${wordmark('/app', 'Recruit')}
    <nav class="nav nav-bar" aria-label="Main">
      ${navLinks(active, isAdmin)}
    </nav>
    <details class="nav-menu">
      <summary><span class="nav-menu-label">Menu</span>${current ? html`<span class="nav-menu-current">${current}</span>` : ''}</summary>
      <nav class="nav-menu-list" aria-label="Main menu">
        ${navLinks(active, isAdmin)}
      </nav>
    </details>
    <div class="masthead-user">
      <a href="/app/account" class="user-name"${onAccount ? html` aria-current="page"` : ''}>${user.name || user.email}</a>
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
    ? html`<main id="main" class="auth-main" tabindex="-1"><div class="auth-wrap">${wordmark('/', '', ' auth-wordmark')}<div class="auth-card">${flashHtml}${body}</div></div></main>`
    : html`<main id="main" tabindex="-1">${flashHtml}${body}</main>`;
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

const fmtDateTime = (ctx, iso) => formatDateTimeFriendly(iso, ctx.app.config.timezone);
const fmtDate = (ctx, iso) => formatDateFriendly(iso, ctx.app.config.timezone);

// Source tags are free text from ?source=; the common ones read as labels, and a tag that starts with one
// ("linkedin-nfl") keeps what was typed in brackets. Anything else is shown as typed.
const SOURCE_LABELS = { linkedin: 'LinkedIn', indeed: 'Indeed', x: 'X', twitter: 'X', 'x/twitter': 'X', referral: 'Referral', site: 'FanSided site', 'fansided site': 'FanSided site', other: 'Other' };
const SOURCE_PREFIXES = /^(linkedin|indeed|twitter|x|referral|site)[-_:.]/i;
const sourceLabel = (tag) => {
  const t = String(tag || '').trim();
  const exact = SOURCE_LABELS[t.toLowerCase()];
  if (exact) return exact;
  const m = SOURCE_PREFIXES.exec(t);
  return m ? `${SOURCE_LABELS[m[1].toLowerCase()]} (${t})` : t;
};

// "There is a problem" summary shared by every form. `items` are { id, text } where id is the field's element id.
// It gets focus on load (public/app.js); without JavaScript the page it sits at the top of is where the browser lands.
function errorSummary(items, { intro = '' } = {}) {
  if (!items.length && !intro) return '';
  return html`<div class="error-summary" id="error-summary" tabindex="-1" role="alert">
    <h2>There is a problem</h2>
    ${intro ? html`<p>${intro}</p>` : ''}
    ${items.length ? html`<ul>${items.map((i) => html`<li><a href="#${i.id}">${i.text}</a></li>`)}</ul>` : ''}
  </div>`;
}

module.exports = { page, errorPage, setFlash, stageBadge, HEARD_FROM, fmtDateTime, fmtDate, sourceLabel, errorSummary };

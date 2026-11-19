'use strict';
// Internal: dashboard, role pipeline, reassign rep, CSV export.
const { html, raw } = require('../lib/render');
const { page, setFlash, STAGES, STAGE_LABELS, fmtDate, sourceLabel } = require('../lib/layout');
const { requireUser } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso } = require('../lib/db');
const { toCsv } = require('../lib/csv');
const { formatDateTime, zonedMidnightUtc, isValidYmd, todayIn, daysSince } = require('../lib/time');

function idParam(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new HttpError(404, 'Not found');
  return Number(value);
}

function stageSelect(current, name = 'stage') {
  return html`<select name="${name}" aria-label="Stage">
    ${STAGES.map((s) => html`<option value="${s}"${s === current ? raw(' selected') : ''}>${STAGE_LABELS[s]}</option>`)}
  </select>`;
}

async function dashboard(ctx) {
  const { db } = ctx.app;
  const showAll = ctx.query.get('view') === 'all';
  const roles = await db.all(
    `SELECT r.*, u.name AS rep_name, u.email AS rep_email
       FROM job_roles r LEFT JOIN users u ON u.id = r.assigned_user_id
      ${showAll ? '' : 'WHERE r.assigned_user_id = ?'}
      ORDER BY r.status = 'closed', r.title COLLATE NOCASE`,
    showAll ? [] : [ctx.user.id]
  );
  const counts = new Map();
  for (const row of await db.all('SELECT role_id, stage, COUNT(*) AS n FROM applications GROUP BY role_id, stage')) {
    if (!counts.has(row.role_id)) counts.set(row.role_id, {});
    counts.get(row.role_id)[row.stage] = row.n;
  }
  // "+N since your last visit": applications that arrived after the stored stamp users.dashboard_seen_at, which only
  // the explicit "Mark as seen" POST moves (a GET never writes). Until a user has marked something as seen there is
  // no stamp, so nothing is shown.
  const since = new Map();
  if (ctx.user.dashboard_seen_at) {
    for (const row of await db.all('SELECT role_id, COUNT(*) AS n FROM applications WHERE applied_at > ? GROUP BY role_id', [ctx.user.dashboard_seen_at])) {
      since.set(row.role_id, row.n);
    }
  }
  // Summary strip: totals over the roles on this page (so "My roles" shows my own numbers).
  const total = (stage) => roles.reduce((n, r) => n + ((counts.get(r.id) || {})[stage] || 0), 0);
  const monthStart = zonedMidnightUtc(`${todayIn(ctx.app.config.timezone).slice(0, 7)}-01`, ctx.app.config.timezone).toISOString();
  const onboardedByRole = new Map();
  for (const row of await db.all("SELECT role_id, COUNT(*) AS n FROM applications WHERE stage = 'onboarded' AND onboarded_at >= ? GROUP BY role_id", [monthStart])) {
    onboardedByRole.set(row.role_id, row.n);
  }
  const onboardedThisMonth = roles.reduce((n, r) => n + (onboardedByRole.get(r.id) || 0), 0);
  const openRoles = roles.filter((r) => r.status === 'open').length;
  const summary = [
    ['Open roles', openRoles, false],
    ['New applications', total('new'), total('new') > 0],
    ['In Trial', total('trial'), false],
    ['Onboarded this month', onboardedThisMonth, false],
  ];
  page(ctx, {
    title: 'Dashboard',
    body: html`<div class="page-header">
        <div><h1>Dashboard</h1></div>
        <div class="page-actions">
          <form method="post" action="/app/seen" class="inline">${csrfField(ctx)}${showAll ? html`<input type="hidden" name="view" value="all">` : ''}<button type="submit" class="btn btn-secondary">Mark as seen</button></form>
        </div>
      </div>
      <div class="summary-strip">
        ${summary.map(([label, n, hot]) => html`<div class="summary-item${hot ? ' is-hot' : ''}"><span class="summary-n">${n}</span><span class="summary-l">${label}</span></div>`)}
      </div>
      <nav aria-label="Which roles"><ul class="filter">
        <li><a class="chip" href="/app"${showAll ? '' : html` aria-current="true"`}>My roles</a></li>
        <li><a class="chip" href="/app?view=all"${showAll ? html` aria-current="true"` : ''}>All roles</a></li>
      </ul></nav>
      ${roles.length === 0
        ? html`<div class="empty">
            <h2>${showAll ? 'No roles yet' : 'No roles are assigned to you'}</h2>
            <p>${showAll ? 'Roles appear here once an admin creates them.' : 'Roles you are the rep for will show up here.'}</p>
            ${showAll ? '' : html`<p><a class="btn btn-secondary" href="/app?view=all">See all roles</a></p>`}
          </div>`
        : html`<ul class="role-list role-list-app" id="roles-list">
            ${roles.map((r) => {
              const c = counts.get(r.id) || {};
              const fresh = since.get(r.id) || 0;
              return html`<li class="role-row role-row-app${r.status === 'closed' ? ' is-closed' : ''}" data-role-id="${r.id}">
                <div class="role-row-main">
                  <a class="role-title" href="/app/roles/${r.id}">${r.title}</a>
                  <span class="role-site">${r.site_name || r.vertical}</span>
                  <div class="role-row-meta">
                    <span class="status status-${r.status}">${r.status === 'open' ? 'Open' : 'Closed'}</span>
                    <span>Rep: ${r.rep_name || r.rep_email || html`<span class="muted">Unassigned</span>`}</span>
                  </div>
                </div>
                <div class="role-row-counter">
                  <ol class="stage-counter" aria-label="Candidates by stage">
                    ${STAGES.map((s) => {
                      const n = c[s] || 0;
                      const cls = `stage-seg stage-${s}${s === 'new' && n > 0 ? ' is-hot' : ''}${n === 0 ? ' is-zero' : ''}`;
                      return html`<li class="${cls}" data-stage="${s}"><span class="stage-seg-n">${n}</span><span class="stage-seg-l">${STAGE_LABELS[s]}</span></li>`;
                    })}
                  </ol>
                  ${fresh ? html`<span class="since" data-since="${fresh}">+${fresh} since your last visit</span>` : ''}
                </div>
                <div class="role-row-action"><a class="btn btn-secondary" href="/app/roles/${r.id}" aria-label="Open pipeline for ${r.title}">Open pipeline</a></div>
              </li>`;
            })}
          </ul>`}`,
  });
}

// The only writer of users.dashboard_seen_at: "+N since your last visit" counts from this moment on.
async function markSeen(ctx) {
  await ctx.app.db.run('UPDATE users SET dashboard_seen_at = ? WHERE id = ?', [nowIso(), ctx.user.id]);
  ctx.redirect(ctx.form.get('view') === 'all' ? '/app?view=all' : '/app');
}

async function rolePipeline(ctx) {
  const { db } = ctx.app;
  const roleId = idParam(ctx.params.id);
  const role = await db.get('SELECT r.*, u.name AS rep_name, u.email AS rep_email FROM job_roles r LEFT JOIN users u ON u.id = r.assigned_user_id WHERE r.id = ?', [roleId]);
  if (!role) throw new HttpError(404, 'Role not found');
  const users = await db.all('SELECT id, name, email FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE, email');
  const apps = await db.all(
    `SELECT a.id, a.stage, a.applied_at, a.stage_changed_at, a.source_tag, p.name, p.email
       FROM applications a JOIN people p ON p.id = a.person_id
      WHERE a.role_id = ? ORDER BY a.applied_at DESC`,
    [roleId]
  );
  const returnTo = `/app/roles/${roleId}`;
  const isAdmin = ctx.user.role === 'admin';
  page(ctx, {
    title: role.title,
    body: html`<a class="back" href="/app">Dashboard</a>
      <div class="page-header">
        <div>
          <h1>${role.title}</h1>
          <dl class="meta-list">
            ${role.site_name ? html`<div><dt>Site</dt><dd>${role.site_name}</dd></div>` : ''}
            <div><dt>Vertical</dt><dd>${role.vertical}</dd></div>
            <div><dt>Status</dt><dd><span class="status status-${role.status}">${role.status === 'open' ? 'Open' : 'Closed'}</span></dd></div>
            <div><dt>Assigned rep</dt><dd>${role.rep_name || role.rep_email || 'Unassigned'}</dd></div>
          </dl>
        </div>
        <div class="page-actions">
          ${role.status === 'open' ? html`<a class="btn btn-secondary" href="/roles/${role.id}">View public page</a>` : ''}
          ${isAdmin ? html`<a class="btn btn-secondary" href="/app/admin/roles/${role.id}">Edit role</a>` : ''}
        </div>
      </div>
      <div class="role-bar">
        <form method="post" action="/app/roles/${role.id}/assign" class="inline">
          ${csrfField(ctx)}
          <label>Reassign rep
            <select name="user_id" required>
              <option value=""${users.some((u) => u.id === role.assigned_user_id) ? '' : raw(' selected')}>Choose…</option>
              ${users.map((u) => html`<option value="${u.id}"${u.id === role.assigned_user_id ? raw(' selected') : ''}>${u.name || u.email}</option>`)}
            </select>
          </label>
          <button type="submit" class="btn btn-secondary">Reassign</button>
        </form>
        <span class="meta">${apps.length} ${apps.length === 1 ? 'candidate' : 'candidates'} in this pipeline</span>
      </div>
      <div class="board">
      ${STAGES.map((stage) => {
        const list = apps.filter((a) => a.stage === stage);
        return html`<section class="board-col stage-${stage}" id="stage-${stage}" data-stage="${stage}" aria-labelledby="h-${stage}">
          <div class="board-col-head">
            <h2 id="h-${stage}">${STAGE_LABELS[stage]}</h2>
            <span class="board-count${list.length === 0 ? ' is-zero' : ''}">${list.length}</span>
          </div>
          ${list.length === 0
            ? html`<p class="board-empty">No candidates in ${STAGE_LABELS[stage]}.</p>`
            : html`<ul class="board-list">
                ${list.map(
                  (a) => html`<li class="cand-card" data-application-id="${a.id}">
                    <a class="cand-name" href="/app/applications/${a.id}">${a.name}</a>
                    <span class="cand-email">${a.email}</span>
                    <dl class="cand-meta">
                      <div><dt>Source</dt><dd class="cand-source">${sourceLabel(a.source_tag) || 'None'}</dd></div>
                      <div><dt>In stage</dt><dd>${daysSince(a.stage_changed_at)} ${daysSince(a.stage_changed_at) === 1 ? 'day' : 'days'}</dd></div>
                      <div><dt>Applied</dt><dd>${fmtDate(ctx, a.applied_at)}</dd></div>
                    </dl>
                    <form method="post" action="/app/applications/${a.id}/stage" class="cand-move">
                      ${csrfField(ctx)}
                      <input type="hidden" name="return_to" value="${returnTo}">
                      <select name="stage" aria-label="Move ${a.name} to stage" required>
                        <option value="">Move to…</option>
                        ${STAGES.filter((s) => s !== a.stage).map((s) => html`<option value="${s}">${STAGE_LABELS[s]}</option>`)}
                      </select>
                      <button type="submit" aria-label="Move ${a.name} to the selected stage">Move</button>
                    </form>
                  </li>`
                )}
              </ul>`}
        </section>`;
      })}
      </div>`,
  });
}

async function reassign(ctx) {
  const { db } = ctx.app;
  const roleId = idParam(ctx.params.id);
  const role = await db.get('SELECT id FROM job_roles WHERE id = ?', [roleId]);
  if (!role) throw new HttpError(404, 'Role not found');
  const userId = Number(ctx.form.get('user_id')) || 0;
  const user = await db.get('SELECT id, name, email FROM users WHERE id = ? AND active = 1', [userId]);
  if (!user) {
    setFlash(ctx, 'error', 'Choose an active user to assign this role to.');
  } else {
    await db.run('UPDATE job_roles SET assigned_user_id = ?, updated_at = ? WHERE id = ?', [user.id, nowIso(), roleId]);
    setFlash(ctx, 'ok', `Role reassigned to ${user.name || user.email}.`);
  }
  ctx.redirect(`/app/roles/${roleId}`);
}

function exportPage(ctx) {
  page(ctx, {
    title: 'Export',
    body: html`<div class="page-header"><div><h1>Export applications</h1>
        <p class="lede">Download every application as a spreadsheet-ready CSV file.</p></div></div>
      <form method="get" action="/app/export.csv" class="card centred-card">
        <h2>Choose a date range</h2>
        <p class="fine-print">One row per application, in UTF-8. Dates are in ${ctx.app.config.timezone}. Leave both dates empty to export everything.</p>
        <div class="field-row">
          <div class="field"><label for="f-from">Applied from</label><input type="date" name="from" id="f-from"></div>
          <div class="field"><label for="f-to">Applied to</label><input type="date" name="to" id="f-to"></div>
        </div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Download CSV</button></div>
      </form>`,
  });
}

const CSV_COLUMNS = [
  'application_id', 'applied_at', 'name', 'email', 'role_title', 'vertical', 'site_name', 'assigned_rep',
  'source_tag', 'heard_from', 'stage', 'stage_changed_at', 'onboarded_at', 'voltax_user_id', 'linkedin_url',
];

async function exportCsv(ctx) {
  const { db, config } = ctx.app;
  const tz = config.timezone;
  const from = ctx.query.get('from') || '';
  const to = ctx.query.get('to') || '';
  if ((from && !isValidYmd(from)) || (to && !isValidYmd(to))) throw new HttpError(400, 'Dates must be YYYY-MM-DD.');
  const where = [];
  const args = [];
  if (from) {
    where.push('a.applied_at >= ?');
    args.push(zonedMidnightUtc(from, tz).toISOString());
  }
  if (to) {
    // "to" is inclusive: everything before local midnight of the next day.
    const next = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10) + 1)).toISOString().slice(0, 10);
    where.push('a.applied_at < ?');
    args.push(zonedMidnightUtc(next, tz).toISOString());
  }
  const rows = await db.all(
    `SELECT a.*, p.name, p.email, p.linkedin_url, r.title AS role_title, r.vertical, r.site_name,
            COALESCE(NULLIF(u.name, ''), u.email, '') AS assigned_rep
       FROM applications a
       JOIN people p ON p.id = a.person_id
       JOIN job_roles r ON r.id = a.role_id
       LEFT JOIN users u ON u.id = r.assigned_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.applied_at, a.id`,
    args
  );
  const data = rows.map((a) => [
    a.id,
    formatDateTime(a.applied_at, tz),
    a.name,
    a.email,
    a.role_title,
    a.vertical,
    a.site_name,
    a.assigned_rep,
    a.source_tag,
    a.heard_from,
    a.stage,
    formatDateTime(a.stage_changed_at, tz),
    formatDateTime(a.onboarded_at, tz),
    a.voltax_user_id || '',
    a.linkedin_url,
  ]);
  const filename = `fansided-applications-${todayIn(tz)}.csv`;
  ctx.send(200, toCsv(CSV_COLUMNS, data), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

function register(router) {
  router.get('/app', requireUser, dashboard);
  router.post('/app/seen', requireUser, internalForm, markSeen);
  router.get('/app/roles/:id', requireUser, rolePipeline);
  router.post('/app/roles/:id/assign', requireUser, internalForm, reassign);
  router.get('/app/export', requireUser, exportPage);
  router.get('/app/export.csv', requireUser, exportCsv);
}

module.exports = { register, idParam, stageSelect, CSV_COLUMNS };

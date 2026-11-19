'use strict';
// Internal: dashboard, role pipeline, reassign rep, CSV export.
const { html, raw } = require('../lib/render');
const { page, setFlash, STAGES, STAGE_LABELS, fmtDate } = require('../lib/layout');
const { requireUser } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso } = require('../lib/db');
const { toCsv } = require('../lib/csv');
const { formatDateTime, zonedMidnightUtc, isValidYmd, todayIn, daysSince } = require('../lib/time');

function idParam(value) {
  if (!/^\d+$/.test(String(value))) throw new HttpError(404, 'Not found');
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
  page(ctx, {
    title: 'Dashboard',
    body: html`<h1>${showAll ? 'All roles' : 'My roles'}</h1>
      <p class="toolbar">
        ${showAll ? html`<a href="/app">Show my roles</a>` : html`<a href="/app?view=all">Show all roles</a>`}
        · <a href="/app/export">Export CSV</a>
      </p>
      ${roles.length === 0
        ? html`<p class="muted">${showAll ? 'No roles yet.' : 'No roles are assigned to you.'} ${showAll ? '' : html`<a href="/app?view=all">See all roles</a>.`}</p>`
        : html`<div class="table-wrap"><table class="data" id="roles-table">
          <thead><tr><th>Role</th><th>Site</th><th>Status</th><th>Rep</th>${STAGES.map((s) => html`<th class="num">${STAGE_LABELS[s]}</th>`)}</tr></thead>
          <tbody>
            ${roles.map((r) => {
              const c = counts.get(r.id) || {};
              return html`<tr data-role-id="${r.id}">
                <td><a href="/app/roles/${r.id}">${r.title}</a></td>
                <td>${r.site_name}</td>
                <td><span class="status status-${r.status}">${r.status}</span></td>
                <td>${r.rep_name || r.rep_email || html`<span class="muted">Unassigned</span>`}</td>
                ${STAGES.map(
                  (s) => html`<td class="num${s === 'new' && c.new ? ' highlight' : ''}" data-stage="${s}">${c[s] || 0}</td>`
                )}
              </tr>`;
            })}
          </tbody>
        </table></div>`}`,
  });
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
  page(ctx, {
    title: role.title,
    body: html`<p><a href="/app">← Dashboard</a></p>
      <h1>${role.title}</h1>
      <p class="muted">${role.vertical}${role.site_name ? ` · ${role.site_name}` : ''}</p>
      <div class="role-header">
        <p>Status: <span class="status status-${role.status}">${role.status}</span>
           · Assigned rep: <strong>${role.rep_name || role.rep_email || 'Unassigned'}</strong>
           ${role.status === 'open' ? html` · <a href="/roles/${role.id}">Public page</a>` : ''}
           ${ctx.user.role === 'admin' ? html` · <a href="/app/admin/roles/${role.id}">Edit role</a>` : ''}</p>
        <form method="post" action="/app/roles/${role.id}/assign" class="inline">
          ${csrfField(ctx)}
          <label>Reassign rep
            <select name="user_id" required>
              <option value=""${users.some((u) => u.id === role.assigned_user_id) ? '' : raw(' selected')}>Choose…</option>
              ${users.map((u) => html`<option value="${u.id}"${u.id === role.assigned_user_id ? raw(' selected') : ''}>${u.name || u.email}</option>`)}
            </select>
          </label>
          <button type="submit">Save</button>
        </form>
      </div>
      ${STAGES.map((stage) => {
        const list = apps.filter((a) => a.stage === stage);
        return html`<section class="stage-section" id="stage-${stage}" data-stage="${stage}">
          <h2>${STAGE_LABELS[stage]} <span class="count">${list.length}</span></h2>
          ${list.length === 0
            ? html`<p class="muted">No candidates.</p>`
            : html`<div class="table-wrap"><table class="data pipeline">
              <colgroup><col class="c-name"><col class="c-email"><col class="c-date"><col class="c-source"><col class="c-days"><col class="c-move"></colgroup>
              <thead><tr><th>Name</th><th>Email</th><th>Applied</th><th>Source</th><th class="num">Days in stage</th><th>Move to</th></tr></thead>
              <tbody>
                ${list.map(
                  (a) => html`<tr class="clickable" data-href="/app/applications/${a.id}">
                    <td><a href="/app/applications/${a.id}">${a.name}</a></td>
                    <td>${a.email}</td>
                    <td>${fmtDate(ctx, a.applied_at)}</td>
                    <td>${a.source_tag}</td>
                    <td class="num">${daysSince(a.stage_changed_at)}</td>
                    <td>
                      <form method="post" action="/app/applications/${a.id}/stage" class="inline">
                        ${csrfField(ctx)}
                        <input type="hidden" name="return_to" value="${returnTo}">
                        ${stageSelect(a.stage)}
                        <button type="submit">Move</button>
                      </form>
                    </td>
                  </tr>`
                )}
              </tbody>
            </table></div>`}
        </section>`;
      })}`,
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
    body: html`<h1>Export applications</h1>
      <p>Downloads one row per application as CSV (UTF-8). Dates are in ${ctx.app.config.timezone}. Leave the dates empty to export everything.</p>
      <form method="get" action="/app/export.csv" class="stacked narrow">
        <label>Applied from <input type="date" name="from"></label>
        <label>Applied to <input type="date" name="to"></label>
        <p><button type="submit" class="primary">Download CSV</button></p>
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
  router.get('/app/roles/:id', requireUser, rolePipeline);
  router.post('/app/roles/:id/assign', requireUser, internalForm, reassign);
  router.get('/app/export', requireUser, exportPage);
  router.get('/app/export.csv', requireUser, exportCsv);
}

module.exports = { register, idParam, stageSelect, CSV_COLUMNS };

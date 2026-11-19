'use strict';
// Admin-only screens: email templates, roles, users.
const { html, raw } = require('../lib/render');
const { page, setFlash, fmtDate } = require('../lib/layout');
const { requireAdmin, normaliseEmail } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso } = require('../lib/db');
const { MERGE_FIELDS } = require('../lib/email');
const { randomToken, sha256Hex } = require('../lib/crypto');
const { idParam } = require('./dashboard');

const MAX_QUESTIONS = 5;

function fieldError(errors, name) {
  return errors[name] ? html`<span class="error">${errors[name]}</span>` : '';
}

// ---------- Templates ----------

async function templatesPage(ctx) {
  const templates = await ctx.app.db.all('SELECT * FROM email_templates ORDER BY name COLLATE NOCASE');
  page(ctx, {
    title: 'Email templates',
    body: html`<h1>Email templates</h1>
      <p><a href="/app/admin/templates/new" class="button">New template</a></p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Subject</th><th>Updated</th><th></th></tr></thead><tbody>
        ${templates.map(
          (t) => html`<tr><td><a href="/app/admin/templates/${t.id}">${t.name}</a></td><td>${t.subject}</td><td>${fmtDate(ctx, t.updated_at)}</td>
            <td><form method="post" action="/app/admin/templates/${t.id}/delete" class="inline">${csrfField(ctx)}
              <button type="submit" class="link danger" data-confirm="Delete this template?">Delete</button></form></td></tr>`
        )}
      </tbody></table></div>
      ${mergeFieldHelp()}`,
  });
}

function mergeFieldHelp() {
  return html`<h2>Merge fields</h2><ul>${Object.entries(MERGE_FIELDS).map(([k, v]) => html`<li><code>{{${k}}}</code>: ${v}</li>`)}</ul>
    <p class="muted">Any other <code>{{…}}</code> stays as typed, and the rep sees a warning when loading the template.</p>`;
}

function templateForm(ctx, t, { errors = {}, status = 200 } = {}) {
  const isNew = !t.id;
  page(ctx, {
    title: isNew ? 'New template' : 'Edit template',
    status,
    body: html`<p><a href="/app/admin/templates">← Templates</a></p>
      <h1>${isNew ? 'New template' : `Edit: ${t.name}`}</h1>
      <form method="post" action="${isNew ? '/app/admin/templates' : `/app/admin/templates/${t.id}`}" class="stacked">
        ${csrfField(ctx)}
        <label>Name <input type="text" name="name" maxlength="200" value="${t.name || ''}" required></label>${fieldError(errors, 'name')}
        <label>Subject <input type="text" name="subject" maxlength="200" value="${t.subject || ''}" required></label>${fieldError(errors, 'subject')}
        <label>Body (plain text) <textarea name="body" rows="12" maxlength="10000" required>${t.body || ''}</textarea></label>${fieldError(errors, 'body')}
        <p><button type="submit" class="primary">Save</button></p>
      </form>
      ${mergeFieldHelp()}`,
  });
}

function readTemplate(form) {
  const t = {
    name: form.get('name').trim(),
    subject: form.get('subject').replace(/[\r\n]+/g, ' ').trim(),
    body: form.get('body').replace(/\r\n/g, '\n').trim(),
  };
  const errors = {};
  if (!t.name || t.name.length > 200) errors.name = 'Name is required (up to 200 characters).';
  if (!t.subject || t.subject.length > 200) errors.subject = 'Subject is required (up to 200 characters).';
  if (!t.body || t.body.length > 10000) errors.body = 'Body is required (up to 10,000 characters).';
  return { t, errors };
}

async function getTemplate(db, id) {
  const t = await db.get('SELECT * FROM email_templates WHERE id = ?', [idParam(id)]);
  if (!t) throw new HttpError(404, 'Template not found');
  return t;
}

// ---------- Roles ----------

async function rolesPage(ctx) {
  const roles = await ctx.app.db.all(
    `SELECT r.*, u.name AS rep_name, u.email AS rep_email, (SELECT COUNT(*) FROM applications a WHERE a.role_id = r.id) AS n
       FROM job_roles r LEFT JOIN users u ON u.id = r.assigned_user_id ORDER BY r.status = 'closed', r.vertical COLLATE NOCASE, r.title COLLATE NOCASE`
  );
  page(ctx, {
    title: 'Roles',
    body: html`<h1>Roles</h1>
      <p><a href="/app/admin/roles/new" class="button">New role</a></p>
      <div class="table-wrap"><table class="data"><thead><tr><th>Title</th><th>Vertical</th><th>Site</th><th>Status</th><th>Rep</th><th class="num">Candidates</th></tr></thead><tbody>
        ${roles.map(
          (r) => html`<tr><td><a href="/app/admin/roles/${r.id}">${r.title}</a></td><td>${r.vertical}</td><td>${r.site_name}</td>
            <td><span class="status status-${r.status}">${r.status}</span></td><td>${r.rep_name || r.rep_email || ''}</td>
            <td class="num"><a href="/app/roles/${r.id}">${r.n}</a></td></tr>`
        )}
      </tbody></table></div>`,
  });
}

async function roleForm(ctx, r, { errors = {}, status = 200 } = {}) {
  const { db } = ctx.app;
  const isNew = !r.id;
  const verticals = await db.all("SELECT DISTINCT vertical FROM job_roles WHERE vertical != '' ORDER BY vertical COLLATE NOCASE");
  const users = await db.all('SELECT id, name, email, active FROM users ORDER BY name COLLATE NOCASE, email');
  const questions = [...(r.questions || [])];
  while (questions.length < MAX_QUESTIONS) questions.push({ text: '', required: false });
  page(ctx, {
    title: isNew ? 'New role' : 'Edit role',
    status,
    body: html`<p><a href="/app/admin/roles">← Roles</a>${isNew ? '' : html` · <a href="/app/roles/${r.id}">Pipeline</a>`}</p>
      <h1>${isNew ? 'New role' : `Edit: ${r.title}`}</h1>
      <form method="post" action="${isNew ? '/app/admin/roles' : `/app/admin/roles/${r.id}`}" class="stacked">
        ${csrfField(ctx)}
        <label>Title <input type="text" name="title" maxlength="200" value="${r.title || ''}" required></label>${fieldError(errors, 'title')}
        <label>Vertical <input type="text" name="vertical" maxlength="100" list="verticals" value="${r.vertical || ''}" required></label>${fieldError(errors, 'vertical')}
        <datalist id="verticals">${verticals.map((v) => html`<option value="${v.vertical}">`)}</datalist>
        <label>Site name <input type="text" name="site_name" maxlength="200" value="${r.site_name || ''}"></label>${fieldError(errors, 'site_name')}
        <label>Description (plain text; line breaks are kept) <textarea name="description" rows="10" maxlength="20000">${r.description || ''}</textarea></label>${fieldError(errors, 'description')}
        <label>Status
          <select name="status">
            <option value="open"${r.status !== 'closed' ? raw(' selected') : ''}>Open</option>
            <option value="closed"${r.status === 'closed' ? raw(' selected') : ''}>Closed</option>
          </select>
        </label>
        <label>Assigned rep
          <select name="assigned_user_id">
            <option value="">Unassigned</option>
            ${users
              .filter((u) => u.active || u.id === r.assigned_user_id)
              .map((u) => html`<option value="${u.id}"${u.id === r.assigned_user_id ? raw(' selected') : ''}>${u.name || u.email}${u.active ? '' : ' (inactive)'}</option>`)}
          </select>
        </label>${fieldError(errors, 'assigned_user_id')}
        <fieldset>
          <legend>Questionnaire (up to ${MAX_QUESTIONS} questions; leave blank to skip)</legend>
          ${questions.map(
            (q, i) => html`<div class="question-row">
              <label>Question ${i + 1} <input type="text" name="q_text_${i}" maxlength="500" value="${q.text}"></label>
              <label class="check"><input type="checkbox" name="q_required_${i}" value="1"${q.required ? raw(' checked') : ''}> Required</label>
            </div>`
          )}
          ${fieldError(errors, 'questions')}
          ${isNew ? '' : html`<p class="muted">Editing questions does not change answers already submitted.</p>`}
        </fieldset>
        <p><button type="submit" class="primary">Save role</button></p>
      </form>`,
  });
}

function readRole(ctx) {
  const f = ctx.form;
  const r = {
    title: f.get('title').trim(),
    vertical: f.get('vertical').trim(),
    site_name: f.get('site_name').trim(),
    description: f.get('description').replace(/\r\n/g, '\n').trim(),
    status: f.get('status') === 'closed' ? 'closed' : 'open',
    assigned_user_id: f.get('assigned_user_id') ? Number(f.get('assigned_user_id')) : null,
    questions: [],
  };
  const errors = {};
  for (let i = 0; i < MAX_QUESTIONS; i++) {
    const text = f.get(`q_text_${i}`).replace(/[\r\n]+/g, ' ').trim();
    if (text) r.questions.push({ text, required: f.get(`q_required_${i}`) === '1' });
    if (text.length > 500) errors.questions = 'Questions must be at most 500 characters.';
  }
  if (!r.title || r.title.length > 200) errors.title = 'Title is required (up to 200 characters).';
  if (!r.vertical || r.vertical.length > 100) errors.vertical = 'Vertical is required (up to 100 characters).';
  if (r.site_name.length > 200) errors.site_name = 'Up to 200 characters.';
  if (r.description.length > 20000) errors.description = 'Up to 20,000 characters.';
  return { r, errors };
}

async function getRole(db, id) {
  const r = await db.get('SELECT * FROM job_roles WHERE id = ?', [idParam(id)]);
  if (!r) throw new HttpError(404, 'Role not found');
  r.questions = JSON.parse(r.questions_json || '[]');
  return r;
}

async function checkAssignee(db, r, errors, previousId) {
  if (r.assigned_user_id === null) return;
  const u = await db.get('SELECT id, active FROM users WHERE id = ?', [r.assigned_user_id]);
  if (!u || (!u.active && u.id !== previousId)) errors.assigned_user_id = 'Pick an active user.';
}

// ---------- Users ----------

const INVITE_DAYS = 7;
const RESET_HOURS = 24;

// A link is shown once, in the response to the POST that created it. Only its SHA-256 is stored.
function newLink(ctx, kind, token) {
  const base = ctx.baseUrl();
  return { kind, url: `${base}/set-password?token=${token}`, relative: !base };
}

async function usersPage(ctx, { errors = {}, values = {}, status = 200, link = null, linkEmail = '' } = {}) {
  const users = await ctx.app.db.all(
    `SELECT u.id, u.email, u.name, u.role, u.active, (u.password_hash IS NOT NULL) AS has_password,
            (SELECT COUNT(*) FROM job_roles r WHERE r.assigned_user_id = u.id) AS role_count
       FROM users u ORDER BY u.active DESC, u.name COLLATE NOCASE, u.email`
  );
  const statusOf = (u) => (!u.active ? 'Deactivated' : u.has_password ? 'Active' : 'Invite pending');
  page(ctx, {
    title: 'Users',
    status,
    body: html`<h1>Users</h1>
      ${link
        ? html`<section class="card" id="new-link">
            <h2>${link.kind === 'invite' ? 'Invite link' : 'Password reset link'} for ${linkEmail}</h2>
            <p><strong>Copy this link now and send it to them. It is shown only once</strong> and works once
              (${link.kind === 'invite' ? `${INVITE_DAYS} days` : `${RESET_HOURS} hours`}).${link.relative ? ' BASE_URL is not set: put your site address in front of it.' : ''}</p>
            <p><input type="text" readonly id="link-url" class="wide" value="${link.url}" aria-label="Link" size="80"></p>
          </section>`
        : ''}
      <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="num">Roles assigned</th><th></th></tr></thead><tbody>
        ${users.map(
          (u) => html`<tr class="${u.active ? '' : 'inactive'}" data-user-id="${u.id}">
            <td><form method="post" action="/app/admin/users/${u.id}/name" class="inline nowrap">${csrfField(ctx)}
              <input type="text" name="name" value="${u.name}" maxlength="200" required aria-label="Display name for ${u.email}" placeholder="Display name">
              <button type="submit">Save</button></form></td>
            <td class="wrap">${u.email}</td>
            <td><form method="post" action="/app/admin/users/${u.id}/role" class="inline nowrap">${csrfField(ctx)}
              <select name="role" aria-label="Role">
                <option value="rep"${u.role === 'rep' ? raw(' selected') : ''}>Rep</option>
                <option value="admin"${u.role === 'admin' ? raw(' selected') : ''}>Admin</option>
              </select> <button type="submit">Change</button></form></td>
            <td class="status-cell">${statusOf(u)}</td>
            <td class="num">${u.role_count}</td>
            <td>${u.active
              ? html`<form method="post" action="/app/admin/users/${u.id}/reset-link" class="inline">${csrfField(ctx)}<button type="submit" class="link">${u.has_password ? 'Create reset link' : 'New invite link'}</button></form>
                 <form method="post" action="/app/admin/users/${u.id}/deactivate" class="inline">${csrfField(ctx)}<button type="submit" class="link danger" data-confirm="Deactivate ${u.name || u.email}? They will be signed out and can no longer sign in.">Deactivate</button></form>`
              : html`<form method="post" action="/app/admin/users/${u.id}/reactivate" class="inline">${csrfField(ctx)}<button type="submit" class="link">Reactivate</button></form>`}</td>
          </tr>`
        )}
      </tbody></table></div>
      <h2>Add a user</h2>
      <p class="muted">You get a single-use invite link to send to them. They choose their own password.</p>
      <form method="post" action="/app/admin/users" class="stacked narrow">
        ${csrfField(ctx)}
        <label>Email <input type="email" name="email" maxlength="254" value="${values.email || ''}" required></label>${fieldError(errors, 'email')}
        <label>Name <input type="text" name="name" maxlength="200" value="${values.name || ''}" required></label>${fieldError(errors, 'name')}
        <label>Role
          <select name="role">
            <option value="rep"${values.role !== 'admin' ? raw(' selected') : ''}>Rep</option>
            <option value="admin"${values.role === 'admin' ? raw(' selected') : ''}>Admin</option>
          </select>
        </label>
        <p><button type="submit" class="primary">Add user</button></p>
      </form>`,
  });
}

async function getUser(db, id) {
  const u = await db.get('SELECT id, email, name, role, active, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = ?', [idParam(id)]);
  if (!u) throw new HttpError(404, 'User not found');
  return u;
}

// SQL guard on the users row being changed: it must not be the last active admin that has a password
// (checked inside the statement, so a race cannot remove the last admin who can sign in).
const NOT_LAST_ADMIN = `(role != 'admin' OR active = 0 OR password_hash IS NULL
  OR EXISTS (SELECT 1 FROM users o WHERE o.id != users.id AND o.role = 'admin' AND o.active = 1 AND o.password_hash IS NOT NULL))`;

// Statement that stores a link token (only its SHA-256) for the user selected by `where`.
function insertToken(kind, token, actorId, where, whereArgs) {
  const now = new Date();
  const expires = new Date(now.getTime() + (kind === 'invite' ? INVITE_DAYS * 86400000 : RESET_HOURS * 3600000)).toISOString();
  return {
    sql: `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_by_user_id, created_at)
          SELECT id, ?, ?, ?, ?, ? FROM users WHERE ${where}`,
    args: [kind, sha256Hex(token), expires, actorId, now.toISOString(), ...whereArgs],
  };
}

function register(router) {
  const A = [requireAdmin];
  const AP = [requireAdmin, internalForm];

  // Templates
  router.get('/app/admin/templates', ...A, templatesPage);
  router.get('/app/admin/templates/new', ...A, (ctx) => templateForm(ctx, {}));
  router.post('/app/admin/templates', ...AP, async (ctx) => {
    const { t, errors } = readTemplate(ctx.form);
    if (Object.keys(errors).length) return templateForm(ctx, t, { errors, status: 400 });
    await ctx.app.db.run('INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)', [t.name, t.subject, t.body, nowIso()]);
    setFlash(ctx, 'ok', 'Template created.');
    ctx.redirect('/app/admin/templates');
  });
  router.get('/app/admin/templates/:id', ...A, async (ctx) => templateForm(ctx, await getTemplate(ctx.app.db, ctx.params.id)));
  router.post('/app/admin/templates/:id', ...AP, async (ctx) => {
    const existing = await getTemplate(ctx.app.db, ctx.params.id);
    const { t, errors } = readTemplate(ctx.form);
    if (Object.keys(errors).length) return templateForm(ctx, { ...t, id: existing.id }, { errors, status: 400 });
    await ctx.app.db.run('UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?', [t.name, t.subject, t.body, nowIso(), existing.id]);
    setFlash(ctx, 'ok', 'Template saved.');
    ctx.redirect('/app/admin/templates');
  });
  router.post('/app/admin/templates/:id/delete', ...AP, async (ctx) => {
    const t = await getTemplate(ctx.app.db, ctx.params.id);
    // emails_sent.template_id is nulled explicitly rather than relying on ON DELETE SET NULL.
    await ctx.app.db.batch([
      { sql: 'UPDATE emails_sent SET template_id = NULL WHERE template_id = ?', args: [t.id] },
      { sql: 'DELETE FROM email_templates WHERE id = ?', args: [t.id] },
    ]);
    setFlash(ctx, 'ok', `Template "${t.name}" deleted.`);
    ctx.redirect('/app/admin/templates');
  });

  // Roles
  router.get('/app/admin/roles', ...A, rolesPage);
  router.get('/app/admin/roles/new', ...A, (ctx) => roleForm(ctx, { status: 'open', assigned_user_id: ctx.user.id, questions: [] }));
  router.post('/app/admin/roles', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const { r, errors } = readRole(ctx);
    await checkAssignee(db, r, errors, null);
    if (Object.keys(errors).length) return roleForm(ctx, r, { errors, status: 400 });
    const now = nowIso();
    const res = await db.run(
      'INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.title, r.vertical, r.site_name, r.description, r.status, r.assigned_user_id, JSON.stringify(r.questions), now, now]
    );
    setFlash(ctx, 'ok', 'Role created.');
    ctx.redirect(`/app/admin/roles/${res.lastInsertRowid}`);
  });
  router.get('/app/admin/roles/:id', ...A, async (ctx) => roleForm(ctx, await getRole(ctx.app.db, ctx.params.id)));
  router.post('/app/admin/roles/:id', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const existing = await getRole(db, ctx.params.id);
    const { r, errors } = readRole(ctx);
    await checkAssignee(db, r, errors, existing.assigned_user_id);
    if (Object.keys(errors).length) return roleForm(ctx, { ...r, id: existing.id }, { errors, status: 400 });
    await db.run('UPDATE job_roles SET title = ?, vertical = ?, site_name = ?, description = ?, status = ?, assigned_user_id = ?, questions_json = ?, updated_at = ? WHERE id = ?', [
      r.title, r.vertical, r.site_name, r.description, r.status, r.assigned_user_id, JSON.stringify(r.questions), nowIso(), existing.id,
    ]);
    setFlash(ctx, 'ok', 'Role saved.');
    ctx.redirect(`/app/admin/roles/${existing.id}`);
  });

  // Users
  router.get('/app/admin/users', ...A, (ctx) => usersPage(ctx));
  router.post('/app/admin/users', ...AP, async (ctx) => {
    const { db, log } = ctx.app;
    const values = { email: normaliseEmail(ctx.form.get('email')), name: ctx.form.get('name').replace(/\s+/g, ' ').trim(), role: ctx.form.get('role') === 'admin' ? 'admin' : 'rep' };
    const errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || values.email.length > 254) errors.email = 'Enter a valid email address.';
    else if (await db.get('SELECT id FROM users WHERE email = ?', [values.email])) errors.email = 'A user with this email already exists.';
    if (!values.name || values.name.length > 200) errors.name = 'Name is required (up to 200 characters).';
    if (Object.keys(errors).length) return usersPage(ctx, { errors, values, status: 400 });
    const token = randomToken();
    const now = nowIso();
    let results;
    try {
      // One batch: the user (no password yet) and its invite token.
      results = await db.batch([
        { sql: 'INSERT INTO users (email, name, role, active, password_hash, created_at) VALUES (?, ?, ?, 1, NULL, ?)', args: [values.email, values.name, values.role, now] },
        insertToken('invite', token, ctx.user.id, 'email = ?', [values.email]),
      ]);
    } catch (err) {
      if (/UNIQUE|constraint/i.test(String(err.message))) return usersPage(ctx, { errors: { email: 'A user with this email already exists.' }, values, status: 400 });
      throw err;
    }
    log(`[admin] invite created user=${results[0].lastInsertRowid} by=${ctx.user.id}`);
    // Rendered directly (never put in a redirect URL); the link exists only in this response.
    await usersPage(ctx, { link: newLink(ctx, 'invite', token), linkEmail: values.email });
  });
  router.post('/app/admin/users/:id/reset-link', ...AP, async (ctx) => {
    const { db, log } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    if (!u.active) {
      setFlash(ctx, 'error', 'This user is deactivated. Reactivate them first.');
      return ctx.redirect('/app/admin/users');
    }
    const kind = u.has_password ? 'reset' : 'invite';
    const token = randomToken();
    // One batch: earlier unused links of this user are deleted, the new one is stored (both only while active).
    const results = await db.batch([
      { sql: 'DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1)', args: [u.id, u.id] },
      insertToken(kind, token, ctx.user.id, 'id = ? AND active = 1', [u.id]),
    ]);
    if (results[1].changes !== 1) {
      setFlash(ctx, 'error', 'This user is deactivated. Reactivate them first.');
      return ctx.redirect('/app/admin/users');
    }
    log(`[admin] ${kind} link created user=${u.id} by=${ctx.user.id}`);
    await usersPage(ctx, { link: newLink(ctx, kind, token), linkEmail: u.email });
  });
  router.post('/app/admin/users/:id/name', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    const name = ctx.form.get('name').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 200) {
      setFlash(ctx, 'error', 'A display name is required (up to 200 characters).');
    } else {
      await db.run('UPDATE users SET name = ? WHERE id = ?', [name, u.id]);
      setFlash(ctx, 'ok', `Name saved for ${u.email}.`);
    }
    ctx.redirect('/app/admin/users');
  });
  router.post('/app/admin/users/:id/role', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    const role = ctx.form.get('role') === 'admin' ? 'admin' : 'rep';
    if (role === u.role) return ctx.redirect('/app/admin/users');
    if (u.id === ctx.user.id && role !== 'admin') {
      setFlash(ctx, 'error', 'You cannot change your own role.');
      return ctx.redirect('/app/admin/users');
    }
    // Demoting is guarded inside the UPDATE: not yourself, never the last active admin who has a password.
    const r = await db.run(`UPDATE users SET role = ? WHERE id = ? AND (? = 'admin' OR (id != ? AND ${NOT_LAST_ADMIN}))`, [role, u.id, role, ctx.user.id]);
    if (r.changes === 0) setFlash(ctx, 'error', 'You cannot remove the last active admin.');
    else setFlash(ctx, 'ok', `${u.email} is now ${role === 'admin' ? 'an admin' : 'a rep'}.`);
    ctx.redirect('/app/admin/users');
  });
  router.post('/app/admin/users/:id/deactivate', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    if (u.id === ctx.user.id) {
      setFlash(ctx, 'error', 'You cannot deactivate yourself.');
      return ctx.redirect('/app/admin/users');
    }
    const roles = await db.all('SELECT id, title, status FROM job_roles WHERE assigned_user_id = ? ORDER BY title', [u.id]);
    if (roles.length && ctx.form.get('confirm') !== '1') {
      return page(ctx, {
        title: 'Deactivate user',
        body: html`<h1>Deactivate ${u.name || u.email}?</h1>
          <p class="flash flash-error">Warning: ${u.name || u.email} is still the assigned rep for ${roles.length} role${roles.length === 1 ? '' : 's'}:</p>
          <ul>${roles.map((r) => html`<li><a href="/app/roles/${r.id}">${r.title}</a>${r.status === 'closed' ? ' (closed)' : ''}</li>`)}</ul>
          <p>Reassign these roles after deactivating.</p>
          <form method="post" action="/app/admin/users/${u.id}/deactivate" class="inline">
            ${csrfField(ctx)}<input type="hidden" name="confirm" value="1">
            <button type="submit" class="danger">Deactivate anyway</button> <a href="/app/admin/users">Cancel</a>
          </form>`,
      });
    }
    // One atomic batch. The last-admin and not-yourself guards are inside the UPDATE; sessions and unused
    // links are only removed once the user really is inactive.
    const results = await db.batch([
      { sql: `UPDATE users SET active = 0 WHERE id = ? AND id != ? AND ${NOT_LAST_ADMIN}`, args: [u.id, ctx.user.id] },
      { sql: 'DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 0)', args: [u.id, u.id] },
      { sql: 'DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 0)', args: [u.id, u.id] },
    ]);
    if (results[0].changes === 0) setFlash(ctx, 'error', 'You cannot deactivate the last active admin.');
    else setFlash(ctx, 'ok', `${u.email} deactivated.`);
    ctx.redirect('/app/admin/users');
  });
  router.post('/app/admin/users/:id/reactivate', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    await db.run('UPDATE users SET active = 1 WHERE id = ?', [u.id]);
    setFlash(ctx, 'ok', `${u.email} reactivated.`);
    ctx.redirect('/app/admin/users');
  });
}

module.exports = { register };

'use strict';
// Admin-only screens: email templates, roles, users.
const { html, raw } = require('../lib/render');
const { page, setFlash, fmtDate } = require('../lib/layout');
const { requireAdmin, normaliseEmail } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso, transaction } = require('../lib/db');
const { MERGE_FIELDS } = require('../lib/email');
const { idParam } = require('./dashboard');

const MAX_QUESTIONS = 5;

function fieldError(errors, name) {
  return errors[name] ? html`<span class="error">${errors[name]}</span>` : '';
}

// ---------- Templates ----------

function templatesPage(ctx) {
  const templates = ctx.app.db.prepare('SELECT * FROM email_templates ORDER BY name COLLATE NOCASE').all();
  page(ctx, {
    title: 'Email templates',
    body: html`<h1>Email templates</h1>
      <p><a href="/app/admin/templates/new" class="button">New template</a></p>
      <table class="data"><thead><tr><th>Name</th><th>Subject</th><th>Updated</th><th></th></tr></thead><tbody>
        ${templates.map(
          (t) => html`<tr><td><a href="/app/admin/templates/${t.id}">${t.name}</a></td><td>${t.subject}</td><td>${fmtDate(ctx, t.updated_at)}</td>
            <td><form method="post" action="/app/admin/templates/${t.id}/delete" class="inline">${csrfField(ctx)}
              <button type="submit" class="link danger" data-confirm="Delete this template?">Delete</button></form></td></tr>`
        )}
      </tbody></table>
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
        <label>Subject <input type="text" name="subject" maxlength="300" value="${t.subject || ''}" required></label>${fieldError(errors, 'subject')}
        <label>Body (plain text) <textarea name="body" rows="12" maxlength="20000" required>${t.body || ''}</textarea></label>${fieldError(errors, 'body')}
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
  if (!t.subject || t.subject.length > 300) errors.subject = 'Subject is required (up to 300 characters).';
  if (!t.body || t.body.length > 20000) errors.body = 'Body is required (up to 20,000 characters).';
  return { t, errors };
}

function getTemplate(db, id) {
  const t = db.prepare('SELECT * FROM email_templates WHERE id = ?').get(idParam(id));
  if (!t) throw new HttpError(404, 'Template not found');
  return t;
}

// ---------- Roles ----------

function rolesPage(ctx) {
  const roles = ctx.app.db
    .prepare(
      `SELECT r.*, u.name AS rep_name, u.email AS rep_email, (SELECT COUNT(*) FROM applications a WHERE a.role_id = r.id) AS n
         FROM job_roles r LEFT JOIN users u ON u.id = r.assigned_user_id ORDER BY r.status = 'closed', r.vertical COLLATE NOCASE, r.title COLLATE NOCASE`
    )
    .all();
  page(ctx, {
    title: 'Roles',
    body: html`<h1>Roles</h1>
      <p><a href="/app/admin/roles/new" class="button">New role</a></p>
      <table class="data"><thead><tr><th>Title</th><th>Vertical</th><th>Site</th><th>Status</th><th>Rep</th><th class="num">Candidates</th></tr></thead><tbody>
        ${roles.map(
          (r) => html`<tr><td><a href="/app/admin/roles/${r.id}">${r.title}</a></td><td>${r.vertical}</td><td>${r.site_name}</td>
            <td><span class="status status-${r.status}">${r.status}</span></td><td>${r.rep_name || r.rep_email || ''}</td>
            <td class="num"><a href="/app/roles/${r.id}">${r.n}</a></td></tr>`
        )}
      </tbody></table>`,
  });
}

function roleForm(ctx, r, { errors = {}, status = 200 } = {}) {
  const { db } = ctx.app;
  const isNew = !r.id;
  const verticals = db.prepare("SELECT DISTINCT vertical FROM job_roles WHERE vertical != '' ORDER BY vertical COLLATE NOCASE").all();
  const users = db.prepare('SELECT id, name, email, active FROM users ORDER BY name COLLATE NOCASE, email').all();
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

function getRole(db, id) {
  const r = db.prepare('SELECT * FROM job_roles WHERE id = ?').get(idParam(id));
  if (!r) throw new HttpError(404, 'Role not found');
  r.questions = JSON.parse(r.questions_json || '[]');
  return r;
}

function checkAssignee(db, r, errors, previousId) {
  if (r.assigned_user_id === null) return;
  const u = db.prepare('SELECT id, active FROM users WHERE id = ?').get(r.assigned_user_id);
  if (!u || (!u.active && u.id !== previousId)) errors.assigned_user_id = 'Pick an active user.';
}

// ---------- Users ----------

function activeAdminCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
}

function usersPage(ctx, { errors = {}, values = {}, status = 200 } = {}) {
  const users = ctx.app.db
    .prepare('SELECT u.*, (SELECT COUNT(*) FROM job_roles r WHERE r.assigned_user_id = u.id) AS role_count FROM users u ORDER BY u.active DESC, u.name COLLATE NOCASE, u.email')
    .all();
  page(ctx, {
    title: 'Users',
    status,
    body: html`<h1>Users</h1>
      <table class="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="num">Roles assigned</th><th></th></tr></thead><tbody>
        ${users.map(
          (u) => html`<tr class="${u.active ? '' : 'inactive'}" data-user-id="${u.id}">
            <td>${u.name}</td><td>${u.email}</td>
            <td><form method="post" action="/app/admin/users/${u.id}/role" class="inline">${csrfField(ctx)}
              <select name="role" aria-label="Role">
                <option value="rep"${u.role === 'rep' ? raw(' selected') : ''}>Rep</option>
                <option value="admin"${u.role === 'admin' ? raw(' selected') : ''}>Admin</option>
              </select> <button type="submit">Change</button></form></td>
            <td>${u.active ? 'Active' : 'Deactivated'}</td>
            <td class="num">${u.role_count}</td>
            <td>${u.active
              ? html`<form method="post" action="/app/admin/users/${u.id}/deactivate" class="inline">${csrfField(ctx)}<button type="submit" class="link danger">Deactivate</button></form>`
              : html`<form method="post" action="/app/admin/users/${u.id}/reactivate" class="inline">${csrfField(ctx)}<button type="submit" class="link">Reactivate</button></form>`}</td>
          </tr>`
        )}
      </tbody></table>
      <h2>Add a user</h2>
      <form method="post" action="/app/admin/users" class="stacked narrow">
        ${csrfField(ctx)}
        <label>Email (their Google account) <input type="email" name="email" maxlength="254" value="${values.email || ''}" required></label>${fieldError(errors, 'email')}
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

function getUser(db, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(idParam(id));
  if (!u) throw new HttpError(404, 'User not found');
  return u;
}

function register(router) {
  const A = [requireAdmin];
  const AP = [requireAdmin, internalForm];

  // Templates
  router.get('/app/admin/templates', ...A, templatesPage);
  router.get('/app/admin/templates/new', ...A, (ctx) => templateForm(ctx, {}));
  router.post('/app/admin/templates', ...AP, (ctx) => {
    const { t, errors } = readTemplate(ctx.form);
    if (Object.keys(errors).length) return templateForm(ctx, t, { errors, status: 400 });
    ctx.app.db.prepare('INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)').run(t.name, t.subject, t.body, nowIso());
    setFlash(ctx, 'ok', 'Template created.');
    ctx.redirect('/app/admin/templates');
  });
  router.get('/app/admin/templates/:id', ...A, (ctx) => templateForm(ctx, getTemplate(ctx.app.db, ctx.params.id)));
  router.post('/app/admin/templates/:id', ...AP, (ctx) => {
    const existing = getTemplate(ctx.app.db, ctx.params.id);
    const { t, errors } = readTemplate(ctx.form);
    if (Object.keys(errors).length) return templateForm(ctx, { ...t, id: existing.id }, { errors, status: 400 });
    ctx.app.db.prepare('UPDATE email_templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?').run(t.name, t.subject, t.body, nowIso(), existing.id);
    setFlash(ctx, 'ok', 'Template saved.');
    ctx.redirect('/app/admin/templates');
  });
  router.post('/app/admin/templates/:id/delete', ...AP, (ctx) => {
    const t = getTemplate(ctx.app.db, ctx.params.id);
    ctx.app.db.prepare('DELETE FROM email_templates WHERE id = ?').run(t.id);
    setFlash(ctx, 'ok', `Template "${t.name}" deleted.`);
    ctx.redirect('/app/admin/templates');
  });

  // Roles
  router.get('/app/admin/roles', ...A, rolesPage);
  router.get('/app/admin/roles/new', ...A, (ctx) => roleForm(ctx, { status: 'open', assigned_user_id: ctx.user.id, questions: [] }));
  router.post('/app/admin/roles', ...AP, (ctx) => {
    const { db } = ctx.app;
    const { r, errors } = readRole(ctx);
    checkAssignee(db, r, errors, null);
    if (Object.keys(errors).length) return roleForm(ctx, r, { errors, status: 400 });
    const now = nowIso();
    const res = db
      .prepare('INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.title, r.vertical, r.site_name, r.description, r.status, r.assigned_user_id, JSON.stringify(r.questions), now, now);
    setFlash(ctx, 'ok', 'Role created.');
    ctx.redirect(`/app/admin/roles/${res.lastInsertRowid}`);
  });
  router.get('/app/admin/roles/:id', ...A, (ctx) => roleForm(ctx, getRole(ctx.app.db, ctx.params.id)));
  router.post('/app/admin/roles/:id', ...AP, (ctx) => {
    const { db } = ctx.app;
    const existing = getRole(db, ctx.params.id);
    const { r, errors } = readRole(ctx);
    checkAssignee(db, r, errors, existing.assigned_user_id);
    if (Object.keys(errors).length) return roleForm(ctx, { ...r, id: existing.id }, { errors, status: 400 });
    db.prepare('UPDATE job_roles SET title = ?, vertical = ?, site_name = ?, description = ?, status = ?, assigned_user_id = ?, questions_json = ?, updated_at = ? WHERE id = ?').run(
      r.title, r.vertical, r.site_name, r.description, r.status, r.assigned_user_id, JSON.stringify(r.questions), nowIso(), existing.id
    );
    setFlash(ctx, 'ok', 'Role saved.');
    ctx.redirect(`/app/admin/roles/${existing.id}`);
  });

  // Users
  router.get('/app/admin/users', ...A, (ctx) => usersPage(ctx));
  router.post('/app/admin/users', ...AP, (ctx) => {
    const { db } = ctx.app;
    const values = { email: normaliseEmail(ctx.form.get('email')), name: ctx.form.get('name').trim(), role: ctx.form.get('role') === 'admin' ? 'admin' : 'rep' };
    const errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) || values.email.length > 254) errors.email = 'Enter a valid email address.';
    else if (db.prepare('SELECT id FROM users WHERE email = ?').get(values.email)) errors.email = 'A user with this email already exists.';
    if (!values.name || values.name.length > 200) errors.name = 'Name is required (up to 200 characters).';
    if (Object.keys(errors).length) return usersPage(ctx, { errors, values, status: 400 });
    db.prepare('INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, ?, 1, ?)').run(values.email, values.name, values.role, nowIso());
    setFlash(ctx, 'ok', `Added ${values.email}.`);
    ctx.redirect('/app/admin/users');
  });
  router.post('/app/admin/users/:id/role', ...AP, (ctx) => {
    const { db } = ctx.app;
    const u = getUser(db, ctx.params.id);
    const role = ctx.form.get('role') === 'admin' ? 'admin' : 'rep';
    if (role === u.role) return ctx.redirect('/app/admin/users');
    if (u.role === 'admin' && u.active && activeAdminCount(db) <= 1) {
      setFlash(ctx, 'error', 'You cannot remove the last active admin.');
      return ctx.redirect('/app/admin/users');
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
    setFlash(ctx, 'ok', `${u.email} is now ${role === 'admin' ? 'an admin' : 'a rep'}.`);
    ctx.redirect('/app/admin/users');
  });
  router.post('/app/admin/users/:id/deactivate', ...AP, (ctx) => {
    const { db } = ctx.app;
    const u = getUser(db, ctx.params.id);
    if (u.id === ctx.user.id) {
      setFlash(ctx, 'error', 'You cannot deactivate yourself.');
      return ctx.redirect('/app/admin/users');
    }
    if (u.role === 'admin' && u.active && activeAdminCount(db) <= 1) {
      setFlash(ctx, 'error', 'You cannot deactivate the last active admin.');
      return ctx.redirect('/app/admin/users');
    }
    const roles = db.prepare('SELECT id, title, status FROM job_roles WHERE assigned_user_id = ? ORDER BY title').all(u.id);
    if (roles.length && ctx.form.get('confirm') !== '1') {
      return page(ctx, {
        title: 'Deactivate user',
        body: html`<h1>Deactivate ${u.name || u.email}?</h1>
          <p class="flash flash-error">Warning: ${u.name || u.email} is still the assigned rep for ${roles.length} role${roles.length === 1 ? '' : 's'}:</p>
          <ul>${roles.map((r) => html`<li><a href="/app/roles/${r.id}">${r.title}</a>${r.status === 'closed' ? ' (closed)' : ''}</li>`)}</ul>
          <p>New-application notifications for these roles will go to the first active admin until you reassign them.</p>
          <form method="post" action="/app/admin/users/${u.id}/deactivate" class="inline">
            ${csrfField(ctx)}<input type="hidden" name="confirm" value="1">
            <button type="submit" class="danger">Deactivate anyway</button> <a href="/app/admin/users">Cancel</a>
          </form>`,
      });
    }
    transaction(db, () => {
      db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    });
    setFlash(ctx, 'ok', `${u.email} deactivated.`);
    ctx.redirect('/app/admin/users');
  });
  router.post('/app/admin/users/:id/reactivate', ...AP, (ctx) => {
    const { db } = ctx.app;
    const u = getUser(db, ctx.params.id);
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(u.id);
    setFlash(ctx, 'ok', `${u.email} reactivated.`);
    ctx.redirect('/app/admin/users');
  });
}

module.exports = { register };

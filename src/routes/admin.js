'use strict';
// Admin-only screens: email templates, roles, users.
const { html, raw } = require('../lib/render');
const { page, setFlash, fmtDate, errorSummary } = require('../lib/layout');
const { requireAdmin, normaliseEmail } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso } = require('../lib/db');
const { MERGE_FIELDS } = require('../lib/email');
const { randomToken, sha256Hex } = require('../lib/crypto');
const { idParam } = require('./dashboard');
const { rateKey } = require('../lib/ratelimit');
const { loadSample, removeSample, sampleCounts, ROLES, PEOPLE_COUNT } = require('../lib/sample');
const wf = require('../lib/stages');

const MAX_QUESTIONS = 5;

function fieldError(errors, name) {
  return errors[name] ? html`<p class="error" id="err-${name}">${errors[name]}</p>` : '';
}

// One labelled field with optional help text and inline error; `control(attrs)` renders the input.
function field(errors, name, label, { help = '', required = false, id = `f-${name}` } = {}, control) {
  const describedBy = [help ? `help-${name}` : '', errors[name] ? `err-${name}` : ''].filter(Boolean).join(' ');
  const attrs = raw(`id="${id}"${describedBy ? ` aria-describedby="${describedBy}"` : ''}${errors[name] ? ' aria-invalid="true"' : ''}`);
  return html`<div class="field${errors[name] ? ' has-error' : ''}">
    <label for="${id}">${label}${required ? html` <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> (required)</span>` : ''}</label>
    ${help ? html`<p class="help" id="help-${name}">${help}</p>` : ''}
    ${control(attrs)}
    ${fieldError(errors, name)}
  </div>`;
}

// Error summary for a form that has per-field errors. `ids` maps a field name to the element id when it is not f-<name>.
function summaryFor(errors, ids = {}) {
  return errorSummary(Object.keys(errors).map((k) => ({ id: ids[k] || `f-${k}`, text: errors[k] })));
}

// ---------- Templates ----------

async function templatesPage(ctx) {
  const templates = await ctx.app.db.all('SELECT * FROM email_templates ORDER BY name COLLATE NOCASE');
  page(ctx, {
    title: 'Email templates',
    body: html`<div class="page-header">
        <div><h1>Email templates</h1><p class="lede">Reusable messages reps load into the email composer on a candidate page.</p></div>
        <div class="page-actions"><a href="/app/admin/templates/new" class="btn btn-primary">New template</a></div>
      </div>
      ${templates.length === 0
        ? html`<div class="empty"><h2>No templates yet</h2><p>Write the replies you send most often, such as a thank-you or a trial invitation, so reps can load them in one click.</p>
            <p><a class="btn btn-primary" href="/app/admin/templates/new">Create the first template</a></p></div>`
        : html`<div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Subject</th><th>Updated</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
        ${templates.map(
          (t) => html`<tr><td><a href="/app/admin/templates/${t.id}"><strong>${t.name}</strong></a></td><td>${t.subject}</td><td>${fmtDate(ctx, t.updated_at)}</td>
            <td><div class="row-actions"><a href="/app/admin/templates/${t.id}">Edit</a>
              <a class="danger-link" href="/app/admin/templates/${t.id}/delete">Delete<span class="visually-hidden"> ${t.name}</span></a></div></td></tr>`
        )}
      </tbody></table></div>`}`,
  });
}

function mergeFieldHelp() {
  return html`<aside class="card help-aside" aria-labelledby="merge-h"><h2 id="merge-h">Merge fields</h2>
    <p>Type these in the subject or body. They are filled in when a rep loads the template.</p>
    <ul>${Object.entries(MERGE_FIELDS).map(([k, v]) => html`<li><code>{{${k}}}</code>: ${v}</li>`)}</ul>
    <p class="muted">Any other <code>{{…}}</code> stays as typed, and the rep sees a warning when loading the template.</p></aside>`;
}

function templateForm(ctx, t, { errors = {}, status = 200 } = {}) {
  const isNew = !t.id;
  page(ctx, {
    title: isNew ? 'New template' : 'Edit template',
    status,
    body: html`<a class="back" href="/app/admin/templates">Email templates</a>
      <div class="page-header"><div><h1>${isNew ? 'New template' : `Edit ${t.name}`}</h1></div></div>
      ${summaryFor(errors)}
      <div class="grid-2 wide-left">
      <form method="post" action="${isNew ? '/app/admin/templates' : `/app/admin/templates/${t.id}`}" class="card">
        ${csrfField(ctx)}
        ${field(errors, 'name', 'Name', { required: true, help: 'Reps see this name in the template list.' }, (a) => html`<input type="text" ${a} name="name" maxlength="200" value="${t.name || ''}" required>`)}
        ${field(errors, 'subject', 'Subject', { required: true }, (a) => html`<input type="text" ${a} name="subject" maxlength="200" value="${t.subject || ''}" required>`)}
        ${field(errors, 'body', 'Body', { required: true, help: 'Plain text. Line breaks are kept.' }, (a) => html`<textarea ${a} name="body" rows="12" maxlength="10000" required>${t.body || ''}</textarea>`)}
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save template</button><a class="btn btn-secondary" href="/app/admin/templates">Cancel</a></div>
      </form>
      ${mergeFieldHelp()}
      </div>`,
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
    body: html`<div class="page-header">
        <div><h1>Roles</h1><p class="lede">The openings shown on the public careers page, and who looks after each one.</p></div>
        <div class="page-actions"><a href="/app/admin/roles/new" class="btn btn-primary">New role</a></div>
      </div>
      ${roles.length === 0
        ? html`<div class="empty"><h2>No roles yet</h2><p>Create a role to open applications for it.</p><p><a class="btn btn-primary" href="/app/admin/roles/new">Create the first role</a></p></div>`
        : html`<div class="table-wrap"><table class="data"><thead><tr><th>Title</th><th>Vertical</th><th>Site</th><th>Status</th><th>Rep</th><th class="num">Candidates</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
        ${roles.map(
          (r) => html`<tr><td><a href="/app/admin/roles/${r.id}"><strong>${r.title}</strong></a></td><td>${r.vertical}</td><td>${r.site_name}</td>
            <td><span class="status status-${r.status}">${r.status === 'open' ? 'Open' : 'Closed'}</span></td><td>${r.rep_name || r.rep_email || html`<span class="muted">Unassigned</span>`}</td>
            <td class="num"><a href="/app/roles/${r.id}">${r.n}</a></td>
            <td><div class="row-actions"><a href="/app/admin/roles/${r.id}">Edit</a><a href="/app/admin/roles/new?copy=${r.id}">Duplicate<span class="visually-hidden"> ${r.title}</span></a></div></td></tr>`
        )}
      </tbody></table></div>`}`,
  });
}

// ---------- Workflow (stages) editor ----------
// No-JS editor: MAX_PROGRESS rows are always rendered (the role's custom stages first, then blank spare rows).
// A row with a name is kept, a row of an existing stage with its name cleared is removed, "Position" orders the rows.
// stage_slots=1 says the form carried the editor at all; without it the workflow is left exactly as it is.

function slotsFromNames(names) {
  const slots = names.slice(0, wf.MAX_PROGRESS).map((name, i) => ({ id: '', name, pos: String(i + 1) }));
  while (slots.length < wf.MAX_PROGRESS) slots.push({ id: '', name: '', pos: '' });
  return slots;
}

function slotsFromStages(stages) {
  const slots = stages.filter((s) => s.kind === 'progress').map((s, i) => ({ id: String(s.id), name: s.name, pos: String(i + 1) }));
  while (slots.length < wf.MAX_PROGRESS) slots.push({ id: '', name: '', pos: '' });
  return slots;
}

// Reads the editor rows. `existing` = the role's current stages (null for a new role).
// Returns { present, slots (as submitted, for re-rendering), keep: [{id|null, name, position}], removed: [stage], ids, errors }.
function readWorkflow(form, existing, counts = new Map()) {
  const out = { present: form.get('stage_slots') === '1', slots: [], keep: [], removed: [], ids: [], errors: {} };
  if (!out.present) return out;
  const known = existing ? existing.filter((s) => s.kind === 'progress') : [];
  const seen = new Set();
  const rows = [];
  for (let i = 0; i < wf.MAX_PROGRESS; i++) {
    const slot = { id: form.get(`stage_id_${i}`).trim(), name: wf.cleanName(form.get(`stage_name_${i}`)), pos: form.get(`stage_pos_${i}`).trim() };
    out.slots.push(slot);
    const err = (text) => {
      if (!out.errors[`stage_${i}`]) out.errors[`stage_${i}`] = text;
    };
    const prior = slot.id ? known.find((s) => String(s.id) === slot.id) : null;
    if (slot.id && (!prior || seen.has(prior.id))) {
      out.errors.workflow = 'The workflow was changed by someone else while you were editing. Nothing was saved: reload this page and try again.';
      continue;
    }
    if (prior) seen.add(prior.id);
    if (!slot.name) {
      if (prior) {
        out.removed.push(prior);
        const n = counts.get(prior.id) || 0;
        if (n > 0) err(`Move the ${wf.countWord(n)} out of ${prior.name} before removing it.`);
      }
      continue;
    }
    if (/[\u0000-\u001f\u007f]/.test(slot.name)) err('Stage names cannot contain control characters.');
    else if (slot.name.length > wf.NAME_MAX) err(`Stage names must be at most ${wf.NAME_MAX} characters.`);
    let pos = i + 1;
    if (slot.pos) {
      if (!/^\d{1,2}$/.test(slot.pos) || Number(slot.pos) < 1) err('Position must be a whole number from 1 to 99.');
      else pos = Number(slot.pos);
    }
    rows.push({ id: prior ? prior.id : null, name: slot.name, pos, slot: i });
  }
  // Names: unique within the role (case-insensitive) and not one of the three fixed names.
  const names = new Map();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const slotKey = `stage_${row.slot}`;
    if (Object.values(wf.FIXED_NAMES).some((n) => n.toLowerCase() === key)) {
      out.errors[slotKey] = out.errors[slotKey] || `"${row.name}" is a fixed stage of every role. Pick a different name.`;
    } else if (names.has(key)) {
      out.errors[slotKey] = out.errors[slotKey] || `"${row.name}" is already used in this workflow. Stage names must be different.`;
    }
    names.set(key, row.slot);
  }
  rows.sort((a, b) => a.pos - b.pos || a.slot - b.slot);
  out.keep = rows.map((row, i) => ({ id: row.id, name: row.name, position: i + 1, slot: row.slot }));
  if (existing) {
    out.ids = form.get('stage_ids').split(',').map((v) => v.trim()).filter((v) => /^[1-9]\d{0,15}$/.test(v)).map(Number);
    const current = existing.map((s) => s.id).sort((a, b) => a - b);
    const sent = [...new Set(out.ids)].sort((a, b) => a - b);
    if (current.length !== sent.length || current.some((v, i) => v !== sent[i])) {
      out.errors.workflow = 'The workflow was changed by someone else while you were editing. Nothing was saved: reload this page and try again.';
    }
  }
  return out;
}

// The statements that bring an existing role's stages to the submitted state. They run in the SAME batch as the role's own
// UPDATE; the guards come first and abort the whole batch if the world changed since the form was read.
function workflowStatements(roleId, existing, w, now) {
  const statements = [];
  const idList = existing.map((s) => s.id);
  statements.push(
    wf.abortIf(
      `(SELECT COUNT(*) FROM role_stages WHERE role_id = ?) != ? OR EXISTS (SELECT 1 FROM role_stages WHERE role_id = ? AND id NOT IN (${idList.map(() => '?').join(', ')}))`,
      [roleId, idList.length, roleId, ...idList]
    )
  );
  if (w.removed.length) {
    statements.push(
      wf.abortIf(`EXISTS (SELECT 1 FROM applications WHERE stage_id IN (${w.removed.map(() => '?').join(', ')}))`, w.removed.map((s) => s.id))
    );
  }
  return {
    guards: statements,
    apply: [
      ...w.removed.map((s) => ({
        sql: "DELETE FROM role_stages WHERE id = ? AND role_id = ? AND kind = 'progress' AND NOT EXISTS (SELECT 1 FROM applications WHERE stage_id = role_stages.id)",
        args: [s.id, roleId],
      })),
      ...w.keep
        .filter((k) => k.id)
        .map((k) => ({ sql: "UPDATE role_stages SET name = ?, position = ? WHERE id = ? AND role_id = ? AND kind = 'progress'", args: [k.name, k.position, k.id, roleId] })),
      { sql: "UPDATE role_stages SET position = 0 WHERE role_id = ? AND kind = 'new'", args: [roleId] },
      { sql: "UPDATE role_stages SET position = ? WHERE role_id = ? AND kind = 'onboarded'", args: [w.keep.length + 1, roleId] },
      { sql: "UPDATE role_stages SET position = ? WHERE role_id = ? AND kind = 'passed'", args: [w.keep.length + 2, roleId] },
      ...w.keep
        .filter((k) => !k.id)
        .map((k) => ({ sql: "INSERT INTO role_stages (role_id, position, name, kind, created_at) VALUES (?, ?, ?, 'progress', ?)", args: [roleId, k.position, k.name, now] })),
    ],
  };
}

function workflowSection(errors, slots, stages, counts) {
  const fixedRow = (name, note, st) => html`<li class="stage-edit-row is-fixed"><span class="stage-edit-fixed"><span class="stage-dot stage-${st}" aria-hidden="true"></span><strong>${name}</strong></span><span class="stage-edit-note">${note}</span></li>`;
  return html`<fieldset class="form-section" id="workflow">
    <legend>Workflow</legend>
    <p class="help" id="help-workflow">Candidates move through these stages from top to bottom. New, Onboarded and Passed are the same for every role. Add up to ${wf.MAX_PROGRESS} stages of your own in between: fill in a blank row. Remove one by clearing its name. Position sets the order.</p>
    ${errors.workflow ? html`<p class="error" id="err-workflow" role="alert">${errors.workflow}</p>` : ''}
    <input type="hidden" name="stage_slots" value="1">
    <input type="hidden" name="stage_ids" value="${stages.map((s) => s.id).join(',')}">
    <ol class="stage-edit">
      ${fixedRow('New', 'Fixed. Every application starts here.', 'new')}
      ${slots.map((sl, i) => {
        const n = sl.id ? counts.get(Number(sl.id)) || 0 : 0;
        return html`<li class="stage-edit-row${errors[`stage_${i}`] ? ' has-error' : ''}">
          <input type="hidden" name="stage_id_${i}" value="${sl.id}">
          <div class="field stage-edit-name"><label for="f-stage-name-${i}">Stage ${i + 1}${sl.id ? '' : ' (blank row adds a stage)'}</label>
            <input type="text" id="f-stage-name-${i}" name="stage_name_${i}" maxlength="${wf.NAME_MAX * 2}" value="${sl.name}" autocomplete="off"${errors[`stage_${i}`] ? html` aria-invalid="true" aria-describedby="err-stage-${i}"` : ''}>
            ${sl.id && n ? html`<p class="help">${wf.countWord(n)} here</p>` : ''}</div>
          <div class="field stage-edit-pos"><label for="f-stage-pos-${i}">Position</label>
            <input type="number" inputmode="numeric" min="1" max="99" id="f-stage-pos-${i}" name="stage_pos_${i}" value="${sl.pos}"></div>
          ${errors[`stage_${i}`] ? html`<p class="error" id="err-stage-${i}">${errors[`stage_${i}`]}</p>` : ''}
        </li>`;
      })}
      ${fixedRow('Onboarded', 'Fixed. The Voltax details are recorded here.', 'onboarded')}
      ${fixedRow('Passed', 'Fixed. Candidates who will not move forward.', 'passed')}
    </ol>
  </fieldset>`;
}

async function roleForm(ctx, r, { errors = {}, status = 200, notice = '' } = {}) {
  const { db } = ctx.app;
  const isNew = !r.id;
  const verticals = await db.all("SELECT DISTINCT vertical FROM job_roles WHERE vertical != '' ORDER BY vertical COLLATE NOCASE");
  const users = await db.all('SELECT id, name, email, active FROM users ORDER BY name COLLATE NOCASE, email');
  const questions = [...(r.questions || [])];
  while (questions.length < MAX_QUESTIONS) questions.push({ text: '', required: false });
  // Workflow: the role's own stages when editing, the default (or a copied) list when new.
  const stages = isNew ? [] : await wf.roleStages(db, r.id);
  const counts = new Map();
  if (!isNew) for (const row of await db.all('SELECT stage_id, COUNT(*) AS n FROM applications WHERE role_id = ? GROUP BY stage_id', [r.id])) counts.set(row.stage_id, row.n);
  const slots = r.slots || (isNew ? slotsFromNames(r.progressNames || wf.DEFAULT_PROGRESS) : slotsFromStages(stages));
  page(ctx, {
    title: isNew ? 'New role' : 'Edit role',
    status,
    body: html`<a class="back" href="/app/admin/roles">Roles</a>
      <div class="page-header">
        <div><h1>${isNew ? 'New role' : `Edit ${r.title}`}</h1></div>
        ${isNew ? '' : html`<div class="page-actions">${r.status === 'open' ? html`<a class="btn btn-secondary" href="/roles/${r.id}">View public page</a>` : ''}<a class="btn btn-secondary" href="/app/roles/${r.id}">Open pipeline</a></div>`}
      </div>
      ${summaryFor(errors, { questions: 'f-q0', workflow: 'f-stage-name-0', ...Object.fromEntries(slots.map((_, i) => [`stage_${i}`, `f-stage-name-${i}`])) })}
      ${notice ? html`<p class="flash flash-ok" id="copy-notice">${notice}</p>` : ''}
      <form method="post" action="${isNew ? '/app/admin/roles' : `/app/admin/roles/${r.id}`}" class="stack-form">
        ${csrfField(ctx)}
        <fieldset class="form-section">
          <legend>The role</legend>
          ${field(errors, 'title', 'Title', { required: true, help: 'Shown on the careers page, for example "Kansas City Chiefs contributor".' }, (a) => html`<input type="text" ${a} name="title" maxlength="200" value="${r.title || ''}" required>`)}
          <div class="field-row">
            ${field(errors, 'vertical', 'Vertical', { required: true, help: 'The group it is listed under, such as NFL or NBA.' }, (a) => html`<input type="text" ${a} name="vertical" maxlength="100" list="verticals" value="${r.vertical || ''}" required>`)}
            ${field(errors, 'site_name', 'Site name', { help: 'The FanSided site the writer would join.' }, (a) => html`<input type="text" ${a} name="site_name" maxlength="200" value="${r.site_name || ''}">`)}
          </div>
          <datalist id="verticals">${verticals.map((v) => html`<option value="${v.vertical}">`)}</datalist>
          ${field(errors, 'description', 'Description', { help: 'Plain text. Line breaks are kept, and a blank line starts a new paragraph.' }, (a) => html`<textarea ${a} name="description" rows="10" maxlength="20000">${r.description || ''}</textarea>`)}
        </fieldset>
        <fieldset class="form-section">
          <legend>Status and rep</legend>
          <div class="field-row">
            <div class="field"><label for="f-status">Status</label><p class="help" id="help-status">Closed roles disappear from the careers page.</p>
              <select name="status" id="f-status" aria-describedby="help-status">
                <option value="open"${r.status !== 'closed' ? raw(' selected') : ''}>Open</option>
                <option value="closed"${r.status === 'closed' ? raw(' selected') : ''}>Closed</option>
              </select></div>
            ${field(errors, 'assigned_user_id', 'Assigned rep', { help: 'The rep who looks after this role’s candidates.' }, (a) => html`<select ${a} name="assigned_user_id">
              <option value="">Unassigned</option>
              ${users
                .filter((u) => u.active || u.id === r.assigned_user_id)
                .map((u) => html`<option value="${u.id}"${u.id === r.assigned_user_id ? raw(' selected') : ''}>${u.name || u.email}${u.active ? '' : ' (inactive)'}</option>`)}
            </select>`)}
          </div>
        </fieldset>
        ${workflowSection(errors, slots, stages, counts)}
        <fieldset class="form-section">
          <legend>Questionnaire</legend>
          <p class="help">Up to ${MAX_QUESTIONS} questions applicants answer. Leave a row blank to skip it.${isNew ? '' : ' Editing questions does not change answers already submitted.'}</p>
          ${questions.map(
            (q, i) => html`<div class="question-row">
              <div class="field"><label for="f-q${i}">Question ${i + 1}</label><input type="text" id="f-q${i}" name="q_text_${i}" maxlength="500" value="${q.text}"></div>
              <label class="check"><input type="checkbox" name="q_required_${i}" value="1"${q.required ? raw(' checked') : ''}> Required</label>
            </div>`
          )}
          ${fieldError(errors, 'questions')}
        </fieldset>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save role</button><a class="btn btn-secondary" href="/app/admin/roles">Cancel</a></div>
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
    body: html`<div class="page-header">
        <div><h1>Users</h1><p class="lede">Everyone who can sign in to Recruit. Admins manage roles, templates and users; reps work the pipelines.</p></div>
        <div class="page-actions"><a href="#add-user" class="btn btn-quiet">Add a user</a></div>
      </div>
      ${summaryFor(errors)}
      ${link
        ? html`<section class="card link-box" id="new-link">
            <h2>${link.kind === 'invite' ? 'Invite link' : 'Password reset link'} for ${linkEmail}</h2>
            <p><strong>Copy this link now and send it to them. It is shown only once</strong> and works once
              (${link.kind === 'invite' ? `${INVITE_DAYS} days` : `${RESET_HOURS} hours`}).${link.relative ? ' BASE_URL is not set: put your site address in front of it.' : ''}</p>
            <div class="field"><label for="link-url">Link</label><input type="text" readonly id="link-url" class="wide" value="${link.url}" size="80"></div>
          </section>`
        : ''}
      <div class="table-wrap"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="num">Roles assigned</th><th>Actions</th></tr></thead><tbody>
        ${users.map(
          (u) => html`<tr class="${u.active ? '' : 'inactive'}" data-user-id="${u.id}">
            <td><form method="post" action="/app/admin/users/${u.id}/name" class="inline nowrap">${csrfField(ctx)}
              <input type="text" name="name" value="${u.name}" maxlength="200" required aria-label="Display name for ${u.email}" placeholder="Display name">
              <button type="submit" class="btn btn-sm btn-secondary">Save name</button></form></td>
            <td class="wrap">${u.email}</td>
            <td><form method="post" action="/app/admin/users/${u.id}/role" class="inline nowrap">${csrfField(ctx)}
              <select name="role" aria-label="Role for ${u.email}">
                <option value="rep"${u.role === 'rep' ? raw(' selected') : ''}>Rep</option>
                <option value="admin"${u.role === 'admin' ? raw(' selected') : ''}>Admin</option>
              </select> <button type="submit" class="btn btn-sm btn-secondary">Change role</button></form></td>
            <td class="status-cell">${statusOf(u)}</td>
            <td class="num">${u.role_count}</td>
            <td><div class="row-actions">${u.active
              ? html`<form method="post" action="/app/admin/users/${u.id}/reset-link" class="inline">${csrfField(ctx)}<button type="submit" class="link">${u.has_password ? 'Create reset link' : 'Create invite link'}</button></form>
                 <a class="danger-link" href="/app/admin/users/${u.id}/deactivate">Deactivate<span class="visually-hidden"> ${u.name || u.email}</span></a>`
              : html`<form method="post" action="/app/admin/users/${u.id}/reactivate" class="inline">${csrfField(ctx)}<button type="submit" class="link">Reactivate</button></form>`}</div></td>
          </tr>`
        )}
      </tbody></table></div>
      <section class="card centred-card" id="add-user">
        <h2>Add a user</h2>
        <p class="fine-print">You get a single-use invite link to send to them. They choose their own password.</p>
        <form method="post" action="/app/admin/users">
          ${csrfField(ctx)}
          ${field(errors, 'email', 'Email', { required: true }, (a) => html`<input type="email" ${a} name="email" maxlength="254" value="${values.email || ''}" required>`)}
          ${field(errors, 'name', 'Name', { required: true, help: 'Shown to the team and on assigned roles.' }, (a) => html`<input type="text" ${a} name="name" maxlength="200" value="${values.name || ''}" required>`)}
          <div class="field"><label for="f-role-new">Role</label>
            <select name="role" id="f-role-new">
              <option value="rep"${values.role !== 'admin' ? raw(' selected') : ''}>Rep</option>
              <option value="admin"${values.role === 'admin' ? raw(' selected') : ''}>Admin</option>
            </select></div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Create invite link</button></div>
        </form>
      </section>`,
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

// ---------- Sample data ----------

async function samplePage(ctx) {
  const c = await sampleCounts(ctx.app.db);
  page(ctx, {
    title: 'Sample data',
    body: html`<div class="page-header"><div><h1>Sample data</h1></div></div>
      <div class="card wrap-read">
        <h2>Demo records for trying the app</h2>
        <p>Sample data fills Recruit with ${ROLES.length} open roles and ${PEOPLE_COUNT} candidates spread across every stage, so you can see how the dashboard, pipeline and candidate pages look when they are busy. The candidates are made up and use <code>@sample.invalid</code> addresses, which cannot receive email.</p>
        <p>Your real roles and candidates are never touched. When you are done, remove the sample data in one step.</p>
        <p><strong>${c.loaded ? `Sample data is loaded: ${c.roles} roles, ${c.people} candidates, ${c.applications} applications.` : 'No sample data is loaded.'}</strong></p>
        <div class="form-actions">
          <form method="post" action="/app/admin/sample/load" class="inline">${csrfField(ctx)}
            <button type="submit" class="btn btn-primary"${c.loaded ? raw(' disabled') : ''}>Load sample data</button></form>
          ${c.loaded
            ? html`<a class="btn btn-danger" href="/app/admin/sample/remove">Remove sample data</a>`
            : html`<button type="button" class="btn btn-danger" disabled>Remove sample data</button>`}
        </div>
        <p class="muted small">Removing deletes the sample candidates and everything attached to them. A sample role that has received a real application is closed and kept.</p>
      </div>`,
  });
}

// Confirmation pages for destructive actions: plain GET pages (they change nothing) whose button POSTs with the
// CSRF token, so the confirmation works without JavaScript.
async function sampleRemoveConfirm(ctx) {
  const c = await sampleCounts(ctx.app.db);
  if (!c.loaded) {
    setFlash(ctx, 'ok', 'No sample data is loaded.');
    return ctx.redirect('/app/admin/sample');
  }
  page(ctx, {
    title: 'Remove sample data',
    body: html`<div class="card card-danger centred-card">
      <h1>Remove the sample data?</h1>
      <p>This deletes the ${c.roles} sample roles, ${c.people} sample candidates and ${c.applications} applications, with their notes and activity. Your real roles and candidates are not touched.</p>
      <p><strong>This cannot be undone.</strong> A sample role that has received a real application is closed and kept.</p>
      <form method="post" action="/app/admin/sample/remove" class="form-actions">
        ${csrfField(ctx)}
        <button type="submit" class="btn btn-danger">Yes, remove sample data</button>
        <a class="btn btn-secondary" href="/app/admin/sample">Cancel</a>
      </form>
    </div>`,
  });
}

async function templateDeleteConfirm(ctx) {
  const t = await getTemplate(ctx.app.db, ctx.params.id);
  page(ctx, {
    title: 'Delete template',
    body: html`<div class="card card-danger centred-card">
      <h1>Delete the template "${t.name}"?</h1>
      <p>Reps will no longer be able to load it into the email composer. Emails already logged keep their text.</p>
      <p><strong>This cannot be undone.</strong></p>
      <form method="post" action="/app/admin/templates/${t.id}/delete" class="form-actions">
        ${csrfField(ctx)}
        <button type="submit" class="btn btn-danger">Yes, delete template</button>
        <a class="btn btn-secondary" href="/app/admin/templates">Cancel</a>
      </form>
    </div>`,
  });
}

// Shared by the confirm page (GET) and the POST that finds a user still assigned to roles.
async function deactivatePage(ctx, u, roles) {
  const who = u.name || u.email;
  page(ctx, {
    title: 'Deactivate user',
    body: html`<div class="card card-danger centred-card">
      <h1>Deactivate ${who}?</h1>
      <p>${who} will be signed out and can no longer sign in. You can reactivate them later.</p>
      ${roles.length
        ? html`<p class="flash flash-error">Warning: ${who} is still the assigned rep for ${roles.length} role${roles.length === 1 ? '' : 's'}.</p>
          <ul>${roles.map((r) => html`<li><a href="/app/roles/${r.id}">${r.title}</a>${r.status === 'closed' ? ' (closed)' : ''}</li>`)}</ul>
          <p>Reassign ${roles.length === 1 ? 'this role' : 'these roles'} after deactivating.</p>`
        : ''}
      <form method="post" action="/app/admin/users/${u.id}/deactivate" class="form-actions">
        ${csrfField(ctx)}<input type="hidden" name="confirm" value="1">
        <button type="submit" class="btn btn-danger">${roles.length ? 'Deactivate anyway' : 'Yes, deactivate'}</button>
        <a class="btn btn-secondary" href="/app/admin/users">Cancel</a>
      </form>
    </div>`,
  });
}

function register(router) {
  const A = [requireAdmin];
  const AP = [requireAdmin, internalForm];

  // Sample data
  router.get('/app/admin/sample', ...A, samplePage);
  router.post('/app/admin/sample/load', ...AP, async (ctx) => {
    const r = await loadSample(ctx.app.db, ctx.user.id);
    if (r.failed) setFlash(ctx, 'error', 'Sample data could not be loaded (another load may have run at the same moment). Reload this page to see the current state.');
    else if (!r.ok) setFlash(ctx, 'error', 'Sample data is already loaded. Remove it first.');
    else {
      ctx.app.log(`[admin] sample data loaded by=${ctx.user.id}`);
      setFlash(ctx, 'ok', `Loaded ${r.roles} sample roles and ${r.people} sample people.`);
    }
    ctx.redirect('/app/admin/sample');
  });
  router.get('/app/admin/sample/remove', ...A, sampleRemoveConfirm);
  router.post('/app/admin/sample/remove', ...AP, async (ctx) => {
    await removeSample(ctx.app.db);
    ctx.app.log(`[admin] sample data removed by=${ctx.user.id}`);
    setFlash(ctx, 'ok', 'Sample data removed.');
    ctx.redirect('/app/admin/sample');
  });

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
  router.get('/app/admin/templates/:id/delete', ...A, templateDeleteConfirm);
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
  router.get('/app/admin/roles/new', ...A, async (ctx) => {
    // ?copy=<id> pre-fills the form from an existing role (nothing is created until the admin saves). Anything that is not
    // the id of an existing role gives the plain empty form.
    const { db } = ctx.app;
    const copyId = ctx.query.get('copy') || '';
    const source = /^[1-9]\d{0,15}$/.test(copyId) ? await db.get('SELECT * FROM job_roles WHERE id = ?', [Number(copyId)]) : null;
    if (!source) return roleForm(ctx, { status: 'open', assigned_user_id: ctx.user.id, questions: [] });
    const stages = await wf.roleStages(db, source.id);
    const rep = source.assigned_user_id ? await db.get('SELECT id FROM users WHERE id = ? AND active = 1', [source.assigned_user_id]) : null;
    let questions = [];
    try {
      questions = JSON.parse(source.questions_json || '[]');
    } catch {
      questions = [];
    }
    return roleForm(
      ctx,
      {
        title: `Copy of ${source.title}`.slice(0, 200),
        vertical: source.vertical,
        site_name: source.site_name,
        description: source.description,
        status: 'closed',
        assigned_user_id: rep ? rep.id : null,
        questions,
        progressNames: stages.filter((s) => s.kind === 'progress').map((s) => s.name),
      },
      { notice: `You are copying "${source.title}": its description, questions, workflow and rep are filled in. Candidates are not copied. The copy starts as Closed so it is not published by accident. Nothing is created until you save.` }
    );
  });
  router.post('/app/admin/roles', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const { r, errors } = readRole(ctx);
    const w = readWorkflow(ctx.form, null);
    Object.assign(errors, w.errors);
    await checkAssignee(db, r, errors, null);
    if (Object.keys(errors).length) return roleForm(ctx, { ...r, slots: w.present ? w.slots : undefined }, { errors, status: 400 });
    const now = nowIso();
    const progress = w.present ? w.keep.map((k) => k.name) : wf.DEFAULT_PROGRESS;
    // The role and its stages are one atomic batch: a role never exists without its workflow.
    const results = await db.batch([
      {
        sql: 'INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [r.title, r.vertical, r.site_name, r.description, r.status, r.assigned_user_id, JSON.stringify(r.questions), now, now],
      },
      ...wf.insertStagesAfterRole(progress, now),
    ]);
    setFlash(ctx, 'ok', 'Role created.');
    ctx.redirect(`/app/admin/roles/${results[0].lastInsertRowid}`);
  });
  router.get('/app/admin/roles/:id', ...A, async (ctx) => roleForm(ctx, await getRole(ctx.app.db, ctx.params.id)));
  router.post('/app/admin/roles/:id', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const existing = await getRole(db, ctx.params.id);
    const stages = await wf.roleStages(db, existing.id);
    const counts = new Map();
    for (const row of await db.all('SELECT stage_id, COUNT(*) AS n FROM applications WHERE role_id = ? GROUP BY stage_id', [existing.id])) counts.set(row.stage_id, row.n);
    const { r, errors } = readRole(ctx);
    const w = readWorkflow(ctx.form, stages, counts);
    Object.assign(errors, w.errors);
    await checkAssignee(db, r, errors, existing.assigned_user_id);
    if (Object.keys(errors).length) return roleForm(ctx, { ...r, id: existing.id, slots: w.present ? w.slots : undefined }, { errors, status: 400 });
    const now = nowIso();
    const roleUpdate = {
      sql: 'UPDATE job_roles SET title = ?, vertical = ?, site_name = ?, description = ?, status = ?, assigned_user_id = ?, questions_json = ?, updated_at = ? WHERE id = ?',
      args: [r.title, r.vertical, r.site_name, r.description, r.status, r.assigned_user_id, JSON.stringify(r.questions), now, existing.id],
    };
    // Role fields and workflow are ONE batch. The guards come first: if the set of stages changed, or a stage being
    // removed has gained a candidate, since the form was read, the batch aborts and nothing at all is saved.
    const statements = [roleUpdate];
    if (w.present) {
      const ws = workflowStatements(existing.id, stages, w, now);
      statements.unshift(...ws.guards);
      statements.push(...ws.apply);
    }
    try {
      await db.batch(statements);
    } catch (err) {
      if (!wf.isGuardFailure(err)) throw err;
      return roleForm(
        ctx,
        { ...r, id: existing.id, slots: w.slots },
        { errors: { workflow: 'The workflow was changed by someone else (or a candidate moved into a stage you removed) while you were saving. Nothing was saved: reload this page and try again.' }, status: 409 }
      );
    }
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
      // The admin acting on the account also lifts its login lock (recorded failures of this email).
      {
        sql: 'DELETE FROM rate_limits WHERE grp = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1)',
        args: [rateKey(ctx.app.config.secret, 'login-group', normaliseEmail(u.email)), u.id],
      },
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
      setFlash(ctx, 'ok', `Name saved for ${name}.`);
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
    else setFlash(ctx, 'ok', `${u.name || u.email} is now ${role === 'admin' ? 'an admin' : 'a rep'}.`);
    ctx.redirect('/app/admin/users');
  });
  router.get('/app/admin/users/:id/deactivate', ...A, async (ctx) => {
    const { db } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    if (u.id === ctx.user.id) {
      setFlash(ctx, 'error', 'You cannot deactivate yourself.');
      return ctx.redirect('/app/admin/users');
    }
    if (!u.active) return ctx.redirect('/app/admin/users');
    await deactivatePage(ctx, u, await db.all('SELECT id, title, status FROM job_roles WHERE assigned_user_id = ? ORDER BY title', [u.id]));
  });
  router.post('/app/admin/users/:id/deactivate', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    if (u.id === ctx.user.id) {
      setFlash(ctx, 'error', 'You cannot deactivate yourself.');
      return ctx.redirect('/app/admin/users');
    }
    const roles = await db.all('SELECT id, title, status FROM job_roles WHERE assigned_user_id = ? ORDER BY title', [u.id]);
    if (roles.length && ctx.form.get('confirm') !== '1') return deactivatePage(ctx, u, roles);
    // One atomic batch. The last-admin and not-yourself guards are inside the UPDATE; sessions and unused
    // links are only removed once the user really is inactive.
    const results = await db.batch([
      { sql: `UPDATE users SET active = 0 WHERE id = ? AND id != ? AND ${NOT_LAST_ADMIN}`, args: [u.id, ctx.user.id] },
      { sql: 'DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 0)', args: [u.id, u.id] },
      { sql: 'DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 0)', args: [u.id, u.id] },
    ]);
    if (results[0].changes === 0) setFlash(ctx, 'error', 'You cannot deactivate the last active admin.');
    else setFlash(ctx, 'ok', `${u.name || u.email} deactivated.`);
    ctx.redirect('/app/admin/users');
  });
  router.post('/app/admin/users/:id/reactivate', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const u = await getUser(db, ctx.params.id);
    await db.run('UPDATE users SET active = 1 WHERE id = ?', [u.id]);
    setFlash(ctx, 'ok', 'Reactivated. Create a reset link so they can sign in.');
    ctx.redirect('/app/admin/users');
  });
}

module.exports = { register };

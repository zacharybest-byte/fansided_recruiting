'use strict';
// Admin screens for questionnaires: named, reusable lists of questions that roles select.
// Editing a questionnaire changes the apply form of every role that uses it, straight away. Answers already submitted
// are snapshots (question text + answer), so they never change.
const { html, raw } = require('../lib/render');
const { page, setFlash } = require('../lib/layout');
const { requireAdmin } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso } = require('../lib/db');
const { idParam } = require('./dashboard');
const { field, fieldError, summaryFor, questionList } = require('../lib/forms');
const qn = require('../lib/questionnaires');
const { countWord } = require('../lib/stages');

const usedBy = (n) => `Used by ${countWord(n, 'role')}`;

function roleLinks(roles) {
  return html`<ul class="qn-roles">${roles.map((r) => html`<li><a href="/app/admin/roles/${r.id}">${r.title}</a></li>`)}</ul>`;
}

async function listPage(ctx) {
  const all = await qn.listAll(ctx.app.db);
  page(ctx, {
    title: 'Questionnaires',
    body: html`<div class="page-header">
        <div><h1>Questionnaires</h1><p class="lede">Reusable sets of application questions. Pick one on each role; change it here and every role that uses it changes with it.</p></div>
        <div class="page-actions"><a href="/app/admin/questionnaires/new" class="btn btn-primary">New questionnaire</a></div>
      </div>
      ${all.length === 0
        ? html`<div class="empty"><h2>No questionnaires yet</h2><p>Write the questions you ask applicants once, then pick them on as many roles as you like.</p>
            <p><a class="btn btn-primary" href="/app/admin/questionnaires/new">Create the first questionnaire</a></p></div>`
        : html`<div class="table-wrap table-stack"><table class="data" id="questionnaires-table"><thead><tr><th>Name</th><th class="num">Questions</th><th>Used by</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
        ${all.map(
          (q) => html`<tr data-questionnaire-id="${q.id}"><td data-label="Name"><a href="/app/admin/questionnaires/${q.id}"><strong>${q.name}</strong></a></td>
            <td class="num" data-label="Questions">${q.questions.length}</td>
            <td data-label="Used by">${q.roles.length ? html`<strong>${usedBy(q.roles.length)}</strong>${roleLinks(q.roles)}` : html`<span class="muted">Not used by any role</span>`}</td>
            <td data-label="Actions"><div class="row-actions"><a href="/app/admin/questionnaires/${q.id}">Edit<span class="visually-hidden"> ${q.name}</span></a>
              <a href="/app/admin/questionnaires/new?copy=${q.id}">Duplicate<span class="visually-hidden"> ${q.name}</span></a>
              <a class="danger-link" href="/app/admin/questionnaires/${q.id}/delete">Delete<span class="visually-hidden"> ${q.name}</span></a></div></td></tr>`
        )}
      </tbody></table></div>`}`,
  });
}

// q: { id?, name, questions: [{text, required}], roles? }
function form(ctx, q, { errors = {}, status = 200, notice = '' } = {}) {
  const isNew = !q.id;
  const rows = [...(q.questions || [])];
  while (rows.length < qn.MAX_QUESTIONS) rows.push({ text: '', required: false });
  const roles = q.roles || [];
  page(ctx, {
    title: isNew ? 'New questionnaire' : 'Edit questionnaire',
    status,
    body: html`<a class="back" href="/app/admin/questionnaires">Questionnaires</a>
      <div class="page-header"><div><h1>${isNew ? 'New questionnaire' : `Edit ${q.name}`}</h1></div></div>
      ${summaryFor(errors, { questions: 'f-q0' })}
      ${notice ? html`<p class="flash flash-ok" id="copy-notice">${notice}</p>` : ''}
      ${roles.length
        ? html`<section class="card notice-card" id="in-use" aria-labelledby="in-use-h"><h2 id="in-use-h">${usedBy(roles.length)}.</h2>
            <p>Changes apply to ${roles.length === 1 ? 'it' : 'all of them'} straight away. Answers already submitted do not change.</p>${roleLinks(roles)}</section>`
        : ''}
      <form method="post" action="${isNew ? '/app/admin/questionnaires' : `/app/admin/questionnaires/${q.id}`}" class="stack-form">
        ${csrfField(ctx)}
        <fieldset class="form-section">
          <legend>The questionnaire</legend>
          ${field(errors, 'name', 'Name', { required: true, help: `Roles pick a questionnaire by this name, so make it recognisable, for example "NBA team sites". Up to ${qn.NAME_MAX} characters, different from every other questionnaire.` }, (a) => html`<input type="text" ${a} name="name" maxlength="${qn.NAME_MAX * 2}" value="${q.name || ''}" required>`)}
        </fieldset>
        <fieldset class="form-section">
          <legend>Questions</legend>
          <p class="help">Up to ${qn.MAX_QUESTIONS} questions applicants answer, in this order. Leave a row blank to skip it. Editing questions does not change answers already submitted.</p>
          ${rows.map(
            (r, i) => html`<div class="question-row">
              <div class="field"><label for="f-q${i}">Question ${i + 1}</label><input type="text" id="f-q${i}" name="q_text_${i}" maxlength="${qn.QUESTION_MAX * 2}" value="${r.text}"></div>
              <label class="check"><input type="checkbox" name="q_required_${i}" value="1"${r.required ? raw(' checked') : ''}> Required</label>
            </div>`
          )}
          ${fieldError(errors, 'questions')}
        </fieldset>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Save questionnaire</button><a class="btn btn-secondary" href="/app/admin/questionnaires">Cancel</a></div>
      </form>`,
  });
}

function read(ctx) {
  const f = ctx.form;
  const q = { name: qn.cleanName(f.get('name')), questions: [] };
  const errors = {};
  for (let i = 0; i < qn.MAX_QUESTIONS; i++) {
    const text = f.get(`q_text_${i}`).replace(/\s+/g, ' ').trim();
    if (text) q.questions.push({ text, required: f.get(`q_required_${i}`) === '1' });
    if (text.length > qn.QUESTION_MAX) errors.questions = `Questions must be at most ${qn.QUESTION_MAX} characters.`;
  }
  if (!q.name) errors.name = 'Name is required.';
  else if (q.name.length > qn.NAME_MAX) errors.name = `Name must be at most ${qn.NAME_MAX} characters.`;
  else if (/[\u0000-\u001f\u007f]/.test(q.name)) errors.name = 'Name cannot contain control characters.';
  if (!errors.questions && q.questions.length === 0) errors.questions = 'Add at least one question. To ask nothing, choose "None" on the role instead.';
  return { q, errors };
}

async function nameTaken(db, name, exceptId) {
  return Boolean(await db.get('SELECT id FROM questionnaires WHERE name = ? COLLATE NOCASE AND id != ?', [name, exceptId || 0]));
}

const TAKEN = 'Another questionnaire already has this name. Names must be different (capital letters do not count).';

async function getOr404(db, id) {
  const q = await qn.getOne(db, idParam(id));
  if (!q) throw new HttpError(404, 'Questionnaire not found');
  return q;
}

async function deletePage(ctx, q, { status = 200 } = {}) {
  const inUse = q.roles.length > 0;
  page(ctx, {
    title: 'Delete questionnaire',
    status,
    body: html`<a class="back" href="/app/admin/questionnaires">Questionnaires</a>
      <div class="page-header"><div><h1>Delete ${q.name}</h1></div></div>
      <div class="card ${inUse ? '' : 'card-danger'}">
        ${inUse
          ? html`<h2>This questionnaire is in use</h2>
            <p class="flash flash-error" role="alert">It cannot be deleted while ${countWord(q.roles.length, 'role')} use${q.roles.length === 1 ? 's' : ''} it. Switch these roles to another questionnaire (or None) first.</p>${roleLinks(q.roles)}
            <p><a class="btn btn-secondary" href="/app/admin/questionnaires">Back to questionnaires</a></p>`
          : html`<p>Delete the questionnaire <strong>${q.name}</strong> and its ${countWord(q.questions.length, 'question')}? No role uses it. Answers already submitted are not affected.</p>
            <form method="post" action="/app/admin/questionnaires/${q.id}/delete">${csrfField(ctx)}
              <button type="submit" class="btn btn-danger">Yes, delete questionnaire</button>
              <a class="btn btn-secondary" href="/app/admin/questionnaires">Cancel</a></form>`}
      </div>`,
  });
}

function register(router) {
  const A = [requireAdmin];
  const AP = [requireAdmin, internalForm];

  router.get('/app/admin/questionnaires', ...A, listPage);
  router.get('/app/admin/questionnaires/new', ...A, async (ctx) => {
    // ?copy=<id> pre-fills the form from an existing questionnaire; nothing is created until the admin saves.
    const copyId = ctx.query.get('copy') || '';
    const source = /^[1-9]\d{0,15}$/.test(copyId) ? await qn.getOne(ctx.app.db, Number(copyId)) : null;
    if (!source) return form(ctx, { name: '', questions: [] });
    return form(ctx, { name: `Copy of ${source.name}`.slice(0, qn.NAME_MAX), questions: source.questions }, {
      notice: `You are copying "${source.name}": its questions are filled in. Give the copy its own name. Nothing is created until you save, and roles keep using the original.`,
    });
  });
  router.post('/app/admin/questionnaires', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const { q, errors } = read(ctx);
    if (!errors.name && (await nameTaken(db, q.name))) errors.name = TAKEN;
    if (Object.keys(errors).length) return form(ctx, q, { errors, status: 400 });
    const now = nowIso();
    let result;
    try {
      // The name check is repeated in SQL (and by the unique index), so two admins saving the same name cannot both win.
      [result] = await db.batch([
        {
          sql: 'INSERT INTO questionnaires (name, questions_json, is_sample, created_at, updated_at) SELECT ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM questionnaires WHERE name = ? COLLATE NOCASE)',
          args: [q.name, qn.serialise(q.questions), now, now, q.name],
        },
      ]);
    } catch (err) {
      if (!qn.isDuplicateName(err)) throw err;
      result = { changes: 0 };
    }
    if (!result.changes) return form(ctx, q, { errors: { name: TAKEN }, status: 409 });
    setFlash(ctx, 'ok', 'Questionnaire created.');
    ctx.redirect('/app/admin/questionnaires');
  });
  router.get('/app/admin/questionnaires/:id', ...A, async (ctx) => form(ctx, await getOr404(ctx.app.db, ctx.params.id)));
  router.post('/app/admin/questionnaires/:id', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const existing = await getOr404(db, ctx.params.id);
    const { q, errors } = read(ctx);
    if (!errors.name && (await nameTaken(db, q.name, existing.id))) errors.name = TAKEN;
    const withId = { ...q, id: existing.id, roles: existing.roles };
    if (Object.keys(errors).length) return form(ctx, withId, { errors, status: 400 });
    const now = nowIso();
    const json = qn.serialise(q.questions);
    try {
      // One batch: the questionnaire and the legacy copy on every role that uses it. Guards first: it must still exist
      // and no other questionnaire may hold the name.
      await db.batch([
        qn.abortIf('NOT EXISTS (SELECT 1 FROM questionnaires WHERE id = ?)', [existing.id]),
        qn.abortIf('EXISTS (SELECT 1 FROM questionnaires WHERE id != ? AND name = ? COLLATE NOCASE)', [existing.id, q.name]),
        { sql: 'UPDATE questionnaires SET name = ?, questions_json = ?, updated_at = ? WHERE id = ?', args: [q.name, json, now, existing.id] },
        { sql: 'UPDATE job_roles SET questions_json = ? WHERE questionnaire_id = ?', args: [json, existing.id] },
      ]);
    } catch (err) {
      if (!qn.isGuardFailure(err) && !qn.isDuplicateName(err)) throw err;
      const gone = !(await db.get('SELECT id FROM questionnaires WHERE id = ?', [existing.id]));
      if (gone) throw new HttpError(404, 'Questionnaire not found');
      return form(ctx, withId, { errors: { name: TAKEN }, status: 409 });
    }
    setFlash(ctx, 'ok', existing.roles.length ? `Questionnaire saved. ${usedBy(existing.roles.length)}, and they use the new questions now.` : 'Questionnaire saved.');
    ctx.redirect('/app/admin/questionnaires');
  });
  router.get('/app/admin/questionnaires/:id/delete', ...A, async (ctx) => deletePage(ctx, await getOr404(ctx.app.db, ctx.params.id)));
  router.post('/app/admin/questionnaires/:id/delete', ...AP, async (ctx) => {
    const { db } = ctx.app;
    const q = await getOr404(db, ctx.params.id);
    // The "not in use" check is part of the DELETE itself.
    const r = await db.run('DELETE FROM questionnaires WHERE id = ? AND NOT EXISTS (SELECT 1 FROM job_roles WHERE questionnaire_id = ?)', [q.id, q.id]);
    if (!r.changes) return deletePage(ctx, await getOr404(db, q.id), { status: 409 });
    ctx.app.log(`[admin] questionnaire deleted id=${q.id} by=${ctx.user.id}`);
    setFlash(ctx, 'ok', `Questionnaire "${q.name}" deleted.`);
    ctx.redirect('/app/admin/questionnaires');
  });
}

module.exports = { register };

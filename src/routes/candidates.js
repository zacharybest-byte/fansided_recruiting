'use strict';
// Internal: candidate page and its actions (stage, role move, Voltax, notes, email, file, delete).
const fs = require('node:fs');
const path = require('node:path');
const { html, raw, link, multiline } = require('../lib/render');
const { page, setFlash, STAGES, STAGE_LABELS, fmtDate, fmtDateTime } = require('../lib/layout');
const { requireUser, requireAdmin } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso } = require('../lib/db');
const { applyMergeFields, firstName, MERGE_FIELDS } = require('../lib/email');
const { todayIn, isValidYmd } = require('../lib/time');
const { idParam, stageSelect } = require('./dashboard');
const voltax = require('../voltax');

const EMAIL_FAILED = 'Email not sent: please sign out and in again.';

async function loadApplication(db, id) {
  const app = await db.get(
    `SELECT a.*, r.title AS role_title, r.status AS role_status, r.vertical, r.site_name
       FROM applications a JOIN job_roles r ON r.id = a.role_id WHERE a.id = ?`,
    [id]
  );
  if (!app) throw new HttpError(404, 'Application not found');
  const person = await db.get('SELECT * FROM people WHERE id = ?', [app.person_id]);
  return { app, person };
}

// Only redirect back to internal pages.
function returnTo(ctx, fallback) {
  const v = ctx.form.get('return_to');
  return /^\/app\/[a-z0-9/_-]*$/i.test(v) ? v : fallback;
}

function describeEvent(e) {
  if (e.type === 'stage_change') {
    return e.from_value
      ? `Stage: ${STAGE_LABELS[e.from_value] || e.from_value} → ${STAGE_LABELS[e.to_value] || e.to_value}`
      : `Applied (stage ${STAGE_LABELS[e.to_value] || e.to_value})`;
  }
  if (e.type === 'role_change') return `Role: ${e.from_value} → ${e.to_value}`;
  if (e.type === 'voltax_recorded') return `Voltax recorded: ${e.to_value}`;
  return e.type;
}

async function candidatePage(ctx) {
  const { db, config } = ctx.app;
  const id = idParam(ctx.params.id);
  const { app, person } = await loadApplication(db, id);
  const isAdmin = ctx.user.role === 'admin';
  const roles = await db.all("SELECT id, title, status, site_name FROM job_roles ORDER BY status = 'closed', title COLLATE NOCASE");
  const answers = JSON.parse(app.answers_json || '[]');
  const notes = await db.all(
    `SELECT n.*, u.name AS author_name, u.email AS author_email, r.title AS role_title
       FROM notes n
       LEFT JOIN users u ON u.id = n.author_user_id
       LEFT JOIN job_roles r ON r.id = n.role_id
      WHERE n.person_id = ? ORDER BY n.created_at DESC, n.id DESC`,
    [person.id]
  );
  const events = await db.all(
    `SELECT e.*, u.name AS actor_name, u.email AS actor_email FROM application_events e
       LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.application_id = ? ORDER BY e.at, e.id`,
    [app.id]
  );
  const emails = await db.all(
    `SELECT m.*, u.name AS sender_name, u.email AS sender_email, r.title AS role_title
       FROM emails_sent m
       LEFT JOIN users u ON u.id = m.sender_user_id
       LEFT JOIN job_roles r ON r.id = m.role_id
      WHERE m.person_id = ? ORDER BY m.sent_at DESC, m.id DESC`,
    [person.id]
  );
  const history = await db.all(
    `SELECT a.id, a.stage, a.applied_at, r.title AS role_title FROM applications a JOIN job_roles r ON r.id = a.role_id
      WHERE a.person_id = ? AND a.id != ? ORDER BY a.applied_at DESC`,
    [person.id, app.id]
  );
  const templates = await db.all('SELECT id, name, subject, body FROM email_templates ORDER BY name COLLATE NOCASE');

  // Email composer: "Load" is a plain GET (?template=ID) so it works without JS.
  let draft = { subject: '', body: '', templateId: '', unknown: [] };
  const tplId = ctx.query.get('template');
  if (tplId) {
    const tpl = templates.find((t) => String(t.id) === tplId);
    if (tpl) {
      const values = { first_name: firstName(person.name), role_title: app.role_title, rep_name: ctx.user.name || ctx.user.email };
      const s = applyMergeFields(tpl.subject, values);
      const b = applyMergeFields(tpl.body, values);
      draft = { subject: s.text, body: b.text, templateId: tpl.id, unknown: [...new Set([...s.unknown, ...b.unknown])] };
    }
  }
  const linkedin = person.linkedin_url;
  const today = todayIn(config.timezone);

  page(ctx, {
    title: person.name,
    body: html`<p><a href="/app/roles/${app.role_id}">← ${app.role_title}</a></p>
      <header class="candidate-header">
        <h1>${person.name}</h1>
        <p><a href="mailto:${person.email}">${person.email}</a>${linkedin ? html` · ${link(linkedin, 'LinkedIn / portfolio')}` : ''}</p>
        <p>Role: <strong>${app.role_title}</strong>${app.role_status === 'closed' ? ' (closed)' : ''}
           · Stage: <strong class="stage-badge stage-${app.stage}">${STAGE_LABELS[app.stage]}</strong>
           · Applied ${fmtDateTime(ctx, app.applied_at)}</p>
      </header>

      <div class="grid">
      <div class="col">
        <section class="card">
          <h2>Change stage</h2>
          <form method="post" action="/app/applications/${app.id}/stage" class="stacked" id="stage-form">
            ${csrfField(ctx)}
            <label>New stage ${stageSelect(app.stage)}</label>
            <div class="voltax-fields" data-show-for="onboarded" data-current="${app.stage}">
              <p class="muted">When moving to Onboarded, record the Voltax account (Voltax API is not connected yet, so enter it by hand).</p>
              <label>Voltax user ID <input type="text" name="voltax_user_id" maxlength="100"></label>
              <label>Onboarded date <input type="date" name="voltax_onboarded_on" value="${today}"></label>
            </div>
            <p><button type="submit">Save stage</button></p>
          </form>
          ${app.stage === 'onboarded'
            ? html`<h3 id="voltax">Voltax</h3>
              <p>User ID: ${app.voltax_user_id || html`<span class="muted">not recorded</span>`}
                 · Onboarded on: ${app.voltax_onboarded_on || html`<span class="muted">not recorded</span>`}</p>
              <form method="post" action="/app/applications/${app.id}/voltax" class="inline">
                ${csrfField(ctx)}
                <label>Voltax user ID <input type="text" name="voltax_user_id" maxlength="100" value="${app.voltax_user_id || ''}" required></label>
                <label>Date <input type="date" name="voltax_onboarded_on" value="${app.voltax_onboarded_on || today}"></label>
                <button type="submit">Record</button>
              </form>`
            : ''}
        </section>

        <section class="card">
          <h2>Move to another role</h2>
          <form method="post" action="/app/applications/${app.id}/role" class="inline">
            ${csrfField(ctx)}
            <select name="role_id" aria-label="Role">
              ${roles.map(
                (r) => html`<option value="${r.id}"${r.id === app.role_id ? raw(' selected') : ''}>${r.title}${r.site_name ? ` (${r.site_name})` : ''}${r.status === 'closed' ? ' [closed]' : ''}</option>`
              )}
            </select>
            <button type="submit">Move</button>
          </form>
        </section>

        <section class="card">
          <h2>Application</h2>
          <dl class="details">
            <dt>Writing samples</dt>
            <dd><ul class="plain">${String(app.sample_links || '').split('\n').filter(Boolean).map((l) => html`<li>${link(l)}</li>`)}</ul></dd>
            <dt>File</dt>
            <dd>${app.file_path ? html`<a href="/app/applications/${app.id}/file">${app.file_name || 'Download'}</a>` : html`<span class="muted">None</span>`}</dd>
            ${answers.map((a) => html`<dt>${a.question}</dt><dd>${a.answer ? multiline(a.answer) : html`<span class="muted">No answer</span>`}</dd>`)}
            <dt>Source</dt><dd>${app.source_tag || html`<span class="muted">None</span>`}</dd>
            <dt>How they heard about us</dt><dd>${app.heard_from || html`<span class="muted">Not given</span>`}</dd>
          </dl>
        </section>

        <section class="card" id="history">
          <h2>History</h2>
          ${history.length === 0
            ? html`<p class="muted">No other applications.</p>`
            : html`<div class="table-wrap"><table class="data"><thead><tr><th>Role</th><th>Applied</th><th>Stage</th></tr></thead><tbody>
              ${history.map(
                (h) => html`<tr><td><a href="/app/applications/${h.id}">${h.role_title}</a></td><td>${fmtDate(ctx, h.applied_at)}</td><td>${STAGE_LABELS[h.stage]}</td></tr>`
              )}</tbody></table></div>`}
        </section>
      </div>

      <div class="col">
        <section class="card" id="notes">
          <h2>Notes</h2>
          <form method="post" action="/app/applications/${app.id}/notes" class="stacked">
            ${csrfField(ctx)}
            <label>Add a note <textarea name="body" rows="3" maxlength="5000" required></textarea></label>
            <p><button type="submit">Add note</button></p>
          </form>
          ${notes.length === 0
            ? html`<p class="muted">No notes yet.</p>`
            : html`<ul class="notes">${notes.map(
                (n) => html`<li class="note">
                  <div class="meta">${n.author_name || n.author_email || 'Unknown'} · ${fmtDateTime(ctx, n.created_at)}${n.role_title ? html` · <span class="tag">${n.role_title}</span>` : ''}</div>
                  ${multiline(n.body)}
                </li>`
              )}</ul>`}
        </section>

        <section class="card" id="email">
          <h2>Send email</h2>
          <form method="get" action="/app/applications/${app.id}#email" class="inline">
            <select name="template" aria-label="Template">
              <option value="">Choose a template</option>
              ${templates.map((t) => html`<option value="${t.id}"${String(t.id) === String(draft.templateId) ? raw(' selected') : ''}>${t.name}</option>`)}
            </select>
            <button type="submit">Load</button>
          </form>
          ${draft.unknown.length
            ? html`<p class="flash flash-error" id="merge-warning">Unknown merge field${draft.unknown.length > 1 ? 's' : ''}: ${draft.unknown.map((u) => `{{${u}}}`).join(', ')}. Fix ${draft.unknown.length > 1 ? 'them' : 'it'} before sending.</p>`
            : ''}
          <form method="post" action="/app/applications/${app.id}/email" class="stacked">
            ${csrfField(ctx)}
            <input type="hidden" name="template_id" value="${draft.templateId}">
            <p class="muted">To: ${person.email} · From: ${ctx.user.email}</p>
            <label>Subject <input type="text" name="subject" maxlength="300" value="${draft.subject}" required></label>
            <label>Body <textarea name="body" rows="10" maxlength="20000" required>${draft.body}</textarea></label>
            <p><button type="submit" class="primary">Send</button></p>
          </form>
        </section>

        <section class="card" id="activity">
          <h2>Activity</h2>
          <h3>Stage and role changes</h3>
          <ol class="events">${events.map(
            (e) => html`<li data-type="${e.type}">${describeEvent(e)} <span class="meta">· ${e.actor_user_id ? e.actor_name || e.actor_email : 'System'} · ${fmtDateTime(ctx, e.at)}</span></li>`
          )}</ol>
          <h3>Emails</h3>
          ${emails.length === 0
            ? html`<p class="muted">No emails sent.</p>`
            : html`<ul class="emails">${emails.map(
                (m) => html`<li class="email-${m.status}">
                  <details>
                    <summary><strong>${m.subject}</strong> · ${m.sender_name || m.sender_email} · ${fmtDateTime(ctx, m.sent_at)}${m.role_title ? html` · <span class="tag">${m.role_title}</span>` : ''}${m.status === 'failed' ? html` · <span class="error">failed</span>` : ''}</summary>
                    ${m.status === 'failed' ? html`<p class="error">${m.error}</p>` : ''}
                    ${multiline(m.body)}
                  </details>
                </li>`
              )}</ul>`}
        </section>

        ${isAdmin
          ? html`<section class="card danger">
              <h2>Delete candidate</h2>
              <p>Permanently deletes this person and all their applications, notes, emails and files (for data requests).</p>
              <p><a href="/app/people/${person.id}/delete?from=${app.id}" class="button danger">Delete candidate…</a></p>
            </section>`
          : ''}
      </div>
      </div>`,
  });
}

async function changeStage(ctx) {
  const { db, config, log } = ctx.app;
  const id = idParam(ctx.params.id);
  const { app, person } = await loadApplication(db, id);
  const back = returnTo(ctx, `/app/applications/${id}`);
  const stage = ctx.form.get('stage');
  if (!STAGES.includes(stage)) {
    setFlash(ctx, 'error', 'Unknown stage.');
    return ctx.redirect(back);
  }
  if (stage === app.stage) return ctx.redirect(back); // picking the current stage again does nothing

  const voltaxId = ctx.form.get('voltax_user_id').trim().slice(0, 100);
  let voltaxOn = ctx.form.get('voltax_onboarded_on').trim();
  if (voltaxOn && !isValidYmd(voltaxOn)) {
    setFlash(ctx, 'error', 'Onboarded date must be a valid date.');
    return ctx.redirect(back);
  }
  if (voltaxId && !voltaxOn) voltaxOn = todayIn(config.timezone);

  // One atomic batch. The events are inserted first and only if the application is still in the stage we
  // compared against; the UPDATE carries the same guard, so a concurrent change produces no event rows.
  const now = nowIso();
  const guard = 'EXISTS (SELECT 1 FROM applications WHERE id = ? AND stage = ?)';
  const statements = [
    {
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT ?, 'stage_change', ?, ?, ?, ? WHERE ${guard}`,
      args: [id, app.stage, stage, ctx.user.id, now, id, app.stage],
    },
  ];
  const recordVoltaxHere = stage === 'onboarded' && voltaxId;
  if (recordVoltaxHere) {
    statements.push({
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT ?, 'voltax_recorded', (SELECT voltax_user_id FROM applications WHERE id = ?), ?, ?, ? WHERE ${guard}`,
      args: [id, id, `${voltaxId} (onboarded ${voltaxOn})`, ctx.user.id, now, id, app.stage],
    });
  }
  const sets = ['stage = ?', 'stage_changed_at = ?'];
  const setArgs = [stage, now];
  if (stage === 'onboarded') {
    sets.push('onboarded_at = ?');
    setArgs.push(now);
    if (voltaxId) {
      sets.push('voltax_user_id = ?', 'voltax_onboarded_on = ?');
      setArgs.push(voltaxId, voltaxOn);
    }
  }
  statements.push({ sql: `UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND stage = ?`, args: [...setArgs, id, app.stage] });
  const results = await db.batch(statements);
  if (results[results.length - 1].changes === 0) {
    setFlash(ctx, 'error', 'Someone else changed this candidate at the same time. Nothing was saved: please check the page and try again.');
    return ctx.redirect(back);
  }

  let message = `Moved ${person.name} to ${STAGE_LABELS[stage]}.`;
  if (stage === 'onboarded') {
    try {
      const result = await voltax.createUser(person, { ...app, stage, voltax_user_id: voltaxId || app.voltax_user_id });
      if (result && result.status === 'not_configured') {
        message += voltaxId ? ' Voltax details saved.' : ' Voltax is not connected: record the Voltax user ID by hand.';
      }
    } catch (err) {
      log(`[voltax] createUser failed: ${err.message}`);
      message += ' Voltax call failed: record the Voltax user ID by hand.';
    }
  }
  setFlash(ctx, 'ok', message);
  // Onboarded from the pipeline row (no Voltax fields there): go to the candidate's Voltax form.
  if (stage === 'onboarded' && !voltaxId && back !== `/app/applications/${id}`) {
    return ctx.redirect(`/app/applications/${id}#voltax`);
  }
  ctx.redirect(back);
}

async function recordVoltax(ctx) {
  const { db, config } = ctx.app;
  const id = idParam(ctx.params.id);
  await loadApplication(db, id);
  const voltaxId = ctx.form.get('voltax_user_id').trim().slice(0, 100);
  const on = ctx.form.get('voltax_onboarded_on').trim() || todayIn(config.timezone);
  if (!voltaxId || !isValidYmd(on)) {
    setFlash(ctx, 'error', 'Enter a Voltax user ID and a valid date.');
    return ctx.redirect(`/app/applications/${id}`);
  }
  // The event takes its "from" value from the row itself, in the same atomic batch as the update.
  await db.batch([
    {
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT id, 'voltax_recorded', voltax_user_id, ?, ?, ? FROM applications WHERE id = ?`,
      args: [`${voltaxId} (onboarded ${on})`, ctx.user.id, nowIso(), id],
    },
    { sql: 'UPDATE applications SET voltax_user_id = ?, voltax_onboarded_on = ? WHERE id = ?', args: [voltaxId, on, id] },
  ]);
  setFlash(ctx, 'ok', 'Voltax details saved.');
  ctx.redirect(`/app/applications/${id}`);
}

async function moveRole(ctx) {
  const { db } = ctx.app;
  const id = idParam(ctx.params.id);
  const { app } = await loadApplication(db, id);
  const target = await db.get('SELECT id, title FROM job_roles WHERE id = ?', [Number(ctx.form.get('role_id'))]);
  if (!target) {
    setFlash(ctx, 'error', 'Pick a role.');
    return ctx.redirect(`/app/applications/${id}`);
  }
  if (target.id === app.role_id) return ctx.redirect(`/app/applications/${id}`);
  const now = nowIso();
  // Event first, guarded by the role we compared against; the UPDATE carries the same guard.
  const results = await db.batch([
    {
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT ?, 'role_change', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM applications WHERE id = ? AND role_id = ?)`,
      args: [id, `${app.role_title} (#${app.role_id})`, `${target.title} (#${target.id})`, ctx.user.id, now, id, app.role_id],
    },
    { sql: 'UPDATE applications SET role_id = ? WHERE id = ? AND role_id = ?', args: [target.id, id, app.role_id] },
  ]);
  if (results[1].changes === 0) setFlash(ctx, 'error', 'Someone else changed this candidate at the same time. Nothing was saved.');
  else setFlash(ctx, 'ok', `Moved to ${target.title}.`);
  ctx.redirect(`/app/applications/${id}`);
}

async function addNote(ctx) {
  const { db } = ctx.app;
  const id = idParam(ctx.params.id);
  const { app } = await loadApplication(db, id);
  const body = ctx.form.get('body').replace(/\r\n/g, '\n').trim();
  if (!body || body.length > 5000) {
    setFlash(ctx, 'error', 'A note must be between 1 and 5,000 characters.');
  } else {
    await db.run('INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      app.person_id, app.id, app.role_id, ctx.user.id, body, nowIso(),
    ]);
    setFlash(ctx, 'ok', 'Note added.');
  }
  ctx.redirect(`/app/applications/${id}#notes`);
}

async function sendEmail(ctx) {
  const { db, mailer } = ctx.app;
  const id = idParam(ctx.params.id);
  const { app, person } = await loadApplication(db, id);
  const subject = ctx.form.get('subject').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  const body = ctx.form.get('body').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (!subject || !body) {
    setFlash(ctx, 'error', 'Subject and body are required.');
    return ctx.redirect(`/app/applications/${id}#email`);
  }
  const tplId = Number(ctx.form.get('template_id'));
  const template = tplId ? await db.get('SELECT id FROM email_templates WHERE id = ?', [tplId]) : null;
  const sender = await db.get('SELECT * FROM users WHERE id = ?', [ctx.user.id]);
  const result = await mailer.sendCandidateEmail({ sender, application: app, person, templateId: template ? template.id : null, subject, body });
  if (result.ok) setFlash(ctx, 'ok', `Email sent to ${person.email}.`);
  else setFlash(ctx, 'error', EMAIL_FAILED);
  ctx.redirect(`/app/applications/${id}#activity`);
}

async function downloadFile(ctx) {
  const { db, config } = ctx.app;
  const id = idParam(ctx.params.id);
  const app = await db.get('SELECT file_path, file_name FROM applications WHERE id = ?', [id]);
  if (!app || !app.file_path || !/^uploads\/[0-9a-f]+\.(pdf|docx?)$/.test(app.file_path)) throw new HttpError(404, 'No file');
  let data;
  try {
    data = fs.readFileSync(path.join(config.dataDir, app.file_path));
  } catch {
    throw new HttpError(404, 'File missing');
  }
  const ext = path.extname(app.file_path).slice(1);
  const name = app.file_name || `application-${id}.${ext}`;
  const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const types = { pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  ctx.send(200, data, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
}

async function deleteConfirm(ctx) {
  const { db } = ctx.app;
  const pid = idParam(ctx.params.id);
  const person = await db.get('SELECT * FROM people WHERE id = ?', [pid]);
  if (!person) throw new HttpError(404, 'Person not found');
  const apps = await db.all('SELECT a.id, r.title FROM applications a JOIN job_roles r ON r.id = a.role_id WHERE a.person_id = ?', [pid]);
  const from = /^\d+$/.test(ctx.query.get('from') || '') ? ctx.query.get('from') : null;
  page(ctx, {
    title: 'Delete candidate',
    body: html`<h1>Delete ${person.name}?</h1>
      <p>This permanently deletes <strong>${person.name}</strong> (${person.email}), their ${apps.length} application${apps.length === 1 ? '' : 's'}
        (${apps.map((a) => a.title).join(', ')}), all notes, sent-email records, activity and uploaded files. This cannot be undone.</p>
      <form method="post" action="/app/people/${person.id}/delete" class="inline">
        ${csrfField(ctx)}
        <button type="submit" class="danger" data-confirm="Delete this candidate permanently?">Yes, delete permanently</button>
        <a href="${from ? `/app/applications/${from}` : '/app'}">Cancel</a>
      </form>`,
  });
}

async function deletePerson(ctx) {
  const { db, config, log } = ctx.app;
  const pid = idParam(ctx.params.id);
  const person = await db.get('SELECT id FROM people WHERE id = ?', [pid]);
  if (!person) throw new HttpError(404, 'Person not found');
  const files = (await db.all('SELECT file_path FROM applications WHERE person_id = ? AND file_path IS NOT NULL', [pid])).map((r) => r.file_path);
  // One atomic batch with explicit deletes in dependency order (nothing relies on foreign key cascades).
  // The deletion_log row is written while the person still exists, so it only appears for a real deletion.
  const appIds = 'SELECT id FROM applications WHERE person_id = ?';
  await db.batch([
    { sql: `DELETE FROM emails_sent WHERE person_id = ? OR application_id IN (${appIds})`, args: [pid, pid] },
    { sql: `DELETE FROM notes WHERE person_id = ? OR application_id IN (${appIds})`, args: [pid, pid] },
    { sql: `DELETE FROM application_events WHERE application_id IN (${appIds})`, args: [pid] },
    { sql: 'DELETE FROM applications WHERE person_id = ?', args: [pid] },
    {
      sql: 'INSERT INTO deletion_log (deleted_person_id, actor_user_id, at) SELECT id, ?, ? FROM people WHERE id = ?',
      args: [ctx.user.id, nowIso(), pid],
    },
    { sql: 'DELETE FROM people WHERE id = ?', args: [pid] },
  ]);
  for (const f of files) {
    try {
      fs.rmSync(path.join(config.dataDir, f), { force: true });
    } catch (err) {
      log(`[delete] could not remove ${f}: ${err.message}`);
    }
  }
  setFlash(ctx, 'ok', 'Candidate deleted.');
  ctx.redirect('/app');
}

function register(router) {
  router.get('/app/applications/:id', requireUser, candidatePage);
  router.get('/app/applications/:id/file', requireUser, downloadFile);
  router.post('/app/applications/:id/stage', requireUser, internalForm, changeStage);
  router.post('/app/applications/:id/voltax', requireUser, internalForm, recordVoltax);
  router.post('/app/applications/:id/role', requireUser, internalForm, moveRole);
  router.post('/app/applications/:id/notes', requireUser, internalForm, addNote);
  router.post('/app/applications/:id/email', requireUser, internalForm, sendEmail);
  router.get('/app/people/:id/delete', requireAdmin, deleteConfirm);
  router.post('/app/people/:id/delete', requireAdmin, internalForm, deletePerson);
}

module.exports = { register, EMAIL_FAILED, MERGE_FIELDS };

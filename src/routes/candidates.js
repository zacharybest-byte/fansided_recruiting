'use strict';
// Internal: candidate page and its actions (stage, role move, Voltax, notes, email log, delete).
const { html, raw, link, multiline } = require('../lib/render');
const { page, setFlash, stageBadge, fmtDate, fmtDateTime, sourceLabel } = require('../lib/layout');
const { roleStages, stageOf, mapStage, legacyCategory, kindOfLegacy, eventStageName, LEGACY_LABELS } = require('../lib/stages');
const { requireUser, requireAdmin } = require('../lib/auth');
const { csrfField, internalForm } = require('../lib/csrf');
const { HttpError } = require('../lib/http');
const { nowIso } = require('../lib/db');
const { applyMergeFields, firstName, composeUrl, MERGE_FIELDS, VIA_LABELS } = require('../lib/email');
const { todayIn, isValidYmd, daysSince } = require('../lib/time');
const { idParam } = require('./dashboard');
const voltax = require('../voltax');

const LIMITS = { note: 10000, subject: 200, body: 4000 };
const STALE = 'Someone else changed this candidate at the same time. Nothing was saved: please check the page and try again.';

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
      ? `Stage: ${eventStageName(e.from_value)} → ${eventStageName(e.to_value)}`
      : `Applied (stage ${eventStageName(e.to_value)})`;
  }
  if (e.type === 'role_change') return `Role: ${e.from_value} → ${e.to_value}`;
  if (e.type === 'voltax_recorded') return `Voltax recorded: ${e.to_value}`;
  return e.type;
}

// Other applications by the same person, newest first, each with the notes written on it. Deleted candidates have no
// history (their applications are deleted with them). Notes are visible to every signed-in user already.
async function loadHistory(db, personId, applicationId) {
  const rows = await db.all(
    `SELECT a.id, a.stage, a.applied_at, a.stage_changed_at, r.title AS role_title, r.site_name,
            s.name AS stage_name, s.kind AS stage_kind,
            COALESCE(NULLIF(ru.name, ''), ru.email) AS rep_name,
            (SELECT COALESCE(NULLIF(eu.name, ''), eu.email) FROM application_events e JOIN users eu ON eu.id = e.actor_user_id
              WHERE e.application_id = a.id AND e.type = 'stage_change' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS last_actor
       FROM applications a
       JOIN job_roles r ON r.id = a.role_id
       LEFT JOIN users ru ON ru.id = r.assigned_user_id
       LEFT JOIN role_stages s ON s.id = a.stage_id
      WHERE a.person_id = ? AND a.id != ? ORDER BY a.applied_at DESC, a.id DESC`,
    [personId, applicationId]
  );
  const notesBy = new Map(rows.map((h) => [h.id, []]));
  if (rows.length) {
    const notes = await db.all(
      `SELECT n.application_id, n.body, n.created_at, COALESCE(NULLIF(u.name, ''), u.email) AS author
         FROM notes n LEFT JOIN users u ON u.id = n.author_user_id
        WHERE n.person_id = ? AND n.application_id IN (${rows.map(() => '?').join(',')})
        ORDER BY n.created_at DESC, n.id DESC`,
      [personId, ...rows.map((h) => h.id)]
    );
    for (const n of notes) notesBy.get(n.application_id).push(n);
  }
  return rows.map((h) => ({
    ...h,
    kind: h.stage_kind || kindOfLegacy(h.stage),
    stageName: h.stage_name || LEGACY_LABELS[h.stage] || h.stage,
    notes: notesBy.get(h.id),
  }));
}

// "Applied 3 times before: 1 onboarded, 2 passed."
function historySummary(history) {
  const n = history.length;
  const of = (fn) => history.filter(fn).length;
  const parts = [];
  const onboarded = of((h) => h.kind === 'onboarded');
  const passed = of((h) => h.kind === 'passed');
  const open = n - onboarded - passed;
  if (onboarded) parts.push(`${onboarded} onboarded`);
  if (passed) parts.push(`${passed} passed`);
  if (open) parts.push(`${open} still in progress`);
  return `Applied ${n === 1 ? 'once' : `${n} times`} before: ${parts.join(', ')}.`;
}

function noteList(ctx, notes) {
  return html`<ul class="notes history-note-list">${notes.map(
    (n) => html`<li class="note"><div class="meta">${n.author || 'Unknown'}, ${fmtDateTime(ctx, n.created_at)}</div>${multiline(n.body)}</li>`
  )}</ul>`;
}

function historyPanel(ctx, history) {
  return html`<section class="card history-panel" id="history" aria-labelledby="history-h">
    <h2 id="history-h">Application history</h2>
    <p class="history-summary">${historySummary(history)}</p>
    <ol class="history-list">
      ${history.map((h) => {
        const outcome = h.kind === 'onboarded' ? 'Onboarded on' : h.kind === 'passed' ? 'Passed on' : `Still in ${h.stageName} since`;
        return html`<li class="history-item" data-application-id="${h.id}">
          <div class="history-head">
            <div class="history-title">
              <h3>${h.role_title}${h.site_name ? html` <span class="history-site">${h.site_name}</span>` : ''}</h3>
              <p class="history-outcome">${stageBadge({ kind: h.kind, name: h.stageName })} <span>${outcome} ${fmtDate(ctx, h.stage_changed_at)}</span></p>
            </div>
            <a class="btn btn-secondary" href="/app/applications/${h.id}">Open this application<span class="visually-hidden"> for ${h.role_title}</span></a>
          </div>
          <dl class="meta-list history-meta">
            <div><dt>Applied</dt><dd>${fmtDate(ctx, h.applied_at)}</dd></div>
            <div><dt>Assigned rep</dt><dd>${h.rep_name || 'Unassigned'}</dd></div>
            ${h.last_actor ? html`<div><dt>Last moved by</dt><dd>${h.last_actor}</dd></div>` : ''}
            <div><dt>Notes</dt><dd>${h.notes.length}</dd></div>
          </dl>
          ${h.notes.length
            ? html`<details class="history-notes">
                <summary>Show ${h.notes.length} ${h.notes.length === 1 ? 'note' : 'notes'} from this application</summary>
                ${noteList(ctx, h.notes)}
              </details>
              <div class="history-notes-print" aria-hidden="true">${noteList(ctx, h.notes)}</div>`
            : html`<p class="muted history-no-notes">No notes were written on this application.</p>`}
        </li>`;
      })}
    </ol>
  </section>`;
}

// Email with a break opportunity before the @, so a long address wraps there instead of in the middle of a word.
function breakableEmail(email) {
  const i = String(email).indexOf('@');
  return i < 1 ? email : html`${email.slice(0, i)}<wbr>${email.slice(i)}`;
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
  const history = await loadHistory(db, person.id, app.id);
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
  // The person record keeps the first name and LinkedIn; show what this application was submitted with when it differs.
  const nameDiff = Boolean(app.applicant_name) && app.applicant_name !== person.name;
  const linkDiff = Boolean(app.applicant_linkedin) && app.applicant_linkedin !== person.linkedin_url;
  const today = todayIn(config.timezone);

  const stages = await roleStages(db, app.role_id);
  const current = stageOf(app, stages);
  const stageIndex = stages.findIndex((s) => s.id === current.id);
  const sampleLinks = String(app.sample_links || '').split('\n').filter(Boolean);

  page(ctx, {
    title: person.name,
    body: html`<a class="back" href="/app/roles/${app.role_id}">${app.role_title} pipeline</a>
      <header class="candidate-header">
        <div class="page-header">
          <div>
            <h1>${person.name}</h1>
            <dl class="meta-list">
              <div><dt>Email</dt><dd class="meta-email"><a href="mailto:${encodeURIComponent(person.email)}">${breakableEmail(person.email)}</a></dd></div>
              ${linkedin ? html`<div><dt>Profile</dt><dd>${link(linkedin, 'LinkedIn or portfolio')}</dd></div>` : ''}
              <div><dt>Role</dt><dd>${app.role_title}${app.role_status === 'closed' ? ' (closed)' : ''}</dd></div>
              <div><dt>Applied</dt><dd>${fmtDate(ctx, app.applied_at)}</dd></div>
            </dl>
          </div>
          <div class="page-actions">${stageBadge(current)}</div>
        </div>
        <div class="stepper-card">
          <ol class="stepper" aria-label="Stage">
            ${stages.map((st, i) => html`<li class="stepper-step stage-${st.kind}${i < stageIndex ? ' is-done' : ''}${i === stageIndex ? ' is-current' : ''}"${i === stageIndex ? html` aria-current="step"` : ''}><span class="stepper-dot" aria-hidden="true"></span><span class="stepper-label">${st.name}</span></li>`)}
          </ol>
        </div>
      </header>
      ${history.length ? historyPanel(ctx, history) : ''}

      <div class="grid-2 wide-left">
      <div class="col">
        ${nameDiff || linkDiff
          ? html`<div class="submitted-as" id="submitted-as">
              <p>Entered on this application:${nameDiff ? html` name <strong>${app.applicant_name}</strong>` : ''}${linkDiff ? html` link ${link(app.applicant_linkedin)}` : ''}</p>
            </div>`
          : ''}
        <section class="card">
          <h2>Application</h2>
          <dl class="details answers">
            <dt>Writing samples</dt>
            <dd>${sampleLinks.length ? html`<ul class="link-list">${sampleLinks.map((l) => html`<li>${link(l)}</li>`)}</ul>` : html`<span class="muted">None</span>`}</dd>
            <dt>Resume</dt>
            <dd>${app.resume_url ? link(app.resume_url) : html`<span class="muted">None</span>`}</dd>
            ${answers.map((a) => html`<dt>${a.question}</dt><dd>${a.answer ? multiline(a.answer) : html`<span class="muted">No answer</span>`}</dd>`)}
            <dt>Source</dt><dd>${sourceLabel(app.source_tag) || html`<span class="muted">None</span>`}</dd>
            <dt>How they heard about us</dt><dd>${app.heard_from || html`<span class="muted">Not given</span>`}</dd>
          </dl>
        </section>

        ${history.length ? '' : html`<p class="muted first-application" id="first-application">First application from this person.</p>`}
      </div>

      <div class="col">
        <section class="card">
          <h2>Move to another stage</h2>
          <form method="post" action="/app/applications/${app.id}/stage" id="stage-form">
            ${csrfField(ctx)}
            <input type="hidden" name="from_stage" value="${current.id}">
            <div class="field">
              <label for="f-stage">Stage</label>
              <select name="stage" id="f-stage" required><option value="">Move to…</option>${stages.filter((st) => st.id !== current.id).map((st) => html`<option value="${st.id}" data-kind="${st.kind}">${st.name}</option>`)}</select>
            </div>
            ${current.kind === 'onboarded'
              ? ''
              : html`<div class="voltax-fields" data-show-for="onboarded">
                  <p class="help muted" id="help-voltax">Only used when moving to Onboarded. The Voltax API is not connected yet, so enter the account by hand.</p>
                  <div class="field"><label for="f-voltax">Voltax user ID</label><input type="text" id="f-voltax" name="voltax_user_id" maxlength="100" aria-describedby="help-voltax"></div>
                  <div class="field"><label for="f-voltax-on">Onboarded date</label><input type="date" id="f-voltax-on" name="voltax_onboarded_on" value="${today}"></div>
                </div>`}
            <div class="form-actions"><button type="submit" class="btn btn-primary">Move</button></div>
          </form>
          ${current.kind === 'onboarded'
            ? html`<h3 id="voltax">Voltax</h3>
              <dl class="meta-list">
                <div><dt>User ID</dt><dd>${app.voltax_user_id || html`<span class="muted">Not recorded</span>`}</dd></div>
                <div><dt>Onboarded on</dt><dd>${app.voltax_onboarded_on || html`<span class="muted">Not recorded</span>`}</dd></div>
              </dl>
              <form method="post" action="/app/applications/${app.id}/voltax">
                ${csrfField(ctx)}
                <div class="field-row">
                  <div class="field"><label for="f-voltax-id2">Voltax user ID</label><input type="text" id="f-voltax-id2" name="voltax_user_id" maxlength="100" value="${app.voltax_user_id || ''}" required></div>
                  <div class="field"><label for="f-voltax-on2">Date</label><input type="date" id="f-voltax-on2" name="voltax_onboarded_on" value="${app.voltax_onboarded_on || today}"></div>
                </div>
                <div class="form-actions"><button type="submit" class="btn btn-secondary">Update Voltax details</button></div>
              </form>`
            : ''}
        </section>

        <section class="card">
          <h2>Move to another role</h2>
          <form method="post" action="/app/applications/${app.id}/role">
            ${csrfField(ctx)}
            <input type="hidden" name="from_role_id" value="${app.role_id}">
            <div class="field">
              <label for="f-role">Role</label>
              <select name="role_id" id="f-role">
                ${roles.map(
                  (r) => html`<option value="${r.id}"${r.id === app.role_id ? raw(' selected') : ''}>${r.title}${r.site_name ? ` (${r.site_name})` : ''}${r.status === 'closed' ? ' [closed]' : ''}</option>`
                )}
              </select>
            </div>
            <p class="help">The candidate keeps their place in the workflow where the new role has a matching stage (same name), otherwise they start at its first in-progress stage, or at New.</p>
            <div class="form-actions"><button type="submit" class="btn btn-secondary">Move to this role</button></div>
          </form>
        </section>

        <section class="card" id="notes">
          <h2>Notes</h2>
          <form method="post" action="/app/applications/${app.id}/notes" class="notes-form">
            ${csrfField(ctx)}
            <div class="field">
              <label for="f-note">Add a note</label>
              <textarea name="body" id="f-note" rows="3" maxlength="${LIMITS.note}" required></textarea>
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-secondary">Add note</button></div>
          </form>
          ${notes.length === 0
            ? html`<p class="muted">No notes yet. Notes are visible to everyone on the team.</p>`
            : html`<ul class="notes">${notes.map(
                (n) => html`<li class="note">
                  <div class="meta">${n.author_name || n.author_email || 'Unknown'}, ${fmtDateTime(ctx, n.created_at)}${n.role_title ? html` <span class="tag">${n.role_title}</span>` : ''}</div>
                  ${multiline(n.body)}
                </li>`
              )}</ul>`}
        </section>

        <section class="card" id="email">
          <h2>Email</h2>
          <form method="get" action="/app/applications/${app.id}#email" class="inline template-load">
            <label class="visually-hidden" for="f-template">Template</label>
            <select name="template" id="f-template">
              <option value="">Choose a template</option>
              ${templates.map((t) => html`<option value="${t.id}"${String(t.id) === String(draft.templateId) ? raw(' selected') : ''}>${t.name}</option>`)}
            </select>
            <button type="submit" class="btn btn-secondary">Load template</button>
          </form>
          ${draft.unknown.length
            ? html`<p class="flash flash-error" id="merge-warning" role="alert">Unknown merge field${draft.unknown.length > 1 ? 's' : ''}: ${draft.unknown.map((u) => `{{${u}}}`).join(', ')}. Fix ${draft.unknown.length > 1 ? 'them' : 'it'} before sending.</p>`
            : ''}
          <form method="post" action="/app/applications/${app.id}/email" target="_blank">
            ${csrfField(ctx)}
            <input type="hidden" name="template_id" value="${draft.templateId}">
            <p class="composer-to">To: ${person.email}. The email is written and sent from your own mail account. Recruit only logs that you opened it.</p>
            <div class="field"><label for="f-subject">Subject</label><input type="text" id="f-subject" name="subject" maxlength="${LIMITS.subject}" value="${draft.subject}" required></div>
            <div class="field"><label for="f-body">Message</label><textarea name="body" id="f-body" rows="10" maxlength="${LIMITS.body}" required>${draft.body}</textarea></div>
            <div class="form-actions">
              <button type="submit" name="via" value="gmail" class="btn btn-primary">Open in Gmail</button>
              <button type="submit" name="via" value="mailto" class="btn btn-secondary">Open in mail app</button>
            </div>
          </form>
        </section>

        <section class="card" id="activity">
          <h2>Activity</h2>
          <h3>Stage and role changes</h3>
          <ol class="events event-list">${events.map(
            (e) => html`<li data-type="${e.type}">${describeEvent(e)} <span class="meta">${e.actor_user_id ? e.actor_name || e.actor_email : 'System'}, ${fmtDateTime(ctx, e.at)}</span></li>`
          )}</ol>
          <h3>Emails</h3>
          ${emails.length === 0
            ? html`<p class="muted">No emails logged yet.</p>`
            : html`<ul class="emails email-log">${emails.map(
                (m) => html`<li class="email-${m.via}">
                  <details>
                    <summary><strong>${m.subject}</strong><span class="meta">${VIA_LABELS[m.via] || m.via}, ${m.sender_name || m.sender_email}, ${fmtDateTime(ctx, m.sent_at)}${m.role_title ? html` <span class="tag">${m.role_title}</span>` : ''}</span></summary>
                    ${multiline(m.body)}
                  </details>
                </li>`
              )}</ul>`}
        </section>

        ${isAdmin
          ? html`<section class="card card-danger danger">
              <h2>Delete candidate</h2>
              <p>Permanently deletes this person and all their applications, notes, email records and activity. Use this for data requests.</p>
              <a href="/app/people/${person.id}/delete?from=${app.id}" class="btn btn-danger">Delete candidate</a>
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
  const stages = await roleStages(db, app.role_id);
  const current = stageOf(app, stages);
  // Both values are stage ids (not names): a rename between page load and submit must not break the move.
  const idOf = (v) => (/^[1-9]\d{0,15}$/.test(v) ? Number(v) : null);
  const targetId = idOf(ctx.form.get('stage'));
  const target = targetId === null ? null : stages.find((s) => s.id === targetId);
  if (!target) {
    setFlash(ctx, 'error', ctx.form.get('stage') === '' ? 'Choose a stage to move this candidate to.' : 'Unknown stage.');
    return ctx.redirect(back);
  }
  // The form carries the stage the page showed. If the candidate has moved on since (another tab, another rep), or
  // the field is missing or not a stage of this role, nothing is written: this is "stale", never a silent overwrite.
  const fromId = idOf(ctx.form.get('from_stage'));
  if (fromId === null || fromId !== current.id) {
    setFlash(ctx, 'error', STALE);
    return ctx.redirect(back);
  }
  if (target.id === current.id) {
    setFlash(ctx, 'ok', `Already in ${target.name}.`);
    return ctx.redirect(back);
  }

  const voltaxId = ctx.form.get('voltax_user_id').trim().slice(0, 100);
  let voltaxOn = ctx.form.get('voltax_onboarded_on').trim();
  if (voltaxOn && !isValidYmd(voltaxOn)) {
    setFlash(ctx, 'error', 'Onboarded date must be a valid date.');
    return ctx.redirect(back);
  }
  if (voltaxId && !voltaxOn) voltaxOn = todayIn(config.timezone);

  // One atomic batch. The events are inserted first and only if the application is still in the stage we compared
  // against (and the target still belongs to its role); the UPDATE carries the same guards, so a concurrent change
  // produces no event rows. Event values are the stage NAMES, read in SQL so they match the stage rows exactly.
  const now = nowIso();
  const guard = `EXISTS (SELECT 1 FROM applications a JOIN role_stages t ON t.id = ? AND t.role_id = a.role_id WHERE a.id = ? AND a.stage_id = ?)`;
  const guardArgs = [target.id, id, current.id];
  const statements = [
    {
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT ?, 'stage_change', (SELECT name FROM role_stages WHERE id = ?), (SELECT name FROM role_stages WHERE id = ?), ?, ? WHERE ${guard}`,
      args: [id, current.id, target.id, ctx.user.id, now, ...guardArgs],
    },
  ];
  const recordVoltaxHere = target.kind === 'onboarded' && voltaxId;
  if (recordVoltaxHere) {
    statements.push({
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT ?, 'voltax_recorded', (SELECT voltax_user_id FROM applications WHERE id = ?), ?, ?, ? WHERE ${guard}`,
      args: [id, id, `${voltaxId} (onboarded ${voltaxOn})`, ctx.user.id, now, ...guardArgs],
    });
  }
  // stage (legacy column) is written as the stage's category; stage_id is the truth.
  const sets = ['stage_id = ?', 'stage = ?', 'stage_changed_at = ?'];
  const setArgs = [target.id, legacyCategory(target.kind), now];
  if (target.kind === 'onboarded') {
    sets.push('onboarded_at = ?');
    setArgs.push(now);
    if (voltaxId) {
      sets.push('voltax_user_id = ?', 'voltax_onboarded_on = ?');
      setArgs.push(voltaxId, voltaxOn);
    }
  }
  statements.push({
    sql: `UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND stage_id = ? AND EXISTS (SELECT 1 FROM role_stages t WHERE t.id = ? AND t.role_id = applications.role_id)`,
    args: [...setArgs, id, current.id, target.id],
  });
  const results = await db.batch(statements);
  if (results[results.length - 1].changes === 0) {
    setFlash(ctx, 'error', STALE);
    return ctx.redirect(back);
  }

  let message = `Moved "${person.name}" to ${target.name}.`;
  if (target.kind === 'onboarded') {
    try {
      const result = await voltax.createUser(person, { ...app, stage: 'onboarded', voltax_user_id: voltaxId || app.voltax_user_id });
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
  if (target.kind === 'onboarded' && !voltaxId && back !== `/app/applications/${id}`) {
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
  const { app, person } = await loadApplication(db, id);
  const target = await db.get('SELECT id, title FROM job_roles WHERE id = ?', [Number(ctx.form.get('role_id'))]);
  if (!target) {
    setFlash(ctx, 'error', 'Pick a role.');
    return ctx.redirect(`/app/applications/${id}`);
  }
  // Same idea as the stage form: the role the page showed must still be the current one.
  if (ctx.form.get('from_role_id') !== String(app.role_id)) {
    setFlash(ctx, 'error', STALE);
    return ctx.redirect(`/app/applications/${id}`);
  }
  if (target.id === app.role_id) {
    setFlash(ctx, 'ok', `Already in ${target.title}.`);
    return ctx.redirect(`/app/applications/${id}`);
  }
  // The candidate keeps its place in the workflow where it can: new / onboarded / passed map by kind; an in-progress
  // stage maps to the target's stage with the same name, else its first in-progress stage, else New.
  const from = stageOf(app, await roleStages(db, app.role_id));
  const to = mapStage(from, await roleStages(db, target.id));
  const stageChanges = from.name !== to.name;
  const now = nowIso();
  // Events first, guarded by the role and stage we compared against (and the target stage must still be the target
  // role's); the UPDATE carries the same guard. The stage event only exists when the stage name changes.
  const guard = `EXISTS (SELECT 1 FROM applications WHERE id = ? AND role_id = ? AND stage_id IS ?) AND EXISTS (SELECT 1 FROM role_stages WHERE id = ? AND role_id = ?)`;
  const guardArgs = [id, app.role_id, app.stage_id, to.id, target.id];
  const statements = [
    {
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT ?, 'role_change', ?, ?, ?, ? WHERE ${guard}`,
      args: [id, `${app.role_title} (#${app.role_id})`, `${target.title} (#${target.id})`, ctx.user.id, now, ...guardArgs],
    },
  ];
  if (stageChanges) {
    statements.push({
      sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
            SELECT ?, 'stage_change', ?, ?, ?, ? WHERE ${guard}`,
      args: [id, from.name, to.name, ctx.user.id, now, ...guardArgs],
    });
  }
  statements.push({
    sql: `UPDATE applications SET role_id = ?, stage_id = ?, stage = ?${stageChanges ? ', stage_changed_at = ?' : ''}
           WHERE id = ? AND role_id = ? AND stage_id IS ? AND EXISTS (SELECT 1 FROM role_stages WHERE id = ? AND role_id = ?)`,
    args: [target.id, to.id, legacyCategory(to.kind), ...(stageChanges ? [now] : []), id, app.role_id, app.stage_id, to.id, target.id],
  });
  const results = await db.batch(statements);
  if (results[results.length - 1].changes === 0) setFlash(ctx, 'error', STALE);
  else setFlash(ctx, 'ok', `Moved "${person.name}" to ${target.title}${stageChanges ? `, stage ${to.name}` : ''}.`);
  ctx.redirect(`/app/applications/${id}`);
}

async function addNote(ctx) {
  const { db } = ctx.app;
  const id = idParam(ctx.params.id);
  const { app } = await loadApplication(db, id);
  const body = ctx.form.get('body').replace(/\r\n/g, '\n').trim();
  if (body.length > LIMITS.note) throw new HttpError(400, `A note must be at most ${LIMITS.note.toLocaleString('en-US')} characters.`);
  if (!body) {
    setFlash(ctx, 'error', 'A note cannot be empty.');
  } else {
    await db.run('INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      app.person_id, app.id, app.role_id, ctx.user.id, body, nowIso(),
    ]);
    setFlash(ctx, 'ok', 'Note added.');
  }
  ctx.redirect(`/app/applications/${id}#notes`);
}

// Logs that the rep opened a compose window, then hands the rep a Gmail / mailto link. The recipient is always
// the person's stored email: the form has no recipient field and none is read. No redirect: a cross-origin
// redirect after a form POST can be blocked, so the link is rendered on a small page (and followed by public/app.js).
async function logEmail(ctx) {
  const { db } = ctx.app;
  const id = idParam(ctx.params.id);
  const { app, person } = await loadApplication(db, id);
  const via = ctx.form.get('via');
  if (via !== 'gmail' && via !== 'mailto') throw new HttpError(400, 'Choose Open in Gmail or Open in mail app.');
  const subject = ctx.form.get('subject').replace(/[\r\n]+/g, ' ').trim();
  const body = ctx.form.get('body').replace(/\r\n?/g, '\n').trim();
  if (!subject || !body) throw new HttpError(400, 'Subject and body are required.');
  if (subject.length > LIMITS.subject) throw new HttpError(400, `The subject must be at most ${LIMITS.subject} characters.`);
  if (body.length > LIMITS.body) throw new HttpError(400, `The body must be at most ${LIMITS.body.toLocaleString('en-US')} characters.`);
  const tplId = Number(ctx.form.get('template_id'));
  const template = tplId ? await db.get('SELECT id FROM email_templates WHERE id = ?', [tplId]) : null;
  await db.run(
    `INSERT INTO emails_sent (person_id, application_id, role_id, template_id, sender_user_id, to_email, subject, body, via, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [person.id, app.id, app.role_id, template ? template.id : null, ctx.user.id, person.email, subject, body, via, nowIso()]
  );
  const href = composeUrl(via, { to: person.email, subject, body });
  const where = via === 'gmail' ? 'Gmail' : 'your mail app';
  page(ctx, {
    title: 'Email logged',
    body: html`<div class="card centred-card">
      <h1>Email logged. Opening ${where}…</h1>
      <p>If nothing opens, use the button below. Recruit has recorded that you opened this email for ${person.name}.</p>
      <div class="form-actions">
        <a href="${href}" data-auto-open id="compose-link" class="btn btn-primary">Open the compose window</a>
        <a class="btn btn-secondary" href="/app/applications/${app.id}#activity">Back to candidate</a>
      </div>
    </div>`,
  });
}

async function deleteConfirm(ctx) {
  const { db } = ctx.app;
  const pid = idParam(ctx.params.id);
  const person = await db.get('SELECT * FROM people WHERE id = ?', [pid]);
  if (!person) throw new HttpError(404, 'Person not found');
  const apps = await db.all('SELECT a.id, r.title FROM applications a JOIN job_roles r ON r.id = a.role_id WHERE a.person_id = ?', [pid]);
  const from = /^[1-9]\d*$/.test(ctx.query.get('from') || '') ? ctx.query.get('from') : null;
  page(ctx, {
    title: 'Delete candidate',
    body: html`<div class="card card-danger centred-card">
      <h1>Delete ${person.name}?</h1>
      <p>This permanently deletes <strong>${person.name}</strong> (${person.email}), ${apps.length === 1 ? 'their application' : `their ${apps.length} applications`}
        (${apps.map((a) => a.title).join(', ')}), and all notes, email records and activity.</p>
      <p><strong>This cannot be undone.</strong></p>
      <form method="post" action="/app/people/${person.id}/delete" class="form-actions">
        ${csrfField(ctx)}
        <button type="submit" class="btn btn-danger">Yes, delete permanently</button>
        <a class="btn btn-secondary" href="${from ? `/app/applications/${from}` : '/app'}">Cancel</a>
      </form>
    </div>`,
  });
}

async function deletePerson(ctx) {
  const { db, log } = ctx.app;
  const pid = idParam(ctx.params.id);
  const person = await db.get('SELECT id FROM people WHERE id = ?', [pid]);
  if (!person) throw new HttpError(404, 'Person not found');
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
  log(`[delete] person=${pid} by=${ctx.user.id}`);
  setFlash(ctx, 'ok', 'Candidate deleted.');
  ctx.redirect('/app');
}

const PAGE_SIZE = 50;

// Escape LIKE wildcards so % and _ in the query match themselves ("\" is the ESCAPE character).
function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

// Status filter values -> the stage kinds they show. "active" is what is still being worked: new + progress.
const STATUS_KINDS = { active: ['new', 'progress'], new: ['new'], progress: ['progress'], onboarded: ['onboarded'], passed: ['passed'], all: ['new', 'progress', 'onboarded', 'passed'] };
const STATUS_CHIPS = [['active', 'Active'], ['new', 'New'], ['progress', 'In progress'], ['onboarded', 'Onboarded'], ['passed', 'Passed'], ['all', 'All statuses']];
const STATUS_WORDS = { active: 'active ', new: 'new ', progress: 'in progress ', onboarded: 'onboarded ', passed: 'passed ', all: '' };
// Stage kind of an application; the legacy stage column covers rows that have no stage id.
const KIND_SQL = "COALESCE(s.kind, CASE a.stage WHEN 'reviewing' THEN 'progress' WHEN 'trial' THEN 'progress' ELSE a.stage END)";

// Whose candidates: me (default), all, none (roles without a rep, admin only) or a user id (admin only).
// Anything else, including a rep asking for another user, falls back to the signed-in user's own list.
async function resolveOwner(ctx) {
  const { db } = ctx.app;
  const value = ctx.query.get('owner') || 'me';
  if (value === 'all') return { key: 'all' };
  if (ctx.user.role === 'admin') {
    if (value === 'none') return { key: 'none' };
    if (/^[1-9]\d{0,14}$/.test(value) && Number(value) !== ctx.user.id) {
      const user = await db.get('SELECT id, name, email FROM users WHERE id = ?', [Number(value)]);
      if (user) return { key: String(user.id), user };
    }
  }
  return { key: 'me' };
}

async function searchPage(ctx) {
  const { db } = ctx.app;
  const isAdmin = ctx.user.role === 'admin';
  const q = (ctx.query.get('q') || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const pageNo = /^[1-9]\d{0,3}$/.test(ctx.query.get('page') || '') ? Number(ctx.query.get('page')) : 1;
  const owner = await resolveOwner(ctx);
  const status = Object.prototype.hasOwnProperty.call(STATUS_KINDS, ctx.query.get('status')) ? ctx.query.get('status') : 'active';
  const sort = ctx.query.get('sort') === 'stage_age' ? 'stage_age' : 'recent';

  // Everything is bookmarkable: defaults are left out of links so the plain page keeps a plain address.
  const href = (over = {}) => {
    const v = { q, owner: owner.key, status, sort, page: 1, ...over };
    const params = new URLSearchParams();
    if (v.q) params.set('q', v.q);
    if (v.owner !== 'me') params.set('owner', v.owner);
    if (v.status !== 'active') params.set('status', v.status);
    if (v.sort !== 'recent') params.set('sort', v.sort);
    if (v.page > 1) params.set('page', String(v.page));
    const qs = params.toString();
    return qs ? `/app/candidates?${qs}` : '/app/candidates';
  };

  // Scope = owner + search. The status chips count inside the scope, the list shows one status of it.
  const from = 'FROM applications a JOIN people p ON p.id = a.person_id JOIN job_roles r ON r.id = a.role_id LEFT JOIN role_stages s ON s.id = a.stage_id';
  const scope = [];
  const scopeArgs = [];
  if (owner.key === 'me') { scope.push('r.assigned_user_id = ?'); scopeArgs.push(ctx.user.id); }
  else if (owner.key === 'none') scope.push('r.assigned_user_id IS NULL');
  else if (owner.user) { scope.push('r.assigned_user_id = ?'); scopeArgs.push(owner.user.id); }
  if (q) { scope.push("(p.name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\')"); scopeArgs.push(likePattern(q), likePattern(q)); }
  const scopeSql = scope.length ? `WHERE ${scope.join(' AND ')}` : '';
  const counts = { new: 0, progress: 0, onboarded: 0, passed: 0 };
  for (const row of await db.all(`SELECT ${KIND_SQL} AS kind, COUNT(*) AS n ${from} ${scopeSql} GROUP BY ${KIND_SQL}`, scopeArgs)) {
    if (row.kind in counts) counts[row.kind] += row.n;
  }
  const countFor = (key) => STATUS_KINDS[key].reduce((n, k) => n + counts[k], 0);
  const total = countFor(status);
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A page past the end (a stale link, or results that shrank) goes to the last real page.
  if (pageNo > lastPage) return ctx.redirect(href({ page: lastPage }));
  const kinds = STATUS_KINDS[status];
  const shown = total === 0 ? [] : await db.all(
    `SELECT a.id, a.stage, a.applied_at, a.stage_changed_at, p.name, p.email, r.title AS role_title, r.site_name,
            COALESCE(NULLIF(u.name, ''), u.email) AS rep_name, s.name AS stage_name, ${KIND_SQL} AS stage_kind
       ${from} LEFT JOIN users u ON u.id = r.assigned_user_id
      ${scopeSql}${scopeSql ? ' AND' : 'WHERE'} ${KIND_SQL} IN (${kinds.map(() => '?').join(',')})
      ORDER BY ${sort === 'stage_age' ? 'a.stage_changed_at ASC, a.id ASC' : 'a.applied_at DESC, a.id DESC'} LIMIT ? OFFSET ?`,
    [...scopeArgs, ...kinds, PAGE_SIZE, (pageNo - 1) * PAGE_SIZE]
  );
  const hasNext = pageNo < lastPage;

  const ownerPhrase = owner.key === 'me' ? 'on your roles' : owner.key === 'all' ? 'on all roles' : owner.key === 'none' ? 'on roles without a rep' : `on ${owner.user.name || owner.user.email}'s roles`;
  const matching = q ? html` matching "${q}"` : '';
  const filtered = Boolean(q) || owner.key !== 'me' || status !== 'active' || sort !== 'recent';
  const noun = (n) => (n === 1 ? 'candidate' : 'candidates');

  let reps = [];
  if (isAdmin) {
    reps = await db.all('SELECT id, name, email FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE, email');
    if (owner.user && !reps.some((u) => u.id === owner.user.id)) reps.push(owner.user);
  }
  const chip = (label, url, current, count) =>
    html`<li><a class="chip" href="${url}"${current ? html` aria-current="true"` : ''}>${label}${count === undefined ? '' : html` <span class="chip-count">${count}</span>`}</a></li>`;

  let empty;
  if (shown.length === 0) {
    const anywhere = Boolean(await db.get('SELECT 1 AS x FROM applications LIMIT 1'));
    const tips = [];
    if (anywhere) {
      if (status !== 'all' && countFor('all') > 0) tips.push(html`<a class="btn btn-secondary" href="${href({ status: 'all' })}">Show all statuses (${countFor('all')})</a>`);
      if (owner.key !== 'all') tips.push(html`<a class="btn btn-secondary" href="${href({ owner: 'all' })}">Show all candidates</a>`);
      if (q) tips.push(html`<a class="btn btn-secondary" href="${href({ q: '' })}">Clear the search</a>`);
    }
    empty = anywhere
      ? html`<div class="empty" id="candidates-empty">
          <h2>No ${STATUS_WORDS[status]}candidates ${ownerPhrase}${matching}</h2>
          <p>${q ? 'Check the spelling, try part of the name or the email address, or widen the filters.' : status === 'active' && owner.key === 'me' ? 'Nobody on your roles is waiting for you. Show every status, or look at everyone, to see more.' : 'Change the filters above to see more candidates.'}</p>
          ${tips.length ? html`<p class="empty-actions">${tips}</p>` : ''}
        </div>`
      : html`<div class="empty" id="candidates-empty">
          <h2>No applications yet</h2>
          <p>Applications appear here as soon as someone applies for an open role.</p>
        </div>`;
  }

  page(ctx, {
    title: 'Candidates',
    body: html`<div class="page-header"><div><h1>Candidates</h1>
        <p class="lede">Your candidates by default. Search by name or email, and filter by rep and status.</p></div></div>
      <form method="get" action="/app/candidates" class="search-bar" role="search">
        <label class="visually-hidden" for="f-q">Search by name or email</label>
        <input type="search" id="f-q" name="q" value="${q}" maxlength="100" placeholder="Name or email" autocomplete="off">
        ${owner.key !== 'me' ? html`<input type="hidden" name="owner" value="${owner.key}">` : ''}
        ${status !== 'active' ? html`<input type="hidden" name="status" value="${status}">` : ''}
        ${sort !== 'recent' ? html`<input type="hidden" name="sort" value="${sort}">` : ''}
        <button type="submit" class="btn btn-primary">Search</button>
      </form>
      <div class="filter-panel" id="candidate-filters">
        <div class="filter-row">
          <span class="filter-label" id="fl-owner">Whose</span>
          <ul class="filter" aria-labelledby="fl-owner">
            ${chip('My candidates', href({ owner: 'me' }), owner.key === 'me')}
            ${chip('All candidates', href({ owner: 'all' }), owner.key === 'all')}
          </ul>
          ${isAdmin
            ? html`<form method="get" action="/app/candidates" class="inline rep-picker" id="rep-picker">
                ${q ? html`<input type="hidden" name="q" value="${q}">` : ''}
                ${status !== 'active' ? html`<input type="hidden" name="status" value="${status}">` : ''}
                ${sort !== 'recent' ? html`<input type="hidden" name="sort" value="${sort}">` : ''}
                <label for="f-owner">Rep</label>
                <select name="owner" id="f-owner">
                  <option value="me"${owner.key === 'me' || owner.key === 'all' ? raw(' selected') : ''}>${owner.key === 'all' ? 'Choose a rep…' : 'Me'}</option>
                  ${reps.filter((u) => u.id !== ctx.user.id).map((u) => html`<option value="${u.id}"${owner.user && owner.user.id === u.id ? raw(' selected') : ''}>${u.name || u.email}</option>`)}
                  <option value="none"${owner.key === 'none' ? raw(' selected') : ''}>Unassigned roles</option>
                </select>
                <button type="submit" class="btn btn-secondary">Show</button>
              </form>`
            : ''}
        </div>
        <div class="filter-row">
          <span class="filter-label" id="fl-status">Status</span>
          <ul class="filter" aria-labelledby="fl-status">
            ${STATUS_CHIPS.map(([key, label]) => chip(label, href({ status: key }), status === key, countFor(key)))}
          </ul>
        </div>
        <div class="filter-row">
          <span class="filter-label" id="fl-sort">Order</span>
          <ul class="filter" aria-labelledby="fl-sort">
            ${chip('Recently applied', href({ sort: 'recent' }), sort === 'recent')}
            ${chip('Longest in stage', href({ sort: 'stage_age' }), sort === 'stage_age')}
          </ul>
        </div>
      </div>
      ${shown.length === 0
        ? html`${filtered ? html`<p class="result-count"><a href="/app/candidates" id="clear-filters">Clear filters</a></p>` : ''}${empty}`
        : html`<p class="result-count" id="result-count">${total} ${STATUS_WORDS[status]}${noun(total)} ${ownerPhrase}${matching}, ${sort === 'stage_age' ? 'longest in stage first' : 'most recently applied first'}${lastPage > 1 ? `. Page ${pageNo} of ${lastPage}` : ''}${filtered ? html`. <a href="/app/candidates" id="clear-filters">Clear filters</a>` : ''}</p>
          <div class="table-wrap table-stack"><table class="data" id="candidates-table">
            <thead><tr><th>Candidate</th><th>Role</th><th>Stage</th><th>Rep</th><th>Applied</th><th class="num">Days in stage</th></tr></thead>
            <tbody>
              ${shown.map((a) => {
                const days = daysSince(a.stage_changed_at);
                return html`<tr>
                  <td data-label="Candidate" class="cell-candidate"><a href="/app/applications/${a.id}"><strong>${a.name}</strong></a><span class="cell-sub">${a.email}</span></td>
                  <td data-label="Role"><span>${a.role_title}${a.site_name ? html`<span class="cell-sub">${a.site_name}</span>` : ''}</span></td>
                  <td data-label="Stage">${stageBadge({ kind: a.stage_kind, name: a.stage_name || LEGACY_LABELS[a.stage] || a.stage })}</td>
                  <td data-label="Rep">${a.rep_name || html`<span class="muted">Unassigned</span>`}</td>
                  <td data-label="Applied">${fmtDate(ctx, a.applied_at)}</td>
                  <td data-label="Days in stage" class="num">${days}</td>
                </tr>`;
              })}
            </tbody>
          </table></div>
          ${pageNo > 1 || hasNext
            ? html`<nav class="pager" aria-label="Pages">
                ${pageNo > 1 ? html`<a class="btn btn-secondary pager-prev" rel="prev" href="${href({ page: pageNo - 1 })}">Previous 50</a>` : ''}
                ${hasNext ? html`<a class="btn btn-secondary pager-next" rel="next" href="${href({ page: pageNo + 1 })}">Next 50</a>` : ''}
              </nav>`
            : ''}`}`,
  });
}

function register(router) {
  router.get('/app/candidates', requireUser, searchPage);
  router.get('/app/applications/:id', requireUser, candidatePage);
  router.post('/app/applications/:id/stage', requireUser, internalForm, changeStage);
  router.post('/app/applications/:id/voltax', requireUser, internalForm, recordVoltax);
  router.post('/app/applications/:id/role', requireUser, internalForm, moveRole);
  router.post('/app/applications/:id/notes', requireUser, internalForm, addNote);
  router.post('/app/applications/:id/email', requireUser, internalForm, logEmail);
  router.get('/app/people/:id/delete', requireAdmin, deleteConfirm);
  router.post('/app/people/:id/delete', requireAdmin, internalForm, deletePerson);
}

module.exports = { register, MERGE_FIELDS };

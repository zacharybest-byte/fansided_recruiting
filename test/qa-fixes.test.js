'use strict';
// Regression tests for the issues found in QA of v1.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, freshDb, makeUser, makeRole, lastApplication, count } = require('./helpers');

for (const driver of DRIVERS) {

describe(`[${driver}] QA fixes`, () => {
  let t;
  let rep;
  let role;
  let admin;
  before(async () => {
    t = await startApp({ driver });
    rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    role = await makeRole(t.db, { title: 'QA Role', assigned: rep, questions: [{ text: 'Why us?', required: true }] });
    admin = t.client();
    await admin.login('admin@fansided.com');
  });
  after(() => t.close());

  test('#1 ids are never reused after deleting the newest candidate', async () => {
    await t.client().apply(role, { email: 'newest@example.com', name: 'New Est', answer_0: 'x' });
    const app = await lastApplication(t.db);
    await admin.get(`/app/applications/${app.id}`);
    await admin.post(`/app/applications/${app.id}/notes`, { body: 'n' });
    await admin.post(`/app/applications/${app.id}/email`, { via: 'gmail', subject: 's', body: 'b' });
    const ids = {
      person: app.person_id,
      app: app.id,
      note: (await t.db.get('SELECT MAX(id) AS m FROM notes')).m,
      email: (await t.db.get('SELECT MAX(id) AS m FROM emails_sent')).m,
      event: (await t.db.get('SELECT MAX(id) AS m FROM application_events')).m,
    };
    await admin.get(`/app/people/${app.person_id}/delete`);
    assert.equal((await admin.post(`/app/people/${app.person_id}/delete`, {})).status, 303);

    await t.client().apply(role, { email: 'next@example.com', name: 'Next Person', answer_0: 'y' });
    const next = await lastApplication(t.db);
    assert.ok(next.id > ids.app, `application id ${next.id} reused`);
    assert.ok(next.person_id > ids.person, `person id ${next.person_id} reused`);
    assert.ok((await t.db.get('SELECT MAX(id) AS m FROM application_events')).m > ids.event);
    await admin.get(`/app/applications/${next.id}`);
    await admin.post(`/app/applications/${next.id}/notes`, { body: 'n2' });
    await admin.post(`/app/applications/${next.id}/email`, { via: 'gmail', subject: 's2', body: 'b2' });
    assert.ok((await t.db.get('SELECT MAX(id) AS m FROM notes')).m > ids.note);
    assert.ok((await t.db.get('SELECT MAX(id) AS m FROM emails_sent')).m > ids.email);
    // The old notification link does not open someone else.
    assert.equal((await admin.get(`/app/applications/${ids.app}`)).status, 404);
    const log = await t.db.get('SELECT deleted_person_id FROM deletion_log ORDER BY id DESC');
    assert.equal(await count(t.db, 'people', 'id = ?', log.deleted_person_id), 0);
  });

  test('#2 GET on the apply URL (reload after a validation error) redirects to the role page', async () => {
    const res = await t.client().get(`/roles/${role}/apply`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/roles/${role}`);
    const withSource = await t.client().get(`/roles/${role}/apply?source=x-1`);
    assert.equal(withSource.headers.get('location'), `/roles/${role}?source=x-1`);
  });

  test('#3 the form posts to a fragment-free URL and errors render a focusable summary at the top of the page', async () => {
    const c = t.client();
    const page = await c.get(`/roles/${role}`);
    assert.match(page.text, new RegExp(`action="/roles/${role}/apply" `));
    assert.doesNotMatch(page.text, /id="error-summary"/);
    const res = await c.apply(role, { name: '', answer_0: 'a' });
    assert.equal(res.status, 400);
    assert.match(res.text, /<main id="main" tabindex="-1"><div class="error-summary" id="error-summary" tabindex="-1" role="alert">/);
    // The only h2 in the summary comes before the form section's own h2.
    assert.ok(res.text.indexOf('id="error-summary"') < res.text.indexOf('<h2 id="apply">'));
    assert.match(res.text, /<a href="#f-name">Full name is required\.<\/a>/);
  });

  test('#4 only stored applications (and honeypot hits) count towards the rate limit', async () => {
    const c = t.client({ ip: '198.51.100.7' });
    for (let i = 0; i < 12; i++) assert.equal((await c.apply(role, { name: '', answer_0: 'a' })).status, 400); // invalid
    await c.get(`/roles/${role}`);
    for (let i = 0; i < 3; i++) assert.equal((await c.post(`/roles/${role}/apply`, { name: 'x' }, { csrf: 'bad' })).status, 403); // CSRF failures
    for (let i = 1; i <= 9; i++) assert.equal((await c.apply(role, { email: `rl${i}@example.com`, answer_0: 'a' })).status, 303, `valid ${i}`);
    assert.equal((await c.apply(role, { email: 'rl-hp@example.com', website: 'spam', answer_0: 'a' })).status, 303); // 10th: honeypot
    assert.equal((await c.apply(role, { email: 'rl11@example.com', answer_0: 'a' })).status, 429);
  });

  test('#5 note and email role tags show the role at write time, not the current role', async () => {
    const other = await makeRole(t.db, { title: 'Other Role', assigned: rep });
    await t.client().apply(role, { email: 'tags@example.com', name: 'Tag Person', answer_0: 'a' });
    const app = await lastApplication(t.db);
    await admin.get(`/app/applications/${app.id}`);
    await admin.post(`/app/applications/${app.id}/notes`, { body: 'Written under QA Role' });
    await admin.post(`/app/applications/${app.id}/email`, { via: 'gmail', subject: 'Sent under QA Role', body: 'x' });
    await admin.post(`/app/applications/${app.id}/role`, { role_id: String(other), from_role_id: String(role) });
    const page = await admin.get(`/app/applications/${app.id}`);
    const notes = page.text.split('id="notes"')[1].split('</section>')[0];
    assert.match(notes, /<span class="tag">QA Role<\/span>/);
    assert.doesNotMatch(notes, /<span class="tag">Other Role<\/span>/);
    assert.match(page.text, /Sent under QA Role<\/strong>[^\n]*<span class="tag">QA Role<\/span>/);
    assert.equal((await t.db.get('SELECT role_id FROM notes ORDER BY id DESC')).role_id, role);
    assert.equal((await t.db.get('SELECT role_id FROM emails_sent ORDER BY id DESC')).role_id, role);
  });

  test('#6 reassign select offers "Choose…" when the current rep is not active, and requires a choice', async () => {
    const gone = await makeUser(t.db, { email: 'gone@fansided.com', name: 'Gone Rep', active: 0 });
    const r = await makeRole(t.db, { title: 'Orphan Role', assigned: gone });
    const page = await admin.get(`/app/roles/${r}`);
    assert.match(page.text, /<select name="user_id" required>\s*<option value="" selected>Choose…<\/option>/);
    const res = await admin.post(`/app/roles/${r}/assign`, { user_id: '' });
    assert.equal(res.status, 303);
    assert.equal((await t.db.get('SELECT assigned_user_id FROM job_roles WHERE id = ?', [r])).assigned_user_id, gone);
    assert.match((await admin.follow(res)).text, /Choose an active user/);
    const assigned = await admin.get(`/app/roles/${role}`);
    assert.match(assigned.text, /<option value="">Choose…<\/option>/); // not selected when the rep is active
  });

  test('#7 tables are wrapped for horizontal scrolling', async () => {
    const page = await admin.get('/app/admin/roles');
    assert.match(page.text, /<div class="table-wrap"><table class="data">/);
    const css = await t.client().get('/public/style.css');
    assert.match(css.text, /\.table-wrap \{ position: relative; overflow-x: auto;/);
    assert.match(css.text, /overflow-wrap: anywhere/);
  });

  test("#8 admins can edit a user's display name (bootstrap admins start with none)", async () => {
    const me = await t.db.get("SELECT * FROM users WHERE email = 'admin@fansided.com'");
    assert.equal(me.name, '');
    await admin.get('/app/admin/users');
    const res = await admin.post(`/app/admin/users/${me.id}/name`, { name: '  Zach   Admin ' });
    assert.equal(res.status, 303);
    assert.equal((await t.db.get('SELECT name FROM users WHERE id = ?', [me.id])).name, 'Zach Admin');
    await admin.post(`/app/admin/users/${me.id}/name`, { name: '' });
    assert.equal((await t.db.get('SELECT name FROM users WHERE id = ?', [me.id])).name, 'Zach Admin');
    const rc = t.client();
    await rc.login('rep@fansided.com');
    await rc.get('/app');
    assert.equal((await rc.post(`/app/admin/users/${me.id}/name`, { name: 'Hacked' })).status, 403);
    // Deactivate goes through a server-rendered confirmation page (works without JavaScript).
    const users = (await admin.get('/app/admin/users')).text;
    assert.doesNotMatch(users, /data-confirm/);
    assert.match(users, /href="\/app\/admin\/users\/\d+\/deactivate">Deactivate<span class="visually-hidden"> Rita Rep<\/span>/);
  });

  test('#10 a changed questionnaire is detected and the applicant is asked to review', async () => {
    const r = await makeRole(t.db, { title: 'Changing Role', assigned: rep, questions: [{ text: 'Old Q1', required: true }, { text: 'Old Q2', required: false }] });
    const c = t.client();
    await c.get(`/roles/${r}`);
    const staleQv = /name="qv" value="([0-9a-f]+)"/.exec(c.lastHtml)[1];
    await t.db.run('UPDATE job_roles SET questions_json = ? WHERE id = ?', [JSON.stringify([{ text: 'New Q1', required: true }]), r]);
    const before = await count(t.db, 'applications');
    const res = await c.apply(r, { name: 'Kept Name', email: 'qv@example.com', answer_0: 'answer to old Q1', qv: staleQv });
    assert.equal(res.status, 409);
    assert.match(res.text, /The questions for this role have changed/);
    assert.match(res.text, /New Q1/);
    assert.match(res.text, /value="Kept Name"/);
    assert.doesNotMatch(res.text, /answer to old Q1/);
    assert.equal(await count(t.db, 'applications'), before);
    // Resubmitting the re-rendered form works.
    assert.equal((await c.apply(r, { name: 'Kept Name', email: 'qv@example.com', answer_0: 'new answer' })).status, 303);
    assert.deepEqual(JSON.parse((await lastApplication(t.db)).answers_json), [{ question: 'New Q1', answer: 'new answer' }]);
  });

  test('UX: Onboarded from the pipeline row goes to the candidate page Voltax form', async () => {
    await t.client().apply(role, { email: 'pipe-onboard@example.com', answer_0: 'a' });
    const app = await lastApplication(t.db);
    await admin.get(`/app/roles/${role}`);
    const res = await admin.post(`/app/applications/${app.id}/stage`, { stage: 'onboarded', from_stage: 'new', return_to: `/app/roles/${role}` });
    assert.equal(res.headers.get('location'), `/app/applications/${app.id}#voltax`);
    const page = await admin.follow(res);
    assert.match(page.text, /<h3 id="voltax">Voltax<\/h3>/);
    // A normal move from the pipeline still returns to the pipeline.
    await t.client().apply(role, { email: 'pipe-review@example.com', answer_0: 'a' });
    const app2 = await lastApplication(t.db);
    await admin.get(`/app/roles/${role}`);
    const res2 = await admin.post(`/app/applications/${app2.id}/stage`, { stage: 'reviewing', from_stage: 'new', return_to: `/app/roles/${role}` });
    assert.equal(res2.headers.get('location'), `/app/roles/${role}`);
  });
});

// Replaces the v1 "migration 3 upgrades an existing database" test: v2 starts from a fresh baseline schema
// (a v1 file is not migrated), so this checks that baseline keeps the v1.1 guarantees on both drivers.
test(`[${driver}] #1 baseline schema: ids never reused, foreign keys enforced, append-only events, seeded templates`, async () => {
  const f = await freshDb(driver);
  try {
    const { db } = f;
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM email_templates')).n, 4);
    // v2 schema: password auth, hashed sessions, link tokens, no Google/dev-mail/upload leftovers
    const cols = async (tbl) => (await db.all(`PRAGMA table_info(${tbl})`)).map((c) => c.name);
    assert.deepEqual(await cols('sessions'), ['token_hash', 'user_id', 'created_at', 'expires_at']);
    assert.deepEqual(await cols('auth_tokens'), ['id', 'user_id', 'kind', 'token_hash', 'expires_at', 'used_at', 'created_by_user_id', 'created_at']);
    assert.deepEqual(await cols('users'), ['id', 'email', 'name', 'role', 'active', 'password_hash', 'password_changed_at', 'dashboard_seen_at', 'created_at']);
    assert.deepEqual(await cols('emails_sent'), ['id', 'person_id', 'application_id', 'role_id', 'template_id', 'sender_user_id', 'to_email', 'subject', 'body', 'via', 'sent_at']);
    assert.ok((await cols('applications')).includes('resume_url'));
    assert.ok(!(await cols('applications')).some((c) => /^file_/.test(c)));
    for (const tbl of ['job_roles', 'people']) assert.ok((await cols(tbl)).includes('is_sample'), tbl);
    assert.equal(await db.get("SELECT name FROM sqlite_master WHERE name = 'dev_mail_log'"), undefined);
    for (const tbl of ['people', 'applications', 'application_events', 'notes', 'emails_sent', 'email_templates', 'deletion_log']) {
      assert.match((await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [tbl])).sql, /AUTOINCREMENT/, tbl);
    }
    const now = new Date().toISOString();
    await db.batch([
      { sql: "INSERT INTO users (id, email, name, role, active, created_at) VALUES (1, 'a@fansided.com', 'A', 'admin', 1, ?)", args: [now] },
      { sql: 'INSERT INTO job_roles (id, title, created_at, updated_at) VALUES (7, ?, ?, ?)', args: ['Old Role', now, now] },
      { sql: "INSERT INTO people (id, email, name, created_at, updated_at) VALUES (1, 'p1@example.com', 'P1', ?, ?), (2, 'p2@example.com', 'P2', ?, ?)", args: [now, now, now, now] },
      { sql: 'INSERT INTO applications (id, person_id, role_id, applied_at, stage_changed_at) VALUES (1, 1, 7, ?, ?), (2, 2, 7, ?, ?)', args: [now, now, now, now] },
      { sql: "INSERT INTO application_events (application_id, type, to_value, at) VALUES (1, 'stage_change', 'new', ?)", args: [now] },
    ]);
    assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
    // Foreign keys are enforced (local sqlite and the fake; the app does not depend on this, see docs).
    await assert.rejects(db.run("INSERT INTO applications (person_id, role_id, applied_at, stage_changed_at) VALUES (999, 7, 'x', 'x')"), /FOREIGN KEY/);
    // Append-only trigger.
    await assert.rejects(db.run("UPDATE application_events SET to_value = 'x'"), /append-only/);
    // Deleting the newest person does not free its id.
    await db.batch([
      { sql: 'DELETE FROM applications WHERE person_id = 2' },
      { sql: 'DELETE FROM people WHERE id = 2' },
    ]);
    const r = await db.run("INSERT INTO people (email, name, created_at, updated_at) VALUES ('p3@example.com', 'P3', 'x', 'x')");
    assert.equal(r.lastInsertRowid, 3);
  } finally {
    await f.close();
  }
});
}

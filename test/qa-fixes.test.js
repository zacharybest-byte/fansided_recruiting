'use strict';
// Regression tests for the issues found in QA of v1.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startApp, makeUser, makeRole, lastApplication, count } = require('./helpers');
const { MIGRATIONS, openDb } = require('../src/lib/db');

describe('QA fixes', () => {
  let t;
  let rep;
  let role;
  let admin;
  before(async () => {
    t = await startApp();
    rep = makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    role = makeRole(t.db, { title: 'QA Role', assigned: rep, questions: [{ text: 'Why us?', required: true }] });
    admin = t.client();
    await admin.login('admin@fansided.com');
  });
  after(() => t.close());

  test('#1 ids are never reused after deleting the newest candidate', async () => {
    await t.client().apply(role, { email: 'newest@example.com', name: 'New Est', answer_0: 'x' });
    const app = lastApplication(t.db);
    await admin.get(`/app/applications/${app.id}`);
    await admin.post(`/app/applications/${app.id}/notes`, { body: 'n' });
    await admin.post(`/app/applications/${app.id}/email`, { subject: 's', body: 'b' });
    const ids = {
      person: app.person_id,
      app: app.id,
      note: t.db.prepare('SELECT MAX(id) AS m FROM notes').get().m,
      email: t.db.prepare('SELECT MAX(id) AS m FROM emails_sent').get().m,
      event: t.db.prepare('SELECT MAX(id) AS m FROM application_events').get().m,
    };
    await admin.get(`/app/people/${app.person_id}/delete`);
    assert.equal((await admin.post(`/app/people/${app.person_id}/delete`, {})).status, 303);

    await t.client().apply(role, { email: 'next@example.com', name: 'Next Person', answer_0: 'y' });
    const next = lastApplication(t.db);
    assert.ok(next.id > ids.app, `application id ${next.id} reused`);
    assert.ok(next.person_id > ids.person, `person id ${next.person_id} reused`);
    assert.ok(t.db.prepare('SELECT MAX(id) AS m FROM application_events').get().m > ids.event);
    await admin.get(`/app/applications/${next.id}`);
    await admin.post(`/app/applications/${next.id}/notes`, { body: 'n2' });
    await admin.post(`/app/applications/${next.id}/email`, { subject: 's2', body: 'b2' });
    assert.ok(t.db.prepare('SELECT MAX(id) AS m FROM notes').get().m > ids.note);
    assert.ok(t.db.prepare('SELECT MAX(id) AS m FROM emails_sent').get().m > ids.email);
    // The old notification link does not open someone else.
    assert.equal((await admin.get(`/app/applications/${ids.app}`)).status, 404);
    const log = t.db.prepare('SELECT deleted_person_id FROM deletion_log ORDER BY id DESC').get();
    assert.equal(count(t.db, 'people', 'id = ?', log.deleted_person_id), 0);
  });

  test('#2 GET on the apply URL (reload after a validation error) redirects to the role page', async () => {
    const res = await t.client().get(`/roles/${role}/apply`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/roles/${role}`);
    const withSource = await t.client().get(`/roles/${role}/apply?source=x-1`);
    assert.equal(withSource.headers.get('location'), `/roles/${role}?source=x-1`);
  });

  test('#3 the form posts to #apply and errors render a focusable summary', async () => {
    const c = t.client();
    const page = await c.get(`/roles/${role}`);
    assert.match(page.text, new RegExp(`action="/roles/${role}/apply#apply"`));
    const res = await c.apply(role, { name: '', answer_0: 'a' });
    assert.equal(res.status, 400);
    assert.match(res.text, /<h2 id="apply">Apply<\/h2>\s*<div class="flash flash-error" id="error-summary" tabindex="-1" role="alert">/);
  });

  test('#4 only stored applications (and honeypot hits) count towards the rate limit', async () => {
    const c = t.client({ ip: '198.51.100.7' });
    for (let i = 0; i < 12; i++) assert.equal((await c.apply(role, { name: '', answer_0: 'a' })).status, 400); // invalid
    await c.get(`/roles/${role}`);
    const fd = new FormData();
    fd.append('csrf', 'bad');
    for (let i = 0; i < 3; i++) assert.equal((await c.request('POST', `/roles/${role}/apply`, { body: fd })).status, 403); // CSRF failures
    for (let i = 1; i <= 9; i++) assert.equal((await c.apply(role, { email: `rl${i}@example.com`, answer_0: 'a' })).status, 303, `valid ${i}`);
    assert.equal((await c.apply(role, { email: 'rl-hp@example.com', website: 'spam', answer_0: 'a' })).status, 303); // 10th: honeypot
    assert.equal((await c.apply(role, { email: 'rl11@example.com', answer_0: 'a' })).status, 429);
  });

  test('#5 note and email role tags show the role at write time, not the current role', async () => {
    const other = makeRole(t.db, { title: 'Other Role', assigned: rep });
    await t.client().apply(role, { email: 'tags@example.com', name: 'Tag Person', answer_0: 'a' });
    const app = lastApplication(t.db);
    await admin.get(`/app/applications/${app.id}`);
    await admin.post(`/app/applications/${app.id}/notes`, { body: 'Written under QA Role' });
    await admin.post(`/app/applications/${app.id}/email`, { subject: 'Sent under QA Role', body: 'x' });
    await admin.post(`/app/applications/${app.id}/role`, { role_id: String(other) });
    const page = await admin.get(`/app/applications/${app.id}`);
    const notes = page.text.split('id="notes"')[1].split('</section>')[0];
    assert.match(notes, /<span class="tag">QA Role<\/span>/);
    assert.doesNotMatch(notes, /<span class="tag">Other Role<\/span>/);
    assert.match(page.text, /Sent under QA Role<\/strong>[^\n]*<span class="tag">QA Role<\/span>/);
    assert.equal(t.db.prepare('SELECT role_id FROM notes ORDER BY id DESC').get().role_id, role);
    assert.equal(t.db.prepare('SELECT role_id FROM emails_sent ORDER BY id DESC').get().role_id, role);
  });

  test('#6 reassign select offers "Choose…" when the current rep is not active, and requires a choice', async () => {
    const gone = makeUser(t.db, { email: 'gone@fansided.com', name: 'Gone Rep', active: 0 });
    const r = makeRole(t.db, { title: 'Orphan Role', assigned: gone });
    const page = await admin.get(`/app/roles/${r}`);
    assert.match(page.text, /<select name="user_id" required>\s*<option value="" selected>Choose…<\/option>/);
    const res = await admin.post(`/app/roles/${r}/assign`, { user_id: '' });
    assert.equal(res.status, 303);
    assert.equal(t.db.prepare('SELECT assigned_user_id FROM job_roles WHERE id = ?').get(r).assigned_user_id, gone);
    assert.match((await admin.follow(res)).text, /Choose an active user/);
    const assigned = await admin.get(`/app/roles/${role}`);
    assert.match(assigned.text, /<option value="">Choose…<\/option>/); // not selected when the rep is active
  });

  test('#7 tables are wrapped for horizontal scrolling', async () => {
    const page = await admin.get(`/app/roles/${role}`);
    assert.match(page.text, /<div class="table-wrap"><table class="data pipeline">\s*<colgroup>/);
    const css = await t.client().get('/public/style.css');
    assert.match(css.text, /\.table-wrap \{ overflow-x: auto;/);
    assert.match(css.text, /overflow-wrap: anywhere/);
  });

  test("#8 admins can edit a user's display name (bootstrap admins start with none)", async () => {
    const me = t.db.prepare("SELECT * FROM users WHERE email = 'admin@fansided.com'").get();
    assert.equal(me.name, '');
    await admin.get('/app/admin/users');
    const res = await admin.post(`/app/admin/users/${me.id}/name`, { name: '  Zach   Admin ' });
    assert.equal(res.status, 303);
    assert.equal(t.db.prepare('SELECT name FROM users WHERE id = ?').get(me.id).name, 'Zach Admin');
    await admin.post(`/app/admin/users/${me.id}/name`, { name: '' });
    assert.equal(t.db.prepare('SELECT name FROM users WHERE id = ?').get(me.id).name, 'Zach Admin');
    const rc = t.client();
    await rc.login('rep@fansided.com');
    await rc.get('/app');
    assert.equal((await rc.post(`/app/admin/users/${me.id}/name`, { name: 'Hacked' })).status, 403);
    // Deactivate asks for confirmation in the browser.
    assert.match((await admin.get('/app/admin/users')).text, /data-confirm="Deactivate Rita Rep\?/);
  });

  test('#10 a changed questionnaire is detected and the applicant is asked to review', async () => {
    const r = makeRole(t.db, { title: 'Changing Role', assigned: rep, questions: [{ text: 'Old Q1', required: true }, { text: 'Old Q2', required: false }] });
    const c = t.client();
    await c.get(`/roles/${r}`);
    const staleQv = /name="qv" value="([0-9a-f]+)"/.exec(c.lastHtml)[1];
    t.db.prepare('UPDATE job_roles SET questions_json = ? WHERE id = ?').run(JSON.stringify([{ text: 'New Q1', required: true }]), r);
    const before = count(t.db, 'applications');
    const res = await c.apply(r, { name: 'Kept Name', email: 'qv@example.com', answer_0: 'answer to old Q1', qv: staleQv });
    assert.equal(res.status, 409);
    assert.match(res.text, /The questions for this role have changed/);
    assert.match(res.text, /New Q1/);
    assert.match(res.text, /value="Kept Name"/);
    assert.doesNotMatch(res.text, /answer to old Q1/);
    assert.equal(count(t.db, 'applications'), before);
    // Resubmitting the re-rendered form works.
    assert.equal((await c.apply(r, { name: 'Kept Name', email: 'qv@example.com', answer_0: 'new answer' })).status, 303);
    assert.deepEqual(JSON.parse(lastApplication(t.db).answers_json), [{ question: 'New Q1', answer: 'new answer' }]);
  });

  test('UX: Onboarded from the pipeline row goes to the candidate page Voltax form', async () => {
    await t.client().apply(role, { email: 'pipe-onboard@example.com', answer_0: 'a' });
    const app = lastApplication(t.db);
    await admin.get(`/app/roles/${role}`);
    const res = await admin.post(`/app/applications/${app.id}/stage`, { stage: 'onboarded', return_to: `/app/roles/${role}` });
    assert.equal(res.headers.get('location'), `/app/applications/${app.id}#voltax`);
    const page = await admin.follow(res);
    assert.match(page.text, /<h3 id="voltax">Voltax<\/h3>/);
    // A normal move from the pipeline still returns to the pipeline.
    await t.client().apply(role, { email: 'pipe-review@example.com', answer_0: 'a' });
    const app2 = lastApplication(t.db);
    await admin.get(`/app/roles/${role}`);
    const res2 = await admin.post(`/app/applications/${app2.id}/stage`, { stage: 'reviewing', return_to: `/app/roles/${role}` });
    assert.equal(res2.headers.get('location'), `/app/roles/${role}`);
  });
});

test('#11 production logs carry ids, not applicant names or emails', async () => {
  const lines = [];
  const t = await startApp({
    env: { NODE_ENV: 'production', DEV_LOGIN: '0', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', BASE_URL: 'https://recruit.example.com' },
    log: (l) => lines.push(l),
  });
  try {
    const rep = makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    const role = makeRole(t.db, { title: 'Prod Role', assigned: rep });
    t.app.mailer.mode = 'log';
    assert.equal((await t.client().apply(role, { email: 'private.person@example.com', name: 'Private Person' })).status, 303);
    t.app.mailer.deliver = async () => {
      throw new Error('down');
    };
    await t.client().apply(role, { email: 'private.two@example.com', name: 'Private Two' });
    const all = lines.join('\n');
    assert.match(all, /\[notify\]/);
    assert.doesNotMatch(all, /private|Private/);
  } finally {
    await t.close();
  }
});

test('#1 migration 3 upgrades an existing v2 database without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-mig-'));
  try {
    // Build a version-2 database by hand, with data, as v1 would have left it.
    const raw = new DatabaseSync(path.join(dir, 'recruit.sqlite'));
    raw.exec(MIGRATIONS[0]);
    MIGRATIONS[1](raw);
    raw.exec('PRAGMA user_version = 2');
    const now = new Date().toISOString();
    raw.exec(`
      INSERT INTO users (id, email, name, role, active, created_at) VALUES (1, 'a@fansided.com', 'A', 'admin', 1, '${now}');
      INSERT INTO job_roles (id, title, created_at, updated_at) VALUES (7, 'Old Role', '${now}', '${now}');
      INSERT INTO people (id, email, name, created_at, updated_at) VALUES (1, 'p1@example.com', 'P1', '${now}', '${now}'),
                                                                          (2, 'p2@example.com', 'P2', '${now}', '${now}');
      INSERT INTO applications (id, person_id, role_id, applied_at, stage_changed_at) VALUES (1, 1, 7, '${now}', '${now}'), (2, 2, 7, '${now}', '${now}');
      INSERT INTO application_events (application_id, type, to_value, at) VALUES (1, 'stage_change', 'new', '${now}');
      INSERT INTO notes (person_id, application_id, author_user_id, body, created_at) VALUES (1, 1, 1, 'kept note', '${now}');
      INSERT INTO emails_sent (person_id, application_id, sender_user_id, to_email, subject, body, status, sent_at)
        VALUES (1, 1, 1, 'p1@example.com', 'kept subject', 'b', 'sent', '${now}');
    `);
    raw.close();

    const db = openDb(dir);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_templates').get().n, 4);
    assert.equal(db.prepare('SELECT body FROM notes').get().body, 'kept note');
    assert.equal(db.prepare('SELECT role_id FROM notes').get().role_id, 7); // backfilled
    assert.equal(db.prepare('SELECT role_id FROM emails_sent').get().role_id, 7);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    for (const tbl of ['people', 'applications', 'application_events', 'notes', 'emails_sent', 'email_templates', 'deletion_log']) {
      assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tbl).sql, /AUTOINCREMENT/, tbl);
    }
    // Foreign keys still point at the right tables and are enforced.
    assert.throws(() => db.prepare("INSERT INTO applications (person_id, role_id, applied_at, stage_changed_at) VALUES (999, 7, 'x', 'x')").run(), /FOREIGN KEY/);
    // Append-only trigger survived.
    assert.throws(() => db.prepare("UPDATE application_events SET to_value = 'x'").run(), /append-only/);
    // Deleting the newest person does not free its id.
    db.exec('DELETE FROM applications WHERE person_id = 2; DELETE FROM people WHERE id = 2;');
    const r = db.prepare("INSERT INTO people (email, name, created_at, updated_at) VALUES ('p3@example.com', 'P3', 'x', 'x')").run();
    assert.equal(Number(r.lastInsertRowid), 3);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DRIVERS, startApp, makeUser, makeRole, lastApplication, count, pdf } = require('./helpers');
const { CSV_COLUMNS } = require('../src/routes/dashboard');
const { MIGRATIONS } = require('../src/lib/db');

for (const driver of DRIVERS) describe(`[${driver}]`, () => {

let t;
let admin;

before(async () => {
  t = await startApp({ driver });
  await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
  admin = t.client();
  await admin.login('admin@fansided.com');
});
after(() => t.close());

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return rows;
}

test('AC-29: admin creates a role with 5 questions, edits it and closes it; closed roles leave / but stay internal', async () => {
  await admin.get('/app/admin/roles/new');
  const repId = (await t.db.get("SELECT id FROM users WHERE email = 'rep@fansided.com'")).id;
  const fields = { title: 'Packers Writer', vertical: 'NFL', site_name: 'Lombardi Ave', description: 'Line 1\nLine 2', status: 'open', assigned_user_id: String(repId) };
  for (let i = 0; i < 5; i++) fields[`q_text_${i}`] = `Question ${i + 1}?`;
  fields.q_required_0 = '1';
  fields.q_required_3 = '1';
  fields.q_text_5 = 'A sixth question is ignored';
  let res = await admin.post('/app/admin/roles', fields);
  assert.equal(res.status, 303);
  const role = await t.db.get("SELECT * FROM job_roles WHERE title = 'Packers Writer'");
  const qs = JSON.parse(role.questions_json);
  assert.equal(qs.length, 5);
  assert.deepEqual(qs.map((q) => q.required), [true, false, false, true, false]);
  assert.equal(role.description, 'Line 1\nLine 2');
  const pub = await t.client().get(`/roles/${role.id}`);
  assert.match(pub.text, /Question 5\?/);
  assert.doesNotMatch(pub.text, /sixth/);
  assert.match(pub.text, /<div class="pre">Line 1\nLine 2<\/div>/);

  // Datalist of existing verticals on the form
  const form = await admin.get(`/app/admin/roles/${role.id}`);
  assert.match(form.text, /<datalist id="verticals"><option value="NFL">/);

  await t.client().apply(role.id, { email: 'packer@example.com', name: 'Pat Packer', answer_0: 'a', answer_3: 'b' });

  res = await admin.post(`/app/admin/roles/${role.id}`, { ...fields, title: 'Packers Staff Writer', q_text_4: '' });
  assert.equal(res.status, 303);
  let edited = await t.db.get('SELECT * FROM job_roles WHERE id = ?', [role.id]);
  assert.equal(edited.title, 'Packers Staff Writer');
  assert.equal(JSON.parse(edited.questions_json).length, 4);

  assert.match((await t.client().get('/')).text, /Packers Staff Writer/);
  await admin.get(`/app/admin/roles/${role.id}`);
  res = await admin.post(`/app/admin/roles/${role.id}`, { ...fields, title: 'Packers Staff Writer', status: 'closed' });
  edited = await t.db.get('SELECT * FROM job_roles WHERE id = ?', [role.id]);
  assert.equal(edited.status, 'closed');
  assert.doesNotMatch((await t.client().get('/')).text, /Packers Staff Writer/);
  assert.match((await t.client().get(`/roles/${role.id}`)).text, /no longer open/);
  assert.match((await admin.get('/app?view=all')).text, /Packers Staff Writer/);
  assert.match((await admin.get('/app/admin/roles')).text, /Packers Staff Writer/);
  const pipeline = await admin.get(`/app/roles/${role.id}`);
  assert.equal(pipeline.status, 200);
  assert.match(pipeline.text, /packer@example.com/);
  // No delete route for roles.
  assert.equal((await admin.post(`/app/admin/roles/${role.id}/delete`, {})).status, 404);

  // Validation keeps values
  await admin.get('/app/admin/roles/new');
  res = await admin.post('/app/admin/roles', { title: '', vertical: 'NBA', status: 'open' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Title is required/);
  assert.match(res.text, /value="NBA"/);
});

test('AC-30: add user, promote to admin, deactivate; cannot deactivate self or remove the last admin', async () => {
  await admin.get('/app/admin/users');
  let res = await admin.post('/app/admin/users', { email: 'New.Person@FanSided.com', name: 'New Person', role: 'rep' });
  assert.equal(res.status, 303);
  const u = await t.db.get("SELECT * FROM users WHERE email = 'new.person@fansided.com'");
  assert.equal(u.role, 'rep');
  assert.equal(u.active, 1);
  res = await admin.post('/app/admin/users', { email: 'new.person@fansided.com', name: 'Dup', role: 'rep' });
  assert.equal(res.status, 400);
  assert.match(res.text, /already exists/);

  await admin.get('/app/admin/users');
  await admin.post(`/app/admin/users/${u.id}/role`, { role: 'admin' });
  assert.equal((await t.db.get('SELECT role FROM users WHERE id = ?', [u.id])).role, 'admin');

  // New admin can sign in and use admin pages.
  const c = t.client();
  await c.login('new.person@fansided.com');
  assert.equal((await c.get('/app/admin/users')).status, 200);

  // Deactivate them (the original admin remains).
  await admin.get('/app/admin/users');
  res = await admin.post(`/app/admin/users/${u.id}/deactivate`, {});
  assert.equal(res.status, 303);
  assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [u.id])).active, 0);
  assert.equal((await c.get('/app')).status, 302);
  assert.equal((await c.login('new.person@fansided.com')).status, 403);

  // Cannot deactivate self.
  const me = (await t.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id;
  await admin.get('/app/admin/users');
  res = await admin.post(`/app/admin/users/${me}/deactivate`, {});
  let page = await admin.follow(res);
  assert.match(page.text, /You cannot deactivate yourself/);
  assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [me])).active, 1);

  // Cannot demote the last active admin.
  res = await admin.post(`/app/admin/users/${me}/role`, { role: 'rep' });
  page = await admin.follow(res);
  assert.match(page.text, /last active admin/);
  assert.equal((await t.db.get('SELECT role FROM users WHERE id = ?', [me])).role, 'admin');

  // With two active admins, one can deactivate the other; the remaining admin is then protected
  // (self-deactivation and last-admin demotion are refused above).
  const other = await makeUser(t.db, { email: 'other.admin@fansided.com', role: 'admin' });
  await admin.get('/app/admin/users');
  res = await admin.post(`/app/admin/users/${other}/deactivate`, {});
  assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [other])).active, 0);

  // Reactivate.
  res = await admin.post(`/app/admin/users/${u.id}/reactivate`, {});
  assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [u.id])).active, 1);
});

test('AC-30: deactivating a user who still has roles shows a warning first', async () => {
  const repId = await makeUser(t.db, { email: 'busy@fansided.com', name: 'Busy Rep' });
  await makeRole(t.db, { title: 'Busy Role', assigned: repId });
  await admin.get('/app/admin/users');
  const res = await admin.post(`/app/admin/users/${repId}/deactivate`, {});
  assert.equal(res.status, 200);
  assert.match(res.text, /Warning: Busy Rep is still the assigned rep/);
  assert.match(res.text, /Busy Role/);
  assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [repId])).active, 1);
  const res2 = await admin.post(`/app/admin/users/${repId}/deactivate`, { confirm: '1' });
  assert.equal(res2.status, 303);
  assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [repId])).active, 0);
});

test('AC-32: CSV export columns, one row per application, date filter, formula-injection guard', async () => {
  const role = await makeRole(t.db, { title: 'CSV, "Quoted" Role', vertical: 'NBA', site: 'Hoops' });
  await t.client().apply(role, { name: '=HYPERLINK("http://evil")', email: 'csv1@example.com', heard_from: 'Referral' }, { query: '?source=%2Bplus' });
  const a1 = (await lastApplication(t.db)).id;
  await t.client().apply(role, { name: 'Line\nBreak', email: 'csv2@example.com' });
  const a2 = (await lastApplication(t.db)).id;
  // Late evening of 9 March in New York is already 10 March in UTC.
  await t.db.run("UPDATE applications SET applied_at = '2026-03-10T03:30:00.000Z' WHERE id = ?", [a1]);
  await t.db.run("UPDATE applications SET applied_at = '2026-03-12T15:00:00.000Z' WHERE id = ?", [a2]);

  const res = await admin.get('/app/export.csv');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="fansided-applications-\d{4}-\d{2}-\d{2}\.csv"$/);
  const rows = parseCsv(res.text);
  assert.deepEqual(rows[0], CSV_COLUMNS);
  assert.deepEqual(rows[0], ['application_id', 'applied_at', 'name', 'email', 'role_title', 'vertical', 'site_name', 'assigned_rep', 'source_tag', 'heard_from', 'stage', 'stage_changed_at', 'onboarded_at', 'voltax_user_id', 'linkedin_url']);
  assert.equal(rows.length - 1, await count(t.db, 'applications'));
  assert.ok(rows.every((r) => r.length === 15));
  const r1 = rows.find((r) => r[0] === String(a1));
  assert.equal(r1[1], '2026-03-09 23:30'); // America/New_York
  assert.equal(r1[2], `'=HYPERLINK("http://evil")`);
  assert.equal(r1[4], 'CSV, "Quoted" Role');
  assert.equal(r1[8], "'+plus");
  assert.equal(r1[9], 'Referral');
  assert.equal(r1[10], 'new');
  assert.match(res.text, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  const r2 = rows.find((r) => r[0] === String(a2));
  assert.equal(r2[2], 'Line Break'); // whitespace in single-line fields is collapsed
  assert.ok(res.text.endsWith('\r\n'));

  const filtered = parseCsv((await admin.get('/app/export.csv?from=2026-03-09&to=2026-03-09')).text);
  assert.deepEqual(filtered.slice(1).map((r) => r[0]), [String(a1)]);
  const filtered2 = parseCsv((await admin.get('/app/export.csv?from=2026-03-10&to=2026-03-12')).text);
  assert.deepEqual(filtered2.slice(1).map((r) => r[0]), [String(a2)]);
  const none = parseCsv((await admin.get('/app/export.csv?from=2020-01-01&to=2020-01-02')).text);
  assert.equal(none.length, 1);
  assert.equal((await admin.get('/app/export.csv?from=nonsense')).status, 400);

  // Reps can export too.
  const rep = t.client();
  await rep.login('rep@fansided.com');
  assert.equal((await rep.get('/app/export.csv')).status, 200);
  assert.match((await rep.get('/app/export')).text, /type="date" name="from"/);
});

test('AC-33: deleting a candidate removes person, applications, events, notes, emails, files; logs one deletion', async () => {
  const roleA = await makeRole(t.db, { title: 'Delete A' });
  const roleB = await makeRole(t.db, { title: 'Delete B' });
  await t.client().apply(roleA, { email: 'forget.me@example.com', name: 'Forget Me' }, { file: { name: 'cv.pdf', data: pdf(3000) } });
  const a1 = await lastApplication(t.db);
  await t.client().apply(roleB, { email: 'forget.me@example.com', name: 'Forget Me' }, { file: { name: 'cv2.pdf', data: pdf(3000) } });
  const a2 = await lastApplication(t.db);
  const files = [a1.file_path, a2.file_path].map((f) => path.join(t.dataDir, f));
  files.forEach((f) => assert.ok(fs.existsSync(f)));
  await admin.get(`/app/applications/${a1.id}`);
  await admin.post(`/app/applications/${a1.id}/notes`, { body: 'note 1' });
  await admin.post(`/app/applications/${a2.id}/stage`, { stage: 'reviewing' });
  await admin.post(`/app/applications/${a2.id}/email`, { subject: 'Hi', body: 'There' });
  const personId = a1.person_id;
  const keep = await count(t.db, 'applications') - 2;

  const confirm = await admin.get(`/app/people/${personId}/delete?from=${a1.id}`);
  assert.equal(confirm.status, 200);
  assert.match(confirm.text, /This permanently deletes/);
  assert.equal(await count(t.db, 'people', 'id = ?', personId), 1); // GET alone deletes nothing

  const res = await admin.post(`/app/people/${personId}/delete`, {});
  assert.equal(res.status, 303);
  assert.equal(await count(t.db, 'people', 'id = ?', personId), 0);
  assert.equal(await count(t.db, 'applications', 'person_id = ?', personId), 0);
  assert.equal(await count(t.db, 'application_events', 'application_id IN (?, ?)', a1.id, a2.id), 0);
  assert.equal(await count(t.db, 'notes', 'person_id = ?', personId), 0);
  assert.equal(await count(t.db, 'emails_sent', 'person_id = ?', personId), 0);
  files.forEach((f) => assert.ok(!fs.existsSync(f)));
  assert.equal(await count(t.db, 'applications'), keep);
  const log = await t.db.all('SELECT * FROM deletion_log');
  assert.equal(log.length, 1);
  assert.equal(log[0].deleted_person_id, personId);
  assert.deepEqual(Object.keys(log[0]).sort(), ['actor_user_id', 'at', 'deleted_person_id', 'id']);
  assert.equal((await admin.get(`/app/applications/${a1.id}`)).status, 404);
});

test('AC-34: user-entered <script> is escaped on every page', async () => {
  const x = '<script>alert(1)</script>';
  // Admin-entered role and template content
  await admin.get('/app/admin/roles/new');
  await admin.post('/app/admin/roles', { title: `Role ${x}`, vertical: `V ${x}`, site_name: `S ${x}`, description: `D ${x}`, status: 'open', q_text_0: `Q ${x}`, assigned_user_id: String((await t.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id) });
  const role = (await t.db.get("SELECT id FROM job_roles WHERE title LIKE 'Role <script>%'")).id;
  await admin.get('/app/admin/templates/new');
  await admin.post('/app/admin/templates', { name: `T ${x}`, subject: `Subj ${x}`, body: `Body ${x} {{${'"><script>'}}}` });
  await admin.get('/app/admin/users');
  await admin.post('/app/admin/users', { email: 'xss.user@fansided.com', name: `U ${x}`, role: 'rep' });

  // Applicant-entered content
  const c = t.client();
  await c.apply(role, { name: `N ${x}`, email: 'xss@example.com', sample_links: `https://example.com/?q=${x}`, answer_0: `A ${x}`, source: x });
  const app = await lastApplication(t.db);
  assert.ok(app, 'application saved');
  assert.match(app.source_tag, /<script>/);
  await admin.get(`/app/applications/${app.id}`);
  await admin.post(`/app/applications/${app.id}/notes`, { body: `Note ${x}` });
  await admin.post(`/app/applications/${app.id}/email`, { subject: `Mail ${x}`, body: `Mail body ${x}` });
  const tpl = (await t.db.get("SELECT id FROM email_templates WHERE name LIKE 'T <script>%'")).id;

  // Bad URL schemes are never links
  const bad = await t.client().apply(role, { email: 'js@example.com', sample_links: 'javascript:alert(1)', linkedin_url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);

  const pages = [
    ['public', '/'],
    ['public', `/roles/${role}`],
    ['public', `/roles/${role}?source=${encodeURIComponent(x)}`],
    ['admin', '/app'],
    ['admin', '/app?view=all'],
    ['admin', `/app/roles/${role}`],
    ['admin', `/app/applications/${app.id}`],
    ['admin', `/app/applications/${app.id}?template=${tpl}`],
    ['admin', '/app/admin/roles'],
    ['admin', `/app/admin/roles/${role}`],
    ['admin', '/app/admin/templates'],
    ['admin', `/app/admin/templates/${tpl}`],
    ['admin', '/app/admin/users'],
    ['admin', `/app/people/${app.person_id}/delete`],
  ];
  for (const [who, url] of pages) {
    const res = await (who === 'public' ? t.client() : admin).get(url);
    assert.equal(res.status, 200, url);
    assert.ok(!res.text.includes('<script>alert'), `unescaped script on ${url}`);
    assert.ok(!/<script>(?!<\/)/.test(res.text.replace('<script src="/public/app.js" defer></script>', '')), `script tag on ${url}`);
    assert.ok(res.text.includes('&lt;script&gt;'), `escaped text missing on ${url}`);
  }
  // Validation re-render escapes too
  const err = await t.client().apply(role, { name: x, email: 'bad', sample_links: '' });
  assert.ok(!err.text.includes('<script>alert'));
  assert.ok(err.text.includes('value="&lt;script&gt;alert(1)&lt;/script&gt;"'));
});

test('AC-35: data and uploads survive a restart and migrations do not re-run', async () => {
  const role = await makeRole(t.db, { title: 'Persistent Role' });
  await t.client().apply(role, { email: 'persist@example.com', name: 'Per Sist' }, { file: { name: 'keep.pdf', data: pdf(4096) } });
  const app = await lastApplication(t.db);
  // Remove one seeded template: if the seed migration re-ran, it would come back.
  await t.db.run("DELETE FROM email_templates WHERE name = 'Welcome aboard'");
  const templates = await count(t.db, 'email_templates');
  const version = (await t.db.get('SELECT MAX(version) AS v FROM schema_migrations')).v;
  assert.equal(version, MIGRATIONS.length);
  const tables = ['users', 'people', 'applications', 'application_events', 'notes', 'emails_sent', 'job_roles'];
  const totals = [];
  for (const tb of tables) totals.push(await count(t.db, tb));

  t = await t.restart();
  admin = t.client();
  await admin.login('admin@fansided.com');

  assert.equal((await t.db.get('SELECT MAX(version) AS v FROM schema_migrations')).v, version);
  assert.equal(await count(t.db, 'schema_migrations'), MIGRATIONS.length);
  assert.equal(await count(t.db, 'email_templates'), templates);
  assert.equal(await count(t.db, 'email_templates', "name = 'Welcome aboard'"), 0);
  const after = [];
  for (const tb of tables) after.push(await count(t.db, tb));
  assert.deepEqual(after, totals);
  const file = await admin.get(`/app/applications/${app.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.buffer.length, 4096);
  assert.match((await admin.get(`/app/applications/${app.id}`)).text, /Per Sist/);
});
});

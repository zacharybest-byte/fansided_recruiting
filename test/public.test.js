'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DRIVERS, startApp, makeUser, makeRole, lastApplication, count, pdf } = require('./helpers');

for (const driver of DRIVERS) describe(`[${driver}]`, () => {

let t;
let rep;
let openNfl;
let openNba;
let closed;
let qRole;

before(async () => {
  t = await startApp({ driver });
  rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
  openNfl = await makeRole(t.db, { title: 'Bears Writer', vertical: 'NFL', site: 'Bears Wire', assigned: rep, description: 'First line of the bears job.\nSecond line.' });
  openNba = await makeRole(t.db, { title: 'Hoops Writer', vertical: 'NBA', site: 'Hoops Habit', assigned: rep });
  closed = await makeRole(t.db, { title: 'Closed Prospects Role', vertical: 'MLB', status: 'closed', assigned: rep });
  qRole = await makeRole(t.db, {
    title: 'Questionnaire Role',
    vertical: 'NFL',
    assigned: rep,
    questions: [
      { text: 'Why this team?', required: true },
      { text: 'Anything else?', required: false },
    ],
  });
});
after(() => t.close());

test('AC-01: openings list groups open roles by vertical, hides closed ones, no login', async () => {
  const res = await t.client().get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<h2>NFL<\/h2>/);
  assert.match(res.text, /<h2>NBA<\/h2>/);
  assert.match(res.text, /Bears Writer/);
  assert.match(res.text, /Hoops Writer/);
  assert.match(res.text, /Bears Wire/);
  assert.match(res.text, /First line of the bears job\./);
  assert.doesNotMatch(res.text, /Second line/); // one-line excerpt only
  assert.doesNotMatch(res.text, /Closed Prospects Role/);
  assert.doesNotMatch(res.text, /<h2>MLB<\/h2>/);
  // NFL group holds both NFL roles
  const nflSection = res.text.split('<h2>NFL</h2>')[1].split('</section>')[0];
  assert.match(nflSection, /Bears Writer/);
  assert.match(nflSection, /Questionnaire Role/);
  assert.equal(res.headers.get('content-security-policy'), "default-src 'self'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('AC-02: closed role page says no longer open; applying to it creates nothing', async () => {
  const c = t.client();
  const page = await c.get(`/roles/${closed}`);
  assert.match(page.text, /This role is no longer open/);
  assert.match(page.text, /href="\/"/);
  const unknown = await c.get('/roles/99999');
  assert.match(unknown.text, /no longer open/);

  const before = await count(t.db, 'applications');
  const peopleBefore = await count(t.db, 'people');
  await c.get(`/roles/${openNfl}`); // get a valid public token
  const fd = new FormData();
  fd.append('csrf', c.csrf());
  fd.append('name', 'Closed Applicant');
  fd.append('email', 'closed@example.com');
  fd.append('sample_links', 'https://example.com/x');
  const res = await c.request('POST', `/roles/${closed}/apply`, { body: fd });
  assert.match(res.text, /no longer open/);
  assert.equal(await count(t.db, 'applications'), before);
  assert.equal(await count(t.db, 'people'), peopleBefore);
});

test('AC-03: ?source= is carried through to the application', async () => {
  const c = t.client();
  const list = await c.get('/?source=linkedin-nfl');
  assert.match(list.text, new RegExp(`href="/roles/${openNfl}\\?source=linkedin-nfl"`));
  const res = await c.apply(openNfl, { email: 'source@example.com' }, { query: '?source=linkedin-nfl' });
  assert.equal(res.status, 303);
  assert.equal((await lastApplication(t.db)).source_tag, 'linkedin-nfl');
});

test('AC-04: role page shows exactly its questions; a missing required answer keeps other values', async () => {
  const c = t.client();
  const page = await c.get(`/roles/${qRole}`);
  assert.match(page.text, /Why this team\?/);
  assert.match(page.text, /Anything else\?/);
  assert.match(page.text, /name="answer_0"/);
  assert.match(page.text, /name="answer_1"/);
  assert.doesNotMatch(page.text, /name="answer_2"/);
  const other = await c.get(`/roles/${openNfl}`);
  assert.doesNotMatch(other.text, /name="answer_0"/);

  const before = await count(t.db, 'applications');
  const res = await c.apply(qRole, { name: 'Kept Name', email: 'kept@example.com', sample_links: 'https://kept.example.com/a', answer_0: '', answer_1: 'Kept optional answer' });
  assert.equal(res.status, 400);
  assert.match(res.text, /id="err-answer_0"[^>]*>This question is required/);
  assert.match(res.text, /value="Kept Name"/);
  assert.match(res.text, /value="kept@example.com"/);
  assert.match(res.text, /https:\/\/kept.example.com\/a<\/textarea>/);
  assert.match(res.text, />Kept optional answer<\/textarea>/);
  assert.match(res.text, /<option selected>LinkedIn<\/option>/);
  assert.equal(await count(t.db, 'applications'), before);
});

test('AC-05: missing name, invalid email, no sample link are rejected with field errors', async () => {
  const c = t.client();
  const before = await count(t.db, 'applications');
  const res = await c.apply(openNfl, { name: '', email: 'not-an-email', sample_links: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /id="err-name"/);
  assert.match(res.text, /id="err-email"/);
  assert.match(res.text, /id="err-sample_links"/);
  assert.equal(await count(t.db, 'applications'), before);
});

test('AC-06: valid submission creates one New application with one system stage_change event and redirects to /thanks', async () => {
  const c = t.client();
  const before = await count(t.db, 'applications');
  const res = await c.apply(openNfl, { name: 'Valid Person', email: 'valid@example.com' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/thanks');
  assert.equal(await count(t.db, 'applications'), before + 1);
  const app = await lastApplication(t.db);
  assert.equal(app.stage, 'new');
  const events = await t.db.all('SELECT * FROM application_events WHERE application_id = ?', [app.id]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'stage_change');
  assert.equal(events[0].from_value, null);
  assert.equal(events[0].to_value, 'new');
  assert.equal(events[0].actor_user_id, null);
  const thanks = await c.follow(res);
  assert.equal(thanks.status, 200);
  assert.match(thanks.text, /Thank you/);
});

test('AC-07: same email in different case gives one person and two applications', async () => {
  const c = t.client();
  await c.apply(openNfl, { name: 'Dee Dupe', email: 'Dupe.Person@Example.com' });
  await c.apply(openNfl, { name: 'Dee Dupe-Two', email: '  dupe.person@example.COM ' });
  const people = await t.db.all("SELECT * FROM people WHERE email = 'dupe.person@example.com'");
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'Dee Dupe-Two'); // latest application wins
  assert.equal(await count(t.db, 'applications', 'person_id = ?', people[0].id), 2);
});

test('AC-08: answers are snapshotted with question text; editing questions later does not change them', async () => {
  const c = t.client();
  await c.apply(qRole, { email: 'snap@example.com', answer_0: 'Because Bears', answer_1: '' });
  const app = await lastApplication(t.db);
  assert.deepEqual(JSON.parse(app.answers_json), [
    { question: 'Why this team?', answer: 'Because Bears' },
    { question: 'Anything else?', answer: '' },
  ]);
  await t.db.run('UPDATE job_roles SET questions_json = ? WHERE id = ?', [JSON.stringify([{ text: 'Totally new question', required: true }]), qRole]);
  const admin = t.client();
  await admin.login('admin@fansided.com');
  const page = await admin.get(`/app/applications/${app.id}`);
  assert.match(page.text, /Why this team\?/);
  assert.match(page.text, /Because Bears/);
  assert.doesNotMatch(page.text, /Totally new question/);
  await t.db.run('UPDATE job_roles SET questions_json = ? WHERE id = ?', [JSON.stringify([{ text: 'Why this team?', required: true }, { text: 'Anything else?', required: false }]),
    qRole]);
});

test('AC-09: 9 MB PDF accepted; 11 MB rejected; .exe renamed to .pdf rejected', async () => {
  const c = t.client();
  const ok = await c.apply(openNfl, { email: 'ninemb@example.com' }, { file: { name: 'cv.pdf', data: pdf(9 * 1024 * 1024) } });
  assert.equal(ok.status, 303);
  const app = await lastApplication(t.db);
  assert.equal(app.file_name, 'cv.pdf');
  assert.match(app.file_path, /^uploads\/[0-9a-f]{32}\.pdf$/);
  assert.equal(fs.statSync(path.join(t.dataDir, app.file_path)).size, 9 * 1024 * 1024);

  const before = await count(t.db, 'applications');
  const big = await c.apply(openNfl, { email: 'elevenmb@example.com' }, { file: { name: 'big.pdf', data: pdf(11 * 1024 * 1024) } });
  assert.ok(big.status === 413 || (big.status === 400 && /at most 10 MB/.test(big.text)), `got ${big.status}`);

  // Between the file limit and the body cap: a field error rather than 413.
  const mid = await c.apply(openNfl, { email: 'tenhalf@example.com' }, { file: { name: 'mid.pdf', data: pdf(10.5 * 1024 * 1024) } });
  assert.equal(mid.status, 400);
  assert.match(mid.text, /at most 10 MB/);

  const exe = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(1000)]);
  const bad = await c.apply(openNfl, { email: 'exe@example.com' }, { file: { name: 'resume.pdf', data: exe } });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /does not look like a real \.pdf/);
  const wrongExt = await c.apply(openNfl, { email: 'exe2@example.com' }, { file: { name: 'tool.exe', data: exe } });
  assert.equal(wrongExt.status, 400);
  assert.match(wrongExt.text, /must be a PDF, DOC or DOCX/);
  assert.equal(await count(t.db, 'applications'), before);

  // DOC and DOCX magic bytes are accepted
  const doc = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(100)]);
  assert.equal((await c.apply(openNfl, { email: 'doc@example.com' }, { file: { name: 'a.DOC', data: doc } })).status, 303);
  const docx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)]);
  assert.equal((await c.apply(openNfl, { email: 'docx@example.com' }, { file: { name: 'a.docx', data: docx } })).status, 303);
});

test('AC-10: uploaded file downloads for signed-in users only, as an attachment', async () => {
  const c = t.client();
  const data = pdf(5000);
  await c.apply(openNfl, { email: 'download@example.com' }, { file: { name: 'My CV "final".pdf', data } });
  const app = await lastApplication(t.db);
  const anon = await t.client().get(`/app/applications/${app.id}/file`);
  assert.ok(anon.status === 302 || anon.status === 401);
  if (anon.status === 302) assert.match(anon.headers.get('location'), /^\/login/);

  const r = t.client();
  await r.login('rep@fansided.com');
  const res = await r.get(`/app/applications/${app.id}/file`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
  assert.ok(res.buffer.equals(data));
});

test('AC-11: honeypot shows thanks and stores nothing; 11th submission from one IP in an hour is rejected', async () => {
  const c = t.client({ ip: '203.0.113.50' });
  const before = await count(t.db, 'applications');
  const peopleBefore = await count(t.db, 'people');
  const res = await c.apply(openNfl, { email: 'bot@example.com', website: 'http://spam.example.com' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/thanks');
  assert.equal(await count(t.db, 'applications'), before);
  assert.equal(await count(t.db, 'people'), peopleBefore);

  // That was submission 1 from this IP; 9 more are allowed, the 11th is not.
  for (let i = 2; i <= 10; i++) {
    const r = await c.apply(openNfl, { email: `rate${i}@example.com` });
    assert.equal(r.status, 303, `submission ${i}`);
  }
  const eleventh = await c.apply(openNfl, { email: 'rate11@example.com' });
  assert.equal(eleventh.status, 429);
  assert.equal(await count(t.db, 'people', "email = 'rate11@example.com'"), 0);
  // A different IP is unaffected.
  assert.equal((await t.client().apply(openNfl, { email: 'otherip@example.com' })).status, 303);
});

test('public apply form rejects a missing double-submit CSRF token', async () => {
  const c = t.client();
  await c.get(`/roles/${openNfl}`);
  const fd = new FormData();
  fd.append('csrf', 'f'.repeat(64));
  fd.append('name', 'X');
  fd.append('email', 'csrfless@example.com');
  fd.append('sample_links', 'https://example.com');
  const res = await c.request('POST', `/roles/${openNfl}/apply`, { body: fd });
  assert.equal(res.status, 403);
  assert.equal(await count(t.db, 'people', "email = 'csrfless@example.com'"), 0);
});

test('input length limits are enforced', async () => {
  const c = t.client();
  const res = await c.apply(openNfl, { name: 'x'.repeat(201), email: 'long@example.com', sample_links: `https://example.com/${'a'.repeat(2000)}` });
  assert.equal(res.status, 400);
  assert.match(res.text, /id="err-name"/);
  assert.match(res.text, /id="err-sample_links"/);
  const longAnswer = await c.apply(qRole, { email: 'longans@example.com', answer_0: 'y'.repeat(5001) });
  assert.equal(longAnswer.status, 400);
  assert.match(longAnswer.text, /id="err-answer_0"/);
});
});

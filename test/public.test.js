'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole, lastApplication, count } = require('./helpers');

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
  assert.match(res.headers.get('content-security-policy'), /^default-src 'none'; script-src 'self'/);
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
  assert.equal(res.headers.get('location'), '/thanks#top');
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
  assert.equal(people[0].name, 'Dee Dupe'); // F-05: the first saved name stays
  assert.deepEqual((await t.db.all('SELECT applicant_name FROM applications WHERE person_id = ? ORDER BY id', [people[0].id])).map((r) => r.applicant_name), ['Dee Dupe', 'Dee Dupe-Two']);
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

test('AC-53: LinkedIn, resume and sample links must be https; http, javascript: and data: are field errors; bare hosts get https://', async () => {
  const c = t.client();
  const before = await count(t.db, 'applications');
  const bads = ['http://example.com/x', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'ftp://example.com/x', 'mailto:a@b.example', 'https://user:pw@example.com/x', 'https://nodot', 'not a url', '//example.com/x'];
  for (const bad of bads) {
    for (const field of ['linkedin_url', 'resume_url']) {
      const res = await c.apply(openNfl, { email: 'badlink@example.com', [field]: bad });
      assert.equal(res.status, 400, `${field}: ${bad}`);
      assert.match(res.text, new RegExp(`id="err-${field}"`));
    }
    const res = await c.apply(openNfl, { email: 'badlink@example.com', sample_links: `https://example.com/ok\n${bad}` });
    assert.equal(res.status, 400, `sample: ${bad}`);
    assert.match(res.text, /id="err-sample_links"/);
  }
  assert.equal(await count(t.db, 'applications'), before);
  assert.equal(await count(t.db, 'people', "email = 'badlink@example.com'"), 0);

  const ok = await c.apply(openNfl, {
    email: 'goodlinks@example.com',
    linkedin_url: 'linkedin.com/in/someone',
    resume_url: 'https://docs.example.com/resume.pdf',
    sample_links: 'example.com/post-1\nhttps://example.org/post-2\nexample.net:8080/post-3',
  });
  assert.equal(ok.status, 303);
  const app = await lastApplication(t.db);
  assert.equal(app.resume_url, 'https://docs.example.com/resume.pdf');
  assert.equal(app.sample_links, 'https://example.com/post-1\nhttps://example.org/post-2\nhttps://example.net:8080/post-3');
  assert.equal((await t.db.get('SELECT linkedin_url FROM people WHERE id = ?', [app.person_id])).linkedin_url, 'https://linkedin.com/in/someone');
  // Optional: no resume is fine.
  assert.equal((await c.apply(openNfl, { email: 'noresume@example.com' })).status, 303);
  assert.equal((await lastApplication(t.db)).resume_url, '');
});

test('AC-53: stored non-https values are never rendered as links; https links carry rel="noopener noreferrer"', async () => {
  await t.client().apply(openNfl, { email: 'render@example.com', resume_url: 'https://docs.example.com/cv', linkedin_url: 'https://linkedin.com/in/r' });
  const app = await lastApplication(t.db);
  const r = t.client();
  await r.login('rep@fansided.com');
  let page = await r.get(`/app/applications/${app.id}`);
  assert.match(page.text, /<a href="https:\/\/docs\.example\.com\/cv" rel="noopener noreferrer" target="_blank">/);
  assert.match(page.text, /<a href="https:\/\/linkedin\.com\/in\/r" rel="noopener noreferrer" target="_blank">/);
  for (const a of page.text.match(/<a [^>]*href="https?:\/\/[^"]*"[^>]*>/g) || []) assert.match(a, /rel="noopener noreferrer"/, a);
  // Values that bypassed validation (written straight to the database) are shown as text only.
  await t.db.run("UPDATE applications SET resume_url = 'javascript:alert(1)', sample_links = 'http://insecure.example/a\ndata:text/html,x\nhttps://safe.example/b' WHERE id = ?", [app.id]);
  await t.db.run("UPDATE people SET linkedin_url = 'javascript:alert(2)' WHERE id = ?", [app.person_id]);
  page = await r.get(`/app/applications/${app.id}`);
  assert.doesNotMatch(page.text, /href="javascript:/i);
  assert.doesNotMatch(page.text, /href="http:\/\/insecure/);
  assert.doesNotMatch(page.text, /href="data:/i);
  assert.match(page.text, /javascript:alert\(1\)/); // visible as text
  assert.match(page.text, /<a href="https:\/\/safe\.example\/b" rel="noopener noreferrer"/);
});

test('AC-53: multipart/form-data posts are refused with 415 and nothing is stored; there is no file route', async () => {
  const c = t.client();
  await c.get(`/roles/${openNfl}`);
  const fd = new FormData();
  fd.append('csrf', c.csrf());
  fd.append('name', 'Multi Part');
  fd.append('email', 'multipart@example.com');
  fd.append('sample_links', 'https://example.com');
  fd.append('file', new Blob(['%PDF-1.4']), 'cv.pdf');
  const res = await c.request('POST', `/roles/${openNfl}/apply`, { body: fd });
  assert.equal(res.status, 415);
  assert.equal(await count(t.db, 'people', "email = 'multipart@example.com'"), 0);
  // Other content types are refused too (also on internal and login POSTs).
  for (const type of ['application/json', 'text/plain']) {
    assert.equal((await c.request('POST', `/roles/${openNfl}/apply`, { body: '{}', headers: { 'content-type': type } })).status, 415, type);
  }
  assert.equal((await c.request('POST', '/login', { body: fd })).status, 415);
  // The upload form has no file field and no enctype.
  const form = (await c.get(`/roles/${openNfl}`)).text;
  assert.doesNotMatch(form, /type="file"|multipart/);
  assert.match(form, /name="resume_url"/);
  // No file route (signed in or not) and no uploads directory in the data dir.
  const a = t.client();
  await a.login('admin@fansided.com');
  const app = await lastApplication(t.db);
  assert.equal((await a.get(`/app/applications/${app.id}/file`)).status, 404);
  assert.equal(require('node:fs').existsSync(require('node:path').join(t.dataDir, 'uploads')), false);
});

test('AC-11: honeypot shows thanks and stores nothing; 11th submission from one IP in an hour is rejected', async () => {
  const c = t.client({ ip: '203.0.113.50' });
  const before = await count(t.db, 'applications');
  const peopleBefore = await count(t.db, 'people');
  const res = await c.apply(openNfl, { email: 'bot@example.com', website: 'http://spam.example.com' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/thanks#top');
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
  const res = await c.post(`/roles/${openNfl}/apply`, { name: 'X', email: 'csrfless@example.com', sample_links: 'https://example.com' }, { csrf: 'f'.repeat(64) });
  assert.equal(res.status, 403);
  assert.equal((await c.post(`/roles/${openNfl}/apply`, { name: 'X', email: 'csrfless@example.com', sample_links: 'https://example.com' }, { csrf: null })).status, 403);
  assert.equal(await count(t.db, 'people', "email = 'csrfless@example.com'"), 0);
});

test('AC-57: input length limits are enforced and a body over 512 KB is a 413', async () => {
  const c = t.client();
  const res = await c.apply(openNfl, { name: 'x'.repeat(201), email: 'long@example.com', sample_links: `https://example.com/${'a'.repeat(2000)}` });
  assert.equal(res.status, 400);
  assert.match(res.text, /id="err-name"/);
  assert.match(res.text, /id="err-sample_links"/);
  const longUrls = await c.apply(openNfl, { email: 'longurl@example.com', linkedin_url: `https://example.com/${'a'.repeat(2000)}`, resume_url: `https://example.com/${'a'.repeat(2000)}` });
  assert.equal(longUrls.status, 400);
  assert.match(longUrls.text, /id="err-linkedin_url"/);
  assert.match(longUrls.text, /id="err-resume_url"/);
  const longEmail = await c.apply(openNfl, { email: `${'a'.repeat(250)}@example.com` });
  assert.equal(longEmail.status, 400);
  assert.match(longEmail.text, /id="err-email"/);
  assert.equal(await count(t.db, 'people', "email LIKE 'long%' OR email LIKE 'aaaa%'"), 0);
  // 512 KB cap for every POST (declared and streamed)
  const big = await c.apply(openNfl, { email: 'huge@example.com', answer_x: 'z'.repeat(600 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(await count(t.db, 'people', "email = 'huge@example.com'"), 0);
  const stream = await c.request('POST', '/login', { body: `email=a&password=${'z'.repeat(520 * 1024)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(stream.status, 413);
  const near = await c.apply(openNfl, { email: 'near@example.com', answer_x: 'z'.repeat(500 * 1024) });
  assert.equal(near.status, 303);
  const longAnswer = await c.apply(qRole, { email: 'longans@example.com', answer_0: 'y'.repeat(5001) });
  assert.equal(longAnswer.status, 400);
  assert.match(longAnswer.text, /id="err-answer_0"/);
});
});

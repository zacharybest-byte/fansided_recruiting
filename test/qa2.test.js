'use strict';
// Regression tests for the second QA round (findings F-01 .. F-16), on both database drivers.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, TEST_PASSWORD, startApp, makeUser, makeRole, count } = require('./helpers');
const { clientIp, ipBucket } = require('../src/lib/http');
const { safeNext } = require('../src/lib/auth');
const { rateKey } = require('../src/lib/ratelimit');
const { SESSION_SECRET } = require('./helpers');

const hasSid = (res) => res.headers.getSetCookie().some((c) => /^sid=[0-9a-f]{64}/.test(c));
const tokenOf = (text) => /token=([A-Za-z0-9_-]{43})/.exec(text)[1];

// Client address rule (not driver specific).
describe('F-02: client IP header rule and IPv6 /64 buckets', () => {
  const req = (h, remote = '10.9.9.9') => ({ headers: h, socket: { remoteAddress: remote } });
  test('the right-most entry of a multi-entry header is used; spoofed headers are ignored; IPv6 is bucketed by /64', () => {
    const H = 'x-vercel-forwarded-for';
    assert.equal(clientIp(req({ [H]: '198.51.100.1, 203.0.113.9' }), H), '203.0.113.9');
    assert.equal(clientIp(req({ [H]: ' 198.51.100.1 ,  203.0.113.9 ,' }), H), '203.0.113.9');
    assert.equal(clientIp(req({ [H]: '203.0.113.9', 'x-forwarded-for': '1.1.1.1' }), H), '203.0.113.9');
    assert.equal(clientIp(req({ [H]: '' }), H), '10.9.9.9');
    // IPv6: any address of one /64 is the same bucket; another /64 is another bucket.
    const a = clientIp(req({ [H]: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }), H);
    assert.equal(a, '2001:db8:1:2::/64');
    assert.equal(clientIp(req({ [H]: '2001:DB8:1:2::1' }), H), a);
    assert.equal(clientIp(req({ [H]: '2001:db8:1:2:ffff:ffff:ffff:ffff' }), H), a);
    assert.notEqual(clientIp(req({ [H]: '2001:db8:1:3::1' }), H), a);
    assert.equal(clientIp(req({ [H]: '203.0.113.9, 2001:db8:1:2:0:0:0:5' }), H), a, 'multi-entry with an IPv6 right-most entry');
    assert.equal(clientIp(req({ [H]: '2001:db8:1:2::1, 198.51.100.4' }), H), '198.51.100.4');
    assert.equal(clientIp(req({}, '2001:db8:9:9::7')), '2001:db8:9:9::/64', 'socket address too');
    assert.equal(ipBucket('::ffff:203.0.113.9'), '203.0.113.9', 'IPv4-mapped addresses are IPv4');
    assert.equal(ipBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
  });
});

describe('F-07: safeNext', () => {
  test('only printable ASCII /app paths survive', () => {
    for (const bad of ['/app/日本', '/app/é', '/app/a b', '/app/\u0000', '/app/​', '/app/x\ny', '//evil.example', '/\\evil', '/app//x', 'https://evil.example', '/application']) assert.equal(safeNext(bad), '/app', JSON.stringify(bad));
    for (const ok of ['/app', '/app/', '/app?view=all', '/app/roles/3', '/app/applications/12?template=2', '/app/%E6%97%A5']) assert.equal(safeNext(ok), ok);
  });
});

for (const driver of DRIVERS) {
  describe(`[${driver}] QA round 2`, () => {
    async function withApp(fn, opts) {
      const t = await startApp({ driver, ...opts });
      try {
        return await fn(t);
      } finally {
        await t.close();
      }
    }

    test('F-01: an admin reset link (and then using it) clears the email\'s login lock', () =>
      withApp(async (t) => {
        const rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita' });
        const ip = '192.0.2.10';
        const lock = async () => {
          for (let i = 0; i < 5; i++) await t.client({ ip }).login('rep@fansided.com', `wrong password ${i}`);
          assert.equal((await t.client({ ip }).login('rep@fansided.com', TEST_PASSWORD)).status, 429);
        };
        const admin = t.client();
        await admin.login('admin@fansided.com');
        await lock();
        await admin.get('/app/admin/users');
        const reset = await admin.post(`/app/admin/users/${rep}/reset-link`, {});
        assert.equal(reset.status, 200);
        assert.equal(await count(t.db, 'rate_limits', 'grp IS NOT NULL'), 0, 'the lock rows are gone');
        assert.equal((await t.client({ ip }).login('rep@fansided.com', TEST_PASSWORD)).status, 303);
        // other accounts' rows are untouched
        await t.client({ ip }).login('admin@fansided.com', 'wrong password');
        await admin.get('/app/admin/users');
        await admin.post(`/app/admin/users/${rep}/reset-link`, {});
        assert.ok((await count(t.db, 'rate_limits', 'grp IS NOT NULL')) >= 1);
        // using the link clears it too
        await t.db.run('DELETE FROM rate_limits');
        await admin.get('/app/admin/users');
        const link = tokenOf((await admin.post(`/app/admin/users/${rep}/reset-link`, {})).text);
        await lock();
        const c = t.client({ ip: '192.0.2.11' });
        await c.get(`/set-password?token=${link}`);
        assert.equal((await c.post('/set-password', { token: link, password: 'brand new password 1', password_confirm: 'brand new password 1' })).status, 303);
        assert.equal(await count(t.db, 'rate_limits', 'grp IS NOT NULL'), 0);
        assert.equal((await t.client({ ip }).login('rep@fansided.com', 'brand new password 1')).status, 303);
      }));

    test('F-01: the account page uses the same pair and ceiling buckets and records nothing when refused', () =>
      withApp(async (t) => {
        await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita' });
        const c = t.client({ ip: '192.0.2.20' });
        await c.login('rep@fansided.com');
        for (let i = 0; i < 5; i++) {
          await c.get('/app/account');
          assert.equal((await c.post('/app/account', { current_password: 'wrong password 123', password: 'another long password', password_confirm: 'another long password' })).status, 400);
        }
        await c.get('/app/account');
        const limited = await c.post('/app/account', { current_password: TEST_PASSWORD, password: 'another long password', password_confirm: 'another long password' });
        assert.equal(limited.status, 429);
        const rows = await count(t.db, 'rate_limits');
        await c.get('/app/account');
        await c.post('/app/account', { current_password: TEST_PASSWORD, password: 'another long password', password_confirm: 'another long password' });
        assert.equal(await count(t.db, 'rate_limits'), rows);
      }));

    test('F-02: 25 addresses of one IPv6 /64 share one apply bucket; a multi-entry header is bucketed by its right-most entry', () =>
      withApp(async (t) => {
        const role = await makeRole(t.db, { title: 'Bucket' });
        const statuses = [];
        for (let i = 0; i < 12; i++) statuses.push((await t.client({ ip: `2001:db8:55:66:${i + 1}::${i + 7}` }).apply(role, { email: `v6-${i}@example.com` })).status);
        assert.deepEqual(statuses, [...Array(10).fill(303), 429, 429]);
        assert.equal((await t.client({ ip: '2001:db8:55:67::1' }).apply(role, { email: 'v6-other@example.com' })).status, 303, 'another /64 is not affected');
        const multi = [];
        for (let i = 0; i < 11; i++) multi.push((await t.client({ ip: `198.51.100.${i + 1}, 203.0.113.99` }).apply(role, { email: `multi-${i}@example.com` })).status);
        assert.deepEqual(multi, [...Array(10).fill(303), 429]);
        assert.equal(await count(t.db, 'applications'), 21);
      }));

    test('F-03: 30 parallel applications from one IP store exactly 10', () =>
      withApp(async (t) => {
        const role = await makeRole(t.db, { title: 'Parallel' });
        const results = await Promise.all(Array.from({ length: 30 }, (_, i) => t.client({ ip: '192.0.2.77' }).apply(role, { email: `par${i}@example.com`, name: `Par ${i}` })));
        const ok = results.filter((r) => r.status === 303).length;
        const limited = results.filter((r) => r.status === 429).length;
        assert.equal(ok, 10);
        assert.equal(limited, 20);
        assert.equal(await count(t.db, 'applications'), 10);
        assert.equal(await count(t.db, 'people'), 10);
        assert.equal(await count(t.db, 'application_events'), 10);
        assert.equal(await count(t.db, 'rate_limits'), 10);
        // a refused request leaves no person behind and the events still point at their own applications
        const bad = await t.db.get('SELECT COUNT(*) AS n FROM application_events e LEFT JOIN applications a ON a.id = e.application_id WHERE a.id IS NULL');
        assert.equal(bad.n, 0);
      }));

    test('F-04: applicant emails that could change a mailto/URL are refused; plain ones pass; the mailto href is percent-encoded', () =>
      withApp(async (t) => {
        const role = await makeRole(t.db, { title: 'Emails' });
        const bad = [
          'cand@example.net?bcc=evil%40x&subject=hi', 'a@b.example#x', 'a b@c.example', 'a"b@c.example', "a'b@c.example", '<a@b.example>', 'a,b@c.example', 'a;b@c.example',
          'a@b@c.example', 'a@b', 'a@-b.example', 'a@b..example', 'a=b@c.example', 'a/b@c.example', 'a%40b@c.example', 'a&b@c.example', 'a@b.example/x', 'a@b.example?x=1', '.a@b.example', 'a.@b.example', 'a..b@c.example', 'a@b.c', '@b.example', 'a@', 'a@b.example\u0000',
        ];
        for (const email of bad) assert.equal((await t.client().apply(role, { email })).status, 400, email);
        assert.equal(await count(t.db, 'people'), 0);
        for (const email of ['o.brien+tag@example.co.uk', 'first_last-1@sub.example.org', 'X@Example.COM']) assert.equal((await t.client().apply(role, { email })).status, 303, email);
        assert.equal(await count(t.db, 'people'), 3);
        // Even a legacy row with a hostile address cannot make the mailto link carry extra parameters.
        const now = new Date().toISOString();
        const p = await t.db.run("INSERT INTO people (email, name, created_at, updated_at) VALUES ('cand@example.net?bcc=evil%40x&subject=hi', 'Legacy', ?, ?)", [now, now]);
        const a = await t.db.run("INSERT INTO applications (person_id, role_id, applied_at, stage_changed_at) VALUES (?, ?, ?, ?)", [p.lastInsertRowid, role, now, now]);
        const admin = t.client();
        await admin.login('admin@fansided.com');
        const page = await admin.get(`/app/applications/${a.lastInsertRowid}`);
        const hrefs = [...page.text.matchAll(/href="(mailto:[^"]*)"/g)].map((m) => m[1]);
        assert.ok(hrefs.length >= 1);
        for (const h of hrefs) {
          assert.doesNotMatch(h, /[?&=]/, h);
          assert.equal(h, 'mailto:cand%40example.net%3Fbcc%3Devil%2540x%26subject%3Dhi');
        }
      }));

    test('F-05: re-applying keeps the person\'s name and LinkedIn (filling only empty ones); what was typed stays on the application and shows on the candidate page', () =>
      withApp(async (t) => {
        const role = await makeRole(t.db, { title: 'Reapply' });
        await t.client().apply(role, { email: 'same@example.com', name: 'Real Name', linkedin_url: 'https://www.linkedin.com/in/real' });
        await t.client().apply(role, { email: 'same@example.com', name: 'Vandal', linkedin_url: '' });
        await t.client().apply(role, { email: 'same@example.com', name: 'Other Name', linkedin_url: 'https://example.com/other' });
        const person = await t.db.get("SELECT * FROM people WHERE email = 'same@example.com'");
        assert.equal(person.name, 'Real Name');
        assert.equal(person.linkedin_url, 'https://www.linkedin.com/in/real');
        const apps = await t.db.all('SELECT id, applicant_name, applicant_linkedin FROM applications ORDER BY id');
        assert.deepEqual(apps.map((a) => [a.applicant_name, a.applicant_linkedin]), [['Real Name', 'https://www.linkedin.com/in/real'], ['Vandal', ''], ['Other Name', 'https://example.com/other']]);
        // a person without LinkedIn gets it filled by a later application
        await t.client().apply(role, { email: 'fill@example.com', name: 'Fill', linkedin_url: '' });
        await t.client().apply(role, { email: 'fill@example.com', name: 'Fill Two', linkedin_url: 'https://example.com/fill' });
        assert.equal((await t.db.get("SELECT linkedin_url, name FROM people WHERE email = 'fill@example.com'")).linkedin_url, 'https://example.com/fill');
        assert.equal((await t.db.get("SELECT name FROM people WHERE email = 'fill@example.com'")).name, 'Fill');
        const admin = t.client();
        await admin.login('admin@fansided.com');
        assert.doesNotMatch((await admin.get(`/app/applications/${apps[0].id}`)).text, /Entered on this application/);
        const second = (await admin.get(`/app/applications/${apps[1].id}`)).text;
        assert.match(second, /Entered on this application:[^<]*<strong>Vandal<\/strong>/);
        assert.match(second, /<h1>Real Name<\/h1>/);
        const third = (await admin.get(`/app/applications/${apps[2].id}`)).text;
        assert.match(third, /<strong>Other Name<\/strong>/);
        assert.match(third, /href="https:\/\/example\.com\/other"/);
      }));

    test('F-06: concurrent sample loads never give a 500; sample people use a domain the apply form refuses; real applicants with sample-looking addresses are untouched by Remove', () =>
      withApp(async (t) => {
        const admin = t.client();
        await admin.login('admin@fansided.com');
        await admin.get('/app/admin/sample');
        const results = await Promise.all(Array.from({ length: 6 }, () => admin.post('/app/admin/sample/load')));
        assert.deepEqual(results.map((r) => r.status), Array(6).fill(303));
        assert.equal(await count(t.db, 'people', 'is_sample = 1'), 18);
        assert.equal(await count(t.db, 'job_roles', 'is_sample = 1'), 6);
        assert.equal(await count(t.db, 'applications'), 18);
        const flashes = results.map((r) => r.headers.getSetCookie().find((c) => c.startsWith('flash=')));
        assert.ok(flashes.every(Boolean));
        // applying with a sample address is a normal field error
        const role = (await t.db.get('SELECT id FROM job_roles WHERE is_sample = 1 ORDER BY id LIMIT 1')).id;
        const res = await t.client().apply(role, { email: 'marcus.bennett@sample.invalid', answer_0: 'x' });
        assert.equal(res.status, 400);
        assert.match(res.text, /Email must be a valid address/);
        assert.equal((await t.client().apply(role, { email: 'Marcus.Bennett@Sample.Invalid', answer_0: 'x' })).status, 400);
        // a real person using the old-style sample address is a normal applicant, not sample data
        assert.equal((await t.client().apply(role, { email: 'sample.one@example.com', name: 'Really Sample', answer_0: 'x' })).status, 303);
        assert.equal(await count(t.db, 'people', 'is_sample = 1'), 18);
        await admin.get('/app/admin/sample');
        assert.equal((await admin.post('/app/admin/sample/remove')).status, 303);
        assert.ok(await t.db.get("SELECT id FROM people WHERE email = 'sample.one@example.com'"));
        // and Load works again afterwards
        await admin.get('/app/admin/sample');
        await admin.post('/app/admin/sample/load');
        assert.equal(await count(t.db, 'people', 'is_sample = 1'), 18);
        // a failed load is a flash message, not a 500
        await admin.post('/app/admin/sample/remove');
        await t.db.run("INSERT INTO people (email, name, created_at, updated_at) VALUES ('marcus.bennett@sample.invalid', 'Squatter', 'x', 'x')");
        await admin.get('/app/admin/sample');
        const failed = await admin.post('/app/admin/sample/load');
        assert.equal(failed.status, 303);
        const flash = await admin.get('/app/admin/sample');
        assert.match(flash.text, /Sample data could not be loaded/);
        assert.equal(await count(t.db, 'job_roles', 'is_sample = 1'), 0, 'nothing half-loaded');
      }));

    test('F-07: a non-ASCII next signs in and lands on /app (no 500)', () =>
      withApp(async (t) => {
        await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita' });
        const c = t.client();
        const res = await c.login('rep@fansided.com', TEST_PASSWORD, '/app/日本');
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), '/app');
        assert.ok(hasSid(res));
        const again = await c.get('/login?next=' + encodeURIComponent('/app/日本'));
        assert.equal(again.status, 303);
        assert.equal(again.headers.get('location'), '/app');
      }));

    test('F-11/F-12: webhook and database timeouts', () => {
      const { TIMEOUT_MS } = require('../src/lib/notify');
      assert.equal(TIMEOUT_MS, 1500);
      assert.equal(require('../src/lib/db/turso').TIMEOUT_MS, 8000);
    });

    test('F-14: 405 carries Allow; only canonical ids exist', () =>
      withApp(async (t) => {
        const role = await makeRole(t.db, { title: 'Canon' });
        const anon = t.client();
        const post = await anon.request('POST', '/thanks', { body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.equal(post.status, 405);
        assert.deepEqual(post.headers.get('allow').split(', ').sort(), ['GET', 'HEAD']);
        const login = await anon.request('PUT', '/login');
        assert.equal(login.status, 405);
        assert.deepEqual(login.headers.get('allow').split(', ').sort(), ['GET', 'HEAD', 'POST']);
        assert.equal((await anon.get(`/roles/${role}`)).status, 200);
        for (const id of [`0${role}`, '00', '0', `${role}.0`, `+${role}`, ` ${role}`]) assert.equal((await anon.get(`/roles/${encodeURIComponent(id)}`)).status, 404, id);
        const admin = t.client();
        await admin.login('admin@fansided.com');
        assert.equal((await admin.get(`/app/roles/${role}`)).status, 200);
        assert.equal((await admin.get(`/app/roles/0${role}`)).status, 404);
        assert.equal((await admin.get('/app/applications/01')).status, 404);
        assert.equal((await admin.get('/app/admin/templates/01')).status, 404);
      }));

    test('F-16: the flash cookie is signed; unsigned, altered or foreign ones are ignored', () =>
      withApp(async (t) => {
        const c = t.client();
        const forged = [
          encodeURIComponent(JSON.stringify({ type: 'ok', message: 'FORGED-1' })),
          `${Buffer.from(JSON.stringify({ type: 'ok', message: 'FORGED-2' })).toString('base64url')}.${'0'.repeat(64)}`,
        ];
        for (const value of forged) {
          c.jar.set('flash', value);
          const res = await c.get('/login');
          assert.doesNotMatch(res.text, /FORGED/);
          assert.ok(!c.jar.has('flash'), 'an invalid flash cookie is cleared');
        }
        // A genuine one still shows once: the sample page flash.
        const admin = t.client();
        await admin.login('admin@fansided.com');
        await admin.get('/app/admin/sample');
        await admin.post('/app/admin/sample/load');
        const shown = await admin.get('/app/admin/sample');
        assert.match(shown.text, /Loaded 6 sample roles and 18 sample people\./);
        assert.doesNotMatch((await admin.get('/app/admin/sample')).text, /Loaded 6 sample roles/);
        // A genuine cookie signed with another secret is refused.
        const { hmacHex } = require('../src/lib/crypto');
        const payload = Buffer.from(JSON.stringify({ type: 'ok', message: 'FORGED-3' })).toString('base64url');
        c.jar.set('flash', `${payload}.${hmacHex('some other secret value', `flash:${payload}`)}`);
        assert.doesNotMatch((await c.get('/login')).text, /FORGED/);
        c.jar.set('flash', `${payload}.${hmacHex(SESSION_SECRET, `flash:${payload}`)}`);
        assert.match((await c.get('/login')).text, /FORGED-3/, 'signed with the real secret it is accepted (sanity check of the test)');
      }));

    test('XSS: attribute-breaking payloads are escaped on every page, and no page renders a javascript: or data: href', () =>
      withApp(async (t) => {
        const attr = '"><img src=x onerror=alert(1)> \' onmouseover=\'alert(2)\' x="';
        const nospace = '"><img/src=x/onerror=alert(7)>\'onmouseover=\'alert(8)';
        const attr2 = '" autofocus onfocus="alert(3)" x="';
        const rep = await makeUser(t.db, { email: 'rep@fansided.com', name: `Rep ${attr}` });
        await t.db.run('UPDATE users SET name = ? WHERE id = ?', [`Admin ${attr2}`, (await t.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id]);
        const role = await makeRole(t.db, { title: `Role ${attr}`, vertical: attr2, site: attr, assigned: rep, description: attr, questions: [{ text: `Q ${attr}`, required: true }] });
        const c = t.client();
        const res = await c.apply(role, { name: `N ${attr}`, email: 'xss@example.com', linkedin_url: `https://example.com/?a=${nospace}`, resume_url: `https://example.com/cv?b=${nospace}`, sample_links: `https://example.com/?q=${nospace}\nhttps://example.com/2`, answer_0: attr, heard_from: 'Other', source: attr });
        assert.equal(res.status, 303);
        // Stored hostile values from other (older) code paths: javascript:/data: links must not become hrefs.
        const now = new Date().toISOString();
        const p = await t.db.run("INSERT INTO people (email, name, linkedin_url, created_at, updated_at) VALUES ('legacy@example.com', ?, 'javascript:alert(4)', ?, ?)", [`Legacy ${attr2}`, now, now]);
        const a = await t.db.run(
          "INSERT INTO applications (person_id, role_id, applicant_name, applicant_linkedin, sample_links, resume_url, applied_at, stage_changed_at, source_tag) VALUES (?, ?, ?, 'data:text/html,<b>x</b>', ?, 'JaVaScRiPt:alert(5)', ?, ?, ?)",
          [p.lastInsertRowid, role, `Other ${attr}`, 'javascript:alert(6)\ndata:text/html;base64,PHNjcmlwdD4=\nhttps://example.com/ok', now, now, attr]
        );
        const mine = (await t.db.get("SELECT id, person_id FROM applications WHERE person_id = (SELECT id FROM people WHERE email = 'xss@example.com')"));
        const admin = t.client();
        await admin.login('admin@fansided.com');
        await admin.post('/app/admin/templates', { name: `T ${attr}`, subject: `S ${attr}`, body: `B ${attr}` });
        await admin.post(`/app/applications/${mine.id}/notes`, { body: `Note ${attr}` });
        await admin.post(`/app/applications/${mine.id}/email`, { via: 'gmail', subject: `Subj ${attr}`, body: `Body ${attr2}` });
        const enc = encodeURIComponent(attr);
        const urls = [
          '/', `/?source=${enc}`, `/roles/${role}`, `/roles/${role}?source=${enc}`, '/thanks', '/login', `/login?next=${enc}`, '/setup?token=x', '/set-password?token=x',
          '/app', '/app?view=all', '/app/account', '/app/export', `/app/roles/${role}`, `/app/applications/${mine.id}`, `/app/applications/${mine.id}?template=1`, `/app/applications/${a.lastInsertRowid}`,
          `/app/people/${mine.person_id}/delete`, '/app/admin/roles', `/app/admin/roles/${role}`, '/app/admin/templates', '/app/admin/users', '/app/admin/sample',
        ];
        const SAFE_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'script', 'body', 'nav', 'a', 'span', 'form', 'input', 'button', 'main', 'p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'div', 'section', 'article', 'header', 'footer', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'label', 'select', 'option', 'textarea', 'details', 'summary', 'dl', 'dt', 'dd', 'code', 'strong', 'em', 'small', 'pre', 'br', 'time', 'fieldset', 'legend', 'datalist']);
        const clients = [t.client(), admin];
        for (const url of urls) {
          const res = await (url.startsWith('/app') ? admin : clients[0]).get(url);
          assert.ok(res.status < 500, `${url} ${res.status}`);
          const text = res.text;
          // walk every tag with a quote-aware pattern: no unexpected tags, no on* / autofocus / style attributes
          for (const m of text.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
            assert.ok(SAFE_TAGS.has(m[2].toLowerCase()), `unexpected <${m[2]}> on ${url}`);
            const attrs = m[3].replace(/"[^"]*"|'[^']*'/g, '""');
            for (const name of attrs.matchAll(/(?:^|\s)([^\s=/]+)/g)) {
              assert.ok(!/^on/i.test(name[1]) && !/^(autofocus|style|srcdoc|formaction)$/i.test(name[1]), `attribute ${name[1]} on ${url}`);
            }
          }
          // no javascript:/data:/vbscript: link target anywhere
          for (const m of text.matchAll(/\b(?:href|src|action|formaction)\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi)) {
            const v = (m[2] ?? m[3] ?? m[1]).replace(/&#x?[0-9a-f]+;/gi, '').replace(/[\u0000- ]/g, '').toLowerCase();
            assert.doesNotMatch(v, /^(javascript|data|vbscript):/, `${m[0]} on ${url}`);
          }
        }
      }));
  });
}

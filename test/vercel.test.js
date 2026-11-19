'use strict';
// Work order C: Vercel entry (AC-41), security headers on every response (AC-56), sample data (AC-60), repo hygiene.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { DRIVERS, SESSION_SECRET, startApp, makeUser, makeRole, count } = require('./helpers');
const { startFakeTurso } = require('./fake-turso');
const { createApp } = require('../src/app');
const { readForm } = require('../src/lib/http');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

describe('AC-41: Vercel entry', () => {
  test('api/index.js exports (req, res) and serves /, a static asset and a POST', async () => {
    const fake = await startFakeTurso();
    const saved = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'test', SESSION_SECRET, TURSO_DATABASE_URL: fake.url, TURSO_AUTH_TOKEN: fake.token, BASE_URL: 'http://localhost' });
    delete require.cache[require.resolve('../api/index.js')];
    const entry = require('../api/index.js');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    assert.equal(typeof entry, 'function');
    assert.equal(entry.length, 2);
    const { server, base } = await listen(entry);
    try {
      const home = await fetch(`${base}/`);
      assert.equal(home.status, 200);
      assert.match(await home.text(), /<html/);
      const css = await fetch(`${base}/public/style.css`);
      assert.equal(css.status, 200);
      assert.match(css.headers.get('content-type'), /text\/css/);
      assert.equal(css.headers.get('x-content-type-options'), 'nosniff');
      const js = await fetch(`${base}/public/app.js`);
      assert.match(js.headers.get('content-type'), /javascript/);
      const post = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40b.co&password=x' });
      assert.equal(post.status, 403); // no CSRF token: the POST reached the app
    } finally {
      await new Promise((r) => (server.closeAllConnections(), server.close(r)));
      await fake.close();
    }
  });

  test('simulated Vercel request: stream already consumed, req.body pre-parsed', async () => {
    const t = await startApp({ driver: 'sqlite' });
    // Wrapper that behaves like Vercel's helpers: drains the stream, then exposes a parsed `req.body`.
    const wrapped = (bodyFor) => (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        Object.defineProperty(req, 'body', { get: () => bodyFor(raw) });
        // The app must not wait for stream events that already happened.
        t.instance.handler(req, res);
      });
    };
    for (const [name, bodyFor] of [
      ['object', (raw) => Object.fromEntries(new URLSearchParams(raw.toString()))],
      ['string', (raw) => raw.toString()],
      ['buffer', (raw) => raw],
    ]) {
      const { server, base } = await listen(wrapped(bodyFor));
      try {
        const c = t.client();
        c.base = base;
        await c.get('/login');
        const res = await c.post('/login', { email: 'nobody@example.com', password: 'wrong password here' });
        assert.equal(res.status, 401, `${name}: form fields reached the app (not a CSRF 403)`);
        assert.match(res.text, /Email or password is incorrect/);
      } finally {
        await new Promise((r) => (server.closeAllConnections(), server.close(r)));
      }
    }
    await t.close();
  });

  test('readForm rebuilds from req.body when the stream is finished, and keeps the cap and content-type check', async () => {
    const fake = (body, type = 'application/x-www-form-urlencoded') => ({ headers: { 'content-type': type }, readableEnded: true, body });
    assert.equal((await readForm(fake({ a: '1', b: ['x', 'y'] }))).get('a'), '1');
    assert.deepEqual((await readForm(fake({ b: ['x', 'y'] }))).getAll('b'), ['x', 'y']);
    assert.equal((await readForm(fake('a=%C3%A9&c=3'))).get('a'), 'é');
    assert.equal((await readForm(fake(Buffer.from('k=v')))).get('k'), 'v');
    await assert.rejects(readForm(fake('x'.repeat(600 * 1024))), (e) => e.status === 413);
    await assert.rejects(readForm(fake('a=1', 'multipart/form-data; boundary=x')), (e) => e.status === 415);
    await assert.rejects(readForm(fake('a=1', 'application/json')), (e) => e.status === 415);
  });

  test('vercel.json routes every path to the function and ships public/**', () => {
    const cfg = JSON.parse(read('vercel.json'));
    assert.deepEqual(cfg.rewrites, [{ source: '/(.*)', destination: '/api/index?__path=/$1' }]);
    assert.equal(cfg.functions['api/index.js'].includeFiles, 'public/**');
    const headers = cfg.headers.flatMap((h) => h.headers.map((x) => x.key.toLowerCase()));
    for (const k of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'strict-transport-security']) assert.ok(headers.includes(k), k);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f !== 'fonts').sort(), ['app.js', 'favicon.svg', 'logo.png', 'style.css']);
  });

  test('package.json: 2.3.0, node 22.x, no dependencies, scripts start/dev/test only', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.version, "2.3.0");
    assert.equal(pkg.engines.node, '22.x');
    assert.equal(pkg.main, 'api/index.js');
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.deepEqual(Object.keys(pkg.scripts).sort(), ['dev', 'start', 'test']);
  });

  test('with Turso configured, no sqlite driver is ever loaded (fresh process)', async () => {
    const fake = await startFakeTurso();
    const script = `
      const entry = require('./api/index.js');
      const http = require('node:http');
      const server = http.createServer(entry);
      server.listen(0, '127.0.0.1', async () => {
        const r = await fetch('http://127.0.0.1:' + server.address().port + '/');
        await r.text();
        const loaded = process.moduleLoadList.filter((m) => /sqlite/i.test(m));
        const cached = Object.keys(require.cache).filter((m) => /db[\\\\/]sqlite/.test(m));
        console.log(JSON.stringify({ status: r.status, loaded, cached }));
        server.closeAllConnections(); server.close(); process.exit(0);
      });`;
    try {
      const out = await new Promise((resolve, reject) =>
        execFile(process.execPath, ['-e', script], { cwd: ROOT, env: { PATH: process.env.PATH, NODE_ENV: 'test', SESSION_SECRET, TURSO_DATABASE_URL: fake.url, TURSO_AUTH_TOKEN: fake.token, BASE_URL: 'http://localhost' } }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))
      );
      const r = JSON.parse(out.trim().split('\n').pop());
      assert.equal(r.status, 200);
      assert.deepEqual(r.loaded, []);
      assert.deepEqual(r.cached, []);
    } finally {
      await fake.close();
    }
  });

  test('client IP on Vercel comes from x-vercel-forwarded-for; spoofed x-forwarded-for is ignored', async () => {
    const { clientIp } = require('../src/lib/http');
    const req = (h) => ({ headers: h, socket: { remoteAddress: '10.9.9.9' } });
    assert.equal(clientIp(req({ 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' }), 'x-vercel-forwarded-for'), '203.0.113.7');
    assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }), null), '10.9.9.9');
    assert.equal(clientIp(req({}), 'x-vercel-forwarded-for'), '10.9.9.9');
  });
});

describe('repo hygiene', () => {
  test('no removed files; scripts/ holds only fake-turso.js; no file in src/ uses removed env vars', () => {
    for (const f of ['Dockerfile', '.dockerignore', 'deploy', 'scripts/backup.js', 'scripts/seed.js']) assert.ok(!fs.existsSync(path.join(ROOT, f)), f);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'scripts')).sort(), ['embed-assets.js', 'fake-turso.js']);
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)));
    })(path.join(ROOT, 'src'));
    const allowed = new Set(['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'SESSION_SECRET', 'ADMIN_EMAIL', 'SETUP_TOKEN', 'BASE_URL', 'NOTIFY_WEBHOOK_URL', 'PORT', 'NODE_ENV', 'VERCEL', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL']);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) assert.ok(allowed.has(m[1]), `${path.relative(ROOT, f)} reads ${m[1]}`);
      for (const bad of ['GOOGLE_', 'TOKEN_ENCRYPTION_KEY', 'UPLOAD', 'DATA_DIR', 'DEV_LOGIN', 'ALLOWED_DOMAIN', 'NOTIFY_EMAIL', 'GMAIL_']) assert.ok(!text.includes(bad), `${path.relative(ROOT, f)} mentions ${bad}`);
    }
  });

  test('.env.example lists exactly the seven settings', () => {
    const names = [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z_]+)=/gm)].map((m) => m[1]).filter((n) => n !== 'PORT');
    assert.deepEqual(names.sort(), ['ADMIN_EMAIL', 'BASE_URL', 'NOTIFY_WEBHOOK_URL', 'SESSION_SECRET', 'SETUP_TOKEN', 'TURSO_AUTH_TOKEN', 'TURSO_DATABASE_URL']);
  });

  test('README has exactly five numbered setup steps', () => {
    const readme = read('README.md');
    const section = readme.split(/^## Deploy in 5 steps/m)[1].split(/^## /m)[0];
    assert.equal([...section.matchAll(/^\d+\. /gm)].length, 5);
    assert.ok(readme.split('\n').length <= 100);
  });

  test('AC-36: the integration suites run on both drivers', () => {
    assert.deepEqual(DRIVERS, ['sqlite', 'turso']);
    for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js') && n !== 'vercel.test.js' && n !== 'unit.test.js')) {
      const text = read(`test/${f}`);
      if (text.includes('startApp(')) assert.match(text, /of DRIVERS/, f);
    }
  });
});

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function assertHeaders(res, label, { production = false } = {}) {
  assert.equal(res.headers.get('content-security-policy'), CSP, `${label}: CSP`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY', `${label}: XFO`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${label}: nosniff`);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${label}: referrer`);
  assert.equal(res.headers.get('strict-transport-security'), production ? 'max-age=63072000; includeSubDomains' : null, `${label}: HSTS`);
}

function assertNoInlineCode(text, label) {
  assert.doesNotMatch(text, /<script\b(?![^>]*\bsrc=)[^>]*>/i, `${label}: inline script`);
  assert.doesNotMatch(text, /<script\b[^>]*>(?!\s*<\/script>)/i, `${label}: script body`);
  assert.doesNotMatch(text, /<[a-z][^>]*\son\w+\s*=/i, `${label}: event handler attribute`);
  assert.doesNotMatch(text, /<[a-z][^>]*\sstyle\s*=/i, `${label}: style attribute`);
}

for (const driver of DRIVERS) describe(`AC-56 [${driver}]`, () => {
  for (const production of [false, true]) {
    test(`every response path carries the headers (${production ? 'production' : 'development'})`, async () => {
      const t = await startApp({ driver: production ? 'turso' : driver, env: production ? { NODE_ENV: 'production' } : {} });
      try {
        const repId = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
        const roleId = await makeRole(t.db, { title: 'Header Role', assigned: repId, questions: [{ text: 'Why?', required: true }] });
        const anon = t.client();
        const apply = await anon.apply(roleId, { name: 'Pat Person', email: 'pat@example.com', answer_0: 'Because.' });
        assert.equal(apply.status, 303);
        const appId = (await t.db.get('SELECT id, person_id FROM applications ORDER BY id DESC LIMIT 1'));
        const admin = t.client();
        await admin.login('admin@fansided.com');
        const rep = t.client();
        await rep.login('rep@fansided.com');
        const checks = [];
        const hit = async (label, client, method, url, expect, opts) => {
          const res = await client.request(method, url, opts);
          assert.equal(res.status, expect, `${label}: status ${res.status}`);
          assertHeaders(res, label, { production });
          if ((res.headers.get('content-type') || '').startsWith('text/html')) assertNoInlineCode(res.text, label);
          checks.push(label);
          return res;
        };
        // public pages
        for (const u of ['/', `/roles/${roleId}`, '/thanks', '/login', `/roles/${roleId}/apply`]) await hit(`GET ${u}`, anon, 'GET', u, u.endsWith('/apply') ? 303 : 200);
        // internal pages (admin sees all)
        const pages = ['/app', '/app/candidates', '/app/candidates?q=pat', '/app/account', '/app/export', '/app/export.csv', `/app/roles/${roleId}`, `/app/applications/${appId.id}`, `/app/people/${appId.person_id}/delete`, '/app/admin/roles', '/app/admin/roles/new', `/app/admin/roles/${roleId}`, '/app/admin/templates', '/app/admin/templates/new', '/app/admin/templates/1', '/app/admin/users', '/app/admin/sample'];
        for (const u of pages) {
          const res = await hit(`GET ${u}`, admin, 'GET', u, 200);
          if (!u.startsWith('/app/export.csv')) assert.equal(res.headers.get('cache-control'), 'no-store', `${u} no-store`);
        }
        for (const u of ['/login', '/setup', '/set-password']) {
          const res = await anon.request('GET', u);
          assertHeaders(res, u, { production });
          if (res.status !== 404) assert.equal(res.headers.get('cache-control'), 'no-store');
        }
        // admin sample pages after loading
        await admin.get('/app/admin/sample');
        await hit('POST sample load', admin, 'POST', '/app/admin/sample/load', 303, { body: new URLSearchParams({ csrf: admin.csrf() }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        await hit('GET sample (loaded)', admin, 'GET', '/app/admin/sample', 200);
        // redirects
        await hit('redirect: /app anonymous', anon, 'GET', '/app', 302);
        const loginPage = await anon.get('/login');
        assert.equal(loginPage.status, 200);
        // errors
        await hit('404 page', anon, 'GET', '/nope', 404);
        await hit('404 role', anon, 'GET', '/roles/99999', 404);
        await hit('403 rep admin page', rep, 'GET', '/app/admin/users', 403);
        await hit('403 csrf', admin, 'POST', '/app/admin/sample/remove', 403, { body: new URLSearchParams({ csrf: 'bad' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        await hit('405', anon, 'POST', '/thanks', 405, { body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        await hit('413', anon, 'POST', `/roles/${roleId}/apply`, 413, { body: 'a=' + 'x'.repeat(600 * 1024), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        await hit('415', anon, 'POST', '/login', 415, { body: '{}', headers: { 'content-type': 'application/json' } });
        // static files, GET and HEAD
        for (const f of ['style.css', 'app.js', 'favicon.svg', 'logo.png']) {
          const res = await hit(`static ${f}`, anon, 'GET', `/public/${f}`, 200);
          assert.ok(res.buffer.length > 100);
          await hit(`static HEAD ${f}`, anon, 'HEAD', `/public/${f}`, 200);
        }
        await hit('static 404', anon, 'GET', '/public/nothing.css', 404);
        await hit('missing font 404', anon, 'GET', '/public/fonts/PublicSans-Black.woff2', 404);
        // 500: the database fails
        const broken = createApp({
          env: { NODE_ENV: production ? 'production' : 'test', SESSION_SECRET, TURSO_DATABASE_URL: 'http://127.0.0.1:1', TURSO_AUTH_TOKEN: 'x', BASE_URL: 'http://localhost' },
          log: () => {},
          db: { all: async () => { throw new Error('db down'); }, get: async () => { throw new Error('db down'); }, run: async () => { throw new Error('db down'); }, batch: async () => { throw new Error('db down'); }, close: async () => {} },
        });
        const { server, base } = await listen(broken.handler);
        try {
          const res = await fetch(`${base}/`);
          assert.equal(res.status, 500);
          assertHeaders(res, '500', { production });
          assert.doesNotMatch(await res.text(), /db down/);
        } finally {
          await new Promise((r) => (server.closeAllConnections(), server.close(r)));
        }
        // configuration error: generic 500
        const cfg = createApp({ env: { NODE_ENV: 'production' }, log: () => {} });
        assert.ok(cfg.configError);
        const s2 = await listen(cfg.handler);
        try {
          const res = await fetch(`${s2.base}/anything`);
          assert.equal(res.status, 500);
          assertHeaders(res, 'config 500', { production: true });
        } finally {
          await new Promise((r) => (s2.server.closeAllConnections(), s2.server.close(r)));
        }
        assert.ok(checks.length >= 35, String(checks.length));
      } finally {
        await t.close();
      }
    });
  }
});

for (const driver of DRIVERS) describe(`AC-60 [${driver}]`, () => {
  test('load / refuse twice / remove, real data untouched, admin only, no deletion_log rows', async () => {
    const t = await startApp({ driver });
    try {
      const repId = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      const realRole = await makeRole(t.db, { title: 'Real Role', assigned: repId });
      const real = t.client();
      assert.equal((await real.apply(realRole, { name: 'Real Person', email: 'real@fansided-test.com' })).status, 303);
      const before = { roles: await count(t.db, 'job_roles'), people: await count(t.db, 'people'), apps: await count(t.db, 'applications'), events: await count(t.db, 'application_events') };

      const rep = t.client();
      await rep.login('rep@fansided.com');
      assert.equal((await rep.get('/app/admin/sample')).status, 403);
      assert.equal((await rep.post('/app/admin/sample/load', {}, { csrf: 'x' })).status, 403);
      assert.equal((await rep.post('/app/admin/sample/remove', {}, { csrf: 'x' })).status, 403);

      const admin = t.client();
      await admin.login('admin@fansided.com');
      const page = await admin.get('/app/admin/sample');
      assert.match(page.text, /Load sample data/);
      assert.doesNotMatch(page.text, /data-confirm/);
      assert.match(page.text, /<button type="button" class="btn btn-danger" disabled>Remove sample data<\/button>/); // nothing loaded yet
      assert.equal((await rep.get('/app/admin/sample/remove')).status, 403);
      assert.match(admin.lastHtml, /href="\/app\/admin\/sample"/);
      const load = await admin.post('/app/admin/sample/load');
      assert.equal(load.status, 303);
      assert.equal(await count(t.db, 'job_roles', 'is_sample = 1'), 6);
      assert.equal(await count(t.db, 'people', 'is_sample = 1'), 18);
      assert.equal(await count(t.db, 'people', "is_sample = 1 AND email LIKE '%@sample.invalid' AND name NOT LIKE '%(demo)%' AND name NOT LIKE 'Sample%'"), 18);
      // legacy column holds the CATEGORY; stage_id points at a stage of the application's own role
      const stages = await t.db.all('SELECT DISTINCT stage FROM applications ORDER BY stage');
      assert.deepEqual(stages.map((s) => s.stage).filter((s) => s !== 'new').sort(), ['onboarded', 'passed', 'reviewing']);
      assert.ok(stages.some((s) => s.stage === 'new'));
      assert.equal(await count(t.db, 'applications a JOIN role_stages s ON s.id = a.stage_id AND s.role_id = a.role_id'), await count(t.db, 'applications'));
      const names = (await t.db.all("SELECT DISTINCT s.name FROM applications a JOIN role_stages s ON s.id = a.stage_id WHERE a.person_id IN (SELECT id FROM people WHERE is_sample = 1) ORDER BY s.name")).map((r) => r.name);
      assert.deepEqual(names, ['Edit test', 'New', 'Onboarded', 'Passed', 'Phone screen', 'Reviewing', 'Trial']);
      // two of the six sample roles have their own workflow
      const flows = (await t.db.all("SELECT r.title, group_concat(s.name, ' > ') AS flow FROM job_roles r JOIN role_stages s ON s.role_id = r.id WHERE r.is_sample = 1 GROUP BY r.id ORDER BY r.id")).map((r) => r.flow);
      assert.equal(flows.filter((f) => f === 'New > Reviewing > Trial > Onboarded > Passed').length, 4);
      assert.ok(flows.includes('New > Reviewing > Edit test > Trial > Onboarded > Passed'));
      assert.ok(flows.includes('New > Phone screen > Trial > Onboarded > Passed'));
      assert.equal(await count(t.db, 'job_roles', 'is_sample = 1 AND assigned_user_id = (SELECT id FROM users WHERE email = ?)', 'admin@fansided.com'), 6);
      assert.equal(await count(t.db, 'notes', 'person_id IN (SELECT id FROM people WHERE is_sample = 1)'), 8);
      assert.ok((await count(t.db, 'application_events', "type = 'stage_change'")) >= 18 + 12);
      assert.equal(await count(t.db, 'applications', 'person_id IN (SELECT id FROM people WHERE is_sample = 1)'), 20);
      // the pipeline pages render
      const roleRow = await t.db.get('SELECT id FROM job_roles WHERE is_sample = 1 ORDER BY id LIMIT 1');
      assert.equal((await admin.get(`/app/roles/${roleRow.id}`)).status, 200);

      // loading twice is refused and changes nothing
      await admin.get('/app/admin/sample');
      const again = await admin.post('/app/admin/sample/load');
      assert.equal(again.status, 303);
      assert.equal(await count(t.db, 'people', 'is_sample = 1'), 18);
      assert.equal(await count(t.db, 'job_roles', 'is_sample = 1'), 6);

      // a real applicant to a sample role: the role is closed and kept on removal
      const keepRole = (await t.db.get("SELECT id FROM job_roles WHERE is_sample = 1 AND vertical = 'NBA'")).id;
      await t.db.run('UPDATE job_roles SET status = ? WHERE id = ?', ['open', keepRole]);
      assert.equal((await t.client().apply(keepRole, { name: 'Real Applicant', email: 'real2@fansided-test.com', answer_0: 'x' })).status, 303);

      // Remove goes through a server-rendered confirmation page whose button POSTs with the CSRF token.
      const loadedPage = await admin.get('/app/admin/sample');
      assert.match(loadedPage.text, /<a class="btn btn-danger" href="\/app\/admin\/sample\/remove">Remove sample data<\/a>/);
      const confirmPage = await admin.get('/app/admin/sample/remove');
      assert.equal(confirmPage.status, 200);
      assert.match(confirmPage.text, /<h1>Remove the sample data\?<\/h1>/);
      assert.match(confirmPage.text, /<form method="post" action="\/app\/admin\/sample\/remove"[^>]*>\s*<input type="hidden" name="csrf"/);
      assert.equal(await count(t.db, 'people', 'is_sample = 1'), 18, 'GET changes nothing');
      const logBefore = await count(t.db, 'deletion_log');
      const remove = await admin.post('/app/admin/sample/remove');
      assert.equal(remove.status, 303);
      assert.equal(await count(t.db, 'people', 'is_sample = 1'), 0);
      assert.equal(await count(t.db, 'job_roles', 'is_sample = 1'), 0);
      assert.equal(await count(t.db, 'people', "email LIKE 'sample.%'"), 0);
      assert.equal(await count(t.db, 'deletion_log'), logBefore);
      const kept = await t.db.get('SELECT status, is_sample FROM job_roles WHERE id = ?', [keepRole]);
      assert.deepEqual({ ...kept }, { status: 'closed', is_sample: 0 });
      assert.equal(await count(t.db, 'job_roles'), before.roles + 1);
      assert.equal(await count(t.db, 'people'), before.people + 1);
      assert.equal(await count(t.db, 'applications'), before.apps + 1);
      assert.equal(await count(t.db, 'application_events'), before.events + 1);
      assert.ok(await t.db.get('SELECT id FROM people WHERE email = ?', ['real@fansided-test.com']));
      assert.equal(await count(t.db, 'role_stages', 'role_id NOT IN (SELECT id FROM job_roles)'), 0, 'no orphan stages after removal');
      assert.equal(await count(t.db, 'role_stages', 'role_id = ?', keepRole), 5, 'the kept role keeps its workflow');
      // can be loaded again after removal
      await admin.get('/app/admin/sample');
      await admin.post('/app/admin/sample/load');
      assert.equal(await count(t.db, 'people', 'is_sample = 1'), 18);
    } finally {
      await t.close();
    }
  });
});

// Vercel picked src/app.js as the entry point on the first real deploy and rejected it because the module
// did not export a request handler. Both possible entry files must export one.
test('entry points: src/app.js and api/index.js both export a (req, res) handler', () => {
  const assert = require('node:assert');
  const appModule = require('../src/app');
  assert.strictEqual(typeof appModule, 'function');
  assert.strictEqual(appModule.default, appModule);
  assert.strictEqual(typeof appModule.createApp, 'function');
  assert.strictEqual(require('../api/index.js'), appModule);
});

test('embedded assets match public/ (run node scripts/embed-assets.js after editing them)', () => {
  const assert = require('node:assert');
  const fs = require('node:fs');
  const path = require('node:path');
  const embedded = require('../src/lib/assets.generated');
  for (const name of ['style.css', 'app.js', 'favicon.svg']) {
    assert.strictEqual(embedded[name], fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'));
  }
  // Binary files (logo, fonts) are embedded as base64 and must be byte-identical to public/.
  const expected = ['logo.png'];
  const fontDir = path.join(__dirname, '..', 'public', 'fonts');
  if (fs.existsSync(fontDir)) for (const f of fs.readdirSync(fontDir).sort()) if (/\.(woff2|ttf)$/.test(f)) expected.push(`fonts/${f}`);
  assert.deepStrictEqual(Object.keys(embedded.__binary).sort(), expected.sort());
  for (const name of expected) {
    assert.ok(fs.readFileSync(path.join(__dirname, '..', 'public', name)).equals(Buffer.from(embedded.__binary[name], 'base64')), `${name} matches its embedded copy`);
  }
});

// First real deploy: every path except / reached the app as /api/index (the rewrite destination) and got a 404.
test('rewritten Vercel requests: /api/index?__path=... is served as the original path, query kept', async () => {
  const assert = require('node:assert');
  const { createContext } = require('../src/lib/http');
  const mk = (u) => createContext({ url: u, method: 'GET', headers: {} }, {}, { config: {} });
  let ctx = mk('/api/index?__path=/setup&token=abc123');
  assert.strictEqual(ctx.path, '/setup');
  assert.strictEqual(ctx.query.get('token'), 'abc123');
  assert.strictEqual(ctx.query.get('__path'), null);
  assert.strictEqual(mk('/api/index?__path=/roles/3/apply&source=linkedin').path, '/roles/3/apply');
  assert.strictEqual(mk('/api/index?__path=/public/style.css').path, '/public/style.css');
  assert.strictEqual(mk('/api/index').path, '/');
  assert.strictEqual(mk('/api/index?__path=//evil.example').path, '/');
  assert.strictEqual(mk('/api/index?__path=nope').path, '/');
  ctx = mk('/login?__path=/app/admin');
  assert.strictEqual(ctx.path, '/login');
  const rewrite = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'vercel.json'), 'utf8')).rewrites[0];
  assert.strictEqual(rewrite.destination, '/api/index?__path=/$1');
});

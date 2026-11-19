'use strict';
// AC-54 webhook, AC-55 dashboard "since your last visit", AC-58 SQL metacharacters, AC-59 logs carry ids only.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DRIVERS, TEST_PASSWORD, startApp, makeUser, makeRole, lastApplication, count } = require('./helpers');
const { TIMEOUT_MS } = require('../src/lib/notify');

const HOOK = 'https://hooks.example.test/services/T000/B000/secret-path';

// A local stand-in for the chat webhook. mode: 'ok' | 'error500' | 'hang'.
function fakeWebhook() {
  const state = { mode: 'ok', requests: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
      if (state.mode === 'hang') return; // never answers
      res.writeHead(state.mode === 'error500' ? 500 : 200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      state.fetchImpl = (url, init) => fetch(String(url).replace('https://hooks.example.test', `http://127.0.0.1:${server.address().port}`), init);
      state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
      resolve(state);
    })
  );
}

for (const driver of DRIVERS) {

describe(`[${driver}] AC-54: webhook`, () => {
  let t;
  let hook;
  let role;
  const logs = [];
  before(async () => {
    hook = await fakeWebhook();
    t = await startApp({ driver, env: { NOTIFY_WEBHOOK_URL: HOOK, BASE_URL: 'https://recruit.example.com' }, fetchImpl: hook.fetchImpl, log: (m) => logs.push(m) });
    const rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    role = await makeRole(t.db, { title: 'Bears Writer', assigned: rep });
  });
  after(async () => {
    await t.close();
    await hook.close();
  });

  test('a stored application sends exactly one POST {"text"} with role title and link and nothing about the applicant', async () => {
    hook.mode = 'ok';
    hook.requests.length = 0;
    const res = await t.client().apply(role, { name: 'Secret Applicant', email: 'secret.applicant@example.com', answer_0: 'sensitive answer', linkedin_url: 'https://linkedin.com/in/secret' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/thanks');
    const app = await lastApplication(t.db);
    assert.equal(hook.requests.length, 1);
    const [req] = hook.requests;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/services/T000/B000/secret-path');
    assert.match(req.type, /^application\/json/);
    const payload = JSON.parse(req.body);
    assert.deepEqual(Object.keys(payload), ['text']);
    assert.equal(payload.text, `New application for Bears Writer: https://recruit.example.com/app/applications/${app.id}`);
    assert.doesNotMatch(req.body, /Secret|secret|applicant|sensitive|linkedin/i);
  });

  test('invalid applications and honeypot hits send nothing', async () => {
    hook.requests.length = 0;
    await t.client().apply(role, { name: '', email: 'bad' });
    await t.client().apply(role, { email: 'bot@example.com', website: 'spam' });
    assert.equal(hook.requests.length, 0);
  });

  test('a webhook that returns 500 still stores the application and redirects to /thanks; the failure is logged by id only', async () => {
    hook.mode = 'error500';
    hook.requests.length = 0;
    logs.length = 0;
    const res = await t.client().apply(role, { name: 'Err Case', email: 'err.case@example.com' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/thanks');
    const app = await lastApplication(t.db);
    assert.equal(app.stage, 'new');
    assert.equal(hook.requests.length, 1);
    assert.deepEqual(logs.filter((l) => /webhook/.test(l)), [`[webhook] failed application=${app.id}`]);
  });

  test('a webhook that cannot be reached still stores the application', async () => {
    const dead = await startApp({ driver, env: { NOTIFY_WEBHOOK_URL: HOOK }, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    try {
      const r = await makeRole(dead.db, { title: 'Dead hook' });
      const res = await dead.client().apply(r, { email: 'nohook@example.com' });
      assert.equal(res.status, 303);
      assert.equal(await count(dead.db, 'applications'), 1);
    } finally {
      await dead.close();
    }
  });

  test('a webhook that hangs past the timeout still stores the application and redirects to /thanks', async () => {
    hook.mode = 'hang';
    hook.requests.length = 0;
    logs.length = 0;
    const before = await count(t.db, 'applications');
    const started = Date.now();
    const res = await t.client().apply(role, { name: 'Hang Case', email: 'hang.case@example.com' });
    const took = Date.now() - started;
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/thanks');
    assert.equal(await count(t.db, 'applications'), before + 1);
    assert.equal(hook.requests.length, 1);
    assert.ok(took >= TIMEOUT_MS - 200 && took < TIMEOUT_MS + 3000, `took ${took} ms (timeout ${TIMEOUT_MS})`);
    const app = await lastApplication(t.db);
    assert.ok(logs.includes(`[webhook] failed application=${app.id}`));
  });

  test('without NOTIFY_WEBHOOK_URL (or with a non-https one) nothing is sent', async () => {
    for (const env of [{}, { NOTIFY_WEBHOOK_URL: 'http://hooks.example.test/x' }]) {
      const calls = [];
      const x = await startApp({ driver, env, fetchImpl: async (...a) => { calls.push(a); return { ok: true }; } });
      try {
        const r = await makeRole(x.db, { title: 'Quiet' });
        assert.equal((await x.client().apply(r, { email: 'quiet@example.com' })).status, 303);
        assert.equal(calls.length, 0, JSON.stringify(env));
      } finally {
        await x.close();
      }
    }
  });
});

describe(`[${driver}] AC-55: dashboard New counts and "since your last visit"`, () => {
  test('the New count is highlighted per role; +N appears once for applications after the previous view and is gone on reload (also across app restarts)', async () => {
    let t = await startApp({ driver });
    try {
      const rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      const other = await makeUser(t.db, { email: 'other@fansided.com', name: 'Olly Other' });
      const roleA = await makeRole(t.db, { title: 'Role A', assigned: rep });
      const roleB = await makeRole(t.db, { title: 'Role B', assigned: rep });
      const quiet = await makeRole(t.db, { title: 'Quiet', assigned: rep });
      const row = (text, id) => new RegExp(`<tr data-role-id="${id}">[\\s\\S]*?</tr>`).exec(text)[0];
      const newCell = (text, id) => /<td class="num[^"]*" data-stage="new">[\s\S]*?<\/td>/.exec(row(text, id))[0];
      await t.client().apply(roleA, { email: 'before1@example.com' }); // arrived before the first visit

      let c = t.client();
      await c.login('rep@fansided.com'); // the redirect to /app is the first view
      const first = await c.get('/app');
      assert.match(newCell(first.text, roleA), /class="num highlight"/);
      assert.match(newCell(first.text, roleA), />1</);
      assert.doesNotMatch(first.text, /since your last visit/);
      assert.doesNotMatch(newCell(first.text, quiet), /highlight/); // zero New is not highlighted

      await new Promise((r) => setTimeout(r, 15));
      await t.client().apply(roleA, { email: 'a1@example.com' });
      await t.client().apply(roleA, { email: 'a2@example.com' });
      await t.client().apply(roleB, { email: 'b1@example.com' });
      t = await t.restart(); // nothing is kept in memory
      c.base = t.base;
      const seen = await c.get('/app');
      assert.match(newCell(seen.text, roleA), />3 <span class="since" data-since="2">\+2 since your last visit<\/span>/);
      assert.match(newCell(seen.text, roleA), /highlight/);
      assert.match(newCell(seen.text, roleB), /\+1 since your last visit/);
      assert.doesNotMatch(row(seen.text, quiet), /since your last visit/);
      const reload = await c.get('/app');
      assert.doesNotMatch(reload.text, /since your last visit/);
      assert.match(newCell(reload.text, roleA), />3</); // the count itself stays

      // Per user: another rep's stamp is independent; "All roles" view also shows it.
      await makeRole(t.db, { title: 'Other role', assigned: other });
      const oc = t.client();
      await oc.login('other@fansided.com');
      await new Promise((r) => setTimeout(r, 15));
      await t.client().apply(roleB, { email: 'b2@example.com' });
      const all = await c.get('/app?view=all');
      assert.match(newCell(all.text, roleB), /\+1 since your last visit/);
      assert.doesNotMatch((await c.get('/app?view=all')).text, /since your last visit/);
      const otherView = await oc.get('/app?view=all');
      assert.match(newCell(otherView.text, roleB), /\+1 since your last visit/);
      // The stamp is stored in the database.
      assert.ok((await t.db.get("SELECT dashboard_seen_at FROM users WHERE email = 'rep@fansided.com'")).dashboard_seen_at);
      // Only the dashboard stamps: viewing a pipeline does not clear it.
      await new Promise((r) => setTimeout(r, 15));
      await t.client().apply(roleA, { email: 'a3@example.com' });
      await c.get(`/app/roles/${roleA}`);
      assert.match(newCell((await c.get('/app')).text, roleA), /\+1 since your last visit/);
    } finally {
      await t.close();
    }
  });
});

describe(`[${driver}] AC-58: SQL metacharacters are plain text`, () => {
  test('login, apply, notes, filters and ids treat quotes and SQL as data', async () => {
    const t = await startApp({ driver });
    try {
      const rep = await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      const role = await makeRole(t.db, { title: 'Injection Role', assigned: rep, questions: [{ text: "Q' OR 1=1 --", required: false }] });
      const nasty = ["' OR 1=1 --", '"; DROP TABLE users; --', "x'); DELETE FROM applications; --", '\\', '%_', '\u0000x'];
      const usersBefore = await count(t.db, 'users');
      // login
      for (const bad of nasty) {
        const c = t.client();
        const res = await c.login(bad, bad);
        assert.equal(res.status, 401, bad);
        assert.ok(!res.headers.getSetCookie().some((h) => h.startsWith('sid=')));
      }
      const c0 = t.client();
      assert.equal((await c0.login("rep@fansided.com' OR '1'='1", "' OR '1'='1")).status, 401);
      assert.equal(await count(t.db, 'users'), usersBefore);
      // apply
      let n = 0;
      for (const bad of nasty.slice(0, 4)) {
        n++;
        const res = await t.client().apply(role, { name: bad, email: `inj${n}@example.com`, sample_links: 'https://example.com/a', answer_0: bad, source: bad, heard_from: 'LinkedIn' });
        assert.equal(res.status, 303, bad);
      }
      const stored = await t.db.all('SELECT p.name, a.answers_json, a.source_tag FROM applications a JOIN people p ON p.id = a.person_id ORDER BY a.id');
      assert.equal(stored.length, 4);
      assert.equal(stored[0].name, "' OR 1=1 --");
      assert.equal(stored[1].name, '"; DROP TABLE users; --');
      assert.equal(JSON.parse(stored[2].answers_json)[0].answer, "x'); DELETE FROM applications; --");
      assert.equal(stored[2].source_tag, "x'); DELETE FROM applications; --");
      // notes, filters, ids
      const a = await t.client();
      await a.login('admin@fansided.com');
      const app = await lastApplication(t.db);
      await a.get(`/app/applications/${app.id}`);
      const csrf = a.csrf();
      assert.equal((await a.post(`/app/applications/${app.id}/notes`, { body: "'); DROP TABLE notes; --" })).status, 303);
      assert.equal((await t.db.get('SELECT body FROM notes')).body, "'); DROP TABLE notes; --");
      for (const q of ["from=' OR 1=1 --", 'to=2026-01-01"; DROP TABLE applications;--', "from=2026-01-01' OR '1'='1"]) {
        assert.equal((await a.get(`/app/export.csv?${encodeURI(q)}`)).status, 400, q);
      }
      assert.equal((await a.get(`/app/applications/${app.id}?template=${encodeURIComponent("1' OR '1'='1")}`)).status, 200);
      assert.equal((await a.get(`/roles/${role}?source=${encodeURIComponent("'; DROP TABLE job_roles; --")}`)).status, 200);
      for (const id of ["abc", "1' OR '1'='1", '1%20OR%201=1', '-1', '1.5', '0x1', '99999999999999999999999', '%00']) {
        for (const url of [`/app/applications/${id}`, `/app/roles/${id}`, `/app/people/${id}/delete`, `/app/admin/roles/${id}`, `/app/admin/templates/${id}`]) {
          const res = await a.get(url);
          assert.ok([404].includes(res.status), `${url} -> ${res.status}`);
        }
        assert.equal((await a.get(`/roles/${id}`)).status, 404, `/roles/${id}`);
        assert.equal((await a.post(`/app/applications/${id}/stage`, { stage: 'reviewing' }, { csrf })).status, 404);
        assert.equal((await a.post(`/app/admin/users/${id}/deactivate`, {}, { csrf })).status, 404);
      }
      // nothing else changed
      assert.equal(await count(t.db, 'users'), usersBefore);
      assert.equal(await count(t.db, 'applications'), 4);
      assert.equal(await count(t.db, 'job_roles'), 1);
    } finally {
      await t.close();
    }
  });
});

describe(`[${driver}] AC-59: logs carry ids only`, () => {
  test('apply, login failure, invite and reset creation, webhook failure and candidate deletion log no email, name, token or password', async () => {
    const lines = [];
    const t = await startApp({
      driver,
      env: { SESSION_SECRET: 'p'.repeat(40), NOTIFY_WEBHOOK_URL: HOOK, BASE_URL: 'https://recruit.example.com', },
      fetchImpl: async () => ({ ok: false, status: 500 }),
      log: (l) => lines.push(l),
    });
    try {
      const rep = await makeUser(t.db, { email: 'rep.logs@fansided.com', name: 'Rita Logs' });
      const role = await makeRole(t.db, { title: 'Logged Role', assigned: rep });
      // apply (+ webhook failure)
      assert.equal((await t.client().apply(role, { name: 'Zed Applicant', email: 'zed.applicant@example.com', linkedin_url: 'https://linkedin.com/in/zed' })).status, 303);
      const app = await lastApplication(t.db);
      // login failures with a real and an unknown email, and a wrong password
      const wrongPw = 'my wrong password 123';
      await t.client().login('rep.logs@fansided.com', wrongPw);
      await t.client().login('nobody.logs@example.com', wrongPw);
      for (let i = 0; i < 5; i++) await t.client().login('limited.logs@example.com', wrongPw); // reaches the rate limit too
      // admin: invite, reset link, delete candidate
      const admin = t.client();
      await admin.login('admin@fansided.com');
      await admin.get('/app/admin/users');
      const inv = await admin.post('/app/admin/users', { email: 'ivy.invitee@example.com', name: 'Ivy Invitee', role: 'rep' });
      const inviteToken = /token=([A-Za-z0-9_-]{43})/.exec(inv.text)[1];
      const reset = await admin.post(`/app/admin/users/${rep}/reset-link`, {});
      const resetToken = /token=([A-Za-z0-9_-]{43})/.exec(reset.text)[1];
      const sid = admin.jar.get('sid');
      await admin.get(`/app/applications/${app.id}`);
      await admin.post(`/app/applications/${app.id}/notes`, { body: 'private note text' });
      await admin.post(`/app/applications/${app.id}/email`, { via: 'gmail', subject: 'Private subject', body: 'Private body' });
      await admin.get(`/app/people/${app.person_id}/delete`);
      assert.equal((await admin.post(`/app/people/${app.person_id}/delete`, {})).status, 303);
      // a failing request path (500) is logged without data as well
      await t.client().get('/app/applications/1/../..');

      const all = lines.join('\n');
      for (const secret of ['zed.applicant', 'Zed', 'Applicant', 'rep.logs@', 'Rita Logs', 'nobody.logs', 'limited.logs', 'ivy.invitee', 'Ivy', wrongPw, inviteToken, resetToken, sid, 'private note', 'Private subject', 'linkedin.com/in/zed', 'admin@fansided.com', 'p'.repeat(40)]) {
        assert.ok(!all.includes(secret), `log contains ${secret}`);
      }
      assert.match(all, new RegExp(`\\[webhook\\] failed application=${app.id}`));
      assert.match(all, /\[admin\] invite created user=\d+ by=\d+/);
      assert.match(all, /\[admin\] reset link created user=\d+ by=\d+/);
      assert.match(all, new RegExp(`\\[delete\\] person=${app.person_id} by=\\d+`));
    } finally {
      await t.close();
    }
  });
});

}

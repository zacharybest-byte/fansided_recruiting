'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { DRIVERS, TEST_PASSWORD, SESSION_SECRET, startApp, makeUser, makeRole, count } = require('./helpers');
const { createApp } = require('../src/app');
const { safeNext } = require('../src/lib/auth');
const { sha256Hex } = require('../src/lib/crypto');
const { verifyPassword } = require('../src/lib/password');

const ROOT = path.join(__dirname, '..');
const sidOf = (c) => c.jar.get('sid');
const hasSid = (res) => res.headers.getSetCookie().some((h) => h.startsWith('sid='));

for (const driver of DRIVERS) {

describe(`[${driver}] sessions, permissions and CSRF`, () => {
  let t;
  let roleId;
  let appId;
  before(async () => {
    t = await startApp({ driver });
    await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    await makeUser(t.db, { email: 'rep2@fansided.com', name: 'Second Rep' });
    roleId = await makeRole(t.db, { title: 'Perm Role' });
    await t.client().apply(roleId, { email: 'cand@example.com', name: 'Cand Idate' });
    appId = (await t.db.get('SELECT id FROM applications ORDER BY id DESC')).id;
  });
  after(() => t.close());

  test('AC-15: a rep gets 403 on every /app/admin/* route (GET and POST, incl. unknown paths) and on candidate delete', async () => {
    const c = t.client();
    await c.login('rep@fansided.com');
    const tpl = (await t.db.get('SELECT id FROM email_templates LIMIT 1')).id;
    const personId = (await t.db.get('SELECT person_id FROM applications WHERE id = ?', [appId])).person_id;
    const gets = ['/app/admin', '/app/admin/templates', '/app/admin/templates/new', `/app/admin/templates/${tpl}`, '/app/admin/roles', '/app/admin/roles/new', `/app/admin/roles/${roleId}`, '/app/admin/users', '/app/admin/whatever', `/app/people/${personId}/delete`];
    for (const url of gets) assert.equal((await c.get(url)).status, 403, `GET ${url}`);
    await c.get('/app');
    const posts = [
      '/app/admin/templates', `/app/admin/templates/${tpl}`, `/app/admin/templates/${tpl}/delete`, '/app/admin/roles', `/app/admin/roles/${roleId}`,
      '/app/admin/users', '/app/admin/users/1/role', '/app/admin/users/1/deactivate', '/app/admin/users/1/reactivate', '/app/admin/users/1/reset-link',
      '/app/admin/users/1/name', '/app/admin/whatever', `/app/people/${personId}/delete`,
    ];
    for (const url of posts) assert.equal((await c.post(url, { name: 'x', role: 'rep', title: 'x', vertical: 'x' })).status, 403, `POST ${url}`);
    assert.equal(await count(t.db, 'people', 'id = ?', personId), 1);
    assert.equal(await count(t.db, 'email_templates', 'id = ?', tpl), 1);
    assert.equal(await count(t.db, 'auth_tokens'), 0);
  });

  test('AC-16: internal POST without a valid CSRF token is 403 and changes nothing', async () => {
    const c = t.client();
    await c.login('admin@fansided.com');
    await c.get(`/app/applications/${appId}`);
    const notesBefore = await count(t.db, 'notes');
    const eventsBefore = await count(t.db, 'application_events');
    const tokensBefore = await count(t.db, 'auth_tokens');
    for (const csrf of [null, '', 'a'.repeat(64)]) {
      assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'sneaky' }, { csrf })).status, 403);
      assert.equal((await c.post(`/app/applications/${appId}/stage`, { stage: 'reviewing' }, { csrf })).status, 403);
      assert.equal((await c.post('/app/admin/users', { email: 'evil@fansided.com', name: 'Evil', role: 'admin' }, { csrf })).status, 403);
      assert.equal((await c.post('/app/account', { current_password: TEST_PASSWORD, password: 'new password 123', password_confirm: 'new password 123' }, { csrf })).status, 403);
      assert.equal((await c.post('/logout', {}, { csrf })).status, 403);
    }
    assert.equal(await count(t.db, 'notes'), notesBefore);
    assert.equal(await count(t.db, 'application_events'), eventsBefore);
    assert.equal(await count(t.db, 'auth_tokens'), tokensBefore);
    assert.equal((await t.db.get('SELECT stage FROM applications WHERE id = ?', [appId])).stage, 'new');
    assert.equal(await count(t.db, 'users', "email = 'evil@fansided.com'"), 0);
    // A token from another session is also refused.
    const other = t.client();
    await other.login('rep@fansided.com');
    const foreign = other.csrf();
    assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'x' }, { csrf: foreign })).status, 403);
    // The token is derived from the session token and the secret, never stored.
    assert.notEqual(c.csrf(), sidOf(c));
    // And the real token works.
    assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'legit' })).status, 303);
  });

  test('AC-16: pre-session forms need the double-submit cookie: field must equal the cookie and the HMAC must verify', async () => {
    const c = t.client();
    await c.get('/login');
    const good = c.csrf();
    assert.match(good, /^[0-9a-f]{32}\.[0-9a-f]{64}$/);
    // No token / wrong token / token not matching the cookie: 403, no session
    for (const csrf of [null, '', 'x', `${'a'.repeat(32)}.${'b'.repeat(64)}`]) {
      const res = await c.post('/login', { email: 'rep@fansided.com', password: TEST_PASSWORD }, { csrf });
      assert.equal(res.status, 403);
      assert.ok(!hasSid(res));
    }
    // An attacker who can plant their own cookie still cannot forge the HMAC.
    const forged = `${'c'.repeat(32)}.${'d'.repeat(64)}`;
    c.jar.set('pcsrf', forged);
    assert.equal((await c.post('/login', { email: 'rep@fansided.com', password: TEST_PASSWORD }, { csrf: forged })).status, 403);
    c.jar.set('pcsrf', good);
    assert.equal((await c.post('/login', { email: 'rep@fansided.com', password: TEST_PASSWORD }, { csrf: good })).status, 303);
  });

  test('AC-17: session cookie flags; logout and deactivation kill the old cookie', async () => {
    const c = t.client();
    await c.get('/login');
    const res = await c.post('/login', { email: 'rep2@fansided.com', password: TEST_PASSWORD, next: '/app' });
    const sid = res.headers.getSetCookie().find((h) => h.startsWith('sid='));
    assert.ok(sid);
    assert.match(sid, /HttpOnly/);
    assert.match(sid, /Secure/);
    assert.match(sid, /SameSite=Lax/);
    assert.match(sid, /Path=\//);
    assert.match(sid, /Max-Age=1209600/); // 14 days
    const sidValue = sidOf(c);
    assert.match(sidValue, /^[0-9a-f]{64}$/);
    assert.equal((await c.get('/app')).status, 200);
    assert.equal(await count(t.db, 'sessions', 'token_hash = ?', sha256Hex(sidValue)), 1);

    const logout = await c.post('/logout', {});
    assert.equal(logout.status, 303);
    assert.equal(await count(t.db, 'sessions', 'token_hash = ?', sha256Hex(sidValue)), 0);
    c.jar.set('sid', sidValue); // replay the old cookie
    assert.equal((await c.get('/app')).status, 302);

    // Deactivation deletes sessions.
    const d = t.client();
    await d.login('rep2@fansided.com');
    const old = sidOf(d);
    assert.equal((await d.get('/app')).status, 200);
    const admin = t.client();
    await admin.login('admin@fansided.com');
    await admin.get('/app/admin/users');
    const repId = (await t.db.get("SELECT id FROM users WHERE email = 'rep2@fansided.com'")).id;
    assert.equal((await admin.post(`/app/admin/users/${repId}/deactivate`, {})).status, 303);
    assert.equal(await count(t.db, 'sessions', 'user_id = ?', repId), 0);
    d.jar.set('sid', old);
    assert.equal((await d.get('/app')).status, 302);
    // A session row that survives for a deactivated user is still refused (and removed).
    await t.db.run('UPDATE users SET active = 1 WHERE id = ?', [repId]);
    const f = t.client();
    await f.login('rep2@fansided.com');
    await t.db.run('UPDATE users SET active = 0 WHERE id = ?', [repId]);
    assert.equal((await f.get('/app')).status, 302);
    assert.equal(await count(t.db, 'sessions', 'user_id = ?', repId), 0);
    // Expired sessions are refused too.
    const e = t.client();
    await e.login('rep@fansided.com');
    await t.db.run("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?", [sha256Hex(sidOf(e))]);
    assert.equal((await e.get('/app')).status, 302);
  });

  test('internal pages redirect to login when signed out', async () => {
    const c = t.client();
    for (const url of ['/app', `/app/roles/${roleId}`, `/app/applications/${appId}`, '/app/export', '/app/export.csv', '/app/account']) {
      const res = await c.get(url);
      assert.equal(res.status, 302, url);
      assert.match(res.headers.get('location'), /^\/login\?next=/);
    }
    const post = await c.post(`/app/applications/${appId}/notes`, { body: 'x' }, { csrf: null });
    assert.equal(post.status, 302);
    assert.equal(await count(t.db, 'notes', "body = 'x'"), 0);
  });

  test('the password hash never reaches a page, the session user or the users list', async () => {
    const c = t.client();
    await c.login('admin@fansided.com');
    for (const url of ['/app', '/app/admin/users', '/app/account']) {
      const res = await c.get(url);
      assert.doesNotMatch(res.text, /scrypt\$/, url);
    }
  });
});

describe(`[${driver}] password sign-in`, () => {
  let t;
  before(async () => {
    t = await startApp({ driver });
    await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    await makeUser(t.db, { email: 'gone@fansided.com', name: 'Gone', active: 0 });
    await makeUser(t.db, { email: 'invited@fansided.com', name: 'Invited', password: null });
    await makeUser(t.db, { email: 'other@fansided.com', name: 'Other', password: 'a completely different password' });
  });
  after(() => t.close());

  test('AC-43: correct login issues a new session; the DB holds only its hash; every failure is identical and sets no session', async () => {
    const c = t.client();
    const first = await c.login('Rep@FanSided.com'); // email is case-insensitive
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('location'), '/app');
    const sid1 = sidOf(c);
    assert.match(sid1, /^[0-9a-f]{64}$/);
    const rows = await t.db.all('SELECT * FROM sessions');
    assert.ok(rows.some((r) => r.token_hash === sha256Hex(sid1)));
    assert.ok(!JSON.stringify(rows).includes(sid1), 'the raw token is not stored');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'expires_at', 'token_hash', 'user_id']);
    // A new token at every login (even when already signed in).
    const c2 = t.client();
    await c2.login('rep@fansided.com');
    assert.notEqual(sidOf(c2), sid1);

    const failures = [];
    for (const [email, password] of [
      ['rep@fansided.com', 'wrong password at all'],
      ['nobody@fansided.com', TEST_PASSWORD],
      ['gone@fansided.com', TEST_PASSWORD],
      ['invited@fansided.com', TEST_PASSWORD],
      ['invited@fansided.com', ''],
      ['', ''],
    ]) {
      const f = t.client();
      const before = await count(t.db, 'sessions');
      const res = await f.login(email, password);
      assert.ok(!hasSid(res), email);
      assert.equal(await count(t.db, 'sessions'), before);
      failures.push({ status: res.status, message: /class="flash flash-error" role="alert">([^<]*)</.exec(res.text)[1] });
    }
    assert.equal(failures[0].status, 401);
    assert.equal(failures[0].message, 'Email or password is incorrect.');
    for (const f of failures) assert.deepEqual(f, failures[0]);
    assert.match(failures[0].message, /incorrect/);
    assert.match((await t.client().get('/login')).text, /Forgot your password\? Ask an admin for a reset link\./);
  });

  test('AC-44: passwords are salted scrypt, never stored in plain, and under 12 / over 200 characters are refused when changing it', async () => {
    // Two users given the same password through the app get different hashes.
    const admin = t.client();
    await admin.login('admin@fansided.com');
    const mk = async (email) => {
      await admin.get('/app/admin/users');
      const res = await admin.post('/app/admin/users', { email, name: email, role: 'rep' });
      const token = /token=([A-Za-z0-9_-]{43})/.exec(res.text)[1];
      const c = t.client();
      await c.get(`/set-password?token=${token}`);
      const set = await c.post('/set-password', { token, password: 'shared password 1234', password_confirm: 'shared password 1234' });
      assert.equal(set.status, 303);
    };
    await mk('same1@fansided.com');
    await mk('same2@fansided.com');
    const hashes = await t.db.all("SELECT password_hash FROM users WHERE email LIKE 'same%'");
    assert.equal(hashes.length, 2);
    assert.notEqual(hashes[0].password_hash, hashes[1].password_hash);
    for (const { password_hash: h } of hashes) {
      assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
      const [, , , , saltB64, keyB64] = h.split('$');
      assert.equal(Buffer.from(saltB64, 'base64').length, 16);
      assert.equal(Buffer.from(keyB64, 'base64').length, 32);
    }
    assert.notEqual(hashes[0].password_hash.split('$')[4], hashes[1].password_hash.split('$')[4], 'per-user salt');
    assert.ok(await verifyPassword('shared password 1234', hashes[0].password_hash));
    // The plain password appears nowhere in the database.
    const dump = [];
    for (const { name } of await t.db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) dump.push(JSON.stringify(await t.db.all(`SELECT * FROM "${name}"`)));
    assert.ok(!dump.join('\n').includes('shared password 1234'));
    assert.ok(!dump.join('\n').includes(TEST_PASSWORD));

    // Length rules at the account page (set-password and setup are covered in invites.test.js).
    const c = t.client();
    await c.login('other@fansided.com', 'a completely different password');
    await c.get('/app/account');
    const before = (await t.db.get("SELECT password_hash FROM users WHERE email = 'other@fansided.com'")).password_hash;
    for (const bad of ['short', 'a'.repeat(11), 'a'.repeat(201)]) {
      const res = await c.post('/app/account', { current_password: 'a completely different password', password: bad, password_confirm: bad });
      assert.equal(res.status, 400, bad.length);
      assert.match(res.text, /between 12 and 200 characters/);
    }
    assert.equal((await t.db.get("SELECT password_hash FROM users WHERE email = 'other@fansided.com'")).password_hash, before);
    for (const ok of ['a'.repeat(12), 'b'.repeat(200)]) {
      const res = await c.post('/app/account', { current_password: ok === 'a'.repeat(12) ? 'a completely different password' : 'a'.repeat(12), password: ok, password_confirm: ok });
      assert.equal(res.status, 303, ok.length);
      await c.get('/app/account');
    }
  });

  test('AC-45: 5 failures for one email lock it (even for the right password); 20 from one IP lock the IP; both expire', async () => {
    await t.db.run('DELETE FROM rate_limits');
    await makeUser(t.db, { email: 'fresh@fansided.com', name: 'Fresh' });
    const ip = '203.0.113.50';
    // email limit
    for (let i = 0; i < 5; i++) assert.equal((await t.client({ ip }).login('rep@fansided.com', `wrong password ${i}`)).status, 401);
    const locked = await t.client({ ip }).login('rep@fansided.com', TEST_PASSWORD);
    assert.equal(locked.status, 429);
    assert.match(locked.text, /Too many attempts\. Try again later\./);
    assert.ok(!hasSid(locked));
    // Same message and status whether or not the account exists (limited before any lookup).
    for (let i = 0; i < 5; i++) await t.client({ ip: '203.0.113.51' }).login('ghost@fansided.com', 'wrong password');
    const ghost = await t.client({ ip: '203.0.113.52' }).login('ghost@fansided.com', 'x');
    assert.equal(ghost.status, 429);
    assert.match(ghost.text, /Too many attempts\. Try again later\./);
    // Stored in the DB as HMAC keys, not raw values.
    const keys = await t.db.all('SELECT key FROM rate_limits');
    assert.ok(keys.length >= 10);
    assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k.key)));
    assert.doesNotMatch(JSON.stringify(keys), /rep@fansided|203\.0\.113/);
    // Another email from another IP is not affected; after the window the lock is gone.
    assert.equal((await t.client({ ip: '203.0.113.53' }).login('fresh@fansided.com')).status, 303);
    await t.db.run('UPDATE rate_limits SET at = ?', [new Date(Date.now() - 16 * 60000).toISOString()]);
    assert.equal((await t.client({ ip: '203.0.113.54' }).login('rep@fansided.com')).status, 303);

    // IP limit: 20 failures for different emails, then even a valid login from that IP is refused.
    await t.db.run('DELETE FROM rate_limits');
    const bad = '198.51.100.99';
    for (let i = 0; i < 20; i++) assert.equal((await t.client({ ip: bad }).login(`nobody${i}@fansided.com`, 'wrong password')).status, 401, `attempt ${i + 1}`);
    const refused = await t.client({ ip: bad }).login('rep@fansided.com', TEST_PASSWORD);
    assert.equal(refused.status, 429);
    assert.match(refused.text, /Too many attempts/);
    assert.equal((await t.client({ ip: '198.51.100.100' }).login('rep@fansided.com')).status, 303); // other IP is fine
    await t.db.run('UPDATE rate_limits SET at = ?', [new Date(Date.now() - 16 * 60000).toISOString()]);
    assert.equal((await t.client({ ip: bad }).login('rep@fansided.com')).status, 303);
    // Successful logins leave no rate-limit rows behind.
    await t.db.run('DELETE FROM rate_limits');
    await t.client({ ip: '198.51.100.101' }).login('rep@fansided.com');
    assert.equal(await count(t.db, 'rate_limits'), 0);
  });

  test('AC-46: next only redirects to /app... paths', async () => {
    const cases = [
      ['//evil.example', '/app'],
      ['/\\evil', '/app'],
      ['https://evil.example', '/app'],
      ['/app//evil', '/app'],
      ['/app\\evil', '/app'],
      ['/apple', '/app'],
      ['/app\r\nSet-Cookie: x=1', '/app'],
      ['', '/app'],
      ['/app/roles/7', '/app/roles/7'],
      ['/app?view=all', '/app?view=all'],
    ];
    await t.db.run('DELETE FROM rate_limits');
    for (const [next, want] of cases) {
      assert.equal(safeNext(next), want, JSON.stringify(next));
      const c = t.client();
      await c.get('/login');
      const res = await c.post('/login', { email: 'rep@fansided.com', password: TEST_PASSWORD, next });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), want, JSON.stringify(next));
    }
    // The login page carries a sanitised next, and signed-in users visiting /login are sent on safely.
    const c = t.client();
    assert.match((await c.get('/login?next=%2F%2Fevil.example')).text, /name="next" value="\/app"/);
    assert.match((await c.get('/login?next=%2Fapp%2Froles%2F3')).text, /name="next" value="\/app\/roles\/3"/);
    await c.login('rep@fansided.com');
    assert.equal((await c.get('/login?next=https%3A%2F%2Fevil.example')).headers.get('location'), '/app');
    // Signed-out visit to a deep link goes to login and back.
    const d = t.client();
    const bounce = await d.get('/app/roles/9?x=1');
    assert.equal(bounce.headers.get('location'), '/login?next=%2Fapp%2Froles%2F9%3Fx%3D1');
  });

  test('AC-47: changing the password needs the current one, kills other sessions, keeps this browser signed in with a new token', async () => {
    await makeUser(t.db, { email: 'changer@fansided.com', name: 'Changer' });
    const a = t.client();
    const b = t.client();
    await a.login('changer@fansided.com');
    await b.login('changer@fansided.com');
    const oldSid = sidOf(a);
    await a.get('/app/account');
    const newPw = 'brand new password 99';
    // Wrong current password: nothing changes.
    const wrong = await a.post('/app/account', { current_password: 'nope nope nope nope', password: newPw, password_confirm: newPw });
    assert.equal(wrong.status, 400);
    assert.equal((await b.get('/app')).status, 200);
    // Mismatch: nothing changes.
    assert.equal((await a.post('/app/account', { current_password: TEST_PASSWORD, password: newPw, password_confirm: `${newPw}x` })).status, 400);
    assert.equal((await b.get('/app')).status, 200);
    // Success.
    const ok = await a.post('/app/account', { current_password: TEST_PASSWORD, password: newPw, password_confirm: newPw });
    assert.equal(ok.status, 303);
    assert.ok(hasSid(ok));
    assert.notEqual(sidOf(a), oldSid);
    assert.equal((await a.get('/app')).status, 200, 'this browser stays signed in');
    assert.equal((await b.get('/app')).status, 302, 'every other session is gone');
    a.jar.set('sid', oldSid);
    assert.equal((await a.get('/app')).status, 302, 'the old token is dead');
    assert.equal((await t.client().login('changer@fansided.com', TEST_PASSWORD)).status, 401, 'old password stops working');
    assert.equal((await t.client().login('changer@fansided.com', newPw)).status, 303);
    const uid = (await t.db.get("SELECT id FROM users WHERE email = 'changer@fansided.com'")).id;
    assert.equal(await count(t.db, 'sessions', 'user_id = ?', uid), 1 + 1); // this browser + the login just above
    assert.ok((await t.db.get('SELECT password_changed_at FROM users WHERE id = ?', [uid])).password_changed_at);
  });
});

describe(`[${driver}] AC-40: no in-memory state (the app is rebuilt before every request)`, () => {
  test('login, authenticated page, internal POST, apply limit and login limit all survive a fresh app per request', async () => {
    let t = await startApp({ driver });
    try {
      await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
      const roleId = await makeRole(t.db, { title: 'Stateless', assigned: (await t.db.get("SELECT id FROM users WHERE email = 'rep@fansided.com'")).id });
      const step = async (c) => {
        t = await t.restart();
        c.base = t.base;
        return c;
      };
      // login (GET form + POST in different instances), page, internal POST with a token from an earlier instance
      const c = t.client({ ip: '192.0.2.10' });
      await step(c);
      await c.get('/login');
      await step(c);
      const login = await c.post('/login', { email: 'rep@fansided.com', password: TEST_PASSWORD, next: '/app' });
      assert.equal(login.status, 303);
      await step(c);
      assert.equal((await c.get('/app')).status, 200);
      await c.get('/app/account');
      const csrf = c.csrf();
      await step(c);
      const notesBefore = await count(t.db, 'notes');
      await t.client({ ip: '192.0.2.11' }).apply(roleId, { email: 'p@example.com' });
      const appId = (await t.db.get('SELECT id FROM applications ORDER BY id DESC')).id;
      await step(c);
      assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'survives restarts' }, { csrf })).status, 303);
      assert.equal(await count(t.db, 'notes'), notesBefore + 1);
      await step(c);
      assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'bad' }, { csrf: 'f'.repeat(64) })).status, 403);
      // apply limit: 10 stored applications per IP, each from a brand-new app instance
      const ip = '192.0.2.20';
      for (let i = 0; i < 10; i++) {
        t = await t.restart();
        assert.equal((await t.client({ ip }).apply(roleId, { email: `lim${i}@example.com` })).status, 303, `application ${i + 1}`);
      }
      t = await t.restart();
      assert.equal((await t.client({ ip }).apply(roleId, { email: 'lim10@example.com' })).status, 429);
      // login limit: 5 failures, each from a new instance, then the correct password is refused
      const lip = '192.0.2.30';
      for (let i = 0; i < 5; i++) {
        t = await t.restart();
        assert.equal((await t.client({ ip: lip }).login('rep@fansided.com', `wrong password ${i}`)).status, 401);
      }
      t = await t.restart();
      assert.equal((await t.client({ ip: lip }).login('rep@fansided.com', TEST_PASSWORD)).status, 429);
    } finally {
      await t.close();
    }
  });
});

}

describe('AC-42: production configuration', () => {
  const GOOD = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), TURSO_DATABASE_URL: 'http://127.0.0.1:9', TURSO_AUTH_TOKEN: 'tok-secret-value' };

  async function status(app, method = 'GET', url = '/') {
    const http = require('node:http');
    const server = http.createServer(app.handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method });
      return { status: res.status, text: await res.text(), headers: res.headers };
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  }

  test('missing or short SESSION_SECRET and missing Turso variables: configError names variables only; the handler answers a generic 500', async () => {
    const logs = [];
    const cases = [
      [{ ...GOOD, SESSION_SECRET: 'too-short-secret' }, ['SESSION_SECRET'], 'too-short-secret'],
      [{ ...GOOD, SESSION_SECRET: undefined }, ['SESSION_SECRET'], null],
      [{ ...GOOD, TURSO_DATABASE_URL: '' }, ['TURSO_DATABASE_URL'], null],
      [{ ...GOOD, TURSO_AUTH_TOKEN: '' }, ['TURSO_AUTH_TOKEN'], null],
      [{ NODE_ENV: 'production' }, ['SESSION_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'], null],
      [{ VERCEL: '1', VERCEL_URL: 'x.vercel.app' }, ['SESSION_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'], null],
    ];
    for (const [env, names, leak] of cases) {
      const app = createApp({ env, log: (m) => logs.push(m) });
      assert.deepEqual(app.configError.missing, names);
      const res = await status(app);
      assert.equal(res.status, 500);
      assert.match(res.text, /Something went wrong/);
      assert.doesNotMatch(res.text, /SESSION_SECRET|TURSO|tok-secret/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal((await status(app, 'POST', '/auth/dev')).status, 500);
      if (leak) assert.ok(!logs.join('\n').includes(leak));
      await assert.rejects(app.ready);
    }
    assert.match(logs.join('\n'), /SESSION_SECRET/);
    assert.ok(!logs.join('\n').includes('tok-secret-value'));
  });

  test('a complete production configuration is accepted; outside production a missing secret warns and uses a fixed value', () => {
    const logs = [];
    const ok = createApp({ env: GOOD, log: (m) => logs.push(m) });
    assert.equal(ok.configError, undefined);
    assert.equal(ok.config.production, true);
    assert.equal(ok.config.secret, GOOD.SESSION_SECRET);
    const dev = createApp({ env: { NODE_ENV: 'development' }, log: (m) => logs.push(m), dataDir: require('node:os').tmpdir() });
    assert.equal(dev.configError, undefined);
    assert.equal(dev.config.production, false);
    assert.ok(dev.config.secret.length >= 32);
    assert.match(logs.join('\n'), /SESSION_SECRET is missing/);
    assert.equal(createApp({ env: { ...GOOD, NODE_ENV: undefined, VERCEL: '1' }, log: () => {} }).config.production, true);
  });

  test('npm start exits 1 and names the variables (never values) when production configuration is incomplete', () => {
    const run = (env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000 });
    const r = run({ NODE_ENV: 'production', SESSION_SECRET: 'short-secret-value' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SESSION_SECRET.*TURSO_DATABASE_URL.*TURSO_AUTH_TOKEN/);
    assert.ok(!(r.stdout + r.stderr).includes('short-secret-value'));
    const v = run({ VERCEL: '1' });
    assert.equal(v.status, 1);
  });

  test('there is no dev-login bypass in any mode: POST /auth/dev is 404', async () => {
    for (const env of [{ NODE_ENV: 'development', DEV_LOGIN: '1', SESSION_SECRET: SESSION_SECRET }, { NODE_ENV: 'test', DEV_LOGIN: '1' }]) {
      const t = await startApp({ driver: 'sqlite', env });
      try {
        const c = t.client();
        await c.get('/login');
        const res = await c.post('/auth/dev', { email: 'admin@fansided.com' });
        assert.equal(res.status, 404);
        assert.ok(!hasSid(res));
        assert.doesNotMatch((await c.get('/login')).text, /Development sign-in|\/auth\/dev/);
      } finally {
        await t.close();
      }
    }
  });
});

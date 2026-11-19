'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, makeUser, makeRole, count } = require('./helpers');
const { createFakeGoogle, googleSignIn } = require('./fake-google');
const { decrypt } = require('../src/lib/crypto');
const { createApp } = require('../src/server');

const GOOGLE_ENV = { GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' };

describe('Google sign-in (real OAuth code path against a fake Google)', () => {
  let t;
  let fake;
  before(async () => {
    fake = createFakeGoogle();
    t = await startApp({ env: { ...GOOGLE_ENV, DEV_LOGIN: '0', ALLOWED_EMAIL_DOMAINS: 'fansided.com,minutemedia.com' }, fetchImpl: fake.fetch });
    makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    makeUser(t.db, { email: 'gone@fansided.com', name: 'Gone', active: 0 });
    makeUser(t.db, { email: 'outsider@gmail.com', name: 'Outsider' });
  });
  after(() => t.close());

  test('authorization URL requests the right scopes, offline access and a state cookie', async () => {
    const c = t.client();
    const res = await c.get('/auth/google');
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(loc.searchParams.get('scope'), 'openid email profile https://www.googleapis.com/auth/gmail.send');
    assert.equal(loc.searchParams.get('access_type'), 'offline');
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.equal(loc.searchParams.get('redirect_uri'), 'http://localhost/auth/google/callback');
    assert.ok(loc.searchParams.get('state').length >= 32);
    assert.match(res.headers.getSetCookie().join('\n'), /oauth_state=.*HttpOnly; Secure; SameSite=Lax/);
  });

  test('AC-14: ADMIN_EMAILS can sign in as admin on a fresh database; refresh token stored encrypted', async () => {
    const admin = t.db.prepare("SELECT * FROM users WHERE email = 'admin@fansided.com'").get();
    assert.equal(admin.role, 'admin');
    assert.equal(admin.active, 1);
    fake.addIdentity('admin-code', { email: 'Admin@FanSided.com', email_verified: true, name: 'Ada Admin', refresh_token: 'rt-admin-secret' });
    const c = t.client();
    const { res } = await googleSignIn(c, 'admin-code');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/app');
    const home = await c.get('/app/admin/users');
    assert.equal(home.status, 200);
    const row = t.db.prepare("SELECT * FROM users WHERE email = 'admin@fansided.com'").get();
    assert.match(row.google_refresh_token_enc, /^v1:/);
    assert.ok(!row.google_refresh_token_enc.includes('rt-admin-secret'));
    assert.equal(decrypt(row.google_refresh_token_enc, Buffer.alloc(32, 7)), 'rt-admin-secret');
    assert.equal(row.name, 'Ada Admin'); // filled from Google profile when empty
  });

  test('a sign-in with no refresh token and none stored goes back to Google with prompt=consent', async () => {
    fake.addIdentity('rep-code-1', { email: 'rep@fansided.com', email_verified: true, name: 'Rita' });
    const c = t.client();
    const { res } = await googleSignIn(c, 'rep-code-1');
    assert.equal(res.status, 302);
    const again = new URL(res.headers.get('location'));
    assert.equal(again.searchParams.get('prompt'), 'consent');
    assert.ok(!res.headers.getSetCookie().some((h) => h.startsWith('sid=')));
    // Second round trip returns a refresh token and signs in.
    fake.addIdentity('rep-code-2', { email: 'rep@fansided.com', email_verified: true, name: 'Rita', refresh_token: 'rt-rep' });
    const res2 = await c.get(`/auth/google/callback?code=rep-code-2&state=${again.searchParams.get('state')}`);
    assert.equal(res2.status, 303);
    assert.equal((await c.get('/app')).status, 200);
    // Later sign-ins without a new refresh token keep the stored one and do not force consent.
    fake.addIdentity('rep-code-3', { email: 'rep@fansided.com', email_verified: true, name: 'Rita' });
    const c2 = t.client();
    const { res: res3 } = await googleSignIn(c2, 'rep-code-3');
    assert.equal(res3.status, 303);
  });

  test('AC-13: unknown, inactive, unverified or out-of-domain accounts get no session', async () => {
    const cases = [
      ['stranger-code', { email: 'stranger@fansided.com', email_verified: true, refresh_token: 'x' }],
      ['inactive-code', { email: 'gone@fansided.com', email_verified: true, refresh_token: 'x' }],
      ['unverified-code', { email: 'rep@fansided.com', email_verified: false, refresh_token: 'x' }],
      ['domain-code', { email: 'outsider@gmail.com', email_verified: true, refresh_token: 'x' }],
    ];
    for (const [code, identity] of cases) {
      fake.addIdentity(code, identity);
      const before = count(t.db, 'sessions');
      const c = t.client();
      const { res } = await googleSignIn(c, code);
      assert.equal(res.status, 403, code);
      assert.match(res.text, /Your account isn&#39;t authorised\. Ask an admin\./, code);
      assert.ok(!res.headers.getSetCookie().some((h) => h.startsWith('sid=')), code);
      assert.equal(count(t.db, 'sessions'), before, code);
      assert.equal((await c.get('/app')).status, 302, code);
    }
  });

  test('OAuth state mismatch is refused', async () => {
    fake.addIdentity('state-code', { email: 'rep@fansided.com', email_verified: true, refresh_token: 'x' });
    const c = t.client();
    await c.get('/auth/google');
    const res = await c.get('/auth/google/callback?code=state-code&state=wrong');
    assert.equal(res.status, 400);
    assert.ok(!res.headers.getSetCookie().some((h) => h.startsWith('sid=')));
  });

  test('DEV_LOGIN is off here: /auth/dev does nothing', async () => {
    const c = t.client();
    await c.get('/login');
    const res = await c.post('/auth/dev', { email: 'admin@fansided.com' });
    assert.equal(res.status, 404);
  });
});

test('DEV_LOGIN=1 is refused when NODE_ENV=production', () => {
  assert.throws(
    () => createApp({ env: { NODE_ENV: 'production', DEV_LOGIN: '1', DATA_DIR: '/tmp/never-created', ...GOOGLE_ENV, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), BASE_URL: 'https://x.example.com' } }),
    /DEV_LOGIN=1 is refused/
  );
});

describe('sessions, permissions and CSRF', () => {
  let t;
  let roleId;
  let appId;
  before(async () => {
    t = await startApp();
    makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    makeUser(t.db, { email: 'rep2@fansided.com', name: 'Second Rep' });
    roleId = makeRole(t.db, { title: 'Perm Role' });
    await t.client().apply(roleId, { email: 'cand@example.com', name: 'Cand Idate' });
    appId = t.db.prepare('SELECT id FROM applications ORDER BY id DESC').get().id;
  });
  after(() => t.close());

  test('dev login refuses users who are not active', async () => {
    const c = t.client();
    const res = await c.login('nobody@fansided.com');
    assert.equal(res.status, 403);
    assert.match(res.text, /isn&#39;t authorised/);
    assert.ok(!res.headers.getSetCookie().some((h) => h.startsWith('sid=')));
  });

  test('AC-15: a rep gets 403 on every /app/admin/* route and on candidate delete', async () => {
    const c = t.client();
    await c.login('rep@fansided.com');
    const tpl = t.db.prepare('SELECT id FROM email_templates LIMIT 1').get().id;
    const personId = t.db.prepare('SELECT person_id FROM applications WHERE id = ?').get(appId).person_id;
    const gets = ['/app/admin', '/app/admin/templates', '/app/admin/templates/new', `/app/admin/templates/${tpl}`, '/app/admin/roles', '/app/admin/roles/new', `/app/admin/roles/${roleId}`, '/app/admin/users', '/app/admin/whatever', `/app/people/${personId}/delete`];
    for (const url of gets) assert.equal((await c.get(url)).status, 403, `GET ${url}`);
    await c.get('/app');
    const posts = ['/app/admin/templates', `/app/admin/templates/${tpl}`, `/app/admin/templates/${tpl}/delete`, '/app/admin/roles', `/app/admin/roles/${roleId}`, '/app/admin/users', '/app/admin/users/1/role', '/app/admin/users/1/deactivate', '/app/admin/users/1/reactivate', `/app/people/${personId}/delete`];
    for (const url of posts) assert.equal((await c.post(url, { name: 'x', role: 'rep', title: 'x', vertical: 'x' })).status, 403, `POST ${url}`);
    assert.equal(count(t.db, 'people', 'id = ?', personId), 1);
    assert.equal(count(t.db, 'email_templates', 'id = ?', tpl), 1);
  });

  test('AC-16: internal POST without a valid CSRF token is 403 and changes nothing', async () => {
    const c = t.client();
    await c.login('admin@fansided.com');
    await c.get(`/app/applications/${appId}`);
    const notesBefore = count(t.db, 'notes');
    const eventsBefore = count(t.db, 'application_events');
    for (const csrf of [null, '', 'a'.repeat(64)]) {
      assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'sneaky' }, { csrf })).status, 403);
      assert.equal((await c.post(`/app/applications/${appId}/stage`, { stage: 'reviewing' }, { csrf })).status, 403);
      assert.equal((await c.post('/app/admin/users', { email: 'evil@fansided.com', name: 'Evil', role: 'admin' }, { csrf })).status, 403);
      assert.equal((await c.post('/logout', {}, { csrf })).status, 403);
    }
    assert.equal(count(t.db, 'notes'), notesBefore);
    assert.equal(count(t.db, 'application_events'), eventsBefore);
    assert.equal(t.db.prepare('SELECT stage FROM applications WHERE id = ?').get(appId).stage, 'new');
    assert.equal(count(t.db, 'users', "email = 'evil@fansided.com'"), 0);
    // A token from another session is also refused.
    const other = t.client();
    await other.login('rep@fansided.com');
    const foreign = other.csrf();
    assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'x' }, { csrf: foreign })).status, 403);
    // And the real token works.
    assert.equal((await c.post(`/app/applications/${appId}/notes`, { body: 'legit' })).status, 303);
  });

  test('AC-17: session cookie flags; logout and deactivation kill the old cookie', async () => {
    const c = t.client();
    await c.get('/login');
    const res = await c.post('/auth/dev', { email: 'rep2@fansided.com', next: '/app' });
    const sid = res.headers.getSetCookie().find((h) => h.startsWith('sid='));
    assert.ok(sid);
    assert.match(sid, /HttpOnly/);
    assert.match(sid, /Secure/);
    assert.match(sid, /SameSite=Lax/);
    assert.match(sid, /Path=\//);
    assert.match(sid, /Max-Age=1209600/); // 14 days
    const sidValue = c.jar.get('sid');
    assert.match(sidValue, /^[0-9a-f]{64}$/);
    assert.equal((await c.get('/app')).status, 200);
    assert.equal(count(t.db, 'sessions', 'id = ?', sidValue), 1);

    const logout = await c.post('/logout', {});
    assert.equal(logout.status, 303);
    assert.equal(count(t.db, 'sessions', 'id = ?', sidValue), 0);
    c.jar.set('sid', sidValue); // replay the old cookie
    assert.equal((await c.get('/app')).status, 302);

    // Deactivation deletes sessions.
    const d = t.client();
    await d.login('rep2@fansided.com');
    const old = d.jar.get('sid');
    assert.equal((await d.get('/app')).status, 200);
    const admin = t.client();
    await admin.login('admin@fansided.com');
    await admin.get('/app/admin/users');
    const repId = t.db.prepare("SELECT id FROM users WHERE email = 'rep2@fansided.com'").get().id;
    assert.equal((await admin.post(`/app/admin/users/${repId}/deactivate`, {})).status, 303);
    assert.equal(count(t.db, 'sessions', 'user_id = ?', repId), 0);
    d.jar.set('sid', old);
    assert.equal((await d.get('/app')).status, 302);
    // Expired sessions are refused too.
    const e = t.client();
    await e.login('rep@fansided.com');
    t.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(e.jar.get('sid'));
    assert.equal((await e.get('/app')).status, 302);
  });

  test('internal pages redirect to login when signed out', async () => {
    const c = t.client();
    for (const url of ['/app', `/app/roles/${roleId}`, `/app/applications/${appId}`, '/app/export', '/app/export.csv']) {
      const res = await c.get(url);
      assert.equal(res.status, 302, url);
      assert.match(res.headers.get('location'), /^\/login\?next=/);
    }
    const post = await c.post(`/app/applications/${appId}/notes`, { body: 'x' }, { csrf: null });
    assert.equal(post.status, 302);
    assert.equal(count(t.db, 'notes', "body = 'x'"), 0);
  });
});

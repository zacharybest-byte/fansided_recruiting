'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, TEST_PASSWORD, startApp, makeUser, count } = require('./helpers');
const { sha256Hex } = require('../src/lib/crypto');
const { verifyPassword } = require('../src/lib/password');

const TOKEN_RE = /token=([A-Za-z0-9_-]{43})/;
const sidOf = (c) => c.jar.get('sid');
const GENERIC = /<h1>This link is no longer valid<\/h1>\s*<p>Ask an admin to send you a new link\.<\/p>\s*<div class=\"form-actions\"><a class=\"btn btn-primary btn-block\" href=\"\/login\">Go to sign in<\/a>/;
const NEW_PW = 'a brand new password 1';

// Dump of every table, to prove a secret is stored nowhere.
async function dumpDb(db) {
  const out = [];
  for (const { name } of await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")) out.push(JSON.stringify(await db.all(`SELECT * FROM "${name}"`)));
  return out.join('\n');
}

for (const driver of DRIVERS) {

describe(`[${driver}] invites and reset links`, () => {
  let t;
  let admin;
  const logs = [];
  before(async () => {
    t = await startApp({ driver, log: (m) => logs.push(m) });
    admin = t.client();
    await admin.login('admin@fansided.com');
  });
  after(() => t.close());

  async function invite(email, name = 'New Person', role = 'rep') {
    await admin.get('/app/admin/users');
    return admin.post('/app/admin/users', { email, name, role });
  }
  async function resetLink(userId) {
    await admin.get('/app/admin/users');
    return admin.post(`/app/admin/users/${userId}/reset-link`, {});
  }
  const idOf = async (email) => (await t.db.get('SELECT id FROM users WHERE email = ?', [email])).id;
  const pwHash = async (email) => (await t.db.get('SELECT password_hash FROM users WHERE email = ?', [email])).password_hash;
  async function setPassword(token, password = NEW_PW, confirm = password, client = t.client()) {
    await client.get('/login'); // any page that sets the pre-session CSRF cookie and field
    return client.post('/set-password', { token, password, password_confirm: confirm });
  }

  test('AC-48: adding a user shows the invite link once; only its hash is stored; no sign-in until it is used', async () => {
    const res = await invite('Newbie@FanSided.com', 'Nia Newbie');
    assert.equal(res.status, 200, 'rendered directly, not redirected');
    assert.equal(res.headers.get('location'), null);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const m = /<input type="text" readonly[^>]*value="(http:\/\/localhost\/set-password\?token=([A-Za-z0-9_-]{43}))"/.exec(res.text);
    assert.ok(m, 'link in a read-only input');
    const token = m[2];
    const user = await t.db.get("SELECT * FROM users WHERE email = 'newbie@fansided.com'");
    assert.equal(user.password_hash, null);
    assert.equal(user.name, 'Nia Newbie');
    assert.equal(user.active, 1);
    const row = await t.db.get('SELECT * FROM auth_tokens WHERE user_id = ?', [user.id]);
    assert.equal(row.kind, 'invite');
    assert.equal(row.token_hash, sha256Hex(token));
    assert.equal(row.used_at, null);
    assert.equal(row.created_by_user_id, (await idOf('admin@fansided.com')));
    const days = (new Date(row.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 6.99 && days <= 7, `invite lasts 7 days (${days})`);
    assert.ok(!(await dumpDb(t.db)).includes(token), 'the raw token is stored nowhere');
    assert.ok(!logs.join('\n').includes(token), 'and never logged');
    // Shown once: the users page afterwards has no link and says "Invite pending".
    const again = await admin.get('/app/admin/users');
    assert.doesNotMatch(again.text, /set-password\?token/);
    assert.match(again.text, /Invite pending/);
    // Cannot sign in yet.
    assert.equal((await t.client().login('newbie@fansided.com', NEW_PW)).status, 401);
    // The link shows the account and sets the password.
    const c = t.client();
    const page = await c.get(`/set-password?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /newbie@fansided\.com/);
    assert.match(page.headers.get('cache-control'), /no-store/);
    const set = await c.post('/set-password', { token, password: NEW_PW, password_confirm: NEW_PW });
    assert.equal(set.status, 303);
    assert.equal(set.headers.get('location'), '/login');
    assert.ok(await verifyPassword(NEW_PW, await pwHash('newbie@fansided.com')));
    assert.ok((await t.db.get('SELECT used_at FROM auth_tokens WHERE id = ?', [row.id])).used_at);
    const login = t.client();
    assert.equal((await login.login('newbie@fansided.com', NEW_PW)).status, 303);
    assert.match((await admin.get('/app/admin/users')).text, /Active/);
  });

  test('AC-44: set-password refuses passwords under 12 or over 200 characters and mismatches, and changes nothing', async () => {
    const token = TOKEN_RE.exec((await invite('lengths@fansided.com')).text)[1];
    for (const [pw, confirm] of [['short', 'short'], ['a'.repeat(11), 'a'.repeat(11)], ['a'.repeat(201), 'a'.repeat(201)], [NEW_PW, `${NEW_PW}x`]]) {
      const res = await setPassword(token, pw, confirm);
      assert.equal(res.status, 400);
      assert.match(res.text, /characters|do not match/);
    }
    assert.equal(await pwHash('lengths@fansided.com'), null);
    assert.equal((await t.db.get('SELECT used_at FROM auth_tokens WHERE token_hash = ?', [sha256Hex(token)])).used_at, null);
    assert.equal((await setPassword(token, 'x'.repeat(12))).status, 303); // still usable afterwards, and 12 is fine
  });

  test('AC-49: a link works exactly once; used, expired, superseded, unknown and deactivated-user tokens show one generic page and change nothing', async () => {
    const email = 'once@fansided.com';
    const token = TOKEN_RE.exec((await invite(email)).text)[1];
    assert.equal((await setPassword(token)).status, 303);
    const hash = await pwHash(email);
    const generic = [];
    // used
    const used = await setPassword(token, 'another password 22');
    generic.push(used);
    assert.equal(used.status, 404);
    assert.match(used.text, GENERIC);
    assert.equal(await pwHash(email), hash);
    const usedGet = await t.client().get(`/set-password?token=${token}`);
    generic.push(usedGet);
    // unknown / malformed
    for (const bad of ['A'.repeat(43), 'short', '', "' OR 1=1 --", 'z'.repeat(500)]) {
      const res = await t.client().get(`/set-password?token=${encodeURIComponent(bad)}`);
      assert.equal(res.status, 404, bad);
      generic.push(res);
      const c = t.client();
      await c.get('/login');
      generic.push(await c.post('/set-password', { token: bad, password: NEW_PW, password_confirm: NEW_PW }));
    }
    // expired
    const exp = TOKEN_RE.exec((await invite('expired@fansided.com')).text)[1];
    await t.db.run('UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?', [new Date(Date.now() - 1000).toISOString(), sha256Hex(exp)]);
    generic.push(await setPassword(exp));
    generic.push(await t.client().get(`/set-password?token=${exp}`));
    assert.equal(await pwHash('expired@fansided.com'), null);
    // superseded: a newer link kills the older unused one
    const uid = await idOf('expired@fansided.com');
    const first = TOKEN_RE.exec((await resetLink(uid)).text)[1];
    const second = TOKEN_RE.exec((await resetLink(uid)).text)[1];
    assert.equal(await count(t.db, 'auth_tokens', 'user_id = ? AND used_at IS NULL', uid), 1);
    generic.push(await setPassword(first));
    assert.equal(await pwHash('expired@fansided.com'), null);
    // deactivated user (also: deactivating deletes the unused links)
    await admin.get('/app/admin/users');
    assert.equal((await admin.post(`/app/admin/users/${uid}/deactivate`, {})).status, 303);
    generic.push(await setPassword(second));
    assert.equal(await pwHash('expired@fansided.com'), null);
    assert.equal(await count(t.db, 'auth_tokens', 'user_id = ?', uid), 0);
    // ... and a token that somehow survives deactivation is still refused by the SQL guard.
    const sneaky = 'S'.repeat(43);
    await t.db.run("INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES (?, 'reset', ?, '2999-01-01T00:00:00.000Z', ?)", [uid, sha256Hex(sneaky), new Date().toISOString()]);
    generic.push(await setPassword(sneaky));
    assert.equal(await pwHash('expired@fansided.com'), null);
    for (const res of generic) {
      assert.equal(res.status, 404);
      assert.match(res.text, GENERIC);
    }
    // One generic page: the bodies are identical, no detail about why.
    const bodies = new Set(generic.map((r) => r.text.replace(/name="csrf" value="[^"]*"/g, '')));
    assert.equal(bodies.size, 1);
    assert.doesNotMatch(generic[0].text, /expired|used|superseded|deactivated|unknown/i);
  });

  test('AC-49: two concurrent uses of one link: exactly one wins', async () => {
    for (let round = 0; round < 3; round++) {
      const email = `race${round}@fansided.com`;
      const token = TOKEN_RE.exec((await invite(email)).text)[1];
      const [c1, c2] = [t.client(), t.client()];
      await c1.get(`/set-password?token=${token}`);
      await c2.get(`/set-password?token=${token}`);
      const [a, b] = await Promise.all([
        c1.post('/set-password', { token, password: 'first winner password', password_confirm: 'first winner password' }),
        c2.post('/set-password', { token, password: 'second winner password', password_confirm: 'second winner password' }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [303, 404], `round ${round}`);
      const winner = a.status === 303 ? 'first winner password' : 'second winner password';
      const loser = a.status === 303 ? 'second winner password' : 'first winner password';
      const hash = await pwHash(email);
      assert.ok(await verifyPassword(winner, hash));
      assert.ok(!(await verifyPassword(loser, hash)));
      assert.equal(await count(t.db, 'auth_tokens', 'token_hash = ? AND used_at IS NOT NULL', sha256Hex(token)), 1);
    }
  });

  test('AC-50: an admin reset link sets a new password and kills all of that user\'s sessions; a rep cannot create links', async () => {
    await makeUser(t.db, { email: 'victim@fansided.com', name: 'Vic Tim' });
    const uid = await idOf('victim@fansided.com');
    const s1 = t.client();
    const s2 = t.client();
    await s1.login('victim@fansided.com');
    await s2.login('victim@fansided.com');
    assert.equal(await count(t.db, 'sessions', 'user_id = ?', uid), 2);
    const res = await resetLink(uid);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.text, /Password reset link for victim@fansided\.com/);
    const token = TOKEN_RE.exec(res.text)[1];
    const row = await t.db.get('SELECT * FROM auth_tokens WHERE token_hash = ?', [sha256Hex(token)]);
    assert.equal(row.kind, 'reset');
    const hours = (new Date(row.expires_at) - Date.now()) / 3600000;
    assert.ok(hours > 23.9 && hours <= 24, `reset lasts 24 h (${hours})`);
    // Creating the link alone changes nothing: sessions and the old password still work.
    assert.equal((await s1.get('/app')).status, 200);
    assert.equal((await setPassword(token, 'victims new password')).status, 303);
    assert.equal((await s1.get('/app')).status, 302);
    assert.equal((await s2.get('/app')).status, 302);
    assert.equal(await count(t.db, 'sessions', 'user_id = ?', uid), 0);
    assert.equal((await t.client().login('victim@fansided.com', TEST_PASSWORD)).status, 401);
    assert.equal((await t.client().login('victim@fansided.com', 'victims new password')).status, 303);
    // A deactivated user gets no link.
    await makeUser(t.db, { email: 'inactive@fansided.com', active: 0 });
    const before = await count(t.db, 'auth_tokens');
    await admin.get('/app/admin/users');
    const none = await admin.post(`/app/admin/users/${await idOf('inactive@fansided.com')}/reset-link`, {});
    assert.equal(none.status, 303);
    assert.equal(await count(t.db, 'auth_tokens'), before);
    // A rep cannot.
    const rep = t.client();
    await makeUser(t.db, { email: 'plainrep@fansided.com' });
    await rep.login('plainrep@fansided.com');
    await rep.get('/app');
    const tokensBefore = await count(t.db, 'auth_tokens');
    assert.equal((await rep.post(`/app/admin/users/${uid}/reset-link`, {})).status, 403);
    assert.equal((await rep.post('/app/admin/users', { email: 'x@fansided.com', name: 'X', role: 'admin' })).status, 403);
    assert.equal(await count(t.db, 'auth_tokens'), tokensBefore);
    assert.equal(await count(t.db, 'users', "email = 'x@fansided.com'"), 0);
  });

  test('adding a duplicate email is refused with a field error and creates no link', async () => {
    const before = await count(t.db, 'auth_tokens');
    const res = await invite('rep-dupe@fansided.com');
    assert.equal(res.status, 200);
    const dup = await invite('REP-DUPE@fansided.com');
    assert.equal(dup.status, 400);
    assert.match(dup.text, /already exists/);
    assert.doesNotMatch(dup.text, /set-password\?token/);
    assert.equal(await count(t.db, 'auth_tokens'), before + 1);
  });

  test('a link for a user who has a password is a reset; a pending user gets a new invite (7 days)', async () => {
    const email = 'pending@fansided.com';
    await invite(email);
    const uid = await idOf(email);
    const again = await resetLink(uid);
    assert.match(again.text, /Invite link for pending@fansided\.com/);
    assert.equal((await t.db.get('SELECT kind FROM auth_tokens WHERE user_id = ?', [uid])).kind, 'invite');
  });
});

describe(`[${driver}] AC-51: first-admin setup link`, () => {
  const SETUP_TOKEN = 'setup-token-0123456789-abcdef-QWERTYUIOP';
  const env = { ADMIN_EMAIL: 'Boss@FanSided.com', SETUP_TOKEN };
  const fields = (pw = NEW_PW, confirm = pw, token = SETUP_TOKEN) => ({ token, password: pw, password_confirm: confirm });

  test('wrong or missing token and missing or weak env are all a plain 404', async () => {
    const t = await startApp({ driver, env, admin: false });
    try {
      const c = t.client();
      for (const url of ['/setup', '/setup?token=', '/setup?token=wrong', `/setup?token=${SETUP_TOKEN}x`, `/setup?token=${SETUP_TOKEN.slice(1)}`]) {
        const res = await c.get(url);
        assert.equal(res.status, 404, url);
        assert.doesNotMatch(res.text, /boss@|password/i);
      }
      await c.get('/login');
      assert.equal((await c.post('/setup', fields(NEW_PW, NEW_PW, 'wrong'))).status, 404);
      assert.equal(await count(t.db, 'users'), 0);
    } finally {
      await t.close();
    }
    // Without ADMIN_EMAIL / SETUP_TOKEN (or with a SETUP_TOKEN under 32 characters, or with fewer than 10 distinct ones) the page does not exist.
    for (const e of [{}, { ADMIN_EMAIL: 'boss@fansided.com' }, { SETUP_TOKEN }, { ADMIN_EMAIL: 'boss@fansided.com', SETUP_TOKEN: 'short-token' }, { ADMIN_EMAIL: 'boss@fansided.com', SETUP_TOKEN: 'setup-token-0123456789-abcdef' }, { ADMIN_EMAIL: 'boss@fansided.com', SETUP_TOKEN: 'abab'.repeat(12) }]) {
      const x = await startApp({ driver, env: e, admin: false });
      try {
        assert.equal((await x.client().get(`/setup?token=${e.SETUP_TOKEN || SETUP_TOKEN}`)).status, 404, JSON.stringify(e));
      } finally {
        await x.close();
      }
    }
  });

  test('the right token sets the first admin once, also under two concurrent POSTs; afterwards it is a 404 (GET and POST)', async () => {
    const t = await startApp({ driver, env, admin: false });
    try {
      const [c1, c2] = [t.client(), t.client()];
      const form = await c1.get(`/setup?token=${SETUP_TOKEN}`);
      const csrf1 = c1.csrf();
      assert.equal(form.status, 200);
      assert.match(form.text, /boss@fansided\.com/);
      assert.match(form.headers.get('cache-control'), /no-store/);
      await c2.get(`/setup?token=${SETUP_TOKEN}`);
      const csrf2 = c2.csrf();
      // CSRF and validation failures create nothing.
      assert.equal((await c1.post('/setup', fields(), { csrf: null })).status, 403);
      assert.equal((await c1.post('/setup', fields(), { csrf: 'x' })).status, 403);
      for (const [pw, confirm] of [['short', 'short'], ['a'.repeat(11), 'a'.repeat(11)], ['a'.repeat(201), 'a'.repeat(201)], [NEW_PW, 'different password 12']]) {
        assert.equal((await c1.post('/setup', fields(pw, confirm), { csrf: csrf1 })).status, 400);
      }
      assert.equal(await count(t.db, 'users'), 0);
      // Two racing POSTs with different passwords: exactly one wins.
      const [a, b] = await Promise.all([c1.post('/setup', fields('first password wins'), { csrf: csrf1 }), c2.post('/setup', fields('second password wins'), { csrf: csrf2 })]);
      assert.deepEqual([a.status, b.status].sort(), [303, 404]);
      assert.equal(a.status === 303 ? a.headers.get('location') : b.headers.get('location'), '/login');
      const winner = a.status === 303 ? 'first password wins' : 'second password wins';
      const loser = a.status === 303 ? 'second password wins' : 'first password wins';
      const users = await t.db.all('SELECT * FROM users');
      assert.equal(users.length, 1);
      assert.equal(users[0].email, 'boss@fansided.com');
      assert.equal(users[0].role, 'admin');
      assert.equal(users[0].active, 1);
      assert.ok(await verifyPassword(winner, users[0].password_hash));
      assert.ok(!(await verifyPassword(loser, users[0].password_hash)));
      assert.ok(users[0].password_changed_at);
      // Now dead, for GET and POST, even with the right token.
      assert.equal((await t.client().get(`/setup?token=${SETUP_TOKEN}`)).status, 404);
      const c3 = t.client();
      await c3.get('/login');
      assert.equal((await c3.post('/setup', fields('third password tries'))).status, 404);
      assert.ok(await verifyPassword(winner, (await t.db.get('SELECT password_hash FROM users')).password_hash));
      assert.equal((await t.client().login('boss@fansided.com', winner)).status, 303);
      assert.equal((await t.client().login('boss@fansided.com', loser)).status, 401);
    } finally {
      await t.close();
    }
  });

  test('an invite-pending admin does not block setup; a pre-existing inactive ADMIN_EMAIL row becomes the active admin and loses its sessions', async () => {
    const t = await startApp({ driver, env, admin: false });
    try {
      await makeUser(t.db, { email: 'pending-admin@fansided.com', role: 'admin', password: null });
      const old = await makeUser(t.db, { email: 'boss@fansided.com', role: 'rep', active: 0, name: 'Old Boss' });
      await t.db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h', ?, 'x', '2999-01-01T00:00:00.000Z')", [old]);
      const c = t.client();
      await c.get(`/setup?token=${SETUP_TOKEN}`);
      assert.equal((await c.post('/setup', fields())).status, 303);
      const boss = await t.db.get('SELECT * FROM users WHERE id = ?', [old]);
      assert.equal(boss.role, 'admin');
      assert.equal(boss.active, 1);
      assert.equal(boss.name, 'Old Boss');
      assert.equal(await count(t.db, 'sessions'), 0);
    } finally {
      await t.close();
    }
  });

  test('with an active admin who has a password the setup link is a 404 from the start', async () => {
    const t = await startApp({ driver, env }); // helper creates admin@fansided.com with a password
    try {
      assert.equal((await t.client().get(`/setup?token=${SETUP_TOKEN}`)).status, 404);
      const c = t.client();
      await c.get('/login');
      assert.equal((await c.post('/setup', fields())).status, 404);
      assert.equal(await count(t.db, 'users', "email = 'boss@fansided.com'"), 0);
    } finally {
      await t.close();
    }
  });

  test('setup POSTs are limited to 10 per IP per 15 minutes (and set-password POSTs share the budget)', async () => {
    const t = await startApp({ driver, env, admin: false });
    try {
      const c = t.client({ ip: '192.0.2.77' });
      await c.get(`/setup?token=${SETUP_TOKEN}`);
      const csrf = c.csrf();
      for (let i = 0; i < 10; i++) assert.equal((await c.post('/setup', fields('short', 'short'), { csrf })).status, 400, `post ${i + 1}`);
      const limited = await c.post('/setup', fields(), { csrf });
      assert.equal(limited.status, 429);
      assert.match(limited.text, /Too many attempts/);
      assert.equal(await count(t.db, 'users'), 0);
      assert.equal((await c.post('/set-password', { token: 'x', password: NEW_PW, password_confirm: NEW_PW }, { csrf })).status, 429);
      // F-08: the budget is taken only AFTER the CSRF check: forged POSTs from an IP use none of it.
      const forger = t.client({ ip: '192.0.2.79' });
      await forger.get(`/setup?token=${SETUP_TOKEN}`);
      const realCsrf = forger.csrf();
      for (let i = 0; i < 15; i++) assert.equal((await forger.post('/setup', fields('short', 'short'), { csrf: 'forged' })).status, 403);
      for (let i = 0; i < 10; i++) assert.equal((await forger.post('/setup', fields('short', 'short'), { csrf: realCsrf })).status, 400, 'the honest POSTs still have their whole budget');
      // another IP is not affected; the window expires
      const other = t.client({ ip: '192.0.2.78' });
      await other.get(`/setup?token=${SETUP_TOKEN}`);
      assert.equal((await other.post('/setup', fields())).status, 303);
    } finally {
      await t.close();
    }
  });

  test('F-08: GETs with an invalid token are limited to 30 per IP per 15 minutes; valid tokens do not count; an IP over the limit learns nothing', async () => {
    const t = await startApp({ driver, env, admin: false });
    try {
      const c = t.client({ ip: '192.0.2.90' });
      for (let i = 0; i < 40; i++) assert.equal((await c.get(`/setup?token=${SETUP_TOKEN.slice(1)}${i}`)).status, i < 30 ? 404 : 429, `guess ${i + 1}`);
      const refused = await c.get(`/setup?token=${SETUP_TOKEN}`); // even the right token: refused before it is looked at
      assert.equal(refused.status, 429);
      assert.doesNotMatch(refused.text, /boss@/);
      // /set-password shares the budget; both are DB-backed (a fresh app instance on the same DB still refuses).
      assert.equal((await c.get(`/set-password?token=${'a'.repeat(43)}`)).status, 429);
      const again = await t.restart();
      try {
        assert.equal((await again.client({ ip: '192.0.2.90' }).get(`/setup?token=${SETUP_TOKEN}`)).status, 429);
        // Other addresses are unaffected, and valid-token GETs never use up the budget.
        const ok = again.client({ ip: '192.0.2.91' });
        for (let i = 0; i < 40; i++) assert.equal((await ok.get(`/setup?token=${SETUP_TOKEN}`)).status, 200, `valid ${i + 1}`);
        assert.equal(await count(again.db, 'rate_limits'), 30);
      } finally {
        await again.close();
      }
    } catch (err) {
      await t.close();
      throw err;
    }
  });
});

}

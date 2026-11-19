'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { html, raw, link, escapeHtml } = require('../src/lib/render');
const { csvCell, toCsv } = require('../src/lib/csv');
const { safeEqual, randomToken, sha256Hex, hmacHex } = require('../src/lib/crypto');
const { hashPassword, verifyPassword, validatePassword, dummyHash } = require('../src/lib/password');
const { formatDateTime, zonedMidnightUtc, isValidYmd } = require('../src/lib/time');
const { applyMergeFields, firstName } = require('../src/lib/email');
const { parseCookies, serializeCookie } = require('../src/lib/cookies');
const { loadConfig, resolveBaseUrl, ConfigError } = require('../src/lib/config');
const { notifyNewApplication } = require('../src/lib/notify');
const { reserve, release } = require('../src/lib/ratelimit');
const { rateKey, allowed, record, RETENTION_MS } = require('../src/lib/ratelimit');
const { freshDb } = require('./helpers');
const voltax = require('../src/voltax');

test('html escapes interpolations by default, including nested arrays', () => {
  const v = '<b>"x" & \'y\'</b>';
  assert.equal(String(html`<p>${v}</p>`), '<p>&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;</p>');
  assert.equal(String(html`<ul>${['<a>', html`<li>${'<i>'}</li>`]}</ul>`), '<ul>&lt;a&gt;<li>&lt;i&gt;</li></ul>');
  assert.equal(String(html`${raw('<br>')}${null}${undefined}${false}${0}`), '<br>0');
  assert.equal(escapeHtml('`'), '`');
});

test('link() only links https URLs and always sets rel="noopener noreferrer"', () => {
  assert.match(String(link('https://example.com/a?b=<c>')), /^<a href="https:\/\/example.com\/a\?b=&lt;c&gt;" rel="noopener noreferrer" target="_blank">/);
  assert.equal(String(link('http://example.com/insecure')), 'http://example.com/insecure');
  assert.equal(String(link('javascript:alert(1)')), 'javascript:alert(1)');
  assert.equal(String(link('data:text/html,<x>')), 'data:text/html,&lt;x&gt;');
  assert.equal(String(link('not a url')), 'not a url');
  assert.equal(String(link('')), '');
});

test('CSV quoting (RFC 4180) and formula-injection guard', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  for (const p of ['=', '+', '-', '@']) assert.equal(csvCell(`${p}1+1`), `'${p}1+1`);
  assert.equal(csvCell('=A1,B1'), `"'=A1,B1"`);
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(42), '42');
  assert.equal(toCsv(['a', 'b'], [[1, 'é']]), 'a,b\r\n1,é\r\n');
});

test('time zone helpers', () => {
  assert.equal(formatDateTime('2026-07-01T16:05:00.000Z', 'America/New_York'), '2026-07-01 12:05');
  assert.equal(formatDateTime('2026-01-01T04:59:00.000Z', 'America/New_York'), '2025-12-31 23:59');
  assert.equal(zonedMidnightUtc('2026-01-15', 'America/New_York').toISOString(), '2026-01-15T05:00:00.000Z');
  assert.equal(zonedMidnightUtc('2026-07-15', 'America/New_York').toISOString(), '2026-07-15T04:00:00.000Z');
  assert.equal(zonedMidnightUtc('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z'); // DST day
  assert.equal(zonedMidnightUtc('2026-11-01', 'America/New_York').toISOString(), '2026-11-01T04:00:00.000Z');
  assert.ok(isValidYmd('2026-02-28'));
  assert.ok(!isValidYmd('2026-02-30'));
  assert.ok(!isValidYmd('26-2-3'));
});

test('merge fields', () => {
  const r = applyMergeFields('Hi {{first_name}}, {{ role_title }} from {{rep_name}} {{nope}} {{nope}}', { first_name: 'Ana', role_title: 'NFL', rep_name: 'Riley' });
  assert.equal(r.text, 'Hi Ana, NFL from Riley {{nope}} {{nope}}');
  assert.deepEqual(r.unknown, ['nope']);
  assert.equal(firstName('  Mary Jane Watson '), 'Mary');
  assert.equal(firstName(''), '');
});

test('cookies parse and serialise with secure defaults', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world; a=2; bad'), { a: '1', b: 'hello world' });
  const s = serializeCookie('sid', 'abc', { maxAge: 60 });
  assert.match(s, /^sid=abc; Max-Age=60; Expires=.*; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
});

test('config: reads exactly the documented variables; production rules; webhook and base URL', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), (e) => e instanceof ConfigError && e.missing.join() === 'SESSION_SECRET,TURSO_DATABASE_URL,TURSO_AUTH_TOKEN');
  assert.throws(() => loadConfig({ TURSO_DATABASE_URL: 'libsql://x.turso.io' }), (e) => e.missing.join() === 'TURSO_AUTH_TOKEN');
  const dev = loadConfig({});
  assert.equal(dev.production, false);
  assert.equal(dev.timezone, 'America/New_York');
  assert.equal(dev.port, 3000);
  assert.ok(dev.warnings.some((w) => /SESSION_SECRET/.test(w)));
  // Removed variables are ignored, not read.
  const ignored = loadConfig({ DEV_LOGIN: '1', EMAIL_MODE: 'gmail', APP_TIMEZONE: 'Mars/Base', GOOGLE_CLIENT_ID: 'x', TOKEN_ENCRYPTION_KEY: 'bad', ADMIN_EMAILS: 'a@b.c', ALLOWED_EMAIL_DOMAINS: 'x.com', DATA_DIR: '/nonexistent', MAX_UPLOAD_MB: '-1', TRUST_PROXY: '3', QUIET: '1' });
  assert.equal(ignored.timezone, 'America/New_York');
  assert.notEqual(ignored.dataDir, '/nonexistent');
  assert.equal(ignored.adminEmail, '');
  // setup variables
  assert.equal(loadConfig({ ADMIN_EMAIL: ' Boss@FanSided.com ', SETUP_TOKEN: 'x'.repeat(20) }).adminEmail, 'boss@fansided.com');
  const short = loadConfig({ ADMIN_EMAIL: 'boss@fansided.com', SETUP_TOKEN: 'x'.repeat(19) });
  assert.equal(short.setupToken, '');
  assert.ok(short.warnings.some((w) => /SETUP_TOKEN/.test(w)));
  // webhook must be https
  assert.equal(loadConfig({ NOTIFY_WEBHOOK_URL: 'https://hooks.example.com/x?k=v' }).webhookUrl, 'https://hooks.example.com/x?k=v');
  for (const bad of ['http://hooks.example.com/x', 'ftp://x', 'nonsense', 'javascript:alert(1)']) {
    const c = loadConfig({ NOTIFY_WEBHOOK_URL: bad });
    assert.equal(c.webhookUrl, '');
    assert.ok(c.warnings.some((w) => /NOTIFY_WEBHOOK_URL/.test(w)));
    assert.ok(!c.warnings.join().includes(bad), 'the URL itself is not logged');
  }
  // base URL: BASE_URL, else VERCEL_PROJECT_PRODUCTION_URL, else VERCEL_URL, else the request host (not in production)
  const prod = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(32), TURSO_DATABASE_URL: 'libsql://a.turso.io', TURSO_AUTH_TOKEN: 't' };
  assert.equal(loadConfig({ ...prod, BASE_URL: 'https://recruit.example.com/', VERCEL_URL: 'v.vercel.app' }).baseUrl, 'https://recruit.example.com');
  assert.equal(loadConfig({ ...prod, VERCEL_PROJECT_PRODUCTION_URL: 'recruit.vercel.app', VERCEL_URL: 'v-abc.vercel.app' }).baseUrl, 'https://recruit.vercel.app');
  assert.equal(loadConfig({ ...prod, VERCEL_URL: 'v-abc.vercel.app' }).baseUrl, 'https://v-abc.vercel.app');
  assert.equal(loadConfig({ ...prod, BASE_URL: 'not a url', VERCEL_URL: 'v.vercel.app' }).baseUrl, 'https://v.vercel.app');
  const none = loadConfig(prod);
  assert.equal(none.baseUrl, '');
  assert.equal(resolveBaseUrl(none, { headers: { host: 'evil.example' } }), '', 'never from the Host header in production');
  const devCfg = loadConfig({});
  assert.equal(resolveBaseUrl(devCfg, { headers: { host: 'localhost:4000' } }), 'http://localhost:4000');
  assert.equal(resolveBaseUrl(devCfg, { headers: { host: 'bad host/<x>' } }), 'http://localhost:3000');
  assert.equal(resolveBaseUrl({ ...devCfg, baseUrl: 'https://x.example' }, { headers: { host: 'other' } }), 'https://x.example');
});

test('passwords: scrypt N=32768 r=8 p=1, per-user salt, parameters parsed from the string, constant-time compare', async () => {
  const h1 = await hashPassword('correct horse battery');
  const h2 = await hashPassword('correct horse battery');
  assert.notEqual(h1, h2);
  const [scheme, n, r, p, salt, key] = h1.split('$');
  assert.deepEqual([scheme, n, r, p], ['scrypt', '32768', '8', '1']);
  assert.equal(Buffer.from(salt, 'base64').length, 16);
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.ok(await verifyPassword('correct horse battery', h1));
  assert.ok(!(await verifyPassword('correct horse batterz', h1)));
  assert.ok(!(await verifyPassword('', h1)));
  // verify uses the parameters in the stored string (an old hash with other parameters still verifies)
  const salt8 = Buffer.alloc(16, 1);
  const old = `scrypt$16384$8$1$${salt8.toString('base64')}$${crypto.scryptSync('pw-old-params-1', salt8, 32, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  assert.ok(await verifyPassword('pw-old-params-1', old));
  // malformed or hostile stored values never match and never throw or allocate gigabytes
  for (const bad of ['', null, undefined, 'plain', 'scrypt$1$2', 'bcrypt$32768$8$1$AA==$AA==', `scrypt$${2 ** 30}$8$1$${salt}$${key}`, `scrypt$32768$999$1$${salt}$${key}`, `scrypt$3$8$1$${salt}$${key}`, `scrypt$32768$8$1$$`]) {
    assert.equal(await verifyPassword('anything', bad), false, String(bad));
  }
  assert.equal(validatePassword('a'.repeat(11)) !== null, true);
  assert.equal(validatePassword('a'.repeat(12)), null);
  assert.equal(validatePassword('a'.repeat(200)), null);
  assert.notEqual(validatePassword('a'.repeat(201)), null);
  assert.notEqual(validatePassword(undefined), null);
  assert.notEqual(validatePassword(['a'.repeat(12)]), null);
  // dummy hash: a real, verifiable-format hash that no password matches; cached
  const d = await dummyHash();
  assert.match(d, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await dummyHash(), d);
  assert.ok(!(await verifyPassword('', d)));
});

test('crypto helpers: safeEqual is exact and never matches empty values; tokens are 43-char base64url; hashes are hex', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
  assert.ok(!safeEqual('', ''));
  assert.ok(!safeEqual(undefined, undefined));
  assert.ok(!safeEqual('abc', undefined));
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(randomToken(), randomToken());
  assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/);
  assert.notEqual(hmacHex('k1', 'v'), hmacHex('k2', 'v'));
});

test('notify: posts {text} with role title and link only; non-2xx, errors and timeouts are logged by id and swallowed', async () => {
  const calls = [];
  const logs = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const args = { webhookUrl: 'https://hooks.example.com/x', log: (m) => logs.push(m), roleTitle: 'Bears Writer', applicationId: 42, baseUrl: 'https://recruit.example.com' };
  assert.equal(await notifyNewApplication({ ...args, fetchImpl: ok }), true);
  assert.equal(calls[0].url, 'https://hooks.example.com/x');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'New application for Bears Writer: https://recruit.example.com/app/applications/42' });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(await notifyNewApplication({ ...args, webhookUrl: '', fetchImpl: ok }), false);
  assert.equal(calls.length, 1);
  assert.equal(await notifyNewApplication({ ...args, fetchImpl: async () => ({ ok: false, status: 500 }) }), false);
  assert.equal(await notifyNewApplication({ ...args, fetchImpl: async () => { throw new Error('boom https://hooks.example.com/secret'); } }), false);
  assert.deepEqual(logs, ['[webhook] failed application=42', '[webhook] failed application=42']);
});

test('rate limiter (database): 10 recorded hits per window per key; checking does not record', async () => {
  const f = await freshDb('sqlite');
  try {
    const key = rateKey('s3cret', 'apply', '203.0.113.9');
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(key, rateKey('other-secret', 'apply', '203.0.113.9'));
    assert.notEqual(key, rateKey('s3cret', 'login', '203.0.113.9'));
    for (let i = 0; i < 50; i++) assert.ok(await allowed(f.db, key, 10, 3600000)); // checks alone never use up the limit
    for (let i = 0; i < 10; i++) {
      assert.ok(await allowed(f.db, key, 10, 3600000));
      await record(f.db, key);
    }
    assert.ok(!(await allowed(f.db, key, 10, 3600000)));
    assert.ok(await allowed(f.db, rateKey('s3cret', 'apply', 'other'), 10, 3600000));
    // The window moves on: hits from an hour and a bit ago no longer count, and old rows are pruned.
    await f.db.run('UPDATE rate_limits SET at = ?', [new Date(Date.now() - 3600000 - 5000).toISOString()]);
    assert.ok(await allowed(f.db, key, 10, 3600000));
    await f.db.run('UPDATE rate_limits SET at = ?', [new Date(Date.now() - RETENTION_MS - 5000).toISOString()]);
    await record(f.db, key);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM rate_limits')).n, 1);
    // Neither the raw key value nor the secret is stored.
    assert.doesNotMatch(JSON.stringify(await f.db.all('SELECT * FROM rate_limits')), /203\.0\.113|s3cret/);
  } finally {
    await f.close();
  }
});

test('rate limiter reserve(): the guarded INSERT lets only `limit` of a parallel burst through; release() frees the hits of a success', async () => {
  const f = await freshDb('sqlite');
  try {
    const key = rateKey('s3cret', 'login-email', 'a@b.example');
    const spec = { key, limit: 5, windowMs: 900000 };
    const results = await Promise.all(Array.from({ length: 12 }, () => reserve(f.db, [spec])));
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM rate_limits')).n, 5);
    const two = await reserve(f.db, [{ ...spec, limit: 100 }, { key: rateKey('s3cret', 'login-ip', '1.2.3.4'), limit: 1, windowMs: 900000 }, { key: rateKey('s3cret', 'login-ip', '1.2.3.4'), limit: 1, windowMs: 900000 }]);
    assert.equal(two.ok, false, 'one refused key makes the whole reservation not ok');
    // Ordered: a spec is only recorded when the specs before it were (so an IP over its limit adds no email keys).
    await f.db.run('DELETE FROM rate_limits');
    const ipKey = rateKey('s3cret', 'login-ip', '1.2.3.4');
    await reserve(f.db, [{ key: ipKey, limit: 1, windowMs: 900000 }]);
    await new Promise((r) => setTimeout(r, 3)); // distinct milliseconds, so the test is deterministic
    const blocked = await reserve(f.db, [{ key: ipKey, limit: 1, windowMs: 900000 }, spec]);
    assert.equal(blocked.ok, false);
    assert.deepEqual(blocked.keys, []);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?', [key])).n, 0);
    await f.db.run('DELETE FROM rate_limits');
    const r = await reserve(f.db, [spec]);
    assert.equal(r.ok, true);
    await release(f.db, r);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM rate_limits')).n, 0);
  } finally {
    await f.close();
  }
});

test('voltax.createUser is a stub that returns not_configured', async () => {
  assert.deepEqual(await voltax.createUser({ email: 'a@b.c' }, { id: 1 }), { status: 'not_configured' });
});

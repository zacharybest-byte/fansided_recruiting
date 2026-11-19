'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { html, raw, link, escapeHtml } = require('../src/lib/render');
const { csvCell, toCsv } = require('../src/lib/csv');
const { parseMultipart } = require('../src/lib/multipart');
const { encrypt, decrypt, safeEqual } = require('../src/lib/crypto');
const { formatDateTime, zonedMidnightUtc, isValidYmd } = require('../src/lib/time');
const { applyMergeFields, firstName, buildRfc2822 } = require('../src/lib/email');
const { parseCookies, serializeCookie } = require('../src/lib/cookies');
const { loadConfig } = require('../src/lib/config');
const { createGoogle } = require('../src/lib/google');
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

test('link() only links http(s) URLs', () => {
  assert.match(String(link('https://example.com/a?b=<c>')), /^<a href="https:\/\/example.com\/a\?b=&lt;c&gt;" rel="noopener noreferrer nofollow"/);
  assert.equal(String(link('javascript:alert(1)')), 'javascript:alert(1)');
  assert.equal(String(link('data:text/html,<x>')), 'data:text/html,&lt;x&gt;');
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

test('multipart parser handles fields, repeated fields, binary files and odd filenames', () => {
  const boundary = '----x1234';
  const bin = Buffer.from([0, 1, 2, 0x0d, 0x0a, 0x2d, 0x2d, 255, 254]); // includes CRLF--
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nJosé Ñ\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="tag"\r\n\r\na\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="tag"\r\n\r\nb\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="my \\"cv\\".pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    bin,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="empty"; filename=""\r\n\r\n\r\n`),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const { fields, files } = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.deepEqual(fields.get('name'), ['José Ñ']);
  assert.deepEqual(fields.get('tag'), ['a', 'b']);
  assert.equal(files.length, 2);
  assert.equal(files[0].filename, 'my "cv".pdf');
  assert.equal(files[0].contentType, 'application/pdf');
  assert.ok(files[0].data.equals(bin));
  assert.equal(files[1].filename, '');
  assert.throws(() => parseMultipart(Buffer.from('garbage'), 'multipart/form-data; boundary=zz'));
  assert.throws(() => parseMultipart(body, 'multipart/form-data'));
});

test('AES-256-GCM token encryption round-trips and detects tampering', () => {
  const key = crypto.randomBytes(32);
  const enc = encrypt('1//refresh-token', key);
  assert.match(enc, /^v1:/);
  assert.notEqual(encrypt('1//refresh-token', key), enc); // random IV
  assert.equal(decrypt(enc, key), '1//refresh-token');
  assert.throws(() => decrypt(enc, crypto.randomBytes(32)));
  const buf = Buffer.from(enc.slice(3), 'base64');
  buf[buf.length - 1] ^= 1;
  assert.throws(() => decrypt(`v1:${buf.toString('base64')}`, key));
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('', ''));
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

test('RFC 2822 message: CRLF, encoded UTF-8 subject, base64 body, no header injection', () => {
  const msg = buildRfc2822({ fromName: 'Rïley Rep', fromEmail: 'r@fansided.com', to: 'x@example.com\r\nBcc: evil@example.com', subject: 'Hé\r\nBcc: evil@example.com', body: 'Line 1\nLine 2' });
  const [head, body] = msg.split('\r\n\r\n');
  const lines = head.split('\r\n');
  assert.ok(!lines.some((l) => /^Bcc:/i.test(l)));
  assert.match(lines[0], /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <r@fansided.com>$/);
  const subj = lines.find((l) => l.startsWith('Subject: ')).slice(9);
  assert.equal(Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(subj)[1], 'base64').toString(), 'Hé Bcc: evil@example.com');
  assert.ok(lines.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.ok(lines.includes('Content-Transfer-Encoding: base64'));
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), 'Line 1\r\nLine 2');
});

test('Google authorization URL and prompt=consent', () => {
  const g = createGoogle({ clientId: 'cid', clientSecret: 's', redirectUri: 'https://r.example.com/cb' });
  const u = new URL(g.authorizationUrl({ state: 'st' }));
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('prompt'), null);
  assert.equal(new URL(g.authorizationUrl({ state: 'st', forceConsent: true })).searchParams.get('prompt'), 'consent');
});

test('cookies parse and serialise with secure defaults', () => {
  assert.deepEqual(parseCookies('a=1; b=hello%20world; a=2; bad'), { a: '1', b: 'hello world' });
  const s = serializeCookie('sid', 'abc', { maxAge: 60 });
  assert.match(s, /^sid=abc; Max-Age=60; Expires=.*; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
});

test('config: production requires secrets and refuses DEV_LOGIN', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /TOKEN_ENCRYPTION_KEY/);
  const key = Buffer.alloc(32, 1).toString('base64');
  assert.throws(() => loadConfig({ NODE_ENV: 'production', TOKEN_ENCRYPTION_KEY: key }), /GOOGLE_CLIENT_ID/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DEV_LOGIN: '1', TOKEN_ENCRYPTION_KEY: key }), /DEV_LOGIN/);
  assert.throws(() => loadConfig({ TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=' }), /32 bytes/);
  assert.throws(() => loadConfig({ APP_TIMEZONE: 'Mars/Base' }), /time zone/);
  const c = loadConfig({ ALLOWED_EMAIL_DOMAINS: 'FanSided.com, minutemedia.com', MAX_UPLOAD_MB: '10' });
  assert.deepEqual(c.allowedEmailDomains, ['fansided.com', 'minutemedia.com']);
  assert.equal(c.maxBodyBytes, 11 * 1024 * 1024);
  assert.equal(c.timezone, 'America/New_York');
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

test('voltax.createUser is a stub that returns not_configured', async () => {
  assert.deepEqual(await voltax.createUser({ email: 'a@b.c' }, { id: 1 }), { status: 'not_configured' });
});

'use strict';
// Brand kit: logo asset, header markup, font wiring, no yellow left.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, DRIVERS } = require('./helpers');

const pub = (f) => path.join(__dirname, '..', 'public', f);

test('logo.png is a small 96px-tall PNG in the source aspect ratio (6906x1800)', () => {
  const buf = fs.readFileSync(pub('logo.png'));
  assert.strictEqual(buf.subarray(1, 4).toString(), 'PNG');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.strictEqual(h, 96);
  assert.strictEqual(w, Math.round((6906 * 96) / 1800));
  assert.ok(buf.length < 25 * 1024, `logo is ${buf.length} bytes`);
});

test('stylesheet: brand tokens, font wiring and no yellow', () => {
  const css = fs.readFileSync(pub('style.css'), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const v of ['--brand: #062f4d', '--brand-2: #5a97c1', '--ink: #111111', '--field: #f6f6f6', '--accent: var(--brand-2)']) assert.ok(css.includes(v), v);
  assert.doesNotMatch(css, /ffd60a|yellow/i);
  assert.doesNotMatch(rules, /ffd60a|yellow/i);
  assert.match(css, /@font-face \{ font-family: "Public Sans";[^}]*font-display: swap;[^}]*local\("Public Sans Black"\)[^}]*PublicSans-Black\.woff2[^}]*PublicSans-Black\.ttf/);
  assert.match(css, /@font-face \{ font-family: "Public Sans";[^}]*local\("Public Sans Medium"\)[^}]*PublicSans-Medium\.woff2[^}]*PublicSans-Medium\.ttf/);
  assert.match(css, /--font-head: "Public Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif/);
  assert.doesNotMatch(rules, /condensed|Arial Narrow|font-stretch/i);
});

for (const driver of DRIVERS) {
  test(`[${driver}] brand: logo route headers, masthead and auth logo`, async () => {
    const t = await startApp({ driver });
    try {
    const client = t.client();
    const res = await client.get('/public/logo.png');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('cache-control'), 'public, max-age=300');
    const home = await client.get('/');
    assert.match(home.text, /<header class="masthead masthead-public">\s*<div class="masthead-inner">\s*<a href="\/" class="wordmark"><img class="logo" src="\/public\/logo\.png" width="368" height="96" alt="FanSided"><\/a>/);
    const login = await client.get('/login');
    assert.match(login.text, /auth-wordmark"><img class="logo" src="\/public\/logo\.png" width="368" height="96" alt="FanSided">/);
    const missing = await client.get('/public/fonts/PublicSans-Black.woff2');
    assert.ok([200, 404].includes(missing.status));
    } finally {
      await t.close();
    }
  });
}

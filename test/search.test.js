'use strict';
// Candidates search: GET /app/candidates?q=&page=
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, makeUser, makeRole } = require('./helpers');
const { nowIso } = require('../src/lib/db');

async function addPerson(db, roleId, name, email, appliedAt = nowIso(), stage = 'new') {
  const now = nowIso();
  const p = await db.run('INSERT INTO people (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [email, name, now, now]);
  const a = await db.run('INSERT INTO applications (person_id, role_id, stage, applied_at, stage_changed_at) VALUES (?, ?, ?, ?, ?)', [p.lastInsertRowid, roleId, stage, appliedAt, appliedAt]);
  return a.lastInsertRowid;
}

const rowsOf = (text) => [...text.matchAll(/<a href="\/app\/applications\/(\d+)"><strong>([^<]*)<\/strong>/g)].map((m) => ({ id: Number(m[1]), name: m[2] }));

for (const driver of DRIVERS) describe(`[${driver}] candidates search`, () => {
  let t;
  let admin;
  let roleId;
  before(async () => {
    t = await startApp({ driver });
    await makeUser(t.db, { email: 'rep@fansided.com', name: 'Rita Rep' });
    roleId = await makeRole(t.db, { title: 'Search Role', site: 'Search Site' });
    await addPerson(t.db, roleId, 'Maria Gonzalez', 'maria.g@example.com', '2026-11-01T10:00:00.000Z', 'trial');
    await addPerson(t.db, roleId, 'Marcus Bennett', 'mb@example.org', '2026-11-02T10:00:00.000Z');
    await addPerson(t.db, roleId, '100% Real', 'percent@example.com', '2026-11-03T10:00:00.000Z');
    await addPerson(t.db, roleId, 'Under_score Person', 'under@example.com', '2026-11-04T10:00:00.000Z');
    await addPerson(t.db, roleId, 'Underscore Neighbour', 'neighbour@example.com', '2026-11-05T10:00:00.000Z');
    admin = t.client();
    await admin.login('admin@fansided.com');
  });
  after(() => t.close());

  test('finds by partial name, case-insensitively, with role, stage and a link to the application', async () => {
    const res = await admin.get('/app/candidates?q=ARI');
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(res.text).map((r) => r.name), ['Maria Gonzalez']);
    assert.match(res.text, /Search Role/);
    assert.match(res.text, /stage-badge stage-trial">Trial</);
    assert.match(res.text, /Nov 1, 2026/);
  });

  test('finds by email', async () => {
    const res = await admin.get('/app/candidates?q=example.org');
    assert.deepEqual(rowsOf(res.text).map((r) => r.name), ['Marcus Bennett']);
  });

  test('% and _ are literal characters, not wildcards', async () => {
    assert.deepEqual(rowsOf((await admin.get('/app/candidates?q=%25')).text).map((r) => r.name), ['100% Real']);
    assert.deepEqual(rowsOf((await admin.get('/app/candidates?q=r_s')).text).map((r) => r.name), ['Under_score Person']);
    const wild = await admin.get('/app/candidates?q=' + encodeURIComponent('M%s'));
    assert.deepEqual(rowsOf(wild.text), []);
    assert.match(wild.text, /No candidates match/);
  });

  test('SQL-looking input is data', async () => {
    for (const q of ["' OR 1=1 --", "'; DROP TABLE people; --", '\\', "x' UNION SELECT 1 --"]) {
      const res = await admin.get('/app/candidates?q=' + encodeURIComponent(q));
      assert.equal(res.status, 200, q);
      assert.deepEqual(rowsOf(res.text), [], q);
    }
    assert.equal((await t.db.get('SELECT COUNT(*) AS n FROM people')).n, 5);
  });

  test('an XSS payload in q is escaped everywhere it is echoed', async () => {
    const payload = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const res = await admin.get('/app/candidates?q=' + encodeURIComponent(payload));
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /<script>alert/);
    assert.doesNotMatch(res.text, /<img src=x/);
    assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test('an empty q lists the most recent applications first; a rep may use it', async () => {
    const rep = t.client();
    await rep.login('rep@fansided.com');
    const res = await rep.get('/app/candidates');
    assert.equal(res.status, 200);
    assert.deepEqual(rowsOf(res.text).map((r) => r.name), ['Underscore Neighbour', 'Under_score Person', '100% Real', 'Marcus Bennett', 'Maria Gonzalez']);
    assert.match(res.text, /Most recent applications/);
  });

  test('signed-out visitors are redirected to sign in', async () => {
    const res = await t.client().get('/app/candidates?q=maria');
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/login/);
  });

  test('pagination: 50 per page with previous and next links that keep q', async () => {
    const t2 = await startApp({ driver });
    try {
      const role = await makeRole(t2.db, { title: 'Bulk' });
      for (let i = 0; i < 120; i++) {
        const at = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
        await addPerson(t2.db, role, `Bulk Person ${String(i).padStart(3, '0')}`, `bulk${i}@example.com`, at);
      }
      const c = t2.client();
      await c.login('admin@fansided.com');
      const p1 = await c.get('/app/candidates?q=bulk');
      assert.equal(rowsOf(p1.text).length, 50);
      assert.equal(rowsOf(p1.text)[0].name, 'Bulk Person 119');
      assert.match(p1.text, /href="\/app\/candidates\?q=bulk&amp;page=2"/);
      assert.doesNotMatch(p1.text, /pager-prev/);
      const p2 = await c.get('/app/candidates?q=bulk&page=2');
      assert.equal(rowsOf(p2.text).length, 50);
      assert.equal(rowsOf(p2.text)[0].name, 'Bulk Person 069');
      assert.match(p2.text, /pager-prev[^>]*href="\/app\/candidates\?q=bulk"/);
      assert.match(p2.text, /pager-next/);
      const p3 = await c.get('/app/candidates?q=bulk&page=3');
      assert.equal(rowsOf(p3.text).length, 20);
      assert.doesNotMatch(p3.text, /pager-next/);
      assert.equal(rowsOf((await c.get('/app/candidates?q=bulk&page=abc')).text).length, 50); // junk page falls back to 1
    } finally {
      await t2.close();
    }
  });
});

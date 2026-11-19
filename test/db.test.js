'use strict';
// Database layer: both drivers, the Turso HTTP wire format, atomic batches, migrations, DB-backed rate limits.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DRIVERS, startApp, freshDb, makeUser, makeRole, lastApplication, count } = require('./helpers');
const { startFakeTurso } = require('./fake-turso');
const { createApp } = require('../src/app');
const { createTursoDb, pipelineUrl } = require('../src/lib/db/turso');
const { MIGRATIONS } = require('../src/lib/db');

const ROOT = path.join(__dirname, '..');

async function post(fake, body, { token = fake.token } = {}) {
  const res = await fetch(`${fake.url}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const exec = (sql, args) => ({ type: 'execute', stmt: args ? { sql, args } : { sql } });

// ---------------------------------------------------------------------------------------------
// AC-36 / AC-37: the Turso driver and the fake
// ---------------------------------------------------------------------------------------------
describe('AC-36: both drivers', () => {
  test('the app runs on the sqlite driver and on the turso driver (every integration suite loops over DRIVERS)', async () => {
    assert.deepEqual(DRIVERS, ['sqlite', 'turso']);
    const s = await startApp({ driver: 'sqlite' });
    const t = await startApp({ driver: 'turso' });
    try {
      assert.equal(s.db.driver, 'sqlite');
      assert.equal(t.db.driver, 'turso');
      for (const x of [s, t]) assert.equal((await x.client().get('/')).status, 200);
      assert.ok(t.fake.requests.length > 0);
      assert.ok(t.fake.requests.every((r) => r.method === 'POST' && r.path === '/v2/pipeline'));
    } finally {
      await s.close();
      await t.close();
    }
  });

  test('node:sqlite is never loaded when the Turso driver is selected', () => {
    const script = `
      const { createApp } = require('./src/app');
      createApp({ env: { TURSO_DATABASE_URL: 'http://127.0.0.1:1', TURSO_AUTH_TOKEN: 'x' }, log: () => {} });
      console.log(process.moduleLoadList.filter((m) => /sqlite/i.test(m)).length);`;
    const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(out.trim(), '0');
  });
});

describe('AC-37: Turso HTTP driver', () => {
  test('sends POST /v2/pipeline with the Bearer token, typed args and a trailing close, and no baton', async () => {
    const fake = await startFakeTurso({ token: 'tok-123' });
    const db = createTursoDb({ url: fake.url, token: 'tok-123' });
    try {
      await db.run('CREATE TABLE t (i INTEGER, f REAL, s TEXT, n TEXT, b BLOB)');
      fake.reset();
      await db.run('INSERT INTO t (i, f, s, n, b) VALUES (?, ?, ?, ?, ?)', [42, 2.5, 'héllo', null, Buffer.from([1, 2, 3])]);
      const req = fake.requests.at(-1);
      assert.equal(req.method, 'POST');
      assert.equal(req.path, '/v2/pipeline');
      assert.equal(req.authorization, 'Bearer tok-123');
      assert.match(req.contentType, /application\/json/);
      assert.equal(req.body.baton, undefined);
      assert.equal(req.body.requests.length, 2);
      assert.deepEqual(req.body.requests[0].stmt.args, [
        { type: 'integer', value: '42' },
        { type: 'float', value: 2.5 },
        { type: 'text', value: 'héllo' },
        { type: 'null' },
        { type: 'blob', base64: 'AQID' },
      ]);
      assert.deepEqual(req.body.requests[1], { type: 'close' });
      // bigint and booleans
      await db.run('INSERT INTO t (i, s) VALUES (?, ?)', [9007199254740993n, true]);
      assert.deepEqual(fake.requests.at(-1).body.requests[0].stmt.args, [{ type: 'integer', value: '9007199254740993' }, { type: 'integer', value: '1' }]);
      // every pipeline (reads, writes, batches) ends with close
      await db.get('SELECT 1 AS x');
      await db.all('SELECT * FROM t');
      await db.batch([{ sql: 'INSERT INTO t (i) VALUES (?)', args: [1] }]);
      for (const r of fake.requests) assert.deepEqual(r.body.requests.at(-1), { type: 'close' });
    } finally {
      await fake.close();
    }
  });

  test('maps integer, float, text, null and blob results to JS values; run() returns Numbers', async () => {
    const fake = await startFakeTurso();
    const db = createTursoDb({ url: fake.url, token: fake.token });
    try {
      await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, i INTEGER, f REAL, s TEXT, n TEXT, b BLOB)');
      const r = await db.run('INSERT INTO t (i, f, s, n, b) VALUES (?, ?, ?, ?, ?)', [7, 0.5, 'x', null, Buffer.from('hi')]);
      assert.deepEqual(r, { changes: 1, lastInsertRowid: 1 });
      assert.equal(typeof r.lastInsertRowid, 'number');
      const row = await db.get('SELECT * FROM t WHERE id = ?', [1]);
      assert.deepEqual(row, { id: 1, i: 7, f: 0.5, s: 'x', n: null, b: Buffer.from('hi') });
      assert.equal(Object.getPrototypeOf(row), Object.prototype);
      assert.equal((await db.get('SELECT * FROM t WHERE id = ?', [99])), undefined);
      assert.deepEqual(await db.all('SELECT id FROM t WHERE id = ?', [99]), []);
      await db.run('INSERT INTO t (i) VALUES (?)', [9007199254740993n]);
      assert.equal((await db.get('SELECT i FROM t WHERE id = 2')).i, 9007199254740993n); // beyond 2^53: BigInt, not a wrong Number
      assert.deepEqual(await db.run('UPDATE t SET s = ? WHERE id = ?', ['y', 1]), { changes: 1, lastInsertRowid: 0 });
    } finally {
      await fake.close();
    }
  });

  test('an error result, a non-2xx status, a network failure and a timeout all throw, and never leak the token', async () => {
    const fake = await startFakeTurso({ token: 'SECRET-TOKEN-xyz' });
    try {
      const db = createTursoDb({ url: fake.url, token: 'SECRET-TOKEN-xyz' });
      // error result (bad SQL): the server's message is kept, the token is not in it
      await assert.rejects(db.run('SELECT * FROM missing_table'), (e) => /no such table/.test(e.message) && !e.message.includes('SECRET-TOKEN-xyz') && !JSON.stringify(e).includes('SECRET'));
      await assert.rejects(db.batch([{ sql: 'SELECT * FROM missing_table' }]), /no such table/);
      // wrong token: 401
      const bad = createTursoDb({ url: fake.url, token: 'WRONG-TOKEN-abc' });
      await assert.rejects(bad.get('SELECT 1'), (e) => /HTTP 401/.test(e.message) && !e.message.includes('WRONG-TOKEN-abc') && !e.message.includes('SECRET'));
    } finally {
      await fake.close();
    }
    const echo = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
    const leaky = createTursoDb({ url: 'https://db.example.turso.io', token: 'SECRET-TOKEN-xyz', fetchImpl: echo(500, { error: 'boom SECRET-TOKEN-xyz boom' }) });
    await assert.rejects(leaky.get('SELECT 1'), (e) => /HTTP 500/.test(e.message) && !e.message.includes('SECRET-TOKEN-xyz'));
    const net = createTursoDb({
      url: 'https://db.example.turso.io',
      token: 'SECRET-TOKEN-xyz',
      fetchImpl: async () => {
        throw Object.assign(new TypeError('fetch failed Bearer SECRET-TOKEN-xyz'), { cause: { code: 'ECONNREFUSED' } });
      },
    });
    await assert.rejects(net.get('SELECT 1'), (e) => /network error \(ECONNREFUSED\)/.test(e.message) && !e.message.includes('SECRET'));
    const hang = createTursoDb({
      url: 'https://db.example.turso.io',
      token: 'SECRET-TOKEN-xyz',
      timeoutMs: 30,
      // AbortSignal.timeout() timers are unref'd, so keep the event loop alive while this fake request "hangs".
      fetchImpl: (url, { signal }) =>
        new Promise((resolve, reject) => {
          const keepAlive = setTimeout(() => {}, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          });
        }),
    });
    await assert.rejects(hang.get('SELECT 1'), /timed out/);
    const junk = createTursoDb({ url: 'https://db.example.turso.io', token: 'tok-long-1', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }) });
    await assert.rejects(junk.get('SELECT 1'), /unexpected response/);
  });

  test('requests never follow redirects (the Bearer token must not travel to another host)', async () => {
    let seen;
    const db = createTursoDb({
      url: 'https://db.example.turso.io',
      token: 't',
      fetchImpl: async (url, init) => {
        seen = init;
        return { ok: true, status: 200, json: async () => ({ results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } }, { type: 'ok', response: { type: 'close' } }] }) };
      },
    });
    await db.run('SELECT 1');
    assert.equal(seen.redirect, 'error');
    assert.equal(seen.headers.Authorization, 'Bearer t');
  });

  test('URL handling: libsql:// becomes https://, http:// only for localhost, no credentials in the URL', () => {
    assert.equal(pipelineUrl('libsql://my-db-org.turso.io'), 'https://my-db-org.turso.io/v2/pipeline');
    assert.equal(pipelineUrl('turso://my-db-org.turso.io'), 'https://my-db-org.turso.io/v2/pipeline');
    assert.equal(pipelineUrl('https://my-db-org.turso.io/'), 'https://my-db-org.turso.io/v2/pipeline');
    assert.equal(pipelineUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v2/pipeline');
    assert.equal(pipelineUrl('http://localhost:8080'), 'http://localhost:8080/v2/pipeline');
    assert.throws(() => pipelineUrl('http://db.example.com'), /https/);
    assert.throws(() => pipelineUrl('ftp://db.example.com'), /libsql:\/\/, turso:\/\/ or https/);
    assert.throws(() => pipelineUrl('https://user:pw@db.example.com'), (e) => /credentials/.test(e.message) && !e.message.includes('pw'));
    assert.throws(() => pipelineUrl('not a url'), /not a valid URL/);
    assert.throws(() => createTursoDb({ url: 'https://db.example.com', token: '' }), /TURSO_AUTH_TOKEN/);
  });

  test('a bad bearer token is a 401 at the fake, and the fake rejects unknown paths and batons', async () => {
    const fake = await startFakeTurso();
    try {
      assert.equal((await post(fake, { requests: [exec('SELECT 1'), { type: 'close' }] }, { token: 'nope' })).status, 401);
      assert.equal((await fetch(`${fake.url}/v2/pipeline`, { method: 'POST', body: '{}' })).status, 401);
      assert.equal((await fetch(`${fake.url}/v1/pipeline`, { method: 'POST' })).status, 404);
      assert.equal((await post(fake, { baton: 'abc', requests: [] })).status, 400);
    } finally {
      await fake.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// AC-38: atomic batches
// ---------------------------------------------------------------------------------------------
describe('AC-38: db.batch is atomic', () => {
  test('the fake really keeps executing after an errored execute (so atomicity must come from the driver)', async () => {
    const fake = await startFakeTurso();
    try {
      await post(fake, { requests: [exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)'), { type: 'close' }] });
      // Plain executes wrapped in BEGIN/COMMIT: the failing statement does NOT stop the later ones.
      const { json } = await post(fake, {
        requests: [
          exec('BEGIN'),
          exec("INSERT INTO t (v) VALUES ('a')"),
          exec("INSERT INTO t (v) VALUES ('a')"), // UNIQUE violation
          exec("INSERT INTO t (v) VALUES ('b')"),
          exec('COMMIT'),
          { type: 'close' },
        ],
      });
      assert.deepEqual(json.results.map((r) => r.type), ['ok', 'ok', 'error', 'ok', 'ok', 'ok']);
      assert.match(json.results[2].error.message, /UNIQUE/);
      const rows = (await post(fake, { requests: [exec('SELECT v FROM t ORDER BY v'), { type: 'close' }] })).json.results[0].response.result.rows;
      assert.deepEqual(rows.map((r) => r[0].value), ['a', 'b']); // partial transaction was committed
      // A transaction left open at the end of a pipeline is rolled back.
      await post(fake, { requests: [exec('BEGIN'), exec("INSERT INTO t (v) VALUES ('c')"), { type: 'close' }] });
      const after = (await post(fake, { requests: [exec('SELECT COUNT(*) FROM t'), { type: 'close' }] })).json.results[0].response.result.rows[0][0];
      assert.deepEqual(after, { type: 'integer', value: '2' });
    } finally {
      await fake.close();
    }
  });

  test('the Turso driver sends a conditional Hrana batch: BEGIN, each step ok(previous), COMMIT, ROLLBACK if COMMIT is not ok', async () => {
    const fake = await startFakeTurso();
    const db = createTursoDb({ url: fake.url, token: fake.token });
    try {
      await db.run('CREATE TABLE t (v TEXT)');
      fake.reset();
      await db.batch([{ sql: 'INSERT INTO t VALUES (?)', args: ['a'] }, { sql: 'INSERT INTO t VALUES (?)', args: ['b'] }]);
      assert.equal(fake.requests.length, 1); // one round trip
      const [rq, close] = fake.requests[0].body.requests;
      assert.deepEqual(close, { type: 'close' });
      assert.equal(rq.type, 'batch');
      const steps = rq.batch.steps;
      assert.equal(steps[0].stmt.sql, 'BEGIN IMMEDIATE');
      assert.equal(steps[0].condition, undefined);
      assert.deepEqual(steps[1].condition, { type: 'ok', step: 0 });
      assert.deepEqual(steps[2].condition, { type: 'ok', step: 1 });
      assert.equal(steps[3].stmt.sql, 'COMMIT');
      assert.deepEqual(steps[3].condition, { type: 'ok', step: 2 });
      assert.equal(steps[4].stmt.sql, 'ROLLBACK');
      assert.deepEqual(steps[4].condition, { type: 'not', cond: { type: 'ok', step: 3 } });
    } finally {
      await fake.close();
    }
  });

  for (const driver of DRIVERS) {
    test(`[${driver}] a failing 3rd statement leaves statements 1-2 unpersisted; a good batch commits and returns per-statement results`, async () => {
      const f = await freshDb(driver);
      const { db } = f;
      try {
        const now = new Date().toISOString();
        const ins = (email) => ({ sql: "INSERT INTO users (email, name, role, active, created_at) VALUES (?, 'x', 'rep', 1, ?)", args: [email, now] });
        await db.run('INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, ?, 1, ?)', ['dupe@x.com', 'd', 'rep', now]);
        const before = await count(db, 'users');
        // third statement violates UNIQUE(email)
        await assert.rejects(db.batch([ins('one@x.com'), ins('two@x.com'), ins('dupe@x.com'), ins('four@x.com')]), /UNIQUE/);
        assert.equal(await count(db, 'users'), before);
        assert.equal(await count(db, 'users', "email IN ('one@x.com','two@x.com','four@x.com')"), 0);
        // third statement is a syntax error
        await assert.rejects(db.batch([ins('one@x.com'), ins('two@x.com'), { sql: 'INSERT INTO nowhere VALUES (1)' }]));
        assert.equal(await count(db, 'users'), before);
        // a CHECK constraint failing in the 2nd statement rolls back the 1st
        await assert.rejects(db.batch([ins('one@x.com'), { sql: "INSERT INTO users (email, name, role, active, created_at) VALUES ('bad@x.com', 'x', 'nope', 1, 'x')" }]), /CHECK/);
        assert.equal(await count(db, 'users'), before);
        // the database still works afterwards (no transaction left open)
        const ok = await db.batch([ins('one@x.com'), { sql: 'SELECT email FROM users WHERE email = ?', args: ['one@x.com'] }, ins('two@x.com')]);
        assert.equal(ok.length, 3);
        assert.equal(typeof ok[0].lastInsertRowid, 'number');
        assert.equal(ok[0].changes, 1);
        assert.deepEqual(ok[1].rows, [{ email: 'one@x.com' }]);
        assert.equal(ok[2].lastInsertRowid, ok[0].lastInsertRowid + 1);
        assert.equal(await count(db, 'users'), before + 2);
        await assert.rejects(db.batch([]), /non-empty/);
      } finally {
        await f.close();
      }
    });

    test(`[${driver}] undefined arguments are rejected with a clear error; booleans, bigint and blobs round-trip`, async () => {
      const f = await freshDb(driver);
      const { db } = f;
      try {
        await assert.rejects(db.get('SELECT ? AS x', [undefined]), /argument 1 is undefined/);
        await assert.rejects(db.run('SELECT ?, ?', [1, undefined]), /argument 2 is undefined/);
        await assert.rejects(db.batch([{ sql: 'SELECT 1' }, { sql: 'SELECT ?', args: [undefined] }]), /batch statement 2: argument 1 is undefined/);
        await assert.rejects(db.get('SELECT ? AS x', [NaN]), /finite/);
        await assert.rejects(db.get('SELECT ? AS x', [{}]), /unsupported type/);
        assert.deepEqual(await db.get('SELECT ? AS a, ? AS b, ? AS c, ? AS d, ? AS e', [true, false, 5n, null, 'x']), { a: 1, b: 0, c: 5, d: null, e: 'x' });
        assert.deepEqual((await db.get('SELECT ? AS b', [Buffer.from([0, 255, 7])])).b, Buffer.from([0, 255, 7]));
        assert.equal((await db.get('SELECT ? AS f', [0.25])).f, 0.25);
        assert.equal(Object.getPrototypeOf(await db.get('SELECT 1 AS x')), Object.prototype);
      } finally {
        await f.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// AC-39: migrations
// ---------------------------------------------------------------------------------------------
describe('AC-39: migrations', () => {
  for (const driver of DRIVERS) {
    test(`[${driver}] a fresh database is fully migrated on first request; a second start does no schema writes`, async () => {
      const t = await startApp({ driver });
      try {
        assert.equal(await count(t.db, 'schema_migrations'), MIGRATIONS.length);
        assert.equal(await count(t.db, 'email_templates'), 4);
        assert.equal((await t.db.get('SELECT MAX(version) AS v FROM schema_migrations')).v, MIGRATIONS.length);
        assert.equal(await count(t.db, 'schema_migrations', 'version = 1'), 1);
        for (const tbl of ['users', 'job_roles', 'applications', 'rate_limits']) {
          assert.equal(await count(t.db, 'sqlite_master', "type = 'table' AND name = ?", tbl), 1, tbl);
        }
        const applied = await t.db.all('SELECT * FROM schema_migrations ORDER BY version');
        if (t.fake) t.fake.reset();
        const t2 = await t.restart();
        try {
          assert.equal((await t2.client().get('/')).status, 200); // a request on the second instance
          assert.deepEqual(await t2.db.all('SELECT * FROM schema_migrations ORDER BY version'), applied); // unchanged rows
          assert.equal(await count(t2.db, 'email_templates'), 4);
          if (t2.fake) {
            const first = t2.fake.requests.find((r) => true).body.requests[0];
            assert.match(first.stmt.sql, /^SELECT MAX\(version\) AS v FROM schema_migrations/); // one cheap read first
            assert.equal(t2.fake.schemaWrites().length, 0);
          }
        } finally {
          await t2.close();
        }
      } finally {
        await t.close().catch(() => {});
      }
    });

    test(`[${driver}] two concurrent first starts on one empty database leave one schema and 4 templates`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-mig-'));
      const fake = driver === 'turso' ? await startFakeTurso() : null;
      const env = { NODE_ENV: 'test', DATA_DIR: dir, QUIET: '1', ...(fake ? { TURSO_DATABASE_URL: fake.url, TURSO_AUTH_TOKEN: fake.token } : {}) };
      const apps = [createApp({ env }), createApp({ env }), createApp({ env })];
      try {
        await Promise.all(apps.map((a) => a.ready));
        const { db } = apps[0];
        assert.equal(await count(db, 'schema_migrations'), MIGRATIONS.length);
        assert.deepEqual((await db.all('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version), MIGRATIONS.map((m) => m.version));
        assert.equal(await count(db, 'email_templates'), 4);
        assert.equal(await count(db, 'sqlite_master', "type = 'table' AND name = 'users'"), 1);
        assert.equal(await count(db, 'sqlite_master', "type = 'trigger' AND name = 'application_events_no_update'"), 1);
        if (fake) {
          // The race really happened: several runners sent the baseline batch, only one of them could commit.
          const baselines = fake.requests.filter((r) => JSON.stringify(r.body).includes('CREATE TABLE schema_migrations'));
          assert.ok(baselines.length >= 2, `expected a contended migration, saw ${baselines.length} baseline batch(es)`);
        }
        // and the app serves requests
        for (const a of apps) assert.ok(a.ready);
      } finally {
        for (const a of apps) await a.close();
        if (fake) await fake.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('a failed init (database unreachable) is retried on the next request instead of being cached', async () => {
    const fake = await startFakeTurso();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-mig-'));
    const wrongToken = createApp({ env: { NODE_ENV: 'test', DATA_DIR: dir, QUIET: '1', TURSO_DATABASE_URL: fake.url, TURSO_AUTH_TOKEN: 'wrong' } });
    try {
      await assert.rejects(wrongToken.ready, /HTTP 401/);
      await assert.rejects(wrongToken.ready, /HTTP 401/); // not a cached success; re-attempted
      assert.ok(fake.requests.length >= 2);
    } finally {
      await wrongToken.close();
      await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Apply flow and guards in SQL (both drivers)
// ---------------------------------------------------------------------------------------------
for (const driver of DRIVERS) {
  describe(`[${driver}] SQL-level behaviour of the batches`, () => {
    test('apply: person upsert, application and event link up via SQL (last_insert_rowid) on this driver', async () => {
      const t = await startApp({ driver });
      try {
        const role = await makeRole(t.db, { title: 'Linked' });
        const c = t.client();
        for (const [email, name] of [['link@example.com', 'First Name'], ['LINK@example.com', 'Second Name'], ['other@example.com', 'Other']]) {
          assert.equal((await c.apply(role, { email, name })).status, 303);
        }
        const apps = await t.db.all('SELECT * FROM applications ORDER BY id');
        const events = await t.db.all('SELECT * FROM application_events ORDER BY id');
        const people = await t.db.all('SELECT * FROM people ORDER BY id');
        assert.equal(people.length, 2);
        assert.equal(people[0].name, 'First Name'); // F-05: an existing person keeps their name (the application row keeps what was typed)
        assert.equal(apps.length, 3);
        assert.deepEqual(apps.map((a) => a.person_id), [people[0].id, people[0].id, people[1].id]);
        assert.equal(events.length, 3);
        assert.deepEqual(events.map((e) => e.application_id), apps.map((a) => a.id)); // each event points at ITS application
        assert.ok(events.every((e) => e.type === 'stage_change' && e.from_value === null && e.to_value === 'new' && e.actor_user_id === null));
        assert.equal(await count(t.db, 'rate_limits'), 3);
      } finally {
        await t.close();
      }
    });

    test('a failure inside the apply batch stores nothing (no person, application, event or rate-limit row)', async () => {
      const t = await startApp({ driver });
      try {
        const role = await makeRole(t.db, { title: 'Atomic' });
        const c = t.client();
        await c.get(`/roles/${role}`);
        // Make the event insert fail inside the batch by dropping what it needs.
        await t.db.run('DROP TRIGGER application_events_no_update');
        await t.db.run('ALTER TABLE application_events RENAME TO application_events_gone');
        const res = await c.apply(role, { email: 'atomic@example.com' });
        assert.equal(res.status, 500);
        assert.equal(await count(t.db, 'people', "email = 'atomic@example.com'"), 0);
        assert.equal(await count(t.db, 'applications'), 0);
        assert.equal(await count(t.db, 'rate_limits'), 0);
      } finally {
        await t.close();
      }
    });

    // Simulates the race deterministically: the other writer changes the row after this request has read it
    // and before its batch runs (db.batch is patched once).
    function raceBeforeNextBatch(db, doRace) {
      const orig = db.batch.bind(db);
      db.batch = async (statements) => {
        db.batch = orig;
        await doRace();
        return orig(statements);
      };
    }

    test('stage change: a concurrent change between the read and the batch writes no event and no stage', async () => {
      const t = await startApp({ driver });
      try {
        const rep = await makeUser(t.db, { email: 'rep@fansided.com' });
        const role = await makeRole(t.db, { title: 'Race', assigned: rep });
        await t.client().apply(role, { email: 'race@example.com' });
        const app = await lastApplication(t.db);
        const c = t.client();
        await c.login('rep@fansided.com');
        await c.get(`/app/applications/${app.id}`);
        const eventsBefore = await t.db.all('SELECT * FROM application_events WHERE application_id = ?', [app.id]);
        raceBeforeNextBatch(t.db, () => t.db.run("UPDATE applications SET stage = 'trial' WHERE id = ?", [app.id]));
        const res = await c.post(`/app/applications/${app.id}/stage`, { stage: 'reviewing', from_stage: 'new' });
        assert.equal(res.status, 303);
        assert.equal((await lastApplication(t.db)).stage, 'trial'); // the other writer's value stands
        assert.deepEqual(await t.db.all('SELECT * FROM application_events WHERE application_id = ?', [app.id]), eventsBefore); // no event row for the lost move
        assert.match((await c.follow(res)).text, /Someone else changed this candidate/);
        // Same guard for moving role and for Voltax events.
        const other = await makeRole(t.db, { title: 'Elsewhere', assigned: rep });
        const third = await makeRole(t.db, { title: 'Third', assigned: rep });
        await c.get(`/app/applications/${app.id}`);
        raceBeforeNextBatch(t.db, () => t.db.run('UPDATE applications SET role_id = ? WHERE id = ?', [third, app.id]));
        await c.post(`/app/applications/${app.id}/role`, { role_id: String(other), from_role_id: String(role) });
        assert.equal((await lastApplication(t.db)).role_id, third);
        assert.equal(await count(t.db, 'application_events', "type = 'role_change'"), 0);
        // And with the onboarded + Voltax path: neither event is written.
        raceBeforeNextBatch(t.db, () => t.db.run("UPDATE applications SET stage = 'passed' WHERE id = ?", [app.id]));
        await c.post(`/app/applications/${app.id}/stage`, { stage: 'onboarded', from_stage: 'trial', voltax_user_id: 'vx-9' });
        assert.equal(await count(t.db, 'application_events', "type = 'voltax_recorded'"), 0);
        assert.equal((await lastApplication(t.db)).voltax_user_id, null);
        assert.equal((await lastApplication(t.db)).stage, 'passed');
      } finally {
        await t.close();
      }
    });

    test('stage change to Onboarded with a Voltax id: one atomic batch writes stage, onboarded_at, voltax fields and both events', async () => {
      const t = await startApp({ driver });
      try {
        const rep = await makeUser(t.db, { email: 'rep@fansided.com' });
        const role = await makeRole(t.db, { title: 'Onb', assigned: rep });
        await t.client().apply(role, { email: 'onb@example.com' });
        const app = await lastApplication(t.db);
        const c = t.client();
        await c.login('rep@fansided.com');
        await c.get(`/app/applications/${app.id}`);
        await c.post(`/app/applications/${app.id}/stage`, { stage: 'onboarded', from_stage: 'new', voltax_user_id: 'vx-1', voltax_onboarded_on: '2026-03-01' });
        const row = await lastApplication(t.db);
        assert.equal(row.stage, 'onboarded');
        assert.equal(row.voltax_user_id, 'vx-1');
        assert.equal(row.voltax_onboarded_on, '2026-03-01');
        assert.ok(row.onboarded_at);
        const types = (await t.db.all('SELECT type, from_value, to_value FROM application_events WHERE application_id = ? ORDER BY id', [app.id])).map((e) => `${e.type}:${e.from_value}>${e.to_value}`);
        assert.deepEqual(types, ['stage_change:null>new', 'stage_change:new>onboarded', 'voltax_recorded:null>vx-1 (onboarded 2026-03-01)']);
        // Recording again takes the previous value from the row itself.
        await c.get(`/app/applications/${app.id}`);
        await c.post(`/app/applications/${app.id}/voltax`, { voltax_user_id: 'vx-2', voltax_onboarded_on: '2026-03-02' });
        const last = (await t.db.all('SELECT * FROM application_events WHERE application_id = ? ORDER BY id DESC LIMIT 1', [app.id]))[0];
        assert.equal(last.from_value, 'vx-1');
        assert.equal(last.to_value, 'vx-2 (onboarded 2026-03-02)');
      } finally {
        await t.close();
      }
    });

    test('last admin: the guard inside the UPDATE refuses when a concurrent change already made this the only admin', async () => {
      const t = await startApp({ driver });
      try {
        const a2 = await makeUser(t.db, { email: 'admin2@fansided.com', role: 'admin' });
        const a1 = (await t.db.get("SELECT id FROM users WHERE email = 'admin@fansided.com'")).id;
        const c1 = t.client();
        await c1.login('admin@fansided.com');
        await c1.get('/app/admin/users');
        // admin 1 deactivates admin 2 (2 active admins when read) while, meanwhile, admin 1 is demoted elsewhere.
        raceBeforeNextBatch(t.db, () => t.db.run("UPDATE users SET role = 'rep' WHERE id = ?", [a1]));
        const res = await c1.post(`/app/admin/users/${a2}/deactivate`, {});
        assert.equal(res.status, 303);
        assert.equal(await count(t.db, 'users', "role = 'admin' AND active = 1"), 1);
        assert.equal((await t.db.get('SELECT active FROM users WHERE id = ?', [a2])).active, 1);
        // sessions of the user that was not deactivated are untouched
        assert.equal(await count(t.db, 'sessions', 'user_id = ?', a1), 1);
        // The role-change path has the same guard.
        await t.db.run("UPDATE users SET role = 'admin' WHERE id = ?", [a1]);
        await c1.get('/app/admin/users');
        raceBeforeNextBatch(t.db, () => t.db.run("UPDATE users SET role = 'rep' WHERE id = ?", [a1]));
        await c1.post(`/app/admin/users/${a2}/role`, { role: 'rep' });
        assert.equal(await count(t.db, 'users', "role = 'admin' AND active = 1"), 1);
      } finally {
        await t.close();
      }
    });

    test('delete candidate removes everything in one batch with explicit deletes and writes one PII-free log row', async () => {
      const t = await startApp({ driver });
      try {
        const rep = await makeUser(t.db, { email: 'rep@fansided.com' });
        const role = await makeRole(t.db, { title: 'Del', assigned: rep });
        await t.client().apply(role, { email: 'del@example.com', name: 'Del Person' });
        const app = await lastApplication(t.db);
        const admin = t.client();
        await admin.login('admin@fansided.com');
        await admin.get(`/app/applications/${app.id}`);
        await admin.post(`/app/applications/${app.id}/notes`, { body: 'a note' });
        await admin.get(`/app/people/${app.person_id}/delete`);
        const res = await admin.post(`/app/people/${app.person_id}/delete`, {});
        assert.equal(res.status, 303);
        for (const tb of ['people', 'applications', 'application_events', 'notes']) assert.equal(await count(t.db, tb), 0, tb);
        const log = await t.db.all('SELECT * FROM deletion_log');
        assert.equal(log.length, 1);
        assert.equal(log[0].deleted_person_id, app.person_id);
        assert.doesNotMatch(JSON.stringify(log), /del@example|Del Person/);
        // Deleting a person that does not exist writes no log row.
        assert.equal((await admin.post(`/app/people/${app.person_id}/delete`, {})).status, 404);
        assert.equal(await count(t.db, 'deletion_log'), 1);
      } finally {
        await t.close();
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// AC-11: the apply limit lives in the database
// ---------------------------------------------------------------------------------------------
for (const driver of DRIVERS) {
  describe(`[${driver}] AC-11: apply rate limit survives the app being torn down and recreated`, () => {
    test('10 stored applications per IP per hour; the 11th is refused, also after a restart; other IPs unaffected', async () => {
      let t = await startApp({ driver });
      try {
        const role = await makeRole(t.db, { title: 'Limited' });
        const ip = '198.51.100.7';
        for (let i = 0; i < 6; i++) assert.equal((await t.client({ ip }).apply(role, { email: `lim${i}@example.com` })).status, 303);
        t = await t.restart(); // whole app torn down, same database
        for (let i = 6; i < 10; i++) {
          const c = t.client({ ip });
          const res = await c.apply(role, { email: `lim${i}@example.com` });
          assert.equal(res.status, 303, `application ${i + 1}`);
        }
        t = await t.restart();
        const before = await count(t.db, 'applications');
        assert.equal(before, 10);
        const eleventh = await t.client({ ip }).apply(role, { email: 'lim10@example.com' });
        assert.equal(eleventh.status, 429);
        assert.equal(await count(t.db, 'applications'), before);
        assert.equal((await t.client({ ip: '198.51.100.8' }).apply(role, { email: 'fresh@example.com' })).status, 303);
        // The key is an HMAC, never the raw address.
        const keys = await t.db.all('SELECT key FROM rate_limits');
        assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k.key)));
        assert.doesNotMatch(JSON.stringify(keys), /198\.51\.100/);
        // Rows leave the window: after an hour the same IP may apply again.
        await t.db.run('UPDATE rate_limits SET at = ?', [new Date(Date.now() - 3700000).toISOString()]);
        assert.equal((await t.client({ ip }).apply(role, { email: 'later@example.com' })).status, 303);
      } finally {
        await t.close();
      }
    });

    test('honeypot hits count towards the limit, validation failures and closed roles do not', async () => {
      const t = await startApp({ driver });
      try {
        const role = await makeRole(t.db, { title: 'Honey' });
        const closed = await makeRole(t.db, { title: 'Shut', status: 'closed' });
        const ip = '198.51.100.20';
        for (let i = 0; i < 3; i++) await t.client({ ip }).apply(role, { email: `bad${i}`, name: '' }); // 400s
        await t.client({ ip }).apply(closed, { email: 'closed@example.com' });
        assert.equal(await count(t.db, 'rate_limits'), 0);
        for (let i = 0; i < 4; i++) assert.equal((await t.client({ ip }).apply(role, { email: `hp${i}@example.com`, website: 'http://spam' })).status, 303);
        assert.equal(await count(t.db, 'rate_limits'), 4);
        assert.equal(await count(t.db, 'applications'), 0);
      } finally {
        await t.close();
      }
    });
  });
}

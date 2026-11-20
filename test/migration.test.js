'use strict';
// Migration 3 (per-role workflows) against a database built at the CURRENT (pre-3) schema with real-looking data,
// on BOTH drivers: sqlite and the Turso HTTP driver (against test/fake-turso.js).
// The production database holds real data, so this is the most heavily tested change in the project.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, freshDb, makeUser, moveStage } = require('./helpers');
const { MIGRATIONS, migrate, openDb } = require('../src/lib/db');
const { currentVersion } = require('../src/lib/db/migrations');
const stages = require('../src/lib/stages');

// These tests are about migration 3 only: they stop there (migration 4 has its own file, migration-questionnaires.test.js).
const migrate3 = (db) => migrate(db, { upTo: 3 });

const T0 = '2026-10-01T12:00:00.000Z';
const FIVE = ['New', 'Reviewing', 'Trial', 'Onboarded', 'Passed'];
const LEGACY_TO_NAME = { new: 'New', reviewing: 'Reviewing', trial: 'Trial', onboarded: 'Onboarded', passed: 'Passed' };

// Everything a production database has: users, roles (one without any application), people, applications in ALL FIVE
// legacy stages (several roles, several per stage), events, notes, emails and a deletion log row.
async function seedLegacy(db) {
  const u = await db.run("INSERT INTO users (email, name, role, created_at) VALUES ('rep@fansided.com', 'Rita Rep', 'rep', ?)", [T0]);
  const roles = [];
  for (const [title, status] of [['Chiefs writer', 'open'], ['Lakers writer', 'open'], ['Empty role', 'closed'], ["It's a \"quoted\" role", 'open']]) {
    roles.push((await db.run('INSERT INTO job_roles (title, vertical, status, assigned_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [title, 'NFL', status, u.lastInsertRowid, T0, T0])).lastInsertRowid);
  }
  const apps = [];
  let n = 0;
  const plan = [
    [0, 'new'], [0, 'new'], [0, 'reviewing'], [0, 'trial'], [0, 'trial'], [0, 'onboarded'], [0, 'passed'],
    [1, 'new'], [1, 'reviewing'], [1, 'trial'], [1, 'onboarded'], [1, 'passed'], [1, 'passed'],
    [3, 'trial'], [3, 'onboarded'],
  ];
  for (const [roleIx, stage] of plan) {
    n += 1;
    const p = await db.run('INSERT INTO people (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [`p${n}@example.com`, `Person ${n}`, T0, T0]);
    const a = await db.run(
      `INSERT INTO applications (person_id, role_id, stage, applied_at, stage_changed_at, onboarded_at, voltax_user_id, answers_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.lastInsertRowid, roles[roleIx], stage, T0, T0, stage === 'onboarded' ? T0 : null, stage === 'onboarded' ? `vx-${n}` : null, '[{"question":"Q","answer":"A"}]']
    );
    apps.push({ id: a.lastInsertRowid, role: roles[roleIx], stage, person: p.lastInsertRowid });
    await db.run("INSERT INTO application_events (application_id, type, from_value, to_value, at) VALUES (?, 'stage_change', NULL, 'new', ?)", [a.lastInsertRowid, T0]);
    if (stage !== 'new') await db.run("INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at) VALUES (?, 'stage_change', 'new', ?, ?, ?)", [a.lastInsertRowid, stage, u.lastInsertRowid, T0]);
  }
  await db.run('INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [apps[0].person, apps[0].id, apps[0].role, u.lastInsertRowid, 'a note', T0]);
  await db.run("INSERT INTO emails_sent (person_id, application_id, role_id, sender_user_id, to_email, subject, body, via, sent_at) VALUES (?, ?, ?, ?, 'p1@example.com', 's', 'b', 'gmail', ?)", [apps[0].person, apps[0].id, apps[0].role, u.lastInsertRowid, T0]);
  return { roles, apps, user: u.lastInsertRowid };
}

const TABLES = ['users', 'sessions', 'auth_tokens', 'job_roles', 'people', 'applications', 'application_events', 'notes', 'email_templates', 'emails_sent', 'deletion_log', 'rate_limits'];

async function snapshot(db) {
  const out = {};
  for (const t of TABLES) out[t] = await db.all(`SELECT * FROM ${t} ORDER BY ${t === 'sessions' ? 'token_hash' : 'rowid'}`);
  return out;
}

async function columnsOf(db, table) {
  return (await db.all(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
}

async function tableExists(db, name) {
  return Boolean(await db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

// A second connection to the same database (a second serverless instance starting at the same time).
function secondConnection(driver, handle) {
  return driver === 'turso'
    ? openDb({ tursoUrl: handle.fake.url, tursoToken: handle.fake.token })
    : openDb({ dataDir: handle.dir });
}

for (const driver of DRIVERS) {
  describe(`migration 3: per-role workflows [${driver}]`, () => {
    test('migration 3 exists; the schema it starts from is the current one (versions 1 and 2)', async () => {
      assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5]);
      const h = await freshDb(driver, { upTo: 2 });
      try {
        assert.equal(await currentVersion(h.db), 2);
        assert.equal(await tableExists(h.db, 'role_stages'), false);
        assert.ok(!(await columnsOf(h.db, 'applications')).includes('stage_id'));
      } finally {
        await h.close();
      }
    });

    test('every application lands in the matching stage of its own role; nothing else changes; nothing is lost', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      try {
        const seed = await seedLegacy(h.db);
        const before = await snapshot(h.db);
        assert.equal(before.applications.length, 15);

        const res = await migrate3(h.db);
        assert.deepEqual(res, { from: 2, to: 3 });
        assert.equal(await currentVersion(h.db), 3);

        // role_stages: five per role, in order, with the right kinds, ids ordered by role then position
        const rs = await h.db.all('SELECT * FROM role_stages ORDER BY id');
        assert.equal(rs.length, seed.roles.length * 5);
        for (const roleId of seed.roles) {
          const mine = rs.filter((s) => s.role_id === roleId);
          assert.deepEqual(mine.map((s) => s.name), FIVE);
          assert.deepEqual(mine.map((s) => s.kind), ['new', 'progress', 'progress', 'onboarded', 'passed']);
          assert.deepEqual(mine.map((s) => s.position), [0, 1, 2, 3, 4]);
          assert.ok(mine.every((s) => s.created_at));
        }
        // every application: stage_id is a stage of ITS role and carries the legacy value's name
        const apps = await h.db.all('SELECT a.id, a.role_id, a.stage, a.stage_id, s.role_id AS stage_role, s.name FROM applications a LEFT JOIN role_stages s ON s.id = a.stage_id ORDER BY a.id');
        assert.equal(apps.length, 15);
        for (const a of apps) {
          assert.ok(a.stage_id, `application ${a.id} has a stage_id`);
          assert.equal(a.stage_role, a.role_id, `application ${a.id} points at a stage of its own role`);
          assert.equal(a.name, LEGACY_TO_NAME[a.stage]);
        }
        const per = Object.fromEntries((await h.db.all('SELECT s.name, COUNT(*) AS n FROM applications a JOIN role_stages s ON s.id = a.stage_id GROUP BY s.name')).map((r) => [r.name, r.n]));
        assert.deepEqual(per, { New: 3, Reviewing: 2, Trial: 4, Onboarded: 3, Passed: 3 });

        // Nothing lost or altered: every table is identical except applications gained the stage_id column.
        const after = await snapshot(h.db);
        for (const t of TABLES.filter((x) => x !== 'applications')) assert.deepEqual(after[t], before[t], `${t} unchanged`);
        assert.deepEqual(
          after.applications.map(({ stage_id, ...rest }) => rest),
          before.applications,
          'legacy stage column and every other applications column unchanged'
        );
        assert.equal(await h.db.get('SELECT COUNT(*) AS n FROM schema_migrations').then((r) => r.n), 3);
      } finally {
        await h.close();
      }
    });

    test('start-up twice is a no-op (migrate and the repair that runs after it)', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      try {
        await seedLegacy(h.db);
        await migrate3(h.db);
        const once = { stages: await h.db.all('SELECT * FROM role_stages ORDER BY id'), apps: await h.db.all('SELECT id, stage, stage_id FROM applications ORDER BY id'), mig: await h.db.all('SELECT * FROM schema_migrations ORDER BY version') };
        assert.deepEqual(await migrate3(h.db), { from: 3, to: 3 });
        assert.deepEqual(await stages.repair(h.db), { roles: 0, applications: 0 });
        assert.deepEqual(await migrate3(h.db), { from: 3, to: 3 });
        assert.deepEqual(await stages.repair(h.db), { roles: 0, applications: 0 });
        assert.deepEqual(await h.db.all('SELECT * FROM role_stages ORDER BY id'), once.stages);
        assert.deepEqual(await h.db.all('SELECT id, stage, stage_id FROM applications ORDER BY id'), once.apps);
        assert.deepEqual(await h.db.all('SELECT * FROM schema_migrations ORDER BY version'), once.mig);
      } finally {
        await h.close();
      }
    });

    test('an empty database (no roles, no applications) migrates too', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      try {
        await migrate3(h.db);
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM role_stages')).n, 0);
        assert.ok((await columnsOf(h.db, 'applications')).includes('stage_id'));
      } finally {
        await h.close();
      }
    });

    test('atomic: a failure anywhere in the batch leaves the database exactly as it was (table, column, backfill, tracking row)', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      try {
        await seedLegacy(h.db);
        const before = await snapshot(h.db);
        const good = MIGRATIONS.find((m) => m.version === 3).statements();
        // 1. the last statement fails: everything before it must roll back, DDL included
        await assert.rejects(h.db.batch([...good, 'INSERT INTO no_such_table VALUES (1)']));
        // 2. a statement in the middle fails
        await assert.rejects(h.db.batch([...good.slice(0, 6), 'SELECT * FROM nope', ...good.slice(6)]));
        assert.equal(await tableExists(h.db, 'role_stages'), false);
        assert.ok(!(await columnsOf(h.db, 'applications')).includes('stage_id'));
        assert.equal(await currentVersion(h.db), 2);
        assert.deepEqual(await snapshot(h.db), before);
        // and the real migration still runs afterwards
        assert.deepEqual(await migrate3(h.db), { from: 2, to: 3 });
      } finally {
        await h.close();
      }
    });

    test('tripwire: if an application would be left without a stage, start-up fails and nothing is applied', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      try {
        await seedLegacy(h.db);
        const before = await snapshot(h.db);
        const good = MIGRATIONS.find((m) => m.version === 3).statements();
        const withoutBackfill = good.filter((s) => !(typeof s === 'string' && s.startsWith('UPDATE applications SET stage_id')));
        assert.equal(withoutBackfill.length, good.length - 1);
        await assert.rejects(h.db.batch(withoutBackfill), /role_stages\.role_id/);
        assert.equal(await tableExists(h.db, 'role_stages'), false);
        assert.ok(!(await columnsOf(h.db, 'applications')).includes('stage_id'));
        assert.deepEqual(await snapshot(h.db), before);
        // the same through migrate(): a broken migration surfaces as an error (the app does not start), version unchanged
        const broken = MIGRATIONS[2].statements;
        MIGRATIONS[2].statements = () => withoutBackfill;
        try {
          await assert.rejects(migrate3(h.db));
        } finally {
          MIGRATIONS[2].statements = broken;
        }
        assert.equal(await currentVersion(h.db), 2);
      } finally {
        await h.close();
      }
    });

    test('cold start race: two instances migrating at the same moment end with exactly one workflow per role', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      const second = secondConnection(driver, h);
      try {
        const seed = await seedLegacy(h.db);
        const results = await Promise.all([migrate3(h.db), migrate3(second), migrate3(h.db)]);
        assert.ok(results.every((r) => r.to === 3));
        assert.equal(await currentVersion(h.db), 3);
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM role_stages')).n, seed.roles.length * 5, 'no duplicated stages');
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 3')).n, 1);
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM applications WHERE stage_id IS NULL')).n, 0);
      } finally {
        await second.close();
        await h.close();
      }
    });

    test('cold start through the real app: an old database is migrated by the first request and the pages work', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      let t;
      try {
        const seed = await seedLegacy(h.db);
        await makeUser(h.db, { email: 'admin@fansided.com', role: 'admin' });
        t = await startApp({ driver, dataDir: h.dir, fake: h.fake, ownFake: false });
        assert.equal(await currentVersion(t.db), 5); // the app runs every migration
        const c = t.client();
        await c.login('admin@fansided.com');
        const dash = await c.get('/app?view=all');
        assert.equal(dash.status, 200);
        const board = await c.get(`/app/roles/${seed.roles[0]}`);
        assert.equal(board.status, 200);
        // role 0 had: 2 new, 1 reviewing, 2 trial, 1 onboarded, 1 passed
        const counts = Object.fromEntries([...board.text.matchAll(/<h2 id="h-\d+">([^<]+)<\/h2>\s*<span class="board-count[^"]*">(\d+)</g)].map((m) => [m[1], Number(m[2])]));
        assert.deepEqual(counts, { New: 2, Reviewing: 1, Trial: 2, Onboarded: 1, Passed: 1 });
        // the candidate page works and can move on, with names in the event log
        const move = seed.apps[0];
        const page = await c.get(`/app/applications/${move.id}`);
        assert.equal(page.status, 200);
        assert.match(page.text, /Applied \(stage New\)/); // legacy lowercase event values still read well
        assert.match(page.text, /<h2>Move to another stage<\/h2>/);
        assert.equal((await moveStage(c, t.db, move.id, 'Trial', 'New')).status, 303);
        assert.equal((await t.db.get('SELECT stage FROM applications WHERE id = ?', [move.id])).stage, 'reviewing'); // category of a progress stage
        const csv = (await c.get('/app/export.csv')).text;
        assert.match(csv, /,stage,stage_kind,/);
        assert.match(csv, /,Onboarded,onboarded,/);
      } finally {
        if (t) await t.close({ keepData: true });
        await h.close();
      }
    });

    test('an older deployment still running after the migration keeps working: its writes are kept consistent by the triggers and the repair', async () => {
      const h = await freshDb(driver, { upTo: 2 });
      try {
        const seed = await seedLegacy(h.db);
        await migrate3(h.db);
        const [roleA, roleB] = seed.roles;
        const idOf = async (role, name) => (await h.db.get('SELECT id FROM role_stages WHERE role_id = ? AND name = ?', [role, name])).id;
        // old code inserts an application knowing only the legacy column
        const p = await h.db.run('INSERT INTO people (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)', ['old@example.com', 'Old Code', T0, T0]);
        const ins = await h.db.run('INSERT INTO applications (person_id, role_id, stage, applied_at, stage_changed_at) VALUES (?, ?, ?, ?, ?)', [p.lastInsertRowid, roleA, 'trial', T0, T0]);
        assert.equal((await h.db.get('SELECT stage_id FROM applications WHERE id = ?', [ins.lastInsertRowid])).stage_id, await idOf(roleA, 'Trial'));
        // old code moves it with the legacy column only
        await h.db.run("UPDATE applications SET stage = 'passed' WHERE id = ?", [ins.lastInsertRowid]);
        assert.equal((await h.db.get('SELECT stage_id FROM applications WHERE id = ?', [ins.lastInsertRowid])).stage_id, await idOf(roleA, 'Passed'));
        await h.db.run("UPDATE applications SET stage = 'new' WHERE id = ?", [ins.lastInsertRowid]);
        assert.equal((await h.db.get('SELECT stage_id FROM applications WHERE id = ?', [ins.lastInsertRowid])).stage_id, await idOf(roleA, 'New'));
        // the new code's own writes (stage and stage_id together) are not overridden by the trigger
        const custom = await h.db.run("INSERT INTO role_stages (role_id, position, name, kind, created_at) VALUES (?, 1, 'Edit test', 'progress', ?)", [roleA, T0]);
        await h.db.run("UPDATE applications SET stage = 'reviewing', stage_id = ? WHERE id = ?", [custom.lastInsertRowid, ins.lastInsertRowid]);
        assert.equal((await h.db.get('SELECT stage_id FROM applications WHERE id = ?', [ins.lastInsertRowid])).stage_id, custom.lastInsertRowid);
        // old code moves a candidate to another role (role_id only) and creates a role with no stages
        const mover = seed.apps[0].id;
        await h.db.run('UPDATE applications SET role_id = ? WHERE id = ?', [roleB, mover]);
        const orphanRole = (await h.db.run("INSERT INTO job_roles (title, vertical, created_at, updated_at) VALUES ('Made by old code', 'NFL', ?, ?)", [T0, T0])).lastInsertRowid;
        const p2 = await h.db.run('INSERT INTO people (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)', ['old2@example.com', 'Old Two', T0, T0]);
        const orphanApp = await h.db.run("INSERT INTO applications (person_id, role_id, stage, applied_at, stage_changed_at) VALUES (?, ?, 'new', ?, ?)", [p2.lastInsertRowid, orphanRole, T0, T0]);
        assert.equal((await h.db.get('SELECT stage_id FROM applications WHERE id = ?', [orphanApp.lastInsertRowid])).stage_id, null); // nothing to point at yet
        // the repair (runs at start-up and when a page finds a role without stages) puts both right, and is idempotent
        assert.deepEqual(await stages.repair(h.db), { roles: 1, applications: 2 });
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM role_stages WHERE role_id = ?', [orphanRole])).n, 5);
        const fixed = await h.db.get('SELECT a.stage_id, s.role_id, s.name FROM applications a JOIN role_stages s ON s.id = a.stage_id WHERE a.id = ?', [mover]);
        assert.equal(fixed.role_id, roleB);
        assert.equal(fixed.name, 'New');
        assert.equal((await h.db.get('SELECT s.name FROM applications a JOIN role_stages s ON s.id = a.stage_id WHERE a.id = ?', [orphanApp.lastInsertRowid])).name, 'New');
        assert.deepEqual(await stages.repair(h.db), { roles: 0, applications: 0 });
      } finally {
        await h.close();
      }
    });
  });
}

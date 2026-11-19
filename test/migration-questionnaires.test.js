'use strict';
// Migration 4 (questionnaire templates) against a database built at the CURRENT (v2.2, version 3) schema with real-looking
// data, on BOTH drivers: sqlite and the Turso HTTP driver (against test/fake-turso.js). Plus the start-up repair for
// roles written by an older deployment (rollout / rollback).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, startApp, freshDb, makeUser } = require('./helpers');
const { MIGRATIONS, migrate, openDb } = require('../src/lib/db');
const { currentVersion } = require('../src/lib/db/migrations');
const qn = require('../src/lib/questionnaires');

const T0 = '2026-10-01T12:00:00.000Z';
const q = (text, required = false) => ({ text, required });
const j = (list) => JSON.stringify(list);
const LONG_TITLE = `${'Very long role title '.repeat(8)}end`; // 169 characters

// Every kind of questions_json a production database can hold: [title, questions_json, is_sample, status]
const ROLES = [
  ['Chiefs writer', j([q('Why the Chiefs?', true), q('Link your best piece'), q('Hours a week?')]), 0, 'open'],
  ['Lakers writer', j([q("It's a \"quoted\" question with <b>tags</b> & ampersands?", true), q('Emoji 🏀 and accents: café, naïve, 日本語'), q('x'.repeat(500))]), 0, 'open'],
  ['No questions at all', '[]', 0, 'open'],
  ['Spaced empty', ' [ ] ', 0, 'open'],
  ['Newline empty', '[\n]', 0, 'closed'],
  ['Tab empty', '\t[\t\n  ]\r\n', 0, 'open'],
  ['Blank string', '', 0, 'open'],
  ['Not an array', 'null', 0, 'open'],
  ['Same title', j([q('First of the twins', true)]), 0, 'open'],
  ['same TITLE', j([q('Second of the twins')]), 0, 'open'],
  ['  Same Title  ', j([q('Third of the twins')]), 0, 'open'],
  [LONG_TITLE, j([q('Long title question')]), 0, 'open'],
  ['Padded json', '  [ {"text":"Spaced out","required":true} , {"text":"Second"} ]\n', 0, 'open'],
  ['Demo role', j([q('Sample question one', true), q('Sample question two')]), 1, 'open'],
  ['Chiefs writer questions', j([q('A role whose title looks like a generated name')]), 0, 'open'],
];

// Users, roles (every shape above), people, applications WITH answers (snapshots), events, notes.
async function seed(db) {
  const u = await db.run("INSERT INTO users (email, name, role, created_at) VALUES ('rep@fansided.com', 'Rita Rep', 'rep', ?)", [T0]);
  const roles = [];
  for (const [title, json, sample, status] of ROLES) {
    const r = await db.run(
      'INSERT INTO job_roles (title, vertical, status, assigned_user_id, questions_json, is_sample, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [title, 'NFL', status, u.lastInsertRowid, json, sample, T0, T0]
    );
    roles.push(r.lastInsertRowid);
  }
  const apps = [];
  let n = 0;
  for (const roleIx of [0, 0, 1, 8, 12]) {
    n += 1;
    const p = await db.run('INSERT INTO people (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [`p${n}@example.com`, `Person ${n}`, T0, T0]);
    const answers = JSON.parse(ROLES[roleIx][1]).map((x, i) => ({ question: x.text, answer: `Answer ${n}.${i} <i>x</i>` }));
    const a = await db.run(
      'INSERT INTO applications (person_id, role_id, stage, applied_at, stage_changed_at, answers_json) VALUES (?, ?, ?, ?, ?, ?)',
      [p.lastInsertRowid, roles[roleIx], 'new', T0, T0, j(answers)]
    );
    apps.push({ id: a.lastInsertRowid, answers_json: j(answers), person: p.lastInsertRowid, role: roles[roleIx] });
    await db.run("INSERT INTO application_events (application_id, type, from_value, to_value, at) VALUES (?, 'stage_change', NULL, 'new', ?)", [a.lastInsertRowid, T0]);
  }
  await db.run('INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [apps[0].person, apps[0].id, apps[0].role, u.lastInsertRowid, 'a note', T0]);
  return { roles, apps, user: u.lastInsertRowid };
}

const TABLES = ['users', 'sessions', 'auth_tokens', 'people', 'applications', 'application_events', 'notes', 'email_templates', 'emails_sent', 'deletion_log', 'rate_limits', 'role_stages'];

async function snapshot(db) {
  const out = {};
  for (const t of TABLES) out[t] = await db.all(`SELECT * FROM ${t} ORDER BY ${t === 'sessions' ? 'token_hash' : 'rowid'}`);
  out.job_roles = await db.all('SELECT * FROM job_roles ORDER BY id');
  return out;
}

const withoutQuestionnaire = (rows) => rows.map(({ questionnaire_id, ...rest }) => rest);

async function columnsOf(db, table) {
  return (await db.all(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
}

async function tableExists(db, name) {
  return Boolean(await db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

function secondConnection(driver, handle) {
  return driver === 'turso' ? openDb({ tursoUrl: handle.fake.url, tursoToken: handle.fake.token }) : openDb({ dataDir: handle.dir });
}

// What the OLD code (v2.2) showed on the apply form for a stored questions_json: JSON.parse as it was, no filtering.
function oldQuestions(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// [{ text, required }] as rendered on a public role page.
function renderedQuestions(htmlText) {
  const fs = /<legend>Questions<\/legend>([\s\S]*?)<\/fieldset>/.exec(htmlText);
  if (!fs) return [];
  return [...fs[1].matchAll(/<label for="f-answer_\d+">([\s\S]*?)(?: <span class="req"[\s\S]*?)?<\/label>[\s\S]*?<textarea[^>]*?name="answer_\d+"([^>]*)>/g)].map((m) => ({
    text: m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&'),
    required: /\brequired\b/.test(m[2]),
  }));
}

const HAS_QUESTIONS = ROLES.map(([, json]) => oldQuestions(json).length > 0);

for (const driver of DRIVERS) {
  describe(`migration 4: questionnaires [${driver}]`, () => {
    test('migration 4 is the last one; the schema it starts from has no questionnaires', async () => {
      assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4]);
      const h = await freshDb(driver, { upTo: 3 });
      try {
        assert.equal(await currentVersion(h.db), 3);
        assert.equal(await tableExists(h.db, 'questionnaires'), false);
        assert.ok(!(await columnsOf(h.db, 'job_roles')).includes('questionnaire_id'));
      } finally {
        await h.close();
      }
    });

    test('exact statements: additive only (no DROP, RENAME, rebuild, PRAGMA or JSON function), one statement each', () => {
      const stmts = MIGRATIONS.find((m) => m.version === 4).statements().map((s) => (typeof s === 'string' ? s : s.sql));
      assert.ok(stmts.length >= 6);
      for (const s of stmts) {
        assert.doesNotMatch(s, /\b(DROP|RENAME|PRAGMA|json_\w+|DELETE)\b/i, s.slice(0, 60));
        assert.doesNotMatch(s.replace(/\s+$/, ''), /;\s*\S/, 'a single statement');
      }
      assert.match(stmts[0], /^CREATE TABLE questionnaires/);
      assert.ok(stmts.some((s) => /^ALTER TABLE job_roles ADD COLUMN questionnaire_id INTEGER$/.test(s)));
      assert.ok(!stmts.some((s) => /ALTER TABLE job_roles (DROP|RENAME)/i.test(s)));
    });

    test('every role with questions gets its own questionnaire holding exactly its questions; the rest get NULL; nothing is lost', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      try {
        const seeded = await seed(h.db);
        const before = await snapshot(h.db);
        const res = await migrate(h.db);
        assert.deepEqual(res, { from: 3, to: 4 });
        assert.equal(await currentVersion(h.db), 4);

        const roles = await h.db.all('SELECT * FROM job_roles ORDER BY id');
        const qs = await h.db.all('SELECT * FROM questionnaires ORDER BY id');
        assert.equal(qs.length, HAS_QUESTIONS.filter(Boolean).length);
        roles.forEach((role, i) => {
          if (!HAS_QUESTIONS[i]) {
            assert.equal(role.questionnaire_id, null, `${ROLES[i][0]}: no questionnaire`);
            return;
          }
          const mine = qs.find((x) => x.id === role.questionnaire_id);
          assert.ok(mine, `${ROLES[i][0]}: has a questionnaire`);
          assert.equal(mine.questions_json, ROLES[i][1], `${ROLES[i][0]}: questions copied verbatim`);
          assert.equal(role.questions_json, ROLES[i][1], 'legacy storage untouched');
          assert.equal(mine.is_sample, 0);
          assert.ok(mine.created_at && mine.updated_at);
          assert.equal(qs.filter((x) => x.questionnaire_id === mine.id).length, 0);
        });
        assert.equal(new Set(roles.map((r) => r.questionnaire_id).filter(Boolean)).size, qs.length, 'one questionnaire per role, none shared');

        // Nothing lost or altered: every other table is identical, job_roles only gained the column.
        const after = await snapshot(h.db);
        for (const t of TABLES) assert.deepEqual(after[t], before[t], `${t} unchanged`);
        assert.deepEqual(withoutQuestionnaire(after.job_roles), before.job_roles);
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM schema_migrations')).n, 4);
        assert.equal(seeded.apps.length, 5);
      } finally {
        await h.close();
      }
    });

    test('names: "<title> questions", unique case-insensitively, trimmed, at most 80 characters; look-alike sets are not merged', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      try {
        await seed(h.db);
        await migrate(h.db);
        const rows = await h.db.all('SELECT r.id, r.title, q.name FROM job_roles r JOIN questionnaires q ON q.id = r.questionnaire_id ORDER BY r.id');
        const byTitle = (t) => rows.filter((r) => r.title === t);
        assert.equal(byTitle('Chiefs writer')[0].name, 'Chiefs writer questions');
        assert.equal(byTitle('Lakers writer')[0].name, 'Lakers writer questions');
        const names = rows.map((r) => r.name);
        assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'unique case-insensitively');
        assert.ok(names.every((n) => n.length <= 80 && n === n.trim() && !/\s\s/.test(n)));
        // the three "same title" roles: the first keeps the plain name, later ones are told apart by role id
        const twins = rows.filter((r) => r.title.trim().toLowerCase() === 'same title');
        assert.equal(twins.length, 3);
        assert.equal(twins[0].name, 'Same Title questions'.replace('Same Title', twins[0].title.trim()));
        assert.match(twins[1].name, new RegExp(`^same TITLE questions \\(${twins[1].id}\\)$`));
        assert.match(twins[2].name, new RegExp(`^Same Title questions \\(${twins[2].id}\\)$`));
        // a title that is already someone else's generated name still gets its own questionnaire
        assert.equal(byTitle('Chiefs writer questions')[0].name, 'Chiefs writer questions questions');
        // long title is cut to 50 characters
        const long = byTitle(LONG_TITLE)[0].name;
        assert.equal(long, `${LONG_TITLE.slice(0, 50).trim()} questions`);
        assert.ok(long.length <= 80);
        // the unique index exists and is case-insensitive
        await assert.rejects(h.db.run("INSERT INTO questionnaires (name, created_at, updated_at) VALUES ('CHIEFS WRITER QUESTIONS', ?, ?)", [T0, T0]), /UNIQUE/);
      } finally {
        await h.close();
      }
    });

    test('whitespace variants of an empty array are "no questions"; whitespace inside a non-empty array is kept as it is', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      try {
        await seed(h.db);
        await migrate(h.db);
        const roleOf = (title) => h.db.get('SELECT * FROM job_roles WHERE title = ?', [title]);
        for (const title of ['No questions at all', 'Spaced empty', 'Newline empty', 'Tab empty', 'Blank string', 'Not an array']) {
          assert.equal((await roleOf(title)).questionnaire_id, null, title);
        }
        const padded = await roleOf('Padded json');
        const mine = await h.db.get('SELECT * FROM questionnaires WHERE id = ?', [padded.questionnaire_id]);
        assert.equal(mine.questions_json, '  [ {"text":"Spaced out","required":true} , {"text":"Second"} ]\n');
        assert.deepEqual(qn.parseQuestions(mine.questions_json), [{ text: 'Spaced out', required: true }, { text: 'Second', required: false }]);
      } finally {
        await h.close();
      }
    });

    test('every role shows exactly the same apply-form questions as before (through the real app, after a cold start)', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      let t;
      try {
        const seeded = await seed(h.db);
        t = await startApp({ driver, dataDir: h.dir, fake: h.fake, ownFake: false });
        assert.equal(await currentVersion(t.db), 4);
        const c = t.client();
        for (let i = 0; i < ROLES.length; i++) {
          const res = await c.get(`/roles/${seeded.roles[i]}`);
          if (ROLES[i][3] === 'closed') continue;
          assert.equal(res.status, 200, ROLES[i][0]);
          const expected = oldQuestions(ROLES[i][1]).map((x) => ({ text: x.text, required: Boolean(x.required) }));
          assert.deepEqual(renderedQuestions(res.text), expected, `${ROLES[i][0]}: same questions, same required flags, same order`);
          if (!expected.length) assert.doesNotMatch(res.text, /<legend>Questions<\/legend>/);
        }
        // past applications untouched
        for (const a of seeded.apps) assert.equal((await t.db.get('SELECT answers_json FROM applications WHERE id = ?', [a.id])).answers_json, a.answers_json);
        // an application made now still works and snapshots the text
        const lakers = seeded.roles[1];
        const res = await c.apply(lakers, { email: 'new@example.com', answer_0: 'yes' });
        assert.equal(res.status, 303);
        const app = await t.db.get('SELECT answers_json FROM applications WHERE person_id = (SELECT id FROM people WHERE email = ?)', ['new@example.com']);
        assert.equal(JSON.parse(app.answers_json)[0].question, ROLES[1][1] && JSON.parse(ROLES[1][1])[0].text);
        // admin screens work on the migrated data
        await makeUser(t.db, { email: 'boss@fansided.com', role: 'admin' });
        const admin = t.client();
        await admin.login('boss@fansided.com');
        for (const url of ['/app/admin/questionnaires', '/app/admin/roles', `/app/admin/roles/${seeded.roles[0]}`]) assert.equal((await admin.get(url)).status, 200, url);
      } finally {
        if (t) await t.close({ keepData: true });
        await h.close();
      }
    });

    test('start-up twice is a no-op (migrate and the repair that runs after it)', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      try {
        await seed(h.db);
        await migrate(h.db);
        const once = { q: await h.db.all('SELECT * FROM questionnaires ORDER BY id'), roles: await h.db.all('SELECT * FROM job_roles ORDER BY id'), mig: await h.db.all('SELECT * FROM schema_migrations ORDER BY version') };
        assert.deepEqual(await qn.repair(h.db), { created: 0, cleared: 0 });
        assert.deepEqual(await migrate(h.db), { from: 4, to: 4 });
        assert.deepEqual(await qn.repair(h.db), { created: 0, cleared: 0 });
        assert.deepEqual(await h.db.all('SELECT * FROM questionnaires ORDER BY id'), once.q);
        assert.deepEqual(await h.db.all('SELECT * FROM job_roles ORDER BY id'), once.roles);
        assert.deepEqual(await h.db.all('SELECT * FROM schema_migrations ORDER BY version'), once.mig);
      } finally {
        await h.close();
      }
    });

    test('an empty database (no roles) and a database whose roles have no questions migrate too', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      try {
        await migrate(h.db);
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM questionnaires')).n, 0);
        assert.ok((await columnsOf(h.db, 'job_roles')).includes('questionnaire_id'));
      } finally {
        await h.close();
      }
      const h2 = await freshDb(driver, { upTo: 3 });
      try {
        await h2.db.run("INSERT INTO job_roles (title, vertical, created_at, updated_at) VALUES ('Bare', 'NFL', ?, ?)", [T0, T0]);
        await migrate(h2.db);
        assert.equal((await h2.db.get('SELECT COUNT(*) AS n FROM questionnaires')).n, 0);
        assert.equal((await h2.db.get('SELECT questionnaire_id FROM job_roles')).questionnaire_id, null);
      } finally {
        await h2.close();
      }
    });

    test('atomic: a failure anywhere in the batch leaves the database exactly as it was (table, column, indexes, backfill, tracking row)', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      try {
        await seed(h.db);
        const before = await snapshot(h.db);
        const good = MIGRATIONS.find((m) => m.version === 4).statements();
        await assert.rejects(h.db.batch([...good, 'INSERT INTO no_such_table VALUES (1)']));
        await assert.rejects(h.db.batch([...good.slice(0, 6), 'SELECT * FROM nope', ...good.slice(6)]));
        await assert.rejects(h.db.batch([...good.slice(0, 5), 'SELECT * FROM nope', ...good.slice(5)])); // after the backfill INSERT
        assert.equal(await tableExists(h.db, 'questionnaires'), false);
        assert.ok(!(await columnsOf(h.db, 'job_roles')).includes('questionnaire_id'));
        assert.equal(await h.db.get("SELECT 1 AS x FROM sqlite_master WHERE name IN ('questionnaires_name_nocase', 'job_roles_questionnaire')"), undefined);
        assert.equal(await currentVersion(h.db), 3);
        assert.deepEqual(await snapshot(h.db), before);
        assert.deepEqual(await migrate(h.db), { from: 3, to: 4 }); // and the real migration still runs
      } finally {
        await h.close();
      }
    });

    test('tripwire: a partial backfill (roles not pointed at their questionnaire, or no questionnaires made) rolls everything back', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      try {
        await seed(h.db);
        const before = await snapshot(h.db);
        const good = MIGRATIONS.find((m) => m.version === 4).statements();
        const isSql = (s, re) => re.test(typeof s === 'string' ? s : s.sql);
        const withoutLink = good.filter((s) => !isSql(s, /^UPDATE job_roles SET questionnaire_id/));
        const withoutCopy = good.filter((s) => !isSql(s, /^INSERT INTO questionnaires \(name, questions_json, is_sample/));
        assert.equal(withoutLink.length, good.length - 1);
        assert.equal(withoutCopy.length, good.length - 1);
        for (const broken of [withoutLink, withoutCopy]) {
          await assert.rejects(h.db.batch(broken), /questionnaires\.name/);
          assert.equal(await tableExists(h.db, 'questionnaires'), false);
          assert.ok(!(await columnsOf(h.db, 'job_roles')).includes('questionnaire_id'));
          assert.deepEqual(await snapshot(h.db), before);
        }
        // a partial backfill: only the first role is linked
        const partial = good.map((s) => (isSql(s, /^UPDATE job_roles SET questionnaire_id/) ? { sql: `${(typeof s === 'string' ? s : s.sql)} AND id = (SELECT MIN(id) FROM job_roles)` } : s));
        await assert.rejects(h.db.batch(partial), /questionnaires\.name/);
        assert.deepEqual(await snapshot(h.db), before);
        // through migrate(): the app would not start, version unchanged
        const real = MIGRATIONS[3].statements;
        MIGRATIONS[3].statements = () => withoutLink;
        try {
          await assert.rejects(migrate(h.db));
        } finally {
          MIGRATIONS[3].statements = real;
        }
        assert.equal(await currentVersion(h.db), 3);
      } finally {
        await h.close();
      }
    });

    test('cold start race: three instances migrating at the same moment end with exactly one questionnaire per role with questions', async () => {
      const h = await freshDb(driver, { upTo: 3 });
      const second = secondConnection(driver, h);
      try {
        await seed(h.db);
        const results = await Promise.all([migrate(h.db), migrate(second), migrate(h.db)]);
        assert.ok(results.every((r) => r.to === 4));
        assert.equal(await currentVersion(h.db), 4);
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM questionnaires')).n, HAS_QUESTIONS.filter(Boolean).length, 'no duplicated questionnaires');
        assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4')).n, 1);
        const repairs = await Promise.all([qn.repair(h.db), qn.repair(second), qn.repair(h.db)]);
        assert.deepEqual(repairs, [{ created: 0, cleared: 0 }, { created: 0, cleared: 0 }, { created: 0, cleared: 0 }]);
      } finally {
        await second.close();
        await h.close();
      }
    });

    // ------------------------------------------------------------ a deployment that does not know about questionnaires
    describe('rollout and rollback: the older version still writes job_roles.questions_json', () => {
      async function migrated() {
        const h = await freshDb(driver, { upTo: 3 });
        const seeded = await seed(h.db);
        await migrate(h.db);
        return { h, seeded };
      }
      const roleRow = (db, id) => db.get('SELECT * FROM job_roles WHERE id = ?', [id]);

      test('a role created by the older version with questions (no questionnaire) gets a questionnaire; a role without questions does not', async () => {
        const { h } = await migrated();
        try {
          const withQ = (await h.db.run("INSERT INTO job_roles (title, vertical, questions_json, created_at, updated_at) VALUES ('Made by old code', 'NFL', ?, ?, ?)", [j([q('Old Q1', true), q('Old Q2')]), T0, T0])).lastInsertRowid;
          const without = (await h.db.run("INSERT INTO job_roles (title, vertical, questions_json, created_at, updated_at) VALUES ('Old, no questions', 'NFL', '[]', ?, ?)", [T0, T0])).lastInsertRowid;
          const count = (await h.db.get('SELECT COUNT(*) AS n FROM questionnaires')).n;
          assert.deepEqual(await qn.repair(h.db), { created: 1, cleared: 0 });
          const role = await roleRow(h.db, withQ);
          const made = await h.db.get('SELECT * FROM questionnaires WHERE id = ?', [role.questionnaire_id]);
          assert.equal(made.name, 'Made by old code questions');
          assert.deepEqual(qn.parseQuestions(made.questions_json), [{ text: 'Old Q1', required: true }, { text: 'Old Q2', required: false }]);
          assert.equal(role.questions_json, made.questions_json);
          assert.equal((await roleRow(h.db, without)).questionnaire_id, null);
          assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM questionnaires')).n, count + 1);
          assert.deepEqual(await qn.repair(h.db), { created: 0, cleared: 0 }); // idempotent
        } finally {
          await h.close();
        }
      });

      test('the name is made unique when taken (case-insensitively), again and again', async () => {
        const { h } = await migrated();
        try {
          const ids = [];
          for (let i = 0; i < 3; i++) {
            ids.push((await h.db.run("INSERT INTO job_roles (title, vertical, questions_json, created_at, updated_at) VALUES ('CHIEFS writer', 'NFL', ?, ?, ?)", [j([q(`Q ${i}`)]), T0, T0])).lastInsertRowid);
          }
          assert.deepEqual(await qn.repair(h.db), { created: 3, cleared: 0 });
          const names = [];
          for (const id of ids) names.push((await h.db.get('SELECT q.name FROM job_roles r JOIN questionnaires q ON q.id = r.questionnaire_id WHERE r.id = ?', [id])).name);
          assert.deepEqual(names, ['CHIEFS writer questions (2)', 'CHIEFS writer questions (3)', 'CHIEFS writer questions (4)']);
        } finally {
          await h.close();
        }
      });

      test('the older version edits the questions of a role that shares a questionnaire: only that role changes', async () => {
        const { h, seeded } = await migrated();
        try {
          // two roles share one questionnaire (made by the new code)
          const [a, b] = [seeded.roles[0], seeded.roles[1]];
          const shared = (await roleRow(h.db, a)).questionnaire_id;
          await h.db.run('UPDATE job_roles SET questionnaire_id = ? WHERE id = ?', [shared, b]);
          await h.db.run('UPDATE job_roles SET questions_json = ? WHERE id = ?', [(await roleRow(h.db, a)).questions_json, b]);
          assert.deepEqual(await qn.repair(h.db), { created: 0, cleared: 0 }, 'in step: nothing to do');
          // older version: role b saved with different questions (and does not touch questionnaire_id)
          await h.db.run('UPDATE job_roles SET questions_json = ? WHERE id = ?', [j([q('Edited by old code', true)]), b]);
          assert.deepEqual(await qn.repair(h.db), { created: 1, cleared: 0 });
          const roleB = await roleRow(h.db, b);
          assert.notEqual(roleB.questionnaire_id, shared);
          assert.deepEqual(qn.parseQuestions((await h.db.get('SELECT questions_json FROM questionnaires WHERE id = ?', [roleB.questionnaire_id])).questions_json), [{ text: 'Edited by old code', required: true }]);
          assert.equal((await roleRow(h.db, a)).questionnaire_id, shared, 'the other role keeps the shared questionnaire');
          assert.equal((await h.db.get('SELECT questions_json FROM questionnaires WHERE id = ?', [shared])).questions_json, ROLES[0][1], 'the shared questionnaire is untouched');
        } finally {
          await h.close();
        }
      });

      test('the older version clears a role\'s questions: the role loses its questionnaire (which stays for other roles)', async () => {
        const { h, seeded } = await migrated();
        try {
          const id = seeded.roles[0];
          const was = (await roleRow(h.db, id)).questionnaire_id;
          await h.db.run("UPDATE job_roles SET questions_json = '[]' WHERE id = ?", [id]);
          assert.deepEqual(await qn.repair(h.db), { created: 0, cleared: 1 });
          assert.equal((await roleRow(h.db, id)).questionnaire_id, null);
          assert.ok(await h.db.get('SELECT id FROM questionnaires WHERE id = ?', [was]), 'the questionnaire itself is kept');
          assert.deepEqual(await qn.repair(h.db), { created: 0, cleared: 0 });
        } finally {
          await h.close();
        }
      });

      test('the older version re-saving a role unchanged is not a change (the legacy copy is byte-identical)', async () => {
        const { h, seeded } = await migrated();
        try {
          for (const id of seeded.roles) {
            const r = await roleRow(h.db, id);
            // what the older admin form does on save: JSON.stringify of the trimmed questions it parsed
            if (r.questionnaire_id) await h.db.run('UPDATE job_roles SET questions_json = ?, updated_at = ? WHERE id = ?', [r.questions_json, T0, id]);
          }
          assert.deepEqual(await qn.repair(h.db), { created: 0, cleared: 0 });
        } finally {
          await h.close();
        }
      });

      test('through the real app: a restart repairs it, the role shows the older version\'s questions, and the repair is a no-op the next time', async () => {
        const { h, seeded } = await migrated();
        let t;
        try {
          const id = (await h.db.run("INSERT INTO job_roles (title, vertical, questions_json, created_at, updated_at) VALUES ('Old code role', 'NFL', ?, ?, ?)", [j([q('From the old deployment?', true)]), T0, T0])).lastInsertRowid;
          await h.db.run('UPDATE job_roles SET questions_json = ? WHERE id = ?', [j([q('Edited in the old deployment', true)]), seeded.roles[8]]);
          t = await startApp({ driver, dataDir: h.dir, fake: h.fake, ownFake: false });
          const c = t.client();
          assert.deepEqual(renderedQuestions((await c.get(`/roles/${id}`)).text), [{ text: 'From the old deployment?', required: true }]);
          assert.deepEqual(renderedQuestions((await c.get(`/roles/${seeded.roles[8]}`)).text), [{ text: 'Edited in the old deployment', required: true }]);
          assert.deepEqual(await qn.repair(t.db), { created: 0, cleared: 0 });
        } finally {
          if (t) await t.close({ keepData: true });
          await h.close();
        }
      });

      test('what the new code writes is what the older version reads: role save and questionnaire save keep job_roles.questions_json in step', async () => {
        const { h, seeded } = await migrated();
        let t;
        try {
          await makeUser(h.db, { email: 'boss@fansided.com', role: 'admin' });
          t = await startApp({ driver, dataDir: h.dir, fake: h.fake, ownFake: false });
          const admin = t.client();
          await admin.login('boss@fansided.com');
          const role = seeded.roles[0];
          const first = (await roleRow(t.db, role)).questionnaire_id;
          // edit the questionnaire: every role using it gets the new copy
          await t.db.run('UPDATE job_roles SET questionnaire_id = ? WHERE id = ?', [first, seeded.roles[1]]);
          await admin.get(`/app/admin/questionnaires/${first}`);
          assert.equal((await admin.post(`/app/admin/questionnaires/${first}`, { name: 'Shared set', q_text_0: 'Rewritten?', q_required_0: '1' })).status, 303);
          const copy = JSON.stringify([{ text: 'Rewritten?', required: true }]);
          for (const id of [role, seeded.roles[1]]) assert.equal((await roleRow(t.db, id)).questions_json, copy);
          // swap one role to another questionnaire, then to none
          const other = (await roleRow(t.db, seeded.roles[8])).questionnaire_id;
          await admin.get(`/app/admin/roles/${role}`);
          const body = { title: 'Chiefs writer', vertical: 'NFL', status: 'open', questionnaire_id: String(other) };
          assert.equal((await admin.post(`/app/admin/roles/${role}`, body)).status, 303);
          assert.equal((await roleRow(t.db, role)).questions_json, ROLES[8][1]);
          assert.equal((await admin.post(`/app/admin/roles/${role}`, { ...body, questionnaire_id: '' })).status, 303);
          const none = await roleRow(t.db, role);
          assert.equal(none.questions_json, '[]');
          assert.equal(none.questionnaire_id, null);
          assert.deepEqual(await qn.repair(t.db), { created: 0, cleared: 0 }, 'everything the new code wrote is in step');
        } finally {
          if (t) await t.close({ keepData: true });
          await h.close();
        }
      });
    });
  });
}

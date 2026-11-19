'use strict';
// Demo data for local development: node scripts/seed.js (uses DATA_DIR, default ./data).
// Safe to run more than once: it does nothing if the demo roles already exist.
const path = require('node:path');
const { loadConfig } = require('../src/lib/config');
const { openDb, migrate } = require('../src/lib/db');

const iso = (daysAgo, hours = 0) => new Date(Date.now() - daysAgo * 86400000 - hours * 3600000).toISOString();

async function main() {
  const config = loadConfig(process.env);
  const db = openDb(config);
  await migrate(db);
  const where = config.tursoUrl ? 'the Turso database' : path.resolve(config.dataDir);

  if (await db.get("SELECT 1 FROM job_roles WHERE title = 'NFL Team Site Contributor'")) {
    console.log(`Demo data already present in ${where}. Nothing to do.`);
    return;
  }

  // Users, roles and people first (their ids are needed below); then every application with its events and notes.
  const userSql = `INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, active = 1`;
  await db.batch([
    { sql: userSql, args: ['admin@fansided.com', 'Zach Admin', 'admin', iso(30)] },
    { sql: userSql, args: ['rep.one@fansided.com', 'Riley Rep', 'rep', iso(30)] },
    { sql: userSql, args: ['rep.two@fansided.com', 'Sam Rep', 'rep', iso(30)] },
  ]);
  const userId = async (email) => (await db.get('SELECT id FROM users WHERE email = ?', [email])).id;
  const admin = await userId('admin@fansided.com');
  const rep1 = await userId('rep.one@fansided.com');
  const rep2 = await userId('rep.two@fansided.com');

  const roleSql = `INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const roleDefs = [
    {
      key: 'nfl', args: [
        'NFL Team Site Contributor', 'NFL', 'Bears Wire',
        'Cover the Chicago Bears for one of our team sites.\n\nWhat you will do:\n- Write 3-5 news and analysis posts a week\n- Turn around breaking news quickly\n\nPaid per post, fully remote.',
        'open', rep1,
        JSON.stringify([
          { text: 'Why do you want to cover this team?', required: true },
          { text: 'How many posts a week could you commit to?', required: true },
          { text: 'Anything else we should know?', required: false },
        ]),
        iso(20), iso(20),
      ],
    },
    {
      key: 'nba', args: [
        'NBA Staff Writer', 'NBA', 'Hoops Habit',
        'Write league-wide NBA coverage: news, features and trade analysis.\n\nExperience with SEO-friendly writing is a plus.',
        'open', rep2,
        JSON.stringify([
          { text: 'Link or describe your favourite piece you have written.', required: true },
          { text: 'Which NBA storyline would you pitch first?', required: false },
        ]),
        iso(15), iso(15),
      ],
    },
    {
      key: 'mlb', args: [
        'MLB Prospects Analyst', 'MLB', 'Call to the Pen',
        'Scout and write about minor-league prospects across the league.',
        'closed', rep1,
        JSON.stringify([{ text: 'Name a prospect you think is underrated, and why.', required: true }]),
        iso(40), iso(5),
      ],
    },
  ];
  const roleIds = {};
  const roleQuestions = {};
  for (const r of roleDefs) {
    roleIds[r.key] = (await db.run(roleSql, r.args)).lastInsertRowid;
    roleQuestions[r.key] = JSON.parse(r.args[6]);
  }
  const { nfl, nba, mlb } = roleIds;
  const answersFor = (key, texts) => JSON.stringify(roleQuestions[key].map((q, i) => ({ question: q.text, answer: texts[i] || '' })));

  const personSql = 'INSERT INTO people (email, name, linkedin_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';
  const p1 = (await db.run(personSql, ['jordan.lee@example.com', 'Jordan Lee', 'https://www.linkedin.com/in/jordanlee', iso(12), iso(3)])).lastInsertRowid;
  const p2 = (await db.run(personSql, ['casey.morgan@example.com', 'Casey Morgan', '', iso(9), iso(9)])).lastInsertRowid;
  const p3 = (await db.run(personSql, ['alex.kim@example.com', 'Alex Kim', 'https://alexkim.example.com', iso(30), iso(30)])).lastInsertRowid;
  const p4 = (await db.run(personSql, ['taylor.ortiz@example.com', 'Taylor Ortiz', '', iso(1), iso(1)])).lastInsertRowid;

  const appSql = `INSERT INTO applications (person_id, role_id, stage, sample_links, answers_json, heard_from, source_tag, applied_at, stage_changed_at, onboarded_at, voltax_user_id, voltax_onboarded_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const eventSql = 'INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at) VALUES (?, ?, ?, ?, ?, ?)';

  // stages: list of [stage, daysAgo, actor] after the initial "new"
  async function apply(personId, roleId, roleKey, daysAgo, { stages = [], heard = 'LinkedIn', source = '', answers = [] } = {}) {
    const applied = iso(daysAgo);
    let stage = 'new';
    let changed = applied;
    const events = [['stage_change', null, 'new', null, applied]];
    for (const [to, ago, actor] of stages) {
      changed = iso(ago);
      events.push(['stage_change', stage, to, actor, changed]);
      stage = to;
    }
    const onboarded = stage === 'onboarded';
    const voltaxOn = changed.slice(0, 10);
    if (onboarded) events.push(['voltax_recorded', null, `vx-10234 (onboarded ${voltaxOn})`, stages[stages.length - 1][2], changed]);
    const id = (
      await db.run(appSql, [
        personId, roleId, stage, 'https://example.com/my-best-post\nhttps://example.com/another-post', answersFor(roleKey, answers), heard, source, applied, changed,
        onboarded ? changed : null, onboarded ? 'vx-10234' : null, onboarded ? voltaxOn : null,
      ])
    ).lastInsertRowid;
    await db.batch(events.map(([type, from, to, actor, at]) => ({ sql: eventSql, args: [id, type, from, to, actor, at] })));
    return id;
  }

  const a1 = await apply(p1, nfl, 'nfl', 12, { stages: [['reviewing', 10, rep1], ['trial', 6, rep1]], source: 'linkedin-nfl', answers: ['Lifelong Bears fan.', 'Four a week.'] });
  await apply(p1, nba, 'nba', 3, { heard: 'Referral', answers: ['My piece on the trade deadline.'] });
  await apply(p2, nfl, 'nfl', 9, { heard: 'Indeed', answers: ['I grew up in Chicago.', 'Three.'] });
  const a3 = await apply(p3, mlb, 'mlb', 30, { stages: [['reviewing', 28, rep1], ['trial', 25, rep1], ['onboarded', 20, admin]], heard: 'FanSided site', answers: ['A shortstop in Double-A.'] });
  await apply(p4, nba, 'nba', 1, { heard: 'X/Twitter', source: 'twitter-nba', answers: ['A breakdown of pick-and-roll defence.', 'The MVP race.'] });

  const noteSql = 'INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at) VALUES (?, ?, (SELECT role_id FROM applications WHERE id = ?), ?, ?, ?)';
  await db.batch([
    { sql: noteSql, args: [p1, a1, a1, rep1, 'Strong first sample. Sent the trial brief.', iso(6)] },
    { sql: noteSql, args: [p3, a3, a3, admin, 'Onboarded; Voltax account created by hand.', iso(20)] },
  ]);

  console.log(`Seeded demo data into ${where}:
  admin  admin@fansided.com
  reps   rep.one@fansided.com, rep.two@fansided.com
  3 roles (2 open, 1 closed), 4 people, 5 applications.
Start with: npm run dev   then open http://localhost:3000/login`);
  await db.close();
}

main().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});

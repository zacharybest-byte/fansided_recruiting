'use strict';
// Demo data for local development: node scripts/seed.js (uses DATA_DIR, default ./data).
// Safe to run more than once: it does nothing if the demo roles already exist.
const path = require('node:path');
const { openDb, transaction } = require('../src/lib/db');

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const db = openDb(dataDir);

if (db.prepare("SELECT 1 FROM job_roles WHERE title = 'NFL Team Site Contributor'").get()) {
  console.log(`Demo data already present in ${dataDir}. Nothing to do.`);
  process.exit(0);
}

const iso = (daysAgo, hours = 0) => new Date(Date.now() - daysAgo * 86400000 - hours * 3600000).toISOString();

transaction(db, () => {
  const upsertUser = db.prepare(
    `INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, active = 1`
  );
  const userId = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  upsertUser.run('admin@fansided.com', 'Zach Admin', 'admin', iso(30));
  upsertUser.run('rep.one@fansided.com', 'Riley Rep', 'rep', iso(30));
  upsertUser.run('rep.two@fansided.com', 'Sam Rep', 'rep', iso(30));
  const admin = userId('admin@fansided.com');
  const rep1 = userId('rep.one@fansided.com');
  const rep2 = userId('rep.two@fansided.com');

  // Make sure the four standard templates exist (the migration adds them on a fresh database).
  if (db.prepare('SELECT COUNT(*) AS n FROM email_templates').get().n === 0) {
    const t = db.prepare('INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)');
    t.run('Thanks for applying', 'Thanks for applying to FanSided', 'Hi {{first_name}},\n\nThanks for applying for {{role_title}}.\n\n{{rep_name}}', iso(0));
  }

  const role = db.prepare(
    `INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const nfl = role.run(
    'NFL Team Site Contributor', 'NFL', 'Bears Wire',
    'Cover the Chicago Bears for one of our team sites.\n\nWhat you will do:\n- Write 3-5 news and analysis posts a week\n- Turn around breaking news quickly\n\nPaid per post, fully remote.',
    'open', rep1,
    JSON.stringify([
      { text: 'Why do you want to cover this team?', required: true },
      { text: 'How many posts a week could you commit to?', required: true },
      { text: 'Anything else we should know?', required: false },
    ]),
    iso(20), iso(20)
  ).lastInsertRowid;
  const nba = role.run(
    'NBA Staff Writer', 'NBA', 'Hoops Habit',
    'Write league-wide NBA coverage: news, features and trade analysis.\n\nExperience with SEO-friendly writing is a plus.',
    'open', rep2,
    JSON.stringify([
      { text: 'Link or describe your favourite piece you have written.', required: true },
      { text: 'Which NBA storyline would you pitch first?', required: false },
    ]),
    iso(15), iso(15)
  ).lastInsertRowid;
  const mlb = role.run(
    'MLB Prospects Analyst', 'MLB', 'Call to the Pen',
    'Scout and write about minor-league prospects across the league.',
    'closed', rep1,
    JSON.stringify([{ text: 'Name a prospect you think is underrated, and why.', required: true }]),
    iso(40), iso(5)
  ).lastInsertRowid;

  const person = db.prepare('INSERT INTO people (email, name, linkedin_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const application = db.prepare(
    `INSERT INTO applications (person_id, role_id, stage, sample_links, answers_json, heard_from, source_tag, applied_at, stage_changed_at, onboarded_at, voltax_user_id, voltax_onboarded_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const event = db.prepare('INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at) VALUES (?, ?, ?, ?, ?, ?)');
  const note = db.prepare(
    'INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at) VALUES (?, ?, (SELECT role_id FROM applications WHERE id = ?), ?, ?, ?)'
  );

  const roleQuestions = (id) => JSON.parse(db.prepare('SELECT questions_json FROM job_roles WHERE id = ?').get(id).questions_json);
  const answersFor = (id, texts) => JSON.stringify(roleQuestions(id).map((q, i) => ({ question: q.text, answer: texts[i] || '' })));

  // stages: list of [stage, daysAgo, actor] after the initial "new"
  function apply(personId, roleId, daysAgo, { stages = [], heard = 'LinkedIn', source = '', answers = [] } = {}) {
    const applied = iso(daysAgo);
    let stage = 'new';
    let changed = applied;
    const id = application.run(personId, roleId, 'new', 'https://example.com/my-best-post\nhttps://example.com/another-post',
      answersFor(roleId, answers), heard, source, applied, applied, null, null, null).lastInsertRowid;
    event.run(id, 'stage_change', null, 'new', null, applied);
    for (const [to, ago, actor] of stages) {
      changed = iso(ago);
      event.run(id, 'stage_change', stage, to, actor, changed);
      stage = to;
    }
    db.prepare('UPDATE applications SET stage = ?, stage_changed_at = ? WHERE id = ?').run(stage, changed, id);
    if (stage === 'onboarded') {
      db.prepare("UPDATE applications SET onboarded_at = ?, voltax_user_id = 'vx-10234', voltax_onboarded_on = ? WHERE id = ?").run(changed, changed.slice(0, 10), id);
      event.run(id, 'voltax_recorded', null, `vx-10234 (onboarded ${changed.slice(0, 10)})`, stages[stages.length - 1][2], changed);
    }
    return id;
  }

  const p1 = person.run('jordan.lee@example.com', 'Jordan Lee', 'https://www.linkedin.com/in/jordanlee', iso(12), iso(3)).lastInsertRowid;
  const p2 = person.run('casey.morgan@example.com', 'Casey Morgan', '', iso(9), iso(9)).lastInsertRowid;
  const p3 = person.run('alex.kim@example.com', 'Alex Kim', 'https://alexkim.example.com', iso(30), iso(30)).lastInsertRowid;
  const p4 = person.run('taylor.ortiz@example.com', 'Taylor Ortiz', '', iso(1), iso(1)).lastInsertRowid;

  const a1 = apply(p1, nfl, 12, { stages: [['reviewing', 10, rep1], ['trial', 6, rep1]], source: 'linkedin-nfl', answers: ['Lifelong Bears fan.', 'Four a week.'] });
  apply(p1, nba, 3, { heard: 'Referral', answers: ['My piece on the trade deadline.'] });
  note.run(p1, a1, a1, rep1, 'Strong first sample. Sent the trial brief.', iso(6));
  apply(p2, nfl, 9, { heard: 'Indeed', answers: ['I grew up in Chicago.', 'Three.'] });
  const a3 = apply(p3, mlb, 30, { stages: [['reviewing', 28, rep1], ['trial', 25, rep1], ['onboarded', 20, admin]], heard: 'FanSided site', answers: ['A shortstop in Double-A.'] });
  note.run(p3, a3, a3, admin, 'Onboarded; Voltax account created by hand.', iso(20));
  apply(p4, nba, 1, { heard: 'X/Twitter', source: 'twitter-nba', answers: ['A breakdown of pick-and-roll defence.', 'The MVP race.'] });
});

console.log(`Seeded demo data into ${dataDir}:
  admin  admin@fansided.com
  reps   rep.one@fansided.com, rep.two@fansided.com
  3 roles (2 open, 1 closed), 4 people, 5 applications.
Start with: npm run dev   then open http://localhost:3000/login`);

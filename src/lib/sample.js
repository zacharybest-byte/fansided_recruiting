'use strict';
// Demo data for the team demo: clearly fake roles and people (example.com), flagged is_sample = 1.
// Load and Remove are each ONE db.batch. Ids are found with subselects on the unique sample email / role title,
// so the same statements work on both database drivers.
const DAY = 86400000;

const ROLES = [
  {
    title: 'Sample: NFL Staff Writer (demo)',
    vertical: 'NFL',
    site: 'Sample Gridiron Site',
    description: 'Demo role created by "Load sample data". Safe to delete with "Remove sample data".',
    questions: [
      { text: 'Which NFL storyline are you following most closely this season, and why?', required: true },
      { text: 'Link your best piece of game analysis and tell us what you are proud of.', required: false },
    ],
  },
  {
    title: 'Sample: NBA Contributor (demo)',
    vertical: 'NBA',
    site: 'Sample Hardwood Site',
    description: 'Demo role created by "Load sample data".',
    questions: [{ text: 'Pitch us one story idea for this week.', required: true }],
  },
  {
    title: 'Sample: Soccer Newsletter Editor (demo)',
    vertical: 'Soccer',
    site: 'Sample Pitch Site',
    description: 'Demo role created by "Load sample data".',
    questions: [
      { text: 'How would you structure a weekly transfer-news newsletter?', required: true },
      { text: 'Which leagues do you know best?', required: false },
    ],
  },
];

const NAMES = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
const STAGES = ['new', 'new', 'new', 'reviewing', 'reviewing', 'trial', 'onboarded', 'passed'];
const HEARD = ['LinkedIn', 'Indeed', 'Referral', 'X/Twitter', 'FanSided site', 'Other', 'LinkedIn', 'Referral'];

function samplePeople(now) {
  return NAMES.map((n, i) => {
    const role = ROLES[i % ROLES.length];
    const appliedAt = new Date(now - (i + 1) * 2 * DAY).toISOString();
    return {
      email: `sample.${n.toLowerCase()}@example.com`,
      name: `Sample Applicant ${n} (demo)`,
      linkedin: `https://example.com/in/sample-${n.toLowerCase()}`,
      role,
      stage: STAGES[i],
      heard: HEARD[i],
      appliedAt,
      changedAt: STAGES[i] === 'new' ? appliedAt : new Date(now - (i + 1) * DAY).toISOString(),
      links: `https://example.com/sample-${n.toLowerCase()}/post-1\nhttps://example.com/sample-${n.toLowerCase()}/post-2`,
      resume: i % 2 === 0 ? `https://example.com/sample-${n.toLowerCase()}/resume` : '',
      answers: role.questions.map((q) => ({ question: q.text, answer: `Sample answer from applicant ${n.toLowerCase()}. This is demo text.` })),
    };
  });
}

async function sampleCounts(db) {
  const r = await db.get(
    `SELECT (SELECT COUNT(*) FROM job_roles WHERE is_sample = 1) AS roles,
            (SELECT COUNT(*) FROM people WHERE is_sample = 1) AS people,
            (SELECT COUNT(*) FROM applications a JOIN people p ON p.id = a.person_id WHERE p.is_sample = 1) AS applications`
  );
  return { roles: r.roles, people: r.people, applications: r.applications, loaded: r.roles > 0 || r.people > 0 };
}

// Returns { ok: false } when sample data already exists, otherwise inserts it in one batch.
async function loadSample(db, actorId, nowMs = Date.now()) {
  if ((await sampleCounts(db)).loaded) return { ok: false };
  const nowIso = new Date(nowMs).toISOString();
  const people = samplePeople(nowMs);
  const stmts = [];
  for (const r of ROLES) {
    stmts.push({
      sql: `INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, is_sample, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'open', ?, ?, 1, ?, ?)`,
      args: [r.title, r.vertical, r.site, r.description, actorId, JSON.stringify(r.questions), nowIso, nowIso],
    });
  }
  for (const p of people) {
    stmts.push({
      sql: 'INSERT INTO people (email, name, linkedin_url, is_sample, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      args: [p.email, p.name, p.linkedin, p.appliedAt, p.appliedAt],
    });
  }
  for (const p of people) {
    stmts.push({
      sql: `INSERT INTO applications (person_id, role_id, stage, sample_links, resume_url, answers_json, heard_from, source_tag, applied_at, stage_changed_at, onboarded_at)
            SELECT pe.id, r.id, ?, ?, ?, ?, ?, 'sample', ?, ?, ? FROM people pe, job_roles r WHERE pe.email = ? AND r.title = ? AND r.is_sample = 1`,
      args: [p.stage, p.links, p.resume, JSON.stringify(p.answers), p.heard, p.appliedAt, p.changedAt, p.stage === 'onboarded' ? p.changedAt : null, p.email, p.role.title],
    });
    const events = [[null, 'new', null, p.appliedAt]];
    if (p.stage !== 'new') events.push(['new', p.stage, actorId, p.changedAt]);
    for (const [from, to, actor, at] of events) {
      stmts.push({
        sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
              SELECT a.id, 'stage_change', ?, ?, ?, ? FROM applications a JOIN people pe ON pe.id = a.person_id WHERE pe.email = ? AND pe.is_sample = 1`,
        args: [from, to, actor, at, p.email],
      });
    }
  }
  const notes = [
    [people[3], 'Sample note: strong clips, worth a call. (demo)'],
    [people[5], 'Sample note: trial piece due Friday. (demo)'],
  ];
  for (const [p, body] of notes) {
    stmts.push({
      sql: `INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at)
            SELECT pe.id, a.id, a.role_id, ?, ?, ? FROM applications a JOIN people pe ON pe.id = a.person_id WHERE pe.email = ? AND pe.is_sample = 1`,
      args: [actorId, body, nowIso, p.email],
    });
  }
  await db.batch(stmts);
  return { ok: true, people: people.length, roles: ROLES.length };
}

// One batch. Sample roles that still hold real applications (or notes/emails from real people) are closed and
// converted to normal roles instead of being deleted. No deletion_log rows are written.
async function removeSample(db) {
  const samplePeopleIds = 'SELECT id FROM people WHERE is_sample = 1';
  const sampleAppIds = `SELECT id FROM applications WHERE person_id IN (${samplePeopleIds})`;
  await db.batch([
    { sql: `DELETE FROM emails_sent WHERE person_id IN (${samplePeopleIds})` },
    { sql: `DELETE FROM notes WHERE person_id IN (${samplePeopleIds})` },
    { sql: `DELETE FROM application_events WHERE application_id IN (${sampleAppIds})` },
    { sql: `DELETE FROM applications WHERE person_id IN (${samplePeopleIds})` },
    { sql: 'DELETE FROM people WHERE is_sample = 1' },
    {
      sql: `DELETE FROM job_roles WHERE is_sample = 1
              AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.role_id = job_roles.id)
              AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.role_id = job_roles.id)
              AND NOT EXISTS (SELECT 1 FROM emails_sent m WHERE m.role_id = job_roles.id)`,
    },
    { sql: "UPDATE job_roles SET status = 'closed', is_sample = 0 WHERE is_sample = 1" },
  ]);
}

module.exports = { loadSample, removeSample, sampleCounts, ROLES };

'use strict';
// Demo records for the team: realistic roles and people, flagged is_sample = 1. Sample people use the reserved
// non-deliverable domain SAMPLE_DOMAIN, which the public apply form refuses, so a real applicant can never
// attach to (or collide with) a sample person.
// Load and Remove are each ONE db.batch. Ids are found with subselects on the unique sample email / role title,
// so the same statements work on both database drivers.
const { stageRows, insertStagesWhere, legacyCategory, DEFAULT_PROGRESS } = require('./stages');
const { serialise } = require('./questionnaires');

const DAY = 86400000;
const SAMPLE_DOMAIN = 'sample.invalid';

// Three questionnaires shared across the six roles, so the demo shows one set of questions serving several roles.
const QUESTIONNAIRES = {
  team: {
    name: 'Team site contributor',
    questions: [
      { text: 'Which storyline around your team are you following most closely this season, and why?', required: true },
      { text: 'Link your best piece of game or team analysis and tell us what you are proud of.', required: false },
      { text: 'How many hours a week can you commit during the season?', required: false },
    ],
  },
  league: {
    name: 'League-wide writer',
    questions: [
      { text: 'What would you pitch in your first two weeks, and why would readers care?', required: true },
      { text: 'Which beats, teams or clubs do you know best?', required: false },
    ],
  },
  entertainment: {
    name: 'Entertainment writer',
    questions: [
      { text: 'Which show or franchise deserves more attention than it is getting, and why?', required: true },
      { text: 'How do you keep up with news across the streaming services?', required: false },
    ],
  },
};

const ROLES = [
  {
    title: 'Kansas City Chiefs contributor',
    vertical: 'NFL',
    site: 'Arrowhead Addict',
    description:
      'Arrowhead Addict covers the Chiefs every day of the year, from training camp reports to film breakdowns and draft coverage. We are adding a contributor who can turn out two or three sharp articles a week during the season.\n\nYou will pitch your own angles, work with an editor on headlines and structure, and be paid per article plus traffic bonuses.',
    questionnaire: 'team',
  },
  {
    title: 'Los Angeles Lakers contributor',
    vertical: 'NBA',
    site: 'Lake Show Life',
    description:
      'Lake Show Life is looking for a Lakers writer who can balance quick news reaction with deeper pieces on lineups, trades and the salary cap. Evening game coverage is a regular part of the job.\n\nThis is a freelance position with room to grow into a lead writer role.',
    questionnaire: 'team',
  },
  {
    title: 'New York Yankees contributor',
    progress: ['Reviewing', 'Edit test', 'Trial'],
    vertical: 'MLB',
    site: 'Yanks Go Yard',
    description:
      'Yanks Go Yard needs a writer who knows the Bronx beat inside out. You will cover games, prospects and the offseason, and help us stand out with original analysis rather than recaps.\n\nWe are happy to hear from newer writers with a strong baseball eye.',
    questionnaire: 'team',
  },
  {
    title: 'SEC football writer',
    vertical: 'College',
    site: 'Saturday Blitz',
    description:
      'Saturday Blitz covers college football every week of the fall, with a focus on the SEC. We want a writer who can preview and review big games, track the recruiting cycle and write rankings people argue about.\n\nWeekend availability is essential.',
    questionnaire: 'league',
  },
  {
    title: 'Premier League writer',
    progress: ['Phone screen', 'Trial'],
    vertical: 'Soccer',
    site: 'Playing for 90',
    description:
      'Playing for 90 is a Premier League site for fans who want tactics and context, not just scorelines. We are hiring a writer to cover match days, transfer news and the title and relegation races.\n\nEarly weekend mornings are part of the schedule, so a UK or European time zone helps.',
    questionnaire: 'league',
  },
  {
    title: 'TV and streaming writer',
    vertical: 'Entertainment',
    site: 'Hidden Remote',
    description:
      'Hidden Remote covers television and streaming: renewals, cancellations, premiere dates and the shows people are talking about. We are looking for a writer who can spot a story early and write it clearly.\n\nYou will work with an editor to plan a weekly schedule of news and features.',
    questionnaire: 'entertainment',
  },
];

// Each role carries its questionnaire's questions too (the sample candidates answered them).
for (const r of ROLES) r.questions = QUESTIONNAIRES[r.questionnaire].questions;

// [name, role index, stage NAME in that role's workflow, heard from, source tag, days since applied, days in current stage]
const PEOPLE = [
  ['Marcus Bennett', 0, 'New', 'LinkedIn', 'linkedin', 1, 1],
  ['Priya Nair', 1, 'New', 'FanSided site', 'site', 2, 2],
  ['Daniel Okafor', 2, 'New', 'X/Twitter', 'x', 3, 3],
  ['Hannah Lindqvist', 4, 'New', 'Indeed', 'indeed', 5, 5],
  ['Tyler Reyes', 3, 'New', 'Referral', 'referral', 6, 6],
  ['Sofia Marchetti', 5, 'Reviewing', 'LinkedIn', 'linkedin', 9, 4],
  ['Jamal Whitfield', 0, 'Reviewing', 'Indeed', 'indeed', 11, 6],
  ['Emily Carter', 2, 'Edit test', 'X/Twitter', 'x', 14, 8],
  ['Noah Fitzgerald', 1, 'Reviewing', 'Referral', 'referral', 16, 10],
  ['Aaliyah Brooks', 3, 'Trial', 'FanSided site', 'site', 19, 5],
  ['Connor Walsh', 4, 'Phone screen', 'LinkedIn', 'linkedin', 21, 7],
  ['Grace Tanaka', 5, 'Trial', 'Referral', 'referral', 23, 9],
  ['Luis Hernandez', 0, 'Onboarded', 'X/Twitter', 'x', 26, 12],
  ['Megan Foster', 2, 'Onboarded', 'Indeed', 'indeed', 28, 15],
  ['Owen Mitchell', 1, 'Onboarded', 'LinkedIn', 'linkedin', 30, 18],
  ['Rachel Goldberg', 3, 'Passed', 'Indeed', 'indeed', 17, 8],
  ['Victor Santos', 4, 'Passed', 'FanSided site', 'site', 24, 14],
  ['Chloe Pierce', 5, 'Passed', 'Other', 'other', 29, 20],
];

// Earlier applications by people who are in PEOPLE above (so the candidate page shows an application history):
// [person index in PEOPLE, role index, stage NAME in that role, days since applied, days since the outcome, notes]
const PRIOR = [
  [4, 4, 'Passed', 140, 118, [
    ['Pitches read as recaps rather than analysis. Worth another look once there is a stronger tactical sample.', 118],
    ['Fast to reply and easy to work with. No concerns about reliability.', 119],
  ]],
  [2, 1, 'Onboarded', 210, 196, [
    ['Onboarded for the season. Reliable on deadlines, strong on lineup analysis.', 196],
    ['Stepped back in June after moving cities. Happy to hear from him again.', 90],
  ]],
];

const ANSWERS = [
  [
    'The way the offence has changed around the tight end spot. I think it explains most of the early-season swings.',
    'My piece on third-down play calling last season, which got picked up by a few local podcasts.',
    'Ten to twelve, more in game weeks.',
  ],
  [
    'How the second unit holds up when the starters sit. I would pull minutes data from the last month.',
    'A breakdown of the Lakers closing lineups, with the numbers behind each one.',
    'Around eight, more on game nights.',
  ],
  [
    'The bullpen has been used in a very different way this month. I would chart rest days against results.',
    'A piece on a Double-A infielder who has quietly cut his strikeouts in half.',
    'Ten or so, and I can do evenings.',
  ],
  [
    'Which mid-table programs the rankings misjudge. A weekly list with the reasons would travel well.',
    'The SEC and a little of the Big 12. I ran recruiting notes for a small site for two seasons.',
  ],
  [
    'A running list of what is rumour and what is reported in the transfer window, one club per week.',
    'Mostly the top six, plus a soft spot for the promoted sides.',
  ],
  [
    'A comedy that was cancelled after two seasons and still has a loyal audience.',
    'Trade newsletters, official press pages and a few reliable accounts.',
  ],
];

function samplePeople(now) {
  return PEOPLE.map(([name, roleIndex, stage, heard, tag, ago, inStage], i) => {
    const [first, last] = name.toLowerCase().split(' ');
    const role = ROLES[roleIndex];
    const row = stageRows(role.progress || DEFAULT_PROGRESS).find(([, n]) => n === stage);
    const appliedAt = new Date(now - ago * DAY - (i % 5) * 3600000).toISOString();
    const changedAt = stage === 'New' ? appliedAt : new Date(now - Math.min(inStage, ago - 1) * DAY).toISOString();
    return {
      email: `${first}.${last}@${SAMPLE_DOMAIN}`,
      name,
      linkedin: `https://www.linkedin.com/in/${first}-${last}`,
      role,
      stage,
      kind: row[2],
      heard,
      tag,
      appliedAt,
      changedAt,
      links: `https://example.com/${first}-${last}/clips/1\nhttps://example.com/${first}-${last}/clips/2`,
      resume: i % 3 === 0 ? `https://example.com/${first}-${last}/resume` : '',
      answers: role.questions.map((q, n) => ({ question: q.text, answer: ANSWERS[roleIndex][n] || 'Happy to talk this through on a call.' })),
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

// Returns { ok: false } when sample data already exists, otherwise inserts it in one batch. The first insert is
// guarded in SQL by "no sample data yet"; if a concurrent load got there first, the people inserts hit the unique
// email, the whole batch rolls back and the result is { ok: false, failed: true } (never an exception).
async function loadSample(db, actorId, nowMs = Date.now()) {
  if ((await sampleCounts(db)).loaded) return { ok: false };
  const nowIso = new Date(nowMs).toISOString();
  const people = samplePeople(nowMs);
  const stmts = [];
  // The shared questionnaires first. A questionnaire that already exists under the same name (made by an admin) is
  // used as it is and never marked as sample data, so removing the sample data cannot touch it.
  for (const q of Object.values(QUESTIONNAIRES)) {
    stmts.push({
      sql: 'INSERT INTO questionnaires (name, questions_json, is_sample, created_at, updated_at) SELECT ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM questionnaires WHERE name = ? COLLATE NOCASE)',
      args: [q.name, serialise(q.questions), nowIso, nowIso, q.name],
    });
  }
  for (const r of ROLES) {
    const qName = QUESTIONNAIRES[r.questionnaire].name;
    stmts.push({
      sql: `INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, questionnaire_id, is_sample, created_at, updated_at)
            SELECT ?, ?, ?, ?, 'open', ?,
                   COALESCE((SELECT questions_json FROM questionnaires WHERE name = ? COLLATE NOCASE), '[]'),
                   (SELECT id FROM questionnaires WHERE name = ? COLLATE NOCASE), 1, ?, ? ${stmts.length === Object.keys(QUESTIONNAIRES).length ? "WHERE NOT EXISTS (SELECT 1 FROM job_roles WHERE is_sample = 1) AND NOT EXISTS (SELECT 1 FROM people WHERE is_sample = 1)" : ''}`,
      args: [r.title, r.vertical, r.site, r.description, actorId, qName, qName, nowIso, nowIso],
    });
  }
  // Each sample role gets its workflow (two of them differ from the default so the demo shows the feature).
  for (const r of ROLES) stmts.push(...insertStagesWhere(r.progress || DEFAULT_PROGRESS, 'title = ? AND is_sample = 1', [r.title], nowIso));
  for (const p of people) {
    stmts.push({
      sql: 'INSERT INTO people (email, name, linkedin_url, is_sample, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
      args: [p.email, p.name, p.linkedin, p.appliedAt, p.appliedAt],
    });
  }
  for (const p of people) {
    stmts.push({
      sql: `INSERT INTO applications (person_id, role_id, stage, stage_id, sample_links, resume_url, answers_json, heard_from, source_tag, applied_at, stage_changed_at, onboarded_at)
            SELECT pe.id, r.id, ?, (SELECT s.id FROM role_stages s WHERE s.role_id = r.id AND s.name = ?), ?, ?, ?, ?, ?, ?, ?, ? FROM people pe, job_roles r WHERE pe.email = ? AND r.title = ? AND r.is_sample = 1`,
      args: [legacyCategory(p.kind), p.stage, p.links, p.resume, JSON.stringify(p.answers), p.heard, p.tag, p.appliedAt, p.changedAt, p.kind === 'onboarded' ? p.changedAt : null, p.email, p.role.title],
    });
    const events = [[null, 'New', null, p.appliedAt]];
    if (p.kind !== 'new') events.push(['New', p.stage, actorId, p.changedAt]);
    for (const [from, to, actor, at] of events) {
      stmts.push({
        sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
              SELECT a.id, 'stage_change', ?, ?, ?, ? FROM applications a JOIN people pe ON pe.id = a.person_id WHERE pe.email = ? AND pe.is_sample = 1`,
        args: [from, to, actor, at, p.email],
      });
    }
  }
  const notes = [
    [people[6], 'Strong clips and a clear voice. Worth a call this week.'],
    [people[9], 'Trial piece due Friday. Asked for a Sunday slot.'],
    [people[12], 'Onboarded. Needs a Voltax login before the first article.'],
    [people[15], 'Good writer, but cannot commit to weekends this season. Keep for spring.'],
  ];
  for (const [p, body] of notes) {
    stmts.push({
      sql: `INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at)
            SELECT pe.id, a.id, a.role_id, ?, ?, ? FROM applications a JOIN people pe ON pe.id = a.person_id WHERE pe.email = ? AND pe.is_sample = 1`,
      args: [actorId, body, nowIso, p.email],
    });
  }
  // Earlier applications (with their own events and notes), so the demo shows the application history panel.
  for (const [pi, ri, stage, applied, outcome, priorNotes] of PRIOR) {
    const p = people[pi];
    const role = ROLES[ri];
    const kind = stageRows(role.progress || DEFAULT_PROGRESS).find(([, n]) => n === stage)[2];
    const appliedAt = new Date(nowMs - applied * DAY).toISOString();
    const changedAt = new Date(nowMs - outcome * DAY).toISOString();
    const where = 'pe.email = ? AND pe.is_sample = 1 AND r.title = ? AND r.is_sample = 1';
    stmts.push({
      sql: `INSERT INTO applications (person_id, role_id, stage, stage_id, sample_links, resume_url, answers_json, heard_from, source_tag, applied_at, stage_changed_at, onboarded_at)
            SELECT pe.id, r.id, ?, (SELECT s.id FROM role_stages s WHERE s.role_id = r.id AND s.name = ?), ?, '', ?, ?, ?, ?, ?, ? FROM people pe, job_roles r WHERE ${where}`,
      args: [legacyCategory(kind), stage, p.links, JSON.stringify(role.questions.map((q) => ({ question: q.text, answer: 'Happy to talk this through on a call.' }))), p.heard, p.tag, appliedAt, changedAt, kind === 'onboarded' ? changedAt : null, p.email, role.title],
    });
    for (const [from, to, actor, at] of [[null, 'New', null, appliedAt], ['New', stage, actorId, changedAt]]) {
      stmts.push({
        sql: `INSERT INTO application_events (application_id, type, from_value, to_value, actor_user_id, at)
              SELECT a.id, 'stage_change', ?, ?, ?, ? FROM applications a JOIN people pe ON pe.id = a.person_id JOIN job_roles r ON r.id = a.role_id WHERE ${where}`,
        args: [from, to, actor, at, p.email, role.title],
      });
    }
    for (const [body, daysAgo] of priorNotes) {
      stmts.push({
        sql: `INSERT INTO notes (person_id, application_id, role_id, author_user_id, body, created_at)
              SELECT pe.id, a.id, a.role_id, ?, ?, ? FROM applications a JOIN people pe ON pe.id = a.person_id JOIN job_roles r ON r.id = a.role_id WHERE ${where}`,
        args: [actorId, body, new Date(nowMs - daysAgo * DAY).toISOString(), p.email, role.title],
      });
    }
  }
  try {
    await db.batch(stmts);
  } catch {
    return { ok: false, failed: true };
  }
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
    // Stages of the sample roles that are about to be deleted (same conditions as the delete below).
    {
      sql: `DELETE FROM role_stages WHERE role_id IN (SELECT id FROM job_roles WHERE is_sample = 1
              AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.role_id = job_roles.id)
              AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.role_id = job_roles.id)
              AND NOT EXISTS (SELECT 1 FROM emails_sent m WHERE m.role_id = job_roles.id))`,
    },
    {
      sql: `DELETE FROM job_roles WHERE is_sample = 1
              AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.role_id = job_roles.id)
              AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.role_id = job_roles.id)
              AND NOT EXISTS (SELECT 1 FROM emails_sent m WHERE m.role_id = job_roles.id)`,
    },
    { sql: "UPDATE job_roles SET status = 'closed', is_sample = 0 WHERE is_sample = 1" },
    // Sample questionnaires go with the sample roles, unless a role (a kept sample role, or a real one an admin pointed
    // at it) still uses them: those are kept and become ordinary questionnaires.
    { sql: 'DELETE FROM questionnaires WHERE is_sample = 1 AND NOT EXISTS (SELECT 1 FROM job_roles r WHERE r.questionnaire_id = questionnaires.id)' },
    { sql: 'UPDATE questionnaires SET is_sample = 0 WHERE is_sample = 1' },
  ]);
}

const PEOPLE_COUNT = PEOPLE.length;

module.exports = { loadSample, removeSample, sampleCounts, ROLES, PEOPLE_COUNT, SAMPLE_DOMAIN };

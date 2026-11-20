'use strict';
// Numbered migrations, tracked in schema_migrations(version, applied_at).
// Each migration is a list of single statements applied as ONE atomic db.batch together with its
// tracking row, so a concurrent second runner fails cleanly (primary key conflict / object exists),
// re-reads the version and carries on. No multi-statement strings, no PRAGMA user_version.
const { nowIso } = require('./common');

const BASELINE = [
  `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('admin','rep')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    password_hash TEXT,
    password_changed_at TEXT,
    dashboard_seen_at TEXT,
    created_at TEXT NOT NULL
  )`,
  // token_hash = SHA-256 of the cookie token; the token itself is never stored.
  `CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  'CREATE INDEX sessions_user ON sessions(user_id)',
  // Invite and password-reset links. token_hash = SHA-256 of the link token.
  `CREATE TABLE auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX auth_tokens_user ON auth_tokens(user_id)',
  `CREATE TABLE job_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    vertical TEXT NOT NULL DEFAULT '',
    site_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    assigned_user_id INTEGER REFERENCES users(id),
    questions_json TEXT NOT NULL DEFAULT '[]',
    is_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    linkedin_url TEXT NOT NULL DEFAULT '',
    is_sample INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id),
    role_id INTEGER NOT NULL REFERENCES job_roles(id),
    applicant_name TEXT NOT NULL DEFAULT '',
    applicant_linkedin TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','reviewing','trial','onboarded','passed')),
    sample_links TEXT NOT NULL DEFAULT '',
    resume_url TEXT NOT NULL DEFAULT '',
    answers_json TEXT NOT NULL DEFAULT '[]',
    heard_from TEXT NOT NULL DEFAULT '',
    source_tag TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL,
    stage_changed_at TEXT NOT NULL,
    onboarded_at TEXT,
    voltax_user_id TEXT,
    voltax_onboarded_on TEXT
  )`,
  'CREATE INDEX applications_role ON applications(role_id)',
  'CREATE INDEX applications_person ON applications(person_id)',
  'CREATE INDEX applications_applied ON applications(applied_at)',
  `CREATE TABLE application_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id),
    type TEXT NOT NULL CHECK (type IN ('stage_change','role_change','voltax_recorded')),
    from_value TEXT,
    to_value TEXT,
    actor_user_id INTEGER REFERENCES users(id),
    at TEXT NOT NULL
  )`,
  'CREATE INDEX events_application ON application_events(application_id)',
  // The event log is append-only: updates are refused at the database level.
  `CREATE TRIGGER application_events_no_update BEFORE UPDATE ON application_events
  BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END`,
  `CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id),
    application_id INTEGER REFERENCES applications(id),
    role_id INTEGER REFERENCES job_roles(id),
    author_user_id INTEGER REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX notes_person ON notes(person_id)',
  `CREATE TABLE email_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE emails_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id),
    application_id INTEGER REFERENCES applications(id),
    role_id INTEGER REFERENCES job_roles(id),
    template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
    sender_user_id INTEGER REFERENCES users(id),
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    via TEXT NOT NULL CHECK (via IN ('gmail','mailto')),
    sent_at TEXT NOT NULL
  )`,
  'CREATE INDEX emails_person ON emails_sent(person_id)',
  `CREATE TABLE deletion_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deleted_person_id INTEGER NOT NULL,
    actor_user_id INTEGER REFERENCES users(id),
    at TEXT NOT NULL
  )`,
  // grp (optional) ties rows of one family together, e.g. every login failure of one email (cleared by an admin reset).
  `CREATE TABLE rate_limits (
    key TEXT NOT NULL,
    at TEXT NOT NULL,
    grp TEXT
  )`,
  'CREATE INDEX rate_limits_key_at ON rate_limits(key, at)',
  'CREATE INDEX rate_limits_grp ON rate_limits(grp)',
];

const TEMPLATES = [
  [
    'Thanks for applying',
    'Thanks for applying to FanSided',
    'Hi {{first_name}},\n\nThanks for applying for the {{role_title}} role at FanSided. We review every application and will be in touch soon.\n\nBest,\n{{rep_name}}',
  ],
  [
    'Trial invite',
    'Next step: a trial for {{role_title}}',
    'Hi {{first_name}},\n\nWe liked your application for {{role_title}} and would like to invite you to a short paid trial. Reply to this email and I will send over the details.\n\nBest,\n{{rep_name}}',
  ],
  [
    'Welcome aboard',
    'Welcome to FanSided!',
    'Hi {{first_name}},\n\nWelcome aboard as a {{role_title}} contributor! You will receive your login details shortly. Reply here with any questions.\n\nBest,\n{{rep_name}}',
  ],
  [
    'Not a fit this time',
    'Your application for {{role_title}}',
    'Hi {{first_name}},\n\nThank you for your interest in the {{role_title}} role. We have decided not to move forward this time, but we encourage you to apply for future openings.\n\nBest,\n{{rep_name}}',
  ],
];

// statements() is called when the migration runs, so timestamps are taken at that moment.
const MIGRATIONS = [
  { version: 1, name: 'baseline schema (v2: password auth, auth_tokens, rate_limits, resume_url, is_sample)', statements: () => BASELINE },
  {
    version: 2,
    name: 'seed email templates',
    statements: () => {
      const now = nowIso();
      return TEMPLATES.map(([name, subject, body]) => ({
        sql: 'INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)',
        args: [name, subject, body, now],
      }));
    },
  },
  { version: 3, name: 'per-role workflows (role_stages, applications.stage_id, backfill, triggers)', statements: () => workflowMigration() },
  { version: 4, name: 'questionnaires (questionnaires table, job_roles.questionnaire_id, backfill)', statements: () => questionnaireMigration() },
  { version: 5, name: 'linked documents (email_templates.attachments_json)', statements: () => linkedDocumentsMigration() },
];


// Migration 3 (v2.2.0): per-role workflows. ADDITIVE ONLY: one new table, one new nullable column, indexes, a backfill
// and two triggers. Nothing existing is rebuilt, dropped, renamed or rewritten except by filling the new column.
// Every role gets the five stages the app has always had (New, Reviewing, Trial, Onboarded, Passed) and every
// application is pointed at the matching stage of its own role, so the board looks exactly as it did.
// The legacy applications.stage column (CHECK-limited to the five old values) is left alone and keeps being written
// as the stage's category. Two triggers keep stage_id consistent for any writer that only knows about that column
// (an older deployment still running during a rollout).
const STAGE_ID_FROM_LEGACY = `(SELECT s.id FROM role_stages s WHERE s.role_id = NEW.role_id AND s.kind =
    CASE WHEN NEW.stage IN ('reviewing', 'trial') THEN 'progress' ELSE NEW.stage END
  ORDER BY CASE WHEN lower(s.name) = NEW.stage THEN 0 ELSE 1 END, s.position, s.id LIMIT 1)`;

function workflowMigration() {
  const now = nowIso();
  return [
    `CREATE TABLE role_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('new','progress','onboarded','passed')),
    created_at TEXT NOT NULL
  )`,
    'CREATE INDEX role_stages_role ON role_stages(role_id, position)',
    'ALTER TABLE applications ADD COLUMN stage_id INTEGER',
    'CREATE INDEX applications_stage_id ON applications(stage_id)',
    // Five stages for every existing role, in one statement (ids come out grouped by role and in order).
    {
      sql: `INSERT INTO role_stages (role_id, position, name, kind, created_at)
            SELECT r.id, s.position, s.name, s.kind, ?
              FROM job_roles r
             CROSS JOIN (SELECT 0 AS position, 'New' AS name, 'new' AS kind
                         UNION ALL SELECT 1, 'Reviewing', 'progress'
                         UNION ALL SELECT 2, 'Trial', 'progress'
                         UNION ALL SELECT 3, 'Onboarded', 'onboarded'
                         UNION ALL SELECT 4, 'Passed', 'passed') s
             ORDER BY r.id, s.position`,
      args: [now],
    },
    // Point every application at the stage of its own role that matches its legacy value.
    `UPDATE applications SET stage_id = (
       SELECT s.id FROM role_stages s
        WHERE s.role_id = applications.role_id
          AND s.name = CASE applications.stage
                         WHEN 'new' THEN 'New' WHEN 'reviewing' THEN 'Reviewing' WHEN 'trial' THEN 'Trial'
                         WHEN 'onboarded' THEN 'Onboarded' WHEN 'passed' THEN 'Passed' END)`,
    // Tripwire: if any application of an existing role was NOT mapped, or any role lacks its five stages, this INSERT
    // violates NOT NULL, the whole batch (table, column, backfill, tracking row) rolls back and start-up fails
    // loudly instead of running on a half-migrated database. It can never insert a row.
    {
      sql: `INSERT INTO role_stages (role_id, position, name, kind, created_at)
            SELECT NULL, 0, 'migration check failed', 'new', ?
             WHERE EXISTS (SELECT 1 FROM applications a JOIN job_roles r ON r.id = a.role_id WHERE a.stage_id IS NULL)
                OR EXISTS (SELECT 1 FROM job_roles r WHERE (SELECT COUNT(*) FROM role_stages s WHERE s.role_id = r.id) != 5)`,
      args: [now],
    },
    `CREATE TRIGGER applications_stage_id_on_insert AFTER INSERT ON applications WHEN NEW.stage_id IS NULL
  BEGIN UPDATE applications SET stage_id = ${STAGE_ID_FROM_LEGACY} WHERE id = NEW.id; END`,
    `CREATE TRIGGER applications_stage_id_on_stage AFTER UPDATE OF stage ON applications
  WHEN NEW.stage_id IS OLD.stage_id AND NEW.stage IS NOT OLD.stage
  BEGIN UPDATE applications SET stage_id = ${STAGE_ID_FROM_LEGACY} WHERE id = NEW.id; END`,
  ];
}

// Migration 4 (v2.3.0): questionnaire templates. ADDITIVE ONLY: one new table, one new nullable column, two indexes, a
// backfill and a tripwire. Nothing existing is rebuilt, dropped or renamed; job_roles.questions_json is left exactly as
// it is (legacy storage that the app keeps writing a copy into, so a rollback still shows the right questions).
// Every role whose questions_json is a NON-EMPTY JSON ARRAY gets its own questionnaire, "<title> questions", holding a
// verbatim copy of that JSON, and is pointed at it. Roles without questions keep questionnaire_id NULL.
// "Non-empty array" is decided in SQL without JSON functions: after trimming it starts with '[' and with spaces, tabs
// and line breaks removed it is not '[]' (so '', '[]', '[ ]', ' [\n] ' are all "no questions").
function questionnaireMigration() {
  const now = nowIso();
  const { nonEmptyArray, backfillName } = require('../questionnaires');
  const hasQuestions = (c) => nonEmptyArray(c);
  return [
    `CREATE TABLE questionnaires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    questions_json TEXT NOT NULL DEFAULT '[]',
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    // Names are unique, case-insensitively (also guards two admins saving the same name at once).
    'CREATE UNIQUE INDEX questionnaires_name_nocase ON questionnaires(name COLLATE NOCASE)',
    'ALTER TABLE job_roles ADD COLUMN questionnaire_id INTEGER',
    'CREATE INDEX job_roles_questionnaire ON job_roles(questionnaire_id)',
    {
      sql: `INSERT INTO questionnaires (name, questions_json, is_sample, created_at, updated_at)
            SELECT ${backfillName('r')}, r.questions_json, r.is_sample, ?, ?
              FROM job_roles r WHERE ${hasQuestions('r.questions_json')} ORDER BY r.id`,
      args: [now, now],
    },
    `UPDATE job_roles SET questionnaire_id = (SELECT q.id FROM questionnaires q WHERE q.name = ${backfillName('job_roles')})
      WHERE ${hasQuestions('questions_json')}`,
    // Tripwire: if any role with questions is not pointing at a questionnaire holding exactly its questions, or a role
    // without questions got one, or the counts differ, this INSERT violates NOT NULL, the whole batch (table, column,
    // backfill, tracking row) rolls back and start-up fails loudly. It can never insert a row.
    {
      sql: `INSERT INTO questionnaires (name, questions_json, created_at, updated_at)
            SELECT NULL, '[]', ?, ?
             WHERE EXISTS (SELECT 1 FROM job_roles r WHERE ${hasQuestions('r.questions_json')}
                             AND (r.questionnaire_id IS NULL OR NOT EXISTS (SELECT 1 FROM questionnaires q WHERE q.id = r.questionnaire_id AND q.questions_json = r.questions_json)))
                OR EXISTS (SELECT 1 FROM job_roles r WHERE NOT ${hasQuestions('r.questions_json')} AND r.questionnaire_id IS NOT NULL)
                OR (SELECT COUNT(*) FROM questionnaires) != (SELECT COUNT(*) FROM job_roles r WHERE ${hasQuestions('r.questions_json')})
                OR (SELECT COUNT(DISTINCT questionnaire_id) FROM job_roles) != (SELECT COUNT(*) FROM questionnaires)`,
      args: [now, now],
    },
  ];
}

// Migration 5 (v2.4.0): linked documents. ADDITIVE ONLY: one new column with a default, nothing else. Existing templates
// read '[]' (no documents) and are not rewritten; older code that does not know the column keeps working because of the
// default. Stored as JSON [{"name": "...", "url": "https://..."}].
function linkedDocumentsMigration() {
  return ["ALTER TABLE email_templates ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'"];
}

// One cheap read. A missing schema_migrations table means version 0.
async function currentVersion(db) {
  try {
    const row = await db.get('SELECT MAX(version) AS v FROM schema_migrations');
    return row && row.v ? Number(row.v) : 0;
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return 0;
    throw err;
  }
}

// upTo (tests only): stop after that version, to build a database at an older schema.
async function migrate(db, { upTo = Infinity } = {}) {
  let version = await currentVersion(db);
  const from = version;
  for (const m of MIGRATIONS) {
    if (m.version <= version || m.version > upTo) continue;
    const statements = [
      ...m.statements(),
      { sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', args: [m.version, nowIso()] },
    ];
    try {
      await db.batch(statements);
      version = m.version;
    } catch (err) {
      // A concurrent runner may have applied it first (nothing of ours persisted): re-read and carry on.
      const latest = await currentVersion(db);
      if (latest < m.version) throw err;
      version = latest;
    }
  }
  return { from, to: version };
}

module.exports = { MIGRATIONS, migrate, currentVersion };

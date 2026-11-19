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
  `CREATE TABLE rate_limits (
    key TEXT NOT NULL,
    at TEXT NOT NULL
  )`,
  'CREATE INDEX rate_limits_key_at ON rate_limits(key, at)',
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
];

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

async function migrate(db) {
  let version = await currentVersion(db);
  const from = version;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
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

'use strict';
// SQLite access (node:sqlite) and schema migrations tracked in PRAGMA user_version.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // 1: core schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('admin','rep')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    google_refresh_token_enc TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE job_roles (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    vertical TEXT NOT NULL DEFAULT '',
    site_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    assigned_user_id INTEGER REFERENCES users(id),
    questions_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE people (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    linkedin_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id),
    role_id INTEGER NOT NULL REFERENCES job_roles(id),
    stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new','reviewing','trial','onboarded','passed')),
    sample_links TEXT NOT NULL DEFAULT '',
    file_path TEXT,
    file_name TEXT,
    answers_json TEXT NOT NULL DEFAULT '[]',
    heard_from TEXT NOT NULL DEFAULT '',
    source_tag TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL,
    stage_changed_at TEXT NOT NULL,
    onboarded_at TEXT,
    voltax_user_id TEXT,
    voltax_onboarded_on TEXT
  );
  CREATE INDEX applications_role ON applications(role_id);
  CREATE INDEX applications_person ON applications(person_id);
  CREATE INDEX applications_applied ON applications(applied_at);
  CREATE TABLE application_events (
    id INTEGER PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id),
    type TEXT NOT NULL CHECK (type IN ('stage_change','role_change','voltax_recorded')),
    from_value TEXT,
    to_value TEXT,
    actor_user_id INTEGER REFERENCES users(id),
    at TEXT NOT NULL
  );
  CREATE INDEX events_application ON application_events(application_id);
  -- The event log is append-only: updates are refused at the database level.
  CREATE TRIGGER application_events_no_update BEFORE UPDATE ON application_events
  BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id),
    application_id INTEGER REFERENCES applications(id),
    author_user_id INTEGER REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX notes_person ON notes(person_id);
  CREATE TABLE email_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE emails_sent (
    id INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id),
    application_id INTEGER REFERENCES applications(id),
    template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
    sender_user_id INTEGER REFERENCES users(id),
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    gmail_message_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('sent','failed')),
    error TEXT,
    sent_at TEXT NOT NULL
  );
  CREATE INDEX emails_person ON emails_sent(person_id);
  CREATE TABLE deletion_log (
    id INTEGER PRIMARY KEY,
    deleted_person_id INTEGER NOT NULL,
    actor_user_id INTEGER REFERENCES users(id),
    at TEXT NOT NULL
  );
  -- Only written when EMAIL_MODE=log (local development and tests).
  CREATE TABLE dev_mail_log (
    id INTEGER PRIMARY KEY,
    from_user_id INTEGER,
    from_email TEXT NOT NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL
  );
  `,
  // 2: seed email templates
  (db) => {
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT INTO email_templates (name, subject, body, updated_at) VALUES (?, ?, ?, ?)');
    const templates = [
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
    for (const t of templates) insert.run(t[0], t[1], t[2], now);
  },
];

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'recruit.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const step = MIGRATIONS[i];
    transaction(db, () => {
      if (typeof step === 'function') step(db);
      else db.exec(step);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return { from: current, to: MIGRATIONS.length };
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = { openDb, migrate, transaction, nowIso, MIGRATIONS };

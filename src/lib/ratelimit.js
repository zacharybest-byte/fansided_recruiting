'use strict';
// Rate limits kept in the database (table rate_limits), so they survive restarts and serverless instances.
// Keys are HMAC-SHA256(secret, bucket + ":" + value): the raw IP or email is never stored.
const crypto = require('node:crypto');
const { nowIso } = require('./db');

// Rows older than this are pruned whenever a hit is recorded. Must be at least the largest window in use.
const RETENTION_MS = 24 * 60 * 60 * 1000;

function rateKey(secret, bucket, value) {
  return crypto.createHmac('sha256', String(secret)).update(`${bucket}:${value}`).digest('hex');
}

// True while `key` has fewer than `limit` recorded hits in the last `windowMs`.
async function allowed(db, key, limit, windowMs) {
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = await db.get('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ? AND at > ?', [key, since]);
  return row.n < limit;
}

// Statements that record one hit and prune old rows, so a caller can add them to its own atomic batch.
function recordStatements(key) {
  return [
    { sql: 'INSERT INTO rate_limits (key, at) VALUES (?, ?)', args: [key, nowIso()] },
    { sql: 'DELETE FROM rate_limits WHERE at < ?', args: [new Date(Date.now() - RETENTION_MS).toISOString()] },
  ];
}

// Statements that atomically reserve one hit for each { key, limit, windowMs, group? }. They belong in one db.batch
// (a transaction), and they are ALL-OR-NOTHING: every INSERT is conditioned on every spec being under its limit
// (not counting the rows of this very call), so an attempt that is refused by any limit is recorded against no
// bucket, and concurrent requests cannot all slip under a limit. `group` (optional) is stored beside the row so a
// whole family of rows (all logins of one email) can be cleared later. Returns { at, statements }: `at`
// identifies THIS call's rows (microsecond-style suffix, so another request from the same millisecond cannot be
// mistaken for ours), see reservedGuard().
function reserveStatements(specs) {
  const at = `${nowIso().slice(0, -1)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}Z`;
  const cond = specs.map(() => '(SELECT COUNT(*) FROM rate_limits WHERE key = ? AND at > ? AND at <> ?) < ?').join(' AND ');
  const condArgs = specs.flatMap(({ key, limit, windowMs }) => [key, new Date(Date.now() - windowMs).toISOString(), at, limit]);
  const statements = specs.map(({ key, group }) => ({
    sql: `INSERT INTO rate_limits (key, at, grp) SELECT ?, ?, ? WHERE ${cond}`,
    args: [key, at, group || null, ...condArgs],
  }));
  return { at, statements };
}

// SQL condition + args: "this call's reservation for `key` was stored" (use in a later statement of the same batch).
function reservedGuard(key, at) {
  return { sql: 'EXISTS (SELECT 1 FROM rate_limits WHERE key = ? AND at = ?)', args: [key, at] };
}

function pruneStatement() {
  return { sql: 'DELETE FROM rate_limits WHERE at < ?', args: [new Date(Date.now() - RETENTION_MS).toISOString()] };
}

// Atomically reserves one hit per spec (all or nothing, see reserveStatements).
// Returns { ok, at, keys }: `keys` are the keys that were reserved (they stay recorded unless release() is called).
async function reserve(db, specs) {
  const { at, statements } = reserveStatements(specs);
  const results = await db.batch([...statements, pruneStatement()]);
  const keys = specs.filter((_, i) => results[i].changes === 1).map((s) => s.key);
  return { ok: keys.length === specs.length, at, keys };
}

// Deletes every row of a group (for example after an admin reset: the email's login failures stop counting).
function clearGroupStatement(group) {
  return { sql: 'DELETE FROM rate_limits WHERE grp = ?', args: [group] };
}

// Removes the hits a successful attempt reserved (one row per key).
async function release(db, { at, keys }) {
  if (!keys.length) return;
  await db.batch(keys.map((key) => releaseStatement(key, at)));
}

function releaseStatement(key, at) {
  return {
    sql: 'DELETE FROM rate_limits WHERE rowid = (SELECT MAX(rowid) FROM rate_limits WHERE key = ? AND at = ?)',
    args: [key, at],
  };
}

async function record(db, key) {
  await db.batch(recordStatements(key));
}

module.exports = { rateKey, allowed, record, recordStatements, reserve, reserveStatements, reservedGuard, pruneStatement, clearGroupStatement, release, releaseStatement, RETENTION_MS };

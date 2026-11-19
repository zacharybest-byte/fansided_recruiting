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

// Atomically reserves one hit for each { key, limit, windowMs }, in the given order: the INSERT only happens
// while the key has fewer than `limit` hits in its window, so concurrent requests cannot all slip under the limit.
// A spec is only recorded when every spec before it was reserved too, so a caller that is already over its first
// (outermost) limit, for example the per-IP one, cannot make the table grow with new keys.
// Returns { ok, at, keys }: ok is false when any key was already at its limit; `keys` are the keys that were
// reserved (they stay recorded unless release() is called).
async function reserve(db, specs) {
  // Microsecond-style suffix: `at` identifies THIS call's rows, so the "earlier specs were recorded" check below
  // cannot be satisfied by another request's row from the same millisecond (1 in 1000 collision at worst).
  const at = `${nowIso().slice(0, -1)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}Z`;
  const statements = specs.map(({ key, limit, windowMs }, i) => {
    const earlier = specs.slice(0, i).map(() => 'AND EXISTS (SELECT 1 FROM rate_limits WHERE key = ? AND at = ?)').join(' ');
    return {
      sql: `INSERT INTO rate_limits (key, at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM rate_limits WHERE key = ? AND at > ?) < ? ${earlier}`,
      args: [key, at, key, new Date(Date.now() - windowMs).toISOString(), limit, ...specs.slice(0, i).flatMap((s) => [s.key, at])],
    };
  });
  statements.push({ sql: 'DELETE FROM rate_limits WHERE at < ?', args: [new Date(Date.now() - RETENTION_MS).toISOString()] });
  const results = await db.batch(statements);
  const keys = specs.filter((_, i) => results[i].changes === 1).map((s) => s.key);
  return { ok: keys.length === specs.length, at, keys };
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

module.exports = { rateKey, allowed, record, recordStatements, reserve, release, releaseStatement, RETENTION_MS };

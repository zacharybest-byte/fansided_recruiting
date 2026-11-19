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

async function record(db, key) {
  await db.batch(recordStatements(key));
}

module.exports = { rateKey, allowed, record, recordStatements, RETENTION_MS };

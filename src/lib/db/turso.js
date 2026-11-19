'use strict';
// Turso (libSQL) driver over the stateless HTTP API: POST {url}/v2/pipeline with a Bearer token.
//
// Facts this relies on (Turso HTTP reference + Hrana 2/3 specs):
// - Each request is a pipeline: { requests: [...] }. We always end it with { type: "close" } and never
//   keep or send a baton, so every call is independent (serverless safe).
// - The server executes EVERY request of a pipeline even when an earlier one errored. So a transaction can
//   not be written as BEGIN / stmt / COMMIT execute requests. db.batch() uses the Hrana `batch` request
//   (allowed in /v2/pipeline: its BatchStreamReq has the same semantics as Hrana's batch) whose steps
//   carry conditions: each statement runs only if the previous step succeeded, COMMIT only if the last
//   statement succeeded, ROLLBACK only if COMMIT did not. Everything happens in one round trip.
// - Integers travel as strings ({ type: "integer", value: "42" }), floats as JSON numbers, blobs as base64.
// - Not verified against a real Turso database (no network in the build sandbox), only against test/fake-turso.js.
const { normaliseStatement, normaliseBatch } = require('./common');

const TIMEOUT_MS = 10000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// libsql://host -> https://host. http:// is accepted for localhost / 127.0.0.1 only (the test fake).
function pipelineUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl).trim().replace(/^libsql:\/\//i, 'https://'));
  } catch {
    throw new Error('TURSO_DATABASE_URL is not a valid URL');
  }
  if (u.protocol === 'http:' && !LOCAL_HOSTS.has(u.hostname)) throw new Error('TURSO_DATABASE_URL must use https:// (http:// is only allowed for localhost)');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('TURSO_DATABASE_URL must start with libsql:// or https://');
  if (u.username || u.password) throw new Error('TURSO_DATABASE_URL must not contain credentials; use TURSO_AUTH_TOKEN');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}/v2/pipeline`;
}

function encodeArg(v) {
  if (v === null) return { type: 'null' };
  if (typeof v === 'string') return { type: 'text', value: v };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'blob', base64: Buffer.from(v).toString('base64') }; // Buffer (checked by normaliseArgs)
}

function decodeValue(v) {
  switch (v && v.type) {
    case 'null':
      return null;
    case 'integer': {
      const n = Number(v.value);
      return Number.isSafeInteger(n) ? n : BigInt(v.value);
    }
    case 'float':
      return Number(v.value);
    case 'text':
      return String(v.value);
    case 'blob':
      return Buffer.from(v.base64 || '', 'base64');
    default:
      throw new Error('Unexpected value type in database response');
  }
}

function decodeResult(r) {
  const cols = (r.cols || []).map((c) => c.name);
  const rows = (r.rows || []).map((row) => {
    const o = {};
    row.forEach((v, i) => {
      o[cols[i]] = decodeValue(v);
    });
    return o;
  });
  return { rows, changes: Number(r.affected_row_count || 0), lastInsertRowid: Number(r.last_insert_rowid || 0) };
}

function stmtJson({ sql, args }) {
  return { sql, args: args.map(encodeArg) };
}

function createTursoDb({ url, token, fetchImpl, timeoutMs = TIMEOUT_MS }) {
  const endpoint = pipelineUrl(url);
  if (!token) throw new Error('TURSO_AUTH_TOKEN is required with TURSO_DATABASE_URL');
  const doFetch = fetchImpl || globalThis.fetch;
  const redact = (s) => String(s).split(token).join('[token]');

  function fail(message, extra) {
    const err = new Error(redact(message));
    if (extra && extra.code) err.code = extra.code;
    return err;
  }

  // One round trip. Returns the `results` entries for the given requests (the trailing close is dropped).
  async function pipeline(requests) {
    let res;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error', // never forward the Bearer token to another host
      });
    } catch (err) {
      const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timed out' : `network error${err && err.cause && err.cause.code ? ` (${err.cause.code})` : ''}`;
      throw fail(`Database request failed: ${reason}`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const detail = body && typeof (body.error || body.message) === 'string' ? `: ${String(body.error || body.message).slice(0, 200)}` : '';
      throw fail(`Database request failed with HTTP ${res.status}${detail}`);
    }
    if (!body || !Array.isArray(body.results) || body.results.length < requests.length) throw fail('Database returned an unexpected response');
    return body.results.slice(0, requests.length);
  }

  function checkOk(entry) {
    if (!entry || entry.type !== 'ok') {
      const e = entry && entry.error ? entry.error : {};
      throw fail(`Database error: ${e.message || 'request failed'}`, e);
    }
    return entry.response;
  }

  async function executeOne(sql, args) {
    const st = normaliseStatement({ sql, args });
    const [entry] = await pipeline([{ type: 'execute', stmt: stmtJson(st) }]);
    return decodeResult(checkOk(entry).result);
  }

  const db = {
    driver: 'turso',
    async all(sql, args = []) {
      return (await executeOne(sql, args)).rows;
    },
    async get(sql, args = []) {
      return (await executeOne(sql, args)).rows[0];
    },
    async run(sql, args = []) {
      const r = await executeOne(sql, args);
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    // Atomic batch (see the header comment). Throws the first error and persists nothing on failure.
    async batch(statements) {
      const list = normaliseBatch(statements);
      const steps = [{ stmt: { sql: 'BEGIN IMMEDIATE' } }];
      list.forEach((st, i) => steps.push({ condition: { type: 'ok', step: i }, stmt: stmtJson(st) }));
      const commit = steps.length; // index of the COMMIT step
      steps.push({ condition: { type: 'ok', step: commit - 1 }, stmt: { sql: 'COMMIT' } });
      steps.push({ condition: { type: 'not', cond: { type: 'ok', step: commit } }, stmt: { sql: 'ROLLBACK' } });

      const [entry] = await pipeline([{ type: 'batch', batch: { steps } }]);
      const { step_results: results = [], step_errors: errors = [] } = checkOk(entry).result || {};
      for (let i = 0; i <= commit; i++) {
        if (errors[i]) throw fail(`Database error: ${errors[i].message || 'statement failed'}`, errors[i]);
      }
      if (!results[commit]) throw fail('Database error: the transaction was not committed');
      return list.map((_, i) => decodeResult(results[i + 1]));
    },
    async close() {},
  };
  return db;
}

module.exports = { createTursoDb, pipelineUrl };

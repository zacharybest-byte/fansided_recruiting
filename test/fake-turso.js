'use strict';
// A local fake of Turso's HTTP API (POST /v2/pipeline), backed by a node:sqlite file, for tests and for
// scripts/fake-turso.js. It follows the Turso HTTP reference and the Hrana 2/3 specs:
// - Bearer token required (401 otherwise); body { baton, requests: [...] }.
// - Request types: execute, batch (with ok/error/not/and/or conditions), close. Others return an error result.
// - THE SERVER EXECUTES EVERY REQUEST OF A PIPELINE EVEN IF AN EARLIER ONE ERRORED (as the docs say).
// - Integers are sent and returned as strings, floats as numbers, blobs as base64.
// - Each pipeline runs on its own connection; a transaction left open at the end is rolled back.
// - Batons are not supported (the app is stateless): a non-null baton is a 400.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function sqlErrorCode(err) {
  return err.errstr ? `SQLITE_${String(err.errstr).split(/\s+/)[0].toUpperCase()}` : "SQLITE_ERROR";
}

function decodeArg(a, where) {
  if (!a || typeof a !== 'object') throw new Error(`${where}: argument must be an object`);
  switch (a.type) {
    case 'null':
      return null;
    case 'integer':
      if (typeof a.value !== 'string' || !/^-?\d+$/.test(a.value)) throw new Error(`${where}: integer value must be a decimal string`);
      return BigInt(a.value);
    case 'float':
      if (typeof a.value !== 'number') throw new Error(`${where}: float value must be a number`);
      return a.value;
    case 'text':
      if (typeof a.value !== 'string') throw new Error(`${where}: text value must be a string`);
      return a.value;
    case 'blob':
      if (typeof a.base64 !== 'string') throw new Error(`${where}: blob needs base64`);
      return Buffer.from(a.base64, 'base64');
    default:
      throw new Error(`${where}: unknown value type ${JSON.stringify(a.type)}`);
  }
}

function encodeValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') return { type: 'float', value: v };
  if (typeof v === 'string') return { type: 'text', value: v };
  return { type: 'blob', base64: Buffer.from(v).toString('base64') };
}

const DML = /^\s*(insert|update|delete|replace)\b/i;
const INSERT = /^\s*(insert|replace)\b/i;

function execStmt(conn, stmt) {
  if (!stmt || typeof stmt.sql !== 'string') throw new Error('stmt.sql must be a string');
  if (stmt.named_args && stmt.named_args.length) throw new Error('named_args are not supported by this fake');
  const args = (stmt.args || []).map((a, i) => decodeArg(a, `arg ${i + 1}`));
  const st = conn.prepare(stmt.sql);
  st.setReadBigInts(true);
  const cols = st.columns();
  if (cols.length > 0) {
    st.setReturnArrays(true);
    const rows = st.all(...args).map((r) => r.map(encodeValue));
    return {
      cols: cols.map((c) => ({ name: c.name, decltype: c.type })),
      rows,
      affected_row_count: 0,
      last_insert_rowid: null,
      replication_index: '1',
      rows_read: rows.length,
      rows_written: 0,
      query_duration_ms: 0,
    };
  }
  const r = st.run(...args);
  return {
    cols: [],
    rows: [],
    affected_row_count: DML.test(stmt.sql) ? Number(r.changes) : 0,
    last_insert_rowid: INSERT.test(stmt.sql) ? String(r.lastInsertRowid) : null,
    replication_index: '1',
    rows_read: 0,
    rows_written: DML.test(stmt.sql) ? Number(r.changes) : 0,
    query_duration_ms: 0,
  };
}

function evalCond(cond, results, errors) {
  if (!cond) return true;
  switch (cond.type) {
    case 'ok':
      return Boolean(results[cond.step]);
    case 'error':
      return Boolean(errors[cond.step]);
    case 'not':
      return !evalCond(cond.cond, results, errors);
    case 'and':
      return cond.conds.every((c) => evalCond(c, results, errors));
    case 'or':
      return cond.conds.some((c) => evalCond(c, results, errors));
    default:
      throw new Error(`unsupported condition type ${JSON.stringify(cond.type)} (Hrana 2 has ok, error, not, and, or)`);
  }
}

function runBatch(conn, batch) {
  const step_results = [];
  const step_errors = [];
  for (const [i, step] of (batch.steps || []).entries()) {
    let run;
    try {
      run = evalCond(step.condition, step_results, step_errors);
    } catch (err) {
      return { error: { message: err.message, code: 'BAD_REQUEST' } };
    }
    if (!run) {
      step_results[i] = null;
      step_errors[i] = null;
      continue;
    }
    try {
      step_results[i] = execStmt(conn, step.stmt);
      step_errors[i] = null;
    } catch (err) {
      step_results[i] = null;
      step_errors[i] = { message: String(err.message), code: sqlErrorCode(err) };
    }
  }
  return { result: { step_results, step_errors } };
}

function runPipeline(DatabaseSync, file, requests) {
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  let closed = false;
  const results = [];
  try {
    for (const rq of requests) {
      if (closed) {
        results.push({ type: 'error', error: { message: 'the stream has been closed' } });
        continue;
      }
      try {
        switch (rq && rq.type) {
          case 'execute':
            results.push({ type: 'ok', response: { type: 'execute', result: execStmt(conn, rq.stmt) } });
            break;
          case 'batch': {
            const b = runBatch(conn, rq.batch || {});
            if (b.error) results.push({ type: 'error', error: b.error });
            else results.push({ type: 'ok', response: { type: 'batch', result: b.result } });
            break;
          }
          case 'close':
            closed = true;
            results.push({ type: 'ok', response: { type: 'close' } });
            break;
          default:
            results.push({ type: 'error', error: { message: `unsupported request type ${JSON.stringify(rq && rq.type)}`, code: 'BAD_REQUEST' } });
        }
      } catch (err) {
        results.push({ type: 'error', error: { message: String(err.message), code: sqlErrorCode(err) } });
      }
    }
  } finally {
    try {
      conn.exec('ROLLBACK'); // a transaction left open when the stream ends is rolled back (errors if none: ignore)
    } catch {
      /* no transaction open */
    }
    conn.close();
  }
  return results;
}

const READ_ONLY = /^\s*(select|pragma|with|explain)\b/i;
const SCHEMA = /^\s*(create|alter|drop)\b|schema_migrations|email_templates/i;

function statementsOf(body) {
  const out = [];
  for (const rq of (body && body.requests) || []) {
    if (rq.type === 'execute' && rq.stmt) out.push(rq.stmt.sql);
    if (rq.type === 'batch' && rq.batch) for (const s of rq.batch.steps || []) if (s.stmt) out.push(s.stmt.sql);
  }
  return out;
}

// options: { token, file }. Resolves to { url, token, file, requests, close, writeRequests(), schemaWrites(), reset() }.
async function startFakeTurso({ token = 'test-token', file, port = 0, host = '127.0.0.1' } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  let tmpDir = null;
  if (!file) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-turso-'));
    file = path.join(tmpDir, 'fake.sqlite');
  } else {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const boot = new DatabaseSync(file);
  boot.exec('PRAGMA journal_mode = WAL');
  boot.close();

  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, obj) => {
        const payload = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
      };
      let body = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      const entry = { method: req.method, path: req.url, authorization: req.headers.authorization || '', contentType: req.headers['content-type'] || '', body };
      requests.push(entry);
      if (req.method === 'GET' && req.url === '/v2') return send(200, {});
      if (req.method !== 'POST' || req.url !== '/v2/pipeline') return send(404, { error: 'not found' });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized: invalid or missing auth token' });
      if (!body || !Array.isArray(body.requests)) return send(400, { error: 'invalid pipeline request' });
      if (body.baton !== undefined && body.baton !== null) return send(400, { error: 'this fake does not support batons' });
      return send(200, { baton: null, base_url: null, results: runPipeline(DatabaseSync, file, body.requests) });
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${server.address().port}`;

  return {
    url,
    token,
    file,
    requests,
    reset() {
      requests.length = 0;
    },
    // Requests (since the last reset) that contain any statement other than SELECT/PRAGMA.
    writeRequests() {
      return requests.filter((r) => statementsOf(r.body).some((s) => !READ_ONLY.test(s)));
    },
    // Requests that touch the schema, migration bookkeeping or the seeded templates.
    schemaWrites() {
      return requests.filter((r) => statementsOf(r.body).some((s) => !READ_ONLY.test(s) && SCHEMA.test(s)));
    },
    // A direct connection to the backing file, for assertions.
    open() {
      const c = new DatabaseSync(file);
      c.exec('PRAGMA busy_timeout = 5000');
      return c;
    },
    async close({ keepData = false } = {}) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      if (tmpDir && !keepData) fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

module.exports = { startFakeTurso };

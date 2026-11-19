'use strict';
// Shared by both database drivers: argument and statement validation.

function nowIso() {
  return new Date().toISOString();
}

// Returns a driver-neutral copy of the positional arguments:
// null, finite number, string, bigint, Buffer (boolean becomes 0/1). undefined is a bug in the caller.
function normaliseArgs(args, where = 'statement') {
  if (args === undefined) return [];
  if (!Array.isArray(args)) throw new TypeError(`${where}: args must be an array`);
  return args.map((v, i) => {
    if (v === null) return null;
    switch (typeof v) {
      case 'string':
      case 'bigint':
        return v;
      case 'number':
        if (!Number.isFinite(v)) throw new TypeError(`${where}: argument ${i + 1} is not a finite number`);
        return v;
      case 'boolean':
        return v ? 1 : 0;
      case 'undefined':
        throw new TypeError(`${where}: argument ${i + 1} is undefined (use null for SQL NULL)`);
      default:
        if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
        throw new TypeError(`${where}: argument ${i + 1} has unsupported type ${typeof v}`);
    }
  });
}

function normaliseStatement(stmt, where = 'statement') {
  if (typeof stmt === 'string') return { sql: stmt, args: [] };
  if (!stmt || typeof stmt.sql !== 'string' || !stmt.sql.trim()) throw new TypeError(`${where}: sql must be a non-empty string`);
  return { sql: stmt.sql, args: normaliseArgs(stmt.args, where) };
}

function normaliseBatch(statements) {
  if (!Array.isArray(statements) || statements.length === 0) throw new TypeError('batch needs a non-empty array of statements');
  return statements.map((s, i) => normaliseStatement(s, `batch statement ${i + 1}`));
}

module.exports = { nowIso, normaliseArgs, normaliseStatement, normaliseBatch };

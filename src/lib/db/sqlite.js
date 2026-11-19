'use strict';
// Local driver: node:sqlite behind the async database interface (local development and tests only).
// node:sqlite is required lazily, here and nowhere else, so it is never loaded when the Turso driver is used.
const fs = require('node:fs');
const path = require('node:path');
const { normaliseStatement, normaliseBatch } = require('./common');

function createSqliteDb({ file, dataDir }) {
  const { DatabaseSync } = require('node:sqlite');
  let target = file;
  if (!target) {
    fs.mkdirSync(dataDir, { recursive: true });
    target = path.join(dataDir, 'recruit.sqlite');
  }
  const conn = new DatabaseSync(target);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  function execute({ sql, args }) {
    const st = conn.prepare(sql);
    if (st.columns().length > 0) {
      // Plain objects; blobs come back as Buffer, like the Turso driver.
      const rows = st.all(...args).map((r) => {
        const o = { ...r };
        for (const k of Object.keys(o)) if (o[k] instanceof Uint8Array && !Buffer.isBuffer(o[k])) o[k] = Buffer.from(o[k]);
        return o;
      });
      return { rows, changes: 0, lastInsertRowid: 0 };
    }
    const r = st.run(...args);
    return { rows: [], changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  let closed = false;
  const db = {
    driver: 'sqlite',
    async all(sql, args = []) {
      return execute(normaliseStatement({ sql, args })).rows;
    },
    async get(sql, args = []) {
      return execute(normaliseStatement({ sql, args })).rows[0];
    },
    async run(sql, args = []) {
      const r = execute(normaliseStatement({ sql, args }));
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
    // Atomic: BEGIN IMMEDIATE ... COMMIT, or ROLLBACK and throw.
    async batch(statements) {
      const list = normaliseBatch(statements);
      conn.exec('BEGIN IMMEDIATE');
      try {
        const results = list.map(execute);
        conn.exec('COMMIT');
        return results;
      } catch (err) {
        try {
          conn.exec('ROLLBACK');
        } catch {
          /* already rolled back by SQLite */
        }
        throw err;
      }
    },
    async close() {
      if (!closed) {
        closed = true;
        conn.close();
      }
    },
  };
  return db;
}

module.exports = { createSqliteDb };

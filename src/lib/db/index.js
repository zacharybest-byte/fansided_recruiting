'use strict';
// Database entry point: one async interface, two drivers.
//   await db.all(sql, args)   -> array of plain objects
//   await db.get(sql, args)   -> object or undefined
//   await db.run(sql, args)   -> { changes, lastInsertRowid }
//   await db.batch([{ sql, args }, ...]) -> [{ rows, changes, lastInsertRowid }, ...]   (atomic)
//   await db.close()
// Positional ? arguments only. There are no interactive transactions: every multi-statement write is one batch.
const { nowIso } = require('./common');
const { migrate, MIGRATIONS } = require('./migrations');

// config: { tursoUrl, tursoToken, dataDir } ; options: { fetchImpl, file }
function openDb(config, options = {}) {
  if (config.tursoUrl) {
    const { createTursoDb } = require('./turso');
    return createTursoDb({ url: config.tursoUrl, token: config.tursoToken, fetchImpl: options.fetchImpl });
  }
  const { createSqliteDb } = require('./sqlite');
  return createSqliteDb({ file: options.file, dataDir: config.dataDir });
}

module.exports = { openDb, migrate, nowIso, MIGRATIONS };

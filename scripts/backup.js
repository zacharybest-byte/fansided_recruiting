'use strict';
// Writes a consistent snapshot of the SQLite database (safe while the app is running).
// Usage: node scripts/backup.js /path/to/backup.sqlite   (DATA_DIR selects the source database)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const target = path.resolve(process.argv[2] || path.join(dataDir, 'backups', `recruit-${new Date().toISOString().slice(0, 10)}.sqlite`));
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.rmSync(target, { force: true });
const db = new DatabaseSync(path.join(dataDir, 'recruit.sqlite'));
db.exec('PRAGMA busy_timeout = 10000');
db.prepare('VACUUM INTO ?').run(target);
db.close();
console.log(target);

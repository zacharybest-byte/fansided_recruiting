'use strict';
// Runs the local fake of Turso's HTTP API so the app can be booted in a production-like way:
//   node scripts/fake-turso.js --port 8080 --file ./data/fake-turso.sqlite --token dev-token
//   TURSO_DATABASE_URL=http://127.0.0.1:8080 TURSO_AUTH_TOKEN=dev-token npm start
const path = require('node:path');
const { startFakeTurso } = require('../test/fake-turso');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

startFakeTurso({
  port: Number(arg('port', 8080)),
  file: path.resolve(arg('file', './data/fake-turso.sqlite')),
  token: arg('token', 'dev-token'),
}).then((fake) => {
  console.log(`Fake Turso listening on ${fake.url} (database file ${fake.file})`);
  console.log(`  TURSO_DATABASE_URL=${fake.url} TURSO_AUTH_TOKEN=${fake.token}`);
  const stop = () => fake.close({ keepData: true }).then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
});

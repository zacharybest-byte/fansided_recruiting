'use strict';
// Local / self-hosted entry point: wraps the request handler in a plain Node http server.
const http = require('node:http');
const { createApp } = require('./app');

function createHttpServer(handler) {
  const server = http.createServer(handler);
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  return server;
}

// Outside production, prints the first-admin setup link while no admin has a password yet.
async function logSetupLink(instance) {
  const { config, db, log } = instance;
  if (config.production || !config.adminEmail || !config.setupToken) return;
  const row = await db.get("SELECT 1 AS x FROM users WHERE role = 'admin' AND active = 1 AND password_hash IS NOT NULL LIMIT 1");
  if (row) return;
  const base = config.baseUrl || `http://localhost:${config.port}`;
  log(`First-admin setup link (development only): ${base}/setup?token=${encodeURIComponent(config.setupToken)}`);
}

if (require.main === module) {
  const instance = createApp();
  if (instance.configError) {
    console.error(`Startup failed: ${instance.configError.message}`);
    process.exit(1);
  }
  const { config, log } = instance;
  const server = createHttpServer(instance.handler);
  instance.ready
    .then(() => logSetupLink(instance))
    .then(() => {
      server.listen(config.port, () => {
        log(`FanSided Recruit listening on port ${server.address().port} (${config.production ? 'production' : 'development'}), database: ${config.tursoUrl ? 'turso' : `sqlite in ${config.dataDir}`}`);
      });
    })
    .catch((err) => {
      console.error(`Startup failed: ${err.message}`);
      process.exit(1);
    });
  const shutdown = () => {
    server.closeAllConnections?.();
    server.close(() => instance.close().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createHttpServer, logSetupLink };

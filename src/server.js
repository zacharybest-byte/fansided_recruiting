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

if (require.main === module) {
  let instance;
  try {
    instance = createApp();
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
  const { config, log } = instance;
  const server = createHttpServer(instance.handler);
  instance.ready
    .then(() => {
      server.listen(config.port, () => {
        log(`FanSided Recruit listening on port ${server.address().port} (${config.production ? 'production' : 'development'}), database: ${config.tursoUrl ? 'turso' : `sqlite in ${config.dataDir}`}`);
        if (config.devLogin) log('WARNING: DEV_LOGIN=1 is on: anyone can sign in as any allowlisted user.');
        if (config.emailMode === 'log') log('EMAIL_MODE=log: emails are recorded in dev_mail_log, not sent.');
        if (config.ephemeralTokenKey) log('No TOKEN_ENCRYPTION_KEY set: using a temporary key (stored Google tokens will not survive a restart).');
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

module.exports = { createHttpServer };

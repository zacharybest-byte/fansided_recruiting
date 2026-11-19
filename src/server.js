'use strict';
// Entry point: builds the app (config, db, mailer, routes) and starts the HTTP server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./lib/config');
const { openDb, nowIso } = require('./lib/db');
const { createContext, Router, HttpError, clientIp, SECURITY_HEADERS } = require('./lib/http');
const { loadSession, requireAdmin } = require('./lib/auth');
const { errorPage } = require('./lib/layout');
const { createGoogle } = require('./lib/google');
const { createMailer } = require('./lib/email');
const { createRateLimiter } = require('./routes/public');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png' };

function loadStatic() {
  const files = new Map();
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    const ext = path.extname(name);
    if (STATIC_TYPES[ext]) files.set(`/public/${name}`, { data: fs.readFileSync(path.join(PUBLIC_DIR, name)), type: STATIC_TYPES[ext] });
  }
  return files;
}

function bootstrapAdmins(db, emails) {
  const now = nowIso();
  for (const email of emails) {
    db.prepare(
      `INSERT INTO users (email, name, role, active, created_at) VALUES (?, '', 'admin', 1, ?)
       ON CONFLICT(email) DO UPDATE SET role = 'admin', active = 1`
    ).run(email, now);
  }
}

// options: { env, fetchImpl, log }
function createApp(options = {}) {
  const config = loadConfig(options.env || process.env);
  const log = options.log || (config.quiet ? () => {} : (msg) => console.log(`${new Date().toISOString()} ${msg}`));
  const db = openDb(config.dataDir);
  fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
  bootstrapAdmins(db, config.adminEmails);

  const google = createGoogle({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: `${config.baseUrl}/auth/google/callback`,
    fetchImpl: options.fetchImpl,
  });
  const app = { config, db, google, log, applyLimiter: createRateLimiter() };
  app.mailer = createMailer({ db, config, google, log });

  const router = new Router();
  require('./routes/public').register(router);
  require('./routes/auth').register(router);
  require('./routes/dashboard').register(router);
  require('./routes/candidates').register(router);
  require('./routes/admin').register(router);
  const staticFiles = loadStatic();

  async function handle(req, res) {
    const ctx = createContext(req, res, app);
    ctx.ip = clientIp(req, config.trustProxy);
    try {
      const file = staticFiles.get(ctx.path);
      if (file && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
        return ctx.send(200, file.data, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=300' });
      }
      loadSession(ctx);
      // Every /app/admin/* path (even unknown ones) is admin-only.
      if (ctx.path === '/app/admin' || ctx.path.startsWith('/app/admin/')) {
        requireAdmin(ctx);
        if (res.headersSent) return;
      }
      const match = router.match(ctx.method, ctx.path);
      if (!match) throw new HttpError(404, 'Page not found.');
      if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
      ctx.params = match.params;
      for (const h of match.handlers) {
        await h(ctx);
        if (res.headersSent) return;
      }
      if (!res.headersSent) throw new HttpError(500, 'No response');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`[error] ${ctx.method} ${ctx.path}: ${err.stack || err}`);
      if (res.headersSent) return res.destroy();
      let message = status === 500 ? 'Please try again. If it keeps happening, tell an admin.' : err.message;
      if (status === 413) {
        message = `The upload is too large. Files must be at most ${config.maxUploadMb} MB. Please go back and choose a smaller file.`;
        res.setHeader('Connection', 'close');
      }
      try {
        errorPage(ctx, status, message);
      } catch (renderErr) {
        log(`[error] rendering error page failed: ${renderErr}`);
        res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(message);
      }
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[fatal] ${err.stack || err}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;

  app.server = server;
  app.listen = (port = config.port, host) =>
    new Promise((resolve) => {
      server.listen(port, host, () => resolve(server.address().port));
    });
  app.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        db.close();
        resolve();
      });
    });
  return app;
}

if (require.main === module) {
  let app;
  try {
    app = createApp();
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
  const { config } = app;
  app.listen(config.port).then((port) => {
    app.log(`FanSided Recruit listening on port ${port} (${config.production ? 'production' : 'development'}), data in ${config.dataDir}`);
    if (config.devLogin) app.log('WARNING: DEV_LOGIN=1 is on: anyone can sign in as any allowlisted user.');
    if (config.emailMode === 'log') app.log('EMAIL_MODE=log: emails are recorded in dev_mail_log, not sent.');
    if (config.ephemeralTokenKey) app.log('No TOKEN_ENCRYPTION_KEY set: using a temporary key (stored Google tokens will not survive a restart).');
  });
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };

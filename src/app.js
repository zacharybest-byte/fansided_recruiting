'use strict';
// Builds the application: config, database, mailer, routes and the request handler.
// createApp() is synchronous and cheap; the database is opened and migrated lazily on the first request
// (or when `ready` is read), which makes the handler safe to call on a serverless cold start.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./lib/config');
const { openDb, migrate, nowIso } = require('./lib/db');
const { createContext, Router, HttpError, clientIp, SECURITY_HEADERS } = require('./lib/http');
const { loadSession, requireAdmin } = require('./lib/auth');
const { errorPage } = require('./lib/layout');
const { createGoogle } = require('./lib/google');
const { createMailer } = require('./lib/email');

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

// One batch; an unchanged admin row is not written.
async function bootstrapAdmins(db, emails) {
  if (!emails.length) return;
  const now = nowIso();
  await db.batch(
    emails.map((email) => ({
      sql: `INSERT INTO users (email, name, role, active, created_at) VALUES (?, '', 'admin', 1, ?)
            ON CONFLICT(email) DO UPDATE SET role = 'admin', active = 1 WHERE role != 'admin' OR active != 1`,
      args: [email, now],
    }))
  );
}

// options: { env, log, db, dataDir, fetchImpl (outgoing Google calls), tursoFetchImpl (Turso driver) }
function createApp(options = {}) {
  const config = loadConfig(options.env || process.env);
  if (options.dataDir) config.dataDir = path.resolve(options.dataDir);
  const log = options.log || (config.quiet ? () => {} : (msg) => console.log(`${new Date().toISOString()} ${msg}`));
  const ownsDb = !options.db;
  const db = options.db || openDb(config, { fetchImpl: options.tursoFetchImpl });

  const google = createGoogle({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: `${config.baseUrl}/auth/google/callback`,
    fetchImpl: options.fetchImpl,
  });
  const app = { config, db, google, log };
  app.mailer = createMailer({ db, config, google, log });

  const router = new Router();
  require('./routes/public').register(router);
  require('./routes/auth').register(router);
  require('./routes/dashboard').register(router);
  require('./routes/candidates').register(router);
  require('./routes/admin').register(router);
  const staticFiles = loadStatic();

  // Init runs once per instance (migrations, bootstrap admins); a failure is retried on the next request.
  let initPromise = null;
  function ensureReady() {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
        } catch {
          /* read-only file system: uploads are removed in v2 anyway */
        }
        await migrate(db);
        await bootstrapAdmins(db, config.adminEmails);
      })().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  async function handle(req, res) {
    const ctx = createContext(req, res, app);
    ctx.ip = clientIp(req, config.trustProxy);
    try {
      const file = staticFiles.get(ctx.path);
      if (file && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
        return ctx.send(200, file.data, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=300' });
      }
      await ensureReady();
      await loadSession(ctx);
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

  function handler(req, res) {
    return handle(req, res).catch((err) => {
      log(`[fatal] ${err.stack || err}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }

  return {
    handler,
    get ready() {
      return ensureReady();
    },
    async close() {
      if (ownsDb) await db.close();
    },
    db,
    config,
    log,
    app,
  };
}

module.exports = { createApp };

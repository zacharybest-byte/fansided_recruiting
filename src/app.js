'use strict';
// Builds the application: config, database, routes and the request handler.
// createApp() is synchronous and cheap; the database is opened and migrated lazily on the first request
// (or when `ready` is read), which makes the handler safe to call on a serverless cold start.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('./lib/config');
const { openDb, migrate } = require('./lib/db');
const { repair: repairWorkflows } = require('./lib/stages');
const { createContext, Router, HttpError, clientIp, securityHeaders } = require('./lib/http');
const { loadSession, requireAdmin } = require('./lib/auth');
const { errorPage } = require('./lib/layout');
const { dummyHash } = require('./lib/password');

const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

// Assets are read from public/ when the files are present (local runs), otherwise from the embedded copy in
// src/lib/assets.generated.js, so they are always served whatever Vercel bundles with the function.
function loadStatic() {
  const embedded = require('./lib/assets.generated');
  const files = new Map();
  const read = (name, fallback) => {
    try {
      return fs.readFileSync(path.join(__dirname, '..', 'public', name));
    } catch {
      return fallback();
    }
  };
  for (const name of Object.keys(embedded)) {
    if (name === '__binary') continue;
    const data = read(name, () => Buffer.from(embedded[name]));
    files.set(`/public/${name}`, { data, type: STATIC_TYPES[path.extname(name)] });
    if (name === 'favicon.svg') files.set('/favicon.ico', { data, type: STATIC_TYPES['.svg'] });
  }
  // Binary files (logo, fonts) are embedded as base64 and decoded to Buffers.
  for (const [name, b64] of Object.entries(embedded.__binary || {})) {
    files.set(`/public/${name}`, { data: read(name, () => Buffer.from(b64, 'base64')), type: STATIC_TYPES[path.extname(name)] });
  }
  return files;
}

const GENERIC_500 = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Something went wrong</title></head><body><h1>Something went wrong</h1><p>The service is not available right now. Please try again later.</p></body></html>';

// Unusable configuration (production without its required variables): the app still returns a handler, which
// answers every request with a generic 500, and the variable NAMES are logged. server.js exits 1 on `configError`.
function brokenApp(err, options) {
  const log = options.log || ((msg) => console.log(`${new Date().toISOString()} ${msg}`));
  log(`[config] ${err.message}`);
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL);
  return {
    configError: err,
    handler(req, res) {
      const body = Buffer.from(GENERIC_500);
      res.writeHead(500, { ...securityHeaders(production), 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
    get ready() {
      return Promise.reject(err);
    },
    async close() {},
    log,
  };
}

// options: { env, log, db, dataDir, fetchImpl (outgoing webhook call), tursoFetchImpl (Turso driver),
//            trustedIpHeader (request header carrying the client IP; default x-vercel-forwarded-for on Vercel, else none) }
function createApp(options = {}) {
  let config;
  try {
    config = loadConfig(options.env || process.env);
  } catch (err) {
    if (err instanceof ConfigError) return brokenApp(err, options);
    throw err;
  }
  if (options.dataDir) config.dataDir = path.resolve(options.dataDir);
  const log = options.log || ((msg) => console.log(`${new Date().toISOString()} ${msg}`));
  for (const w of config.warnings) log(`[config] warning: ${w}`);
  const trustedIpHeader = options.trustedIpHeader !== undefined ? options.trustedIpHeader : config.vercel ? 'x-vercel-forwarded-for' : null;
  const ownsDb = !options.db;
  const db = options.db || openDb(config, { fetchImpl: options.tursoFetchImpl });
  const app = { config, db, log, fetchImpl: options.fetchImpl };

  const router = new Router();
  require('./routes/public').register(router);
  require('./routes/auth').register(router);
  require('./routes/dashboard').register(router);
  require('./routes/candidates').register(router);
  require('./routes/admin').register(router);
  const staticFiles = loadStatic();

  // Init runs once per instance (migrations, dummy password hash); a failure is retried on the next request.
  let initPromise = null;
  function ensureReady() {
    if (!initPromise) {
      initPromise = (async () => {
        await migrate(db);
        // Idempotent: a no-op unless an older deployment wrote a role or application without its workflow rows.
        await repairWorkflows(db);
        await dummyHash();
      })().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  async function handle(req, res) {
    const ctx = createContext(req, res, app);
    ctx.ip = clientIp(req, trustedIpHeader);
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
      if (match.methodNotAllowed) {
        res.setHeader('Allow', match.allow.join(', '));
        throw new HttpError(405, 'Method not allowed.');
      }
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
      if (status === 413) message = 'That request was too large (the limit is 512 KB).';
      if (status === 413 || status === 415) res.setHeader('Connection', 'close');
      try {
        errorPage(ctx, status, message);
      } catch (renderErr) {
        log(`[error] rendering error page failed: ${renderErr}`);
        res.writeHead(status, { ...securityHeaders(config.production), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : message);
      }
    }
  }

  function handler(req, res) {
    return handle(req, res).catch((err) => {
      log(`[fatal] ${err.stack || err}`);
      if (!res.headersSent) res.writeHead(500, { ...securityHeaders(config.production), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('Something went wrong');
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

// Vercel may pick this file (src/app.js) as the function entry point by convention, and then requires its
// default export to be a request handler. So the module itself IS the handler (one lazily created app per
// function instance), with createApp attached for api/index.js, src/server.js and the tests.
let defaultApp = null;
function defaultHandler(req, res) {
  if (!defaultApp) defaultApp = createApp();
  return defaultApp.handler(req, res);
}

module.exports = defaultHandler;
module.exports.createApp = createApp;
module.exports.default = defaultHandler;


'use strict';
// Test helpers: start the app on a random port with a temp DATA_DIR, and a cookie-keeping HTTP client.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { createHttpServer } = require('../src/server');
const { nowIso, openDb, migrate } = require('../src/lib/db');
const { startFakeTurso } = require('./fake-turso');

let ipCounter = 1;

// Every integration suite runs on both drivers: the local sqlite file, and the Turso HTTP driver
// against a local fake of /v2/pipeline (test/fake-turso.js).
const DRIVERS = ['sqlite', 'turso'];

// Starts the app on a random port. `driver` is 'sqlite' or 'turso'. For restarts pass the same
// `dataDir` (and `fake`, for turso), or use `t.restart()`.
async function startApp({ driver = 'sqlite', env = {}, dataDir, fake, fetchImpl, log, ownFake: ownFakeOpt } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-test-'));
  const ownFake = ownFakeOpt ?? (driver === 'turso' && !fake);
  const theFake = driver === 'turso' ? fake || (await startFakeTurso()) : null;
  const dbEnv = driver === 'turso' ? { TURSO_DATABASE_URL: theFake.url, TURSO_AUTH_TOKEN: theFake.token } : {};
  const instance = createApp({
    env: {
      NODE_ENV: 'test',
      DATA_DIR: dir,
      DEV_LOGIN: '1',
      EMAIL_MODE: 'log',
      TRUST_PROXY: '1',
      QUIET: '1',
      ADMIN_EMAILS: 'admin@fansided.com',
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      BASE_URL: 'http://localhost',
      ...dbEnv,
      ...env,
    },
    fetchImpl,
    log: log || (() => {}),
  });
  await instance.ready;
  const server = createHttpServer(instance.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const t = {
    driver,
    app: instance.app,
    instance,
    db: instance.db,
    fake: theFake,
    base,
    dataDir: dir,
    client: (opts) => new Client(base, opts),
    async close({ keepData = false } = {}) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await instance.close();
      if (!keepData) {
        if (ownFake) await theFake.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    // Tears the whole app down (server, app instance, caches) and builds a new one on the same database.
    async restart(opts = {}) {
      await t.close({ keepData: true });
      return startApp({ driver, env, dataDir: dir, fake: theFake, fetchImpl, log, ownFake, ...opts });
    },
  };
  return t;
}

// An empty, migrated database on the given driver, without the app (for database-level tests).
async function freshDb(driver, { fetchImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsr-db-'));
  const fake = driver === 'turso' ? await startFakeTurso() : null;
  const db = openDb({ dataDir: dir, tursoUrl: fake && fake.url, tursoToken: fake && fake.token }, { fetchImpl });
  await migrate(db);
  return {
    db,
    fake,
    dir,
    async close() {
      await db.close();
      if (fake) await fake.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

class Client {
  constructor(base, { ip } = {}) {
    this.base = base;
    this.jar = new Map();
    this.ip = ip || `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
    this.lastHtml = '';
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/Max-Age=0/i.test(c) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(method, url, { body, headers = {} } = {}) {
    const res = await fetch(this.base + url, {
      method,
      body,
      redirect: 'manual',
      headers: { cookie: this.cookieHeader(), 'x-forwarded-for': this.ip, ...headers },
    });
    this.storeCookies(res);
    const buf = Buffer.from(await res.arrayBuffer());
    res.buffer = buf;
    res.text = buf.toString('utf8');
    if ((res.headers.get('content-type') || '').startsWith('text/html') && res.text) this.lastHtml = res.text;
    return res;
  }

  get(url) {
    return this.request('GET', url);
  }

  // Follows one redirect (303/302) with a GET.
  async follow(res) {
    const loc = res.headers.get('location');
    if (!loc) return res;
    return this.get(loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc);
  }

  csrf(htmlText = this.lastHtml) {
    const m = /name="csrf" value="([0-9a-f]*)"/.exec(htmlText);
    return m ? m[1] : '';
  }

  // POST an urlencoded form; adds the CSRF token from the last HTML page unless given.
  post(url, fields = {}, { csrf } = {}) {
    const params = new URLSearchParams();
    const token = csrf !== undefined ? csrf : this.csrf();
    if (token !== null) params.append('csrf', token);
    for (const [k, v] of Object.entries(fields)) {
      if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
      else params.append(k, v);
    }
    return this.request('POST', url, { body: params, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  async login(email) {
    await this.get('/login');
    const res = await this.post('/auth/dev', { email, next: '/app' });
    if (res.status === 303) await this.get('/app');
    return res;
  }

  // Loads the role page (for the double-submit token) then submits a multipart application.
  async apply(roleId, fields = {}, { file, query = '' } = {}) {
    await this.get(`/roles/${roleId}${query}`);
    const fd = new FormData();
    fd.append('csrf', this.csrf());
    const defaults = { name: 'Test Person', email: `person${Date.now()}${Math.random()}@example.com`, sample_links: 'https://example.com/post', heard_from: 'LinkedIn' };
    const all = { ...defaults, ...fields };
    if (!('source' in fields)) {
      const m = /name="source" value="([^"]*)"/.exec(this.lastHtml);
      all.source = m ? m[1].replace(/&amp;/g, '&') : '';
    }
    if (!('qv' in fields)) {
      const m = /name="qv" value="([0-9a-f]*)"/.exec(this.lastHtml);
      all.qv = m ? m[1] : '';
    }
    for (const [k, v] of Object.entries(all)) if (v !== undefined) fd.append(k, v);
    if (file) fd.append('file', new Blob([file.data]), file.name);
    return this.request('POST', `/roles/${roleId}/apply`, { body: fd });
  }
}

async function makeUser(db, { email, name = email.split('@')[0], role = 'rep', active = 1 }) {
  const r = await db.run('INSERT INTO users (email, name, role, active, created_at) VALUES (?, ?, ?, ?, ?)', [email, name, role, active, nowIso()]);
  return r.lastInsertRowid;
}

async function makeRole(db, { title = 'Test Role', vertical = 'NFL', site = 'Test Site', status = 'open', assigned = null, questions = [], description = 'A role.' } = {}) {
  const now = nowIso();
  const r = await db.run(
    'INSERT INTO job_roles (title, vertical, site_name, description, status, assigned_user_id, questions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [title, vertical, site, description, status, assigned, JSON.stringify(questions), now, now]
  );
  return r.lastInsertRowid;
}

function lastApplication(db) {
  return db.get('SELECT * FROM applications ORDER BY id DESC LIMIT 1');
}

async function count(db, table, where = '1=1', ...args) {
  return (await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args)).n;
}

const pdf = (bytes = 2000) => {
  const b = Buffer.alloc(bytes, 0x20);
  b.write('%PDF-1.4\n');
  return b;
};

module.exports = { DRIVERS, startApp, freshDb, Client, makeUser, makeRole, lastApplication, count, pdf };

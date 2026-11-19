'use strict';
// Request/response helpers, body reading with a hard size cap, and a small router.
const { parseCookies, serializeCookie } = require('./cookies');
const { parseMultipart } = require('./multipart');
const { SafeHtml } = require('./render');

class HttpError extends Error {
  constructor(status, message) {
    super(message || String(status));
    this.status = status;
  }
}

class Form {
  constructor(fields = new Map(), files = []) {
    this.fields = fields;
    this.files = files;
  }
  get(name) {
    const v = this.fields.get(name);
    return v && v.length ? v[0] : '';
  }
  getAll(name) {
    return this.fields.get(name) || [];
  }
  has(name) {
    return this.fields.has(name);
  }
  file(name) {
    return this.files.find((f) => f.field === name && f.filename !== '') || null;
  }
}

// Reads the whole body into memory, refusing anything over `limit` bytes with a 413.
// Oversized bodies are drained (up to a bound) so the client can read the 413 response.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let size = 0;
    let tooBig = Number.isFinite(declared) && declared > limit;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooBig = true;
      if (tooBig) {
        chunks.length = 0;
        if (size > limit * 3 + 1024 * 1024) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new HttpError(413, 'Request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('close', () => {
      if (tooBig) reject(new HttpError(413, 'Request body too large'));
    });
  });
}

async function readForm(req, limit) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  const body = await readBody(req, limit);
  if (type.startsWith('multipart/form-data')) {
    try {
      const { fields, files } = parseMultipart(body, req.headers['content-type']);
      return new Form(fields, files);
    } catch {
      throw new HttpError(400, 'Malformed form data');
    }
  }
  const fields = new Map();
  if (type.startsWith('application/x-www-form-urlencoded') || type === '') {
    for (const [k, v] of new URLSearchParams(body.toString('utf8'))) {
      if (!fields.has(k)) fields.set(k, []);
      fields.get(k).push(v);
    }
    return new Form(fields, []);
  }
  throw new HttpError(415, 'Unsupported content type');
}

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

function createContext(req, res, app) {
  const url = new URL(req.url, 'http://internal');
  const ctx = {
    req,
    res,
    app,
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    cookies: parseCookies(req.headers.cookie),
    params: {},
    user: null,
    session: null,
    outCookies: [],
    setCookie(name, value, opts) {
      ctx.outCookies.push(serializeCookie(name, value, opts));
    },
    clearCookie(name, opts = {}) {
      ctx.outCookies.push(serializeCookie(name, '', { ...opts, maxAge: 0 }));
    },
    send(status, body, headers = {}) {
      if (res.headersSent) return;
      const isBuffer = Buffer.isBuffer(body);
      const payload = isBuffer ? body : Buffer.from(body instanceof SafeHtml ? body.value : String(body ?? ''), 'utf8');
      const h = { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers };
      if (!h['Content-Type']) h['Content-Type'] = 'text/html; charset=utf-8';
      h['Content-Length'] = payload.length;
      if (ctx.outCookies.length) h['Set-Cookie'] = ctx.outCookies;
      res.writeHead(status, h);
      res.end(req.method === 'HEAD' ? undefined : payload);
    },
    html(body, status = 200) {
      ctx.send(status, body);
    },
    redirect(location, status = 303) {
      ctx.send(status, '', { Location: location });
    },
  };
  return ctx;
}

class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\./g, '\\.').replace(/\/:([a-zA-Z_]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '/?$'
    );
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) {
    this.add('GET', p, ...h);
  }
  post(p, ...h) {
    this.add('POST', p, ...h);
  }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) {
        const params = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]);
          } catch {
            params[k] = m[i + 1];
          }
        });
        return { handlers: r.handlers, params };
      }
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Each trusted proxy appends the address it saw, so with N trusted proxies the
    // client address is the N-th entry from the right.
    if (xff.length) return xff[Math.max(0, xff.length - trustProxy)];
  }
  return req.socket.remoteAddress || 'unknown';
}

module.exports = { HttpError, Form, readBody, readForm, createContext, Router, clientIp, SECURITY_HEADERS };

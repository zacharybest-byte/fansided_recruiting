'use strict';
// Request/response helpers, body reading with a hard size cap, and a small router.
const { parseCookies, serializeCookie } = require('./cookies');
const { resolveBaseUrl } = require('./config');
const { SafeHtml } = require('./render');
const net = require('node:net');

class HttpError extends Error {
  constructor(status, message) {
    super(message || String(status));
    this.status = status;
  }
}

class Form {
  constructor(fields = new Map()) {
    this.fields = fields;
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
}

// One body cap for every POST.
const MAX_BODY_BYTES = 512 * 1024;

// Reads the whole body into memory, refusing anything over `limit` bytes with a 413.
// Oversized bodies are drained (up to a bound) so the client can read the 413 response.
function readBody(req, limit) {
  // Vercel's Node helpers can consume the stream and expose the parsed body as `req.body` instead.
  // If the stream is already finished, nothing more will arrive on it, so use the helper's value.
  if (req.readableEnded || req.destroyed) return Promise.resolve(bodyFromHelper(req, limit));
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
      else if (size === 0 && declared > 0) resolve(bodyFromHelper(req, limit)); // stream already drained by a helper
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
    req.on('close', () => {
      if (tooBig) reject(new HttpError(413, 'Request body too large'));
    });
  });
}

// Rebuilds the raw urlencoded body from Vercel's `req.body` helper (Buffer, string or parsed object).
// Returns an empty buffer when there is nothing usable. The size cap applies here too.
function bodyFromHelper(req, limit) {
  let value;
  try {
    value = req.body;
  } catch {
    return Buffer.alloc(0);
  }
  let buf;
  if (Buffer.isBuffer(value)) buf = value;
  else if (typeof value === 'string') buf = Buffer.from(value, 'utf8');
  else if (value && typeof value === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
      else if (v !== undefined && v !== null) params.append(k, String(v));
    }
    buf = Buffer.from(params.toString(), 'utf8');
  } else buf = Buffer.alloc(0);
  if (buf.length > limit) throw new HttpError(413, 'Request body too large');
  return buf;
}

// Only application/x-www-form-urlencoded is accepted (anything else is refused before the body is read).
async function readForm(req, limit = MAX_BODY_BYTES) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/x-www-form-urlencoded(\s*;|$)/.test(type)) throw new HttpError(415, 'Unsupported content type');
  const body = await readBody(req, limit);
  const fields = new Map();
  for (const [k, v] of new URLSearchParams(body.toString('utf8'))) {
    if (!fields.has(k)) fields.set(k, []);
    fields.get(k).push(v);
  }
  return new Form(fields);
}

// Sent on EVERY response (SPEC section 7). HSTS is added only in production.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const HSTS = 'max-age=63072000; includeSubDomains';

function securityHeaders(production) {
  return production ? { ...SECURITY_HEADERS, 'Strict-Transport-Security': HSTS } : { ...SECURITY_HEADERS };
}

function createContext(req, res, app) {
  const url = new URL(req.url, 'http://internal');
  // On Vercel, vercel.json rewrites every path to /api/index and the function then sees that as its URL.
  // The rewrite passes the path the visitor asked for as ?__path=, which is restored here. Asking for
  // /api/index?__path=/x directly is the same as asking for /x, so this grants nothing extra.
  if (url.pathname === '/api/index' || url.pathname === '/api/index.js') {
    const original = url.searchParams.get('__path');
    url.searchParams.delete('__path');
    url.pathname = original && original.startsWith('/') && !original.startsWith('//') ? original : '/';
  }
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
      const h = { ...securityHeaders(app.config.production), 'Cache-Control': 'no-store', ...headers };
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
    baseUrl() {
      return resolveBaseUrl(app.config, req);
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
    const allow = new Set();
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      allow.add(r.method);
      if (r.method === 'GET') allow.add('HEAD');
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
    return allow.size ? { methodNotAllowed: true, allow: [...allow] } : null;
  }
}

// Rate-limit bucket for an address: IPv4 as is; IPv6 (also "::ffff:a.b.c.d" mapped IPv4) by its /64, because one
// subscriber normally controls a whole /64 and could otherwise use a fresh address for every request.
function ipBucket(raw) {
  const ip = String(raw || '').split('%')[0].toLowerCase();
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return ip || 'unknown';
  const [head, tail] = ip.split('::');
  const mapped = /^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip.replace('::', ':0:'));
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  const toGroups = (part) =>
    (part ? part.split(':') : []).flatMap((g) => {
      if (!g.includes('.')) return [g];
      const o = g.split('.').map(Number);
      return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    });
  const h = toGroups(head);
  const t = tail === undefined ? [] : toGroups(tail);
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// Client address for rate limits. `trustedHeader` is only read when the app is told to trust it. On Vercel that is
// `x-vercel-forwarded-for`: Vercel documents that it sets the client's public IP there (identical to
// x-forwarded-for, but not overwritten by a proxy placed in front of Vercel) and does not forward external values.
// If a list is ever present the right-most entry is used (the address the platform itself saw). Otherwise
// (local runs, tests without the option) the socket address is used. The result is an ipBucket().
function clientIp(req, trustedHeader) {
  if (trustedHeader) {
    const parts = String(req.headers[trustedHeader] || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length) return ipBucket(parts[parts.length - 1].slice(0, 64));
  }
  return ipBucket(req.socket.remoteAddress);
}

module.exports = { HttpError, Form, MAX_BODY_BYTES, readBody, readForm, createContext, Router, clientIp, ipBucket, SECURITY_HEADERS, securityHeaders };

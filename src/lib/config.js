'use strict';
// Configuration. Exactly these environment variables are read (see README / .env.example):
//   TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SESSION_SECRET, ADMIN_EMAIL, SETUP_TOKEN, BASE_URL,
//   NOTIFY_WEBHOOK_URL, plus PORT, NODE_ENV, VERCEL, VERCEL_URL, VERCEL_PROJECT_PRODUCTION_URL.
// Tests pass options to createApp() instead of using more variables.
const path = require('node:path');

const TIMEZONE = 'America/New_York';
const DEV_SECRET = 'dev-only-session-secret-do-not-use-in-production';

// Thrown for unusable configuration. `missing` holds variable NAMES only, never values.
class ConfigError extends Error {
  constructor(missing) {
    super(`Missing or invalid configuration: ${missing.join(', ')}`);
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

function parseUrl(value, protocols) {
  try {
    const u = new URL(String(value).trim());
    return protocols.includes(u.protocol) && !u.username && !u.password ? u : null;
  } catch {
    return null;
  }
}

function loadConfig(env = process.env) {
  const vercel = Boolean(env.VERCEL);
  const production = env.NODE_ENV === 'production' || vercel;
  const warnings = [];
  const tursoUrl = String(env.TURSO_DATABASE_URL || '').trim();
  const tursoToken = String(env.TURSO_AUTH_TOKEN || '');
  const sessionSecret = String(env.SESSION_SECRET || '');

  const missing = [];
  if (production) {
    if (sessionSecret.length < 32) missing.push('SESSION_SECRET');
    if (!tursoUrl) missing.push('TURSO_DATABASE_URL');
    if (!tursoToken) missing.push('TURSO_AUTH_TOKEN');
  } else if (tursoUrl && !tursoToken) {
    missing.push('TURSO_AUTH_TOKEN');
  }
  if (missing.length) throw new ConfigError(missing);

  let secret = sessionSecret;
  if (!production && sessionSecret.length < 32) {
    secret = DEV_SECRET;
    warnings.push('SESSION_SECRET is missing or shorter than 32 characters: using a fixed development value. Never do this in production.');
  }

  const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  let validAdmin = adminEmail;
  if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    validAdmin = '';
    warnings.push('ADMIN_EMAIL is not a valid email address: the setup link is disabled.');
  }
  let setupToken = String(env.SETUP_TOKEN || '');
  if (setupToken && setupToken.length < 20) {
    setupToken = '';
    warnings.push('SETUP_TOKEN is shorter than 20 characters: the setup link is disabled.');
  }

  let webhookUrl = '';
  if (env.NOTIFY_WEBHOOK_URL) {
    const u = parseUrl(env.NOTIFY_WEBHOOK_URL, ['https:']);
    if (u) webhookUrl = u.toString();
    else warnings.push('NOTIFY_WEBHOOK_URL must be an https:// URL: the webhook is ignored.');
  }

  // Base URL (SPEC section 6): BASE_URL, else VERCEL_PROJECT_PRODUCTION_URL, else VERCEL_URL, else (outside
  // production only) the request host, resolved per request by resolveBaseUrl().
  let baseUrl = '';
  const candidates = [];
  if (env.BASE_URL) candidates.push(['BASE_URL', env.BASE_URL]);
  if (env.VERCEL_PROJECT_PRODUCTION_URL) candidates.push(['VERCEL_PROJECT_PRODUCTION_URL', `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`]);
  if (env.VERCEL_URL) candidates.push(['VERCEL_URL', `https://${env.VERCEL_URL}`]);
  for (const [name, value] of candidates) {
    const u = parseUrl(value, ['https:', 'http:']);
    if (u) {
      baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
      break;
    }
    warnings.push(`${name} is not a valid URL and was ignored.`);
  }

  return {
    production,
    vercel,
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 3000,
    dataDir: path.resolve('./data'),
    tursoUrl,
    tursoToken,
    secret,
    adminEmail: validAdmin,
    setupToken,
    baseUrl,
    webhookUrl,
    timezone: TIMEZONE,
    warnings,
  };
}

// Public base URL for links in invite pages and webhook messages ('' when it cannot be known safely).
function resolveBaseUrl(config, req) {
  if (config.baseUrl) return config.baseUrl;
  if (config.production) return '';
  const host = String((req && req.headers && req.headers.host) || '');
  return /^[a-z0-9.\-]+(:\d{1,5})?$/i.test(host) ? `http://${host}` : `http://localhost:${config.port}`;
}

module.exports = { loadConfig, resolveBaseUrl, ConfigError, TIMEZONE, DEV_SECRET };

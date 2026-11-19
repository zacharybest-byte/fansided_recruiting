'use strict';
// Reads configuration from environment variables (see README / .env.example).
const path = require('node:path');
const crypto = require('node:crypto');

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3000);
  const config = {
    production,
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    allowedEmailDomains: list(env.ALLOWED_EMAIL_DOMAINS),
    adminEmails: list(env.ADMIN_EMAILS),
    maxUploadMb: Number(env.MAX_UPLOAD_MB || 10),
    timezone: env.APP_TIMEZONE || 'America/New_York',
    voltaxApiUrl: env.VOLTAX_API_URL || '',
    voltaxApiKey: env.VOLTAX_API_KEY || '',
    devLogin: env.DEV_LOGIN === '1',
    emailMode: (env.EMAIL_MODE || 'gmail').toLowerCase(),
    // Number of trusted reverse proxies in front of the app (0 = use the socket address).
    trustProxy: /^\d+$/.test(env.TRUST_PROXY || '') ? Number(env.TRUST_PROXY) : 0,
    quiet: env.QUIET === '1',
    tokenKey: null,
  };

  if (config.devLogin && production) {
    throw new Error('DEV_LOGIN=1 is refused when NODE_ENV=production.');
  }
  if (!['gmail', 'log'].includes(config.emailMode)) {
    throw new Error('EMAIL_MODE must be "gmail" or "log".');
  }
  if (!Number.isFinite(config.maxUploadMb) || config.maxUploadMb <= 0) {
    throw new Error('MAX_UPLOAD_MB must be a positive number.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.timezone });
  } catch {
    throw new Error(`APP_TIMEZONE "${config.timezone}" is not a valid IANA time zone.`);
  }

  if (env.TOKEN_ENCRYPTION_KEY) {
    const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    config.tokenKey = key;
  } else if (production) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required when NODE_ENV=production.');
  } else {
    // Dev only: a throwaway key. Stored refresh tokens become unreadable after a restart.
    config.tokenKey = crypto.randomBytes(32);
    config.ephemeralTokenKey = true;
  }

  if (production) {
    if (!config.googleClientId || !config.googleClientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when NODE_ENV=production.');
    }
    if (!env.BASE_URL) throw new Error('BASE_URL is required when NODE_ENV=production.');
  }

  config.maxUploadBytes = Math.floor(config.maxUploadMb * 1024 * 1024);
  config.maxBodyBytes = config.maxUploadBytes + 1024 * 1024;
  return config;
}

module.exports = { loadConfig };

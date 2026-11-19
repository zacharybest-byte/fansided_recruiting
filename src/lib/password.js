'use strict';
// Password hashing with scrypt (async, so the event loop is never blocked).
// Stored as  scrypt$N$r$p$saltB64$hashB64  : the parameters travel with the hash.
const crypto = require('node:crypto');

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MIN_LENGTH = 12;
const MAX_LENGTH = 200;
// Parameters read from a stored hash are bounded so a corrupt row cannot ask for gigabytes.
const MAX_N = 1 << 17;
const MAX_R = 16;
const MAX_P = 4;

function scrypt(password, salt, n, r, p, keylen) {
  const maxmem = 128 * n * r * 2 + 1024 * 1024 * 8 * p; // scrypt needs ~128*N*r bytes; allow headroom
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, { N: n, r, p, maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const okInt = (v, max) => Number.isInteger(v) && v >= 1 && v <= max;
  if (!okInt(n, MAX_N) || (n & (n - 1)) !== 0 || n < 2 || !okInt(r, MAX_R) || !okInt(p, MAX_P)) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || key.length < 16 || key.length > 128) return null;
  return { n, r, p, salt, key };
}

// Resolves true only for a matching password. A malformed stored hash is simply "no match".
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let derived;
  try {
    derived = await scrypt(password, parsed.salt, parsed.n, parsed.r, parsed.p, parsed.key.length);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(derived, parsed.key);
}

// One shared rule for setup, set-password and change-password. Returns an error message or null.
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    return `Password must be between ${MIN_LENGTH} and ${MAX_LENGTH} characters.`;
  }
  return null;
}

// A real hash of a random password, verified when the account is unknown, inactive or has no password,
// so the response time does not reveal whether an account exists. Primed at start-up; created lazily otherwise.
let dummy = null;
function dummyHash() {
  if (!dummy) {
    dummy = hashPassword(crypto.randomBytes(24).toString('hex')).catch((err) => {
      dummy = null;
      throw err;
    });
  }
  return dummy;
}

module.exports = { hashPassword, verifyPassword, validatePassword, dummyHash, MIN_LENGTH, MAX_LENGTH };

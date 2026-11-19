'use strict';
// Small helpers around node:crypto: random tokens, hashes, HMACs and a constant-time comparison.
const crypto = require('node:crypto');

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// 32 random bytes as base64url (43 characters): used for invite, reset and setup-style links.
function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

// Constant-time string comparison. Both sides are hashed first so the length is not leaked either.
// Empty or missing values never match.
function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (!x || !y) return false;
  const hx = crypto.createHash('sha256').update(x).digest();
  const hy = crypto.createHash('sha256').update(y).digest();
  return crypto.timingSafeEqual(hx, hy);
}

module.exports = { randomHex, randomToken, sha256Hex, hmacHex, safeEqual };

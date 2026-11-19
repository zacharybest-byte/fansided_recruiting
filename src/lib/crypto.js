'use strict';
// AES-256-GCM encryption for stored refresh tokens, plus random tokens.
const crypto = require('node:crypto');

const VERSION = 'v1';

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

function decrypt(payload, key) {
  const [version, data] = String(payload || '').split(':');
  if (version !== VERSION || !data) throw new Error('Unrecognised encrypted token format');
  const buf = Buffer.from(data, 'base64');
  if (buf.length < 29) throw new Error('Encrypted token is too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { encrypt, decrypt, randomHex, safeEqual };

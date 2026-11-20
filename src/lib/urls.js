'use strict';
// Link validation shared by the apply form and the email template form.

// Accepts "https://x" or a bare "example.com/x" (https:// is added). http:// and every other scheme
// (javascript:, data:, ftp:, ...) is refused. Returns '' for empty input and null for an invalid URL.
function normaliseUrl(value) {
  let v = String(value || '').trim();
  if (!v) return '';
  if (/^[/\\]|\s/.test(v)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(v);
  const hostAndPort = /^[^/?#:@]+:\d+([/?#]|$)/.test(v); // "example.com:8080/x" is a host, not a scheme
  if (hasScheme && !hostAndPort && !/^https:\/\//i.test(v)) return null;
  if (!hasScheme || hostAndPort) v = `https://${v}`;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && u.hostname.includes('.') && !u.username && !u.password) return u.toString();
  } catch {
    /* invalid */
  }
  return null;
}

module.exports = { normaliseUrl };

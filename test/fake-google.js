'use strict';
// A fake of the Google endpoints used by src/lib/google.js, injected as fetchImpl.
const { TOKEN_URL, USERINFO_URL, GMAIL_SEND_URL, SCOPES } = require('../src/lib/google');

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function createFakeGoogle() {
  const fake = {
    identities: new Map(), // code -> { email, email_verified, name, refresh_token? }
    revoked: new Set(), // refresh tokens that now fail with invalid_grant
    failSendFor: new Set(), // access tokens whose Gmail send fails
    sent: [], // { accessToken, raw, decoded }
    calls: [],
    refreshCalls: [],
    addIdentity(code, identity) {
      fake.identities.set(code, identity);
    },
    async fetch(url, opts = {}) {
      fake.calls.push(String(url));
      const u = String(url);
      if (u === TOKEN_URL) {
        const p = new URLSearchParams(opts.body);
        if (p.get('grant_type') === 'authorization_code') {
          const id = fake.identities.get(p.get('code'));
          if (!id || !p.get('client_id') || !p.get('client_secret') || !p.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
          return json(200, {
            access_token: `at-${p.get('code')}`,
            expires_in: 3599,
            token_type: 'Bearer',
            scope: id.scope || SCOPES.join(' '),
            id_token: 'unused',
            ...(id.refresh_token ? { refresh_token: id.refresh_token } : {}),
          });
        }
        if (p.get('grant_type') === 'refresh_token') {
          const rt = p.get('refresh_token');
          fake.refreshCalls.push(rt);
          if (fake.revoked.has(rt)) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          return json(200, { access_token: `at-from-${rt}`, expires_in: 3599, token_type: 'Bearer' });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (u === USERINFO_URL) {
        const token = String(opts.headers.Authorization || '').replace('Bearer ', '');
        const id = fake.identities.get(token.replace(/^at-/, ''));
        if (!id) return json(401, { error: 'invalid_token' });
        return json(200, { sub: `sub-${id.email}`, email: id.email, email_verified: id.email_verified, name: id.name });
      }
      if (u === GMAIL_SEND_URL) {
        const accessToken = String(opts.headers.Authorization || '').replace('Bearer ', '');
        const { raw } = JSON.parse(opts.body);
        if (fake.failSendFor.has(accessToken)) return json(403, { error: { code: 403, message: 'Insufficient Permission' } });
        const decoded = Buffer.from(raw, 'base64url').toString('utf8');
        fake.sent.push({ accessToken, raw, decoded });
        return json(200, { id: `gmail-${fake.sent.length}`, threadId: 't1', labelIds: ['SENT'] });
      }
      return json(404, { error: 'unknown endpoint in fake' });
    },
  };
  fake.fetch = fake.fetch.bind(fake);
  return fake;
}

// Runs the real OAuth redirect + callback against the fake. Returns the callback response.
async function googleSignIn(client, code) {
  const start = await client.get('/auth/google?next=/app');
  const loc = new URL(start.headers.get('location'));
  const state = loc.searchParams.get('state');
  const res = await client.get(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${state}`);
  return { start, startUrl: loc, res };
}

module.exports = { createFakeGoogle, googleSignIn };

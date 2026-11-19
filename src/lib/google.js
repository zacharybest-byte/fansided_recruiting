'use strict';
// Google OAuth 2.0 / OpenID Connect (authorization code flow) and Gmail send, via fetch.
// Endpoints as documented by Google:
//   https://developers.google.com/identity/protocols/oauth2/web-server
//   https://developers.google.com/identity/openid-connect/openid-connect
//   https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'];

class GoogleError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code; // e.g. 'invalid_grant' when a refresh token was revoked
  }
}

function createGoogle({ clientId, clientSecret, redirectUri, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function postForm(url, params) {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new GoogleError(`Google token endpoint error: ${data.error || res.status} ${data.error_description || ''}`.trim(), {
        status: res.status,
        code: data.error,
      });
    }
    return data;
  }

  return {
    configured: Boolean(clientId && clientSecret),
    scopes: SCOPES,

    authorizationUrl({ state, forceConsent = false, loginHint }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        include_granted_scopes: 'true',
        state,
      });
      // Google only returns a refresh token on first consent; force the consent
      // screen again when we need a fresh one.
      if (forceConsent) params.set('prompt', 'consent');
      if (loginHint) params.set('login_hint', loginHint);
      return `${AUTH_URL}?${params}`;
    },

    // Returns { access_token, expires_in, refresh_token?, scope, id_token, token_type }
    exchangeCode(code) {
      return postForm(TOKEN_URL, {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
    },

    refreshAccessToken(refreshToken) {
      return postForm(TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
    },

    // Returns { sub, email, email_verified, name, ... }
    async userinfo(accessToken) {
      const res = await doFetch(USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new GoogleError(`Google userinfo error: ${res.status}`, { status: res.status });
      return res.json();
    },

    // Sends a raw RFC 2822 message; returns the Gmail message id.
    async sendGmail(accessToken, rawMessage) {
      const res = await doFetch(GMAIL_SEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(rawMessage, 'utf8').toString('base64url') }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data.error && data.error.message) || res.status;
        throw new GoogleError(`Gmail send error: ${msg}`, { status: res.status });
      }
      return data.id;
    },
  };
}

module.exports = { createGoogle, GoogleError, SCOPES, AUTH_URL, TOKEN_URL, USERINFO_URL, GMAIL_SEND_URL };

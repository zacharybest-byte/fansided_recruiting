'use strict';
// Outgoing email: merge fields, RFC 2822 message building, and delivery either
// through the Gmail API as the sending user (EMAIL_MODE=gmail) or to a local log (EMAIL_MODE=log).
const crypto = require('node:crypto');
const { decrypt } = require('./crypto');
const { nowIso } = require('./db');

const MERGE_FIELDS = {
  first_name: "First word of the candidate's name",
  role_title: "The application's current role title",
  rep_name: 'Your name (the sender)',
};

// Resolves {{field}} placeholders. Unknown fields stay as literal text and are reported.
function applyMergeFields(text, values) {
  const unknown = new Set();
  const out = String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(MERGE_FIELDS, key)) return values[key] ?? '';
    unknown.add(key);
    return m;
  });
  return { text: out, unknown: [...unknown] };
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

const stripCrlf = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

function encodeHeaderWord(value) {
  const v = stripCrlf(value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function formatAddress(name, email) {
  const addr = stripCrlf(email);
  const n = stripCrlf(name);
  if (!n) return addr;
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(n)) return `"${n.replace(/["\\]/g, '\\$&')}" <${addr}>`;
  return `${encodeHeaderWord(n)} <${addr}>`;
}

// Plain-text UTF-8 message with CRLF line endings; body is base64 so any text is safe.
function buildRfc2822({ fromName, fromEmail, to, subject, body, date = new Date() }) {
  const domain = String(fromEmail).split('@')[1] || 'localhost';
  const normalisedBody = String(body || '').replace(/\r?\n/g, '\r\n');
  const b64 = Buffer.from(normalisedBody, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${formatAddress(fromName, fromEmail)}`,
    `To: ${stripCrlf(to)}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
  ].join('\r\n');
}

class NoTokenError extends Error {}

function createMailer({ db, config, google, log }) {
  const mailer = {
    mode: config.emailMode,

    // Delivers one message from `sender` (a users row). Returns { messageId }.
    async deliver(sender, { to, subject, body }) {
      if (!/^[^\s@<>]+@[^\s@<>]+$/.test(String(to))) throw new Error('Invalid recipient address');
      if (mailer.mode === 'log') {
        const r = db
          .prepare('INSERT INTO dev_mail_log (from_user_id, from_email, to_email, subject, body, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(sender.id, sender.email, to, subject, body, nowIso());
        log(config.production ? `[email:log] #${r.lastInsertRowid} from user ${sender.id}` : `[email:log] from=${sender.email} to=${to} subject=${JSON.stringify(subject)}`);
        return { messageId: `log-${r.lastInsertRowid}` };
      }
      const row = db.prepare('SELECT google_refresh_token_enc FROM users WHERE id = ?').get(sender.id);
      if (!row || !row.google_refresh_token_enc) throw new NoTokenError(`No stored Google token for ${sender.email}`);
      let refreshToken;
      try {
        refreshToken = decrypt(row.google_refresh_token_enc, config.tokenKey);
      } catch {
        throw new NoTokenError(`Stored Google token for ${sender.email} could not be decrypted`);
      }
      let tokens;
      try {
        tokens = await google.refreshAccessToken(refreshToken);
      } catch (err) {
        if (err.code === 'invalid_grant') {
          // Revoked or expired: forget it so the user is asked to sign in again.
          db.prepare('UPDATE users SET google_refresh_token_enc = NULL WHERE id = ?').run(sender.id);
        }
        throw err;
      }
      const raw = buildRfc2822({ fromName: sender.name, fromEmail: sender.email, to, subject, body });
      const messageId = await google.sendGmail(tokens.access_token, raw);
      return { messageId };
    },

    // Sends a candidate email and records the attempt in emails_sent. Never throws.
    async sendCandidateEmail({ sender, application, person, templateId, subject, body }) {
      let status = 'sent';
      let error = null;
      let messageId = null;
      try {
        ({ messageId } = await mailer.deliver(sender, { to: person.email, subject, body }));
      } catch (err) {
        status = 'failed';
        error = String(err.message || err).slice(0, 1000);
        log(`[email] send failed for application ${application.id} from user ${sender.id}: ${error}`);
      }
      db.prepare(
        `INSERT INTO emails_sent (person_id, application_id, role_id, template_id, sender_user_id, to_email, subject, body,
           gmail_message_id, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(person.id, application.id, application.role_id, templateId || null, sender.id, person.email, subject, body, messageId, status, error, nowIso());
      return { ok: status === 'sent', error };
    },

    // New-application notification to the role's assigned rep. Never throws.
    async notifyNewApplication({ role, person, applicationId }) {
      const subject = `New application: ${person.name} for ${role.title}`;
      const link = `${config.baseUrl}/app/applications/${applicationId}`;
      const body = `${person.name} <${person.email}> applied for ${role.title}${role.site_name ? ` (${role.site_name})` : ''}.\n\nOpen the candidate: ${link}\n`;
      const rep = role.assigned_user_id
        ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(role.assigned_user_id)
        : null;
      const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
      const recipient = rep || admin;
      if (!recipient) {
        log(`[notify] no rep or admin to notify about application ${applicationId}`);
        return { sent: false };
      }
      const senders = [rep, admin].filter((u, i, a) => u && a.findIndex((x) => x && x.id === u.id) === i);
      for (const sender of senders) {
        try {
          await mailer.deliver(sender, { to: recipient.email, subject, body });
          return { sent: true, to: recipient.email, via: sender.email };
        } catch (err) {
          log(`[notify] application ${applicationId}: sending as user ${sender.id} failed: ${err.message}`);
        }
      }
      log(`[notify] NOT SENT for application ${applicationId} (rep user ${recipient.id}): ${link}`);
      return { sent: false };
    },
  };
  return mailer;
}

module.exports = { createMailer, applyMergeFields, firstName, buildRfc2822, MERGE_FIELDS, NoTokenError };

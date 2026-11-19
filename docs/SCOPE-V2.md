# FanSided Recruit — Scope v2 (light, secure, quick to ship)

Owner's words: "easy to ship and secure, not something that requires our team to install a ton
of third-party tools or do a long implementation. It needs to work without being heavy."
Target: GitHub repo -> Vercel, one hosted database added from the Vercel dashboard. Team demo first.

Rule: if a feature needs another service, another login system or stored credentials, cut it or
replace it with something simpler.

## Product scope (v1)

Keep from v1.1 (already built and tested in this repo):
- Public openings list, role page with per-role questionnaire, apply form, thank-you page.
- `?source=` capture, "how did you hear about us", honeypot, apply rate limit.
- One person per email (dedupe), re-apply creates a new application; history on candidate page.
- Pipeline list per role with fixed stages New, Reviewing, Trial, Onboarded, Passed.
- Notes; append-only event log of stage changes and role moves; move candidate to another role.
- Voltax user ID + date entered by hand on Onboarded. `src/voltax.js` stub stays.
- Email templates with merge fields ({{first_name}}, {{role_title}}, {{rep_name}}), editable by admin.
- CSV export (formula-injection guard). Reassign role to another rep.
- Admin: roles + questionnaires, users (invite, role, name, deactivate), templates, delete candidate.
- Questionnaire fingerprint check, role_id snapshot on notes/emails, no id reuse.

Change:
1. HOSTING: runs on Vercel as a single Node function (zero npm dependencies stays a hard rule).
   Also still runs locally with `npm run dev` as a plain Node http server. Remove Dockerfile,
   deploy/ VM files, backup scripts.
2. DATABASE: Turso (libSQL) over its HTTP API (`POST {url}/v2/pipeline`, Bearer token) using fetch.
   Local dev and tests use node:sqlite behind the SAME async interface. Tests must also exercise
   the Turso driver against a local fake of /v2/pipeline backed by node:sqlite.
   No interactive transactions over HTTP: every multi-statement write must be one atomic batch.
   Nothing may rely on in-memory state between requests (rate limits, sessions, CSRF) — serverless.
   Migrations run safely on cold start (idempotent, cheap check).
3. SIGN-IN: remove Google OAuth entirely. Email + password.
   - scrypt (node:crypto) with per-user salt, timing-safe compare, min length 12.
   - Admin invites a user -> single-use, expiring invite link (token stored hashed) shown to the
     admin to copy; user sets password. Same mechanism for admin-triggered password reset.
   - First admin: ADMIN_EMAIL env + one-time SETUP_TOKEN env -> /setup?token=... sets password;
     dead once an admin with a password exists.
   - Login rate limit per email + per IP, stored in DB. Generic error messages.
   - Sessions in DB (hashed token), HttpOnly Secure SameSite=Lax cookie, expiry, killed on
     deactivate/password change. SESSION_SECRET env for signing/CSRF.
4. EMAIL: remove Gmail API, refresh tokens, TOKEN_ENCRYPTION_KEY, dev_mail_log.
   Candidate page: pick template -> merge fields filled -> editable subject/body -> button
   "Open in Gmail" (https://mail.google.com/mail/?view=cm&fs=1&to=..&su=..&body=..) plus a
   plain mailto: fallback, opened in a new tab; the same click logs the email (subject, body,
   template, rep, role) on the candidate as "opened in Gmail".
5. ALERTS: no notification email. Dashboard shows count of New applications per role (and
   "new since your last visit"). Optional NOTIFY_WEBHOOK_URL: POST {"text": "..."} (works for
   Google Chat and Slack incoming webhooks); message contains role title and a link only —
   no applicant name/email. Failure never blocks the application.
6. UPLOADS: removed. Apply form takes an optional resume link plus writing-sample links
   (https only). Remove multipart parser, file routes, uploads dir.
7. DEMO DATA: admin-only "Load sample data" and "Remove sample data" actions (clearly fake
   people at example.com), so the team demo needs no CLI.

## Security requirements
- CSRF tokens on every POST (no in-memory store). Escape-by-default templating stays.
- Security headers on every response: CSP (no inline script unless nonce'd), X-Frame-Options
  DENY / frame-ancestors 'none', X-Content-Type-Options, Referrer-Policy, HSTS in production.
- Only parameterised SQL. Request body size cap. Length limits on all fields.
- Admin-only routes enforced server-side; last-admin guard.
- Logs contain ids only, never applicant names/emails.
- Open-redirect safe `next` handling. Production refuses to start without SESSION_SECRET
  (>= 32 chars), TURSO_DATABASE_URL, TURSO_AUTH_TOKEN. No dev-login bypass in production.
- Delete-candidate removes person, applications, notes, emails, events; keeps PII-free log row.

## Configuration (complete list)
TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (injected by the Vercel Turso integration), SESSION_SECRET,
ADMIN_EMAIL, SETUP_TOKEN, BASE_URL (optional; default from request host / VERCEL_URL),
NOTIFY_WEBHOOK_URL (optional).

## Deliverables
- Repo that deploys on Vercel by import with no build step: `api/index.js` (exports the request
  handler), `vercel.json` routing all paths to it, static assets served by the function or
  `public/`, `package.json` with engines node 22.x and NO dependencies.
- `node --test` green; tests cover every feature and security requirement above, on both DB drivers.
- README: one page. What it is; 5-step Vercel setup; run locally; settings table; what's
  untested on real infrastructure (Vercel, Turso — no network in the build sandbox).
- docs/SPEC.md updated to v2 with numbered acceptance checks; docs/NOTES.md changelog.
- Version 2.0.0, committed to git.

## Not in v1 (add later)
Resume file upload, Google sign-in, Gemini scouting, in-tool reports, automatic Voltax creation,
AI candidate search, revenue tie-in, job-board integrations.

# Build notes

## 2.0.0 (Vercel + Turso + password sign-in)

Contract: `docs/SCOPE-V2.md`. Spec and acceptance checks: `docs/SPEC.md` (AC-36 to AC-60 are new).

### Removed
- Google OAuth sign-in, Gmail API sending, refresh tokens and `TOKEN_ENCRYPTION_KEY`, `dev_mail_log`, `DEV_LOGIN`, `EMAIL_MODE`.
- Resume file upload, the multipart parser, file routes and the uploads directory.
- The notification email. Dockerfile, `.dockerignore`, `deploy/`, `scripts/backup.js`, `scripts/seed.js`.
- Config variables `DATA_DIR`, `TRUST_PROXY`, `QUIET`, `ADMIN_EMAILS`, `ALLOWED_DOMAIN`, `MAX_UPLOAD_MB`, `APP_TIMEZONE` and the rest of the v1 list.

### Replaced
- Database: an async interface (`all/get/run/batch/close`) with two drivers. `node:sqlite` (local and tests) and Turso over `fetch` to `/v2/pipeline` (stateless, every pipeline ends with `close`). No interactive transactions: every multi-statement write is one `db.batch`, and read-then-write rules live in the SQL (`WHERE` guards).
- Sign-in: email + scrypt password; invite and reset links (single use, hashed in the DB); first admin via `/setup?token=`. Sessions, CSRF values, rate limits and "last visit" are in the DB or signed with `SESSION_SECRET`. Nothing relies on process memory.
- Hosting: `api/index.js` + `vercel.json` (one rewrite to the function). `src/server.js` is only the local wrapper.
- Email: "Open in Gmail" / "Open in mail app" compose links, logged as "opened", not "sent".
- Alerts: New counts on the dashboard and an optional webhook (role title + link only).

### Added
- `/app/account` (change own password), admin Sample data page (`src/lib/sample.js`), security headers on every response (CSP with no inline code, XFO, nosniff, no-referrer, HSTS in production), https-only links.

### Decisions
- **Fresh baseline schema.** Migration 1 is the whole v2 schema (with `is_sample`, `resume_url`, `auth_tokens`, `rate_limits`). A v1 SQLite file is not migrated: v1 never ran in production. `users` and `job_roles` use `AUTOINCREMENT` so ids are never reused.
- **Hand-off page instead of a redirect** for email compose. A POST that answers with a cross-origin redirect (to mail.google.com or `mailto:`) can be blocked by the form-action CSP and by browsers; a small page with a normal link, followed by `public/app.js`, always works and still works without JS.
- **https-only links** for LinkedIn, resume and samples; stored non-https values are never rendered as links.
- **Config trimmed** to the seven settings. Base URL falls back to Vercel's variables; in production with none of them it is empty and invite pages say to prefix the site address.
- **Rate-limit keys are HMACs** (`SESSION_SECRET`) of bucket + IP or email, so the table holds neither.
- **Client IP.** On Vercel the `x-vercel-forwarded-for` header is used. Vercel's request-header docs say it holds the client's public IP, is identical to `x-forwarded-for`, is not overwritten by a proxy placed in front, and that external forwarded IPs are not forwarded. Locally the socket address is used. (B's first draft read `x-forwarded-for`; changed.)
- **Assets** are always requested as `/public/style.css` and `/public/app.js` and served by the function (with the headers). With the "Other" preset and a `public/` directory, Vercel's output directory is `public` and only its contents are static, so `src/` and `docs/` are not exposed; `/style.css` and `/app.js` may also be CDN-served, and `vercel.json` adds the headers for exactly those two paths.
- **Request body.** Vercel adds a lazy `req.body`. The reader uses the stream, and rebuilds the urlencoded form from `req.body` (Buffer, string or object) if the stream is already finished or empty. The 512 KB cap and the content-type check apply either way. The documented alternative (env var `NODEJS_HELPERS=0`) is not needed.

### Not tested on real infrastructure
Vercel deployment details (rewrite, `includeFiles`, `req.url` after the rewrite, CDN asset headers, client-IP header, cold start with scrypt), the real Turso API (`batch` conditions, error shapes, auth, URL rewrite, foreign keys, injected variable names), Gmail compose URLs with very long bodies, webhook acceptance by Google Chat/Slack, platform logs recording `?token=` query strings. See the README.

### Test coverage notes
`test/vercel.test.js`: AC-41, AC-56 (table-driven over pages, redirects, 403/404/405/413/415/500, config-error 500, static GET/HEAD, development and production), AC-60, AC-36 check, env/removed-file hygiene. The suite runs every integration file on both drivers.

## v1 history (1.0.0 and 1.1.0)

v1 was a single-VM Docker app: Google sign-in, Gmail API sending, SQLite on a mounted disk, uploads, a systemd unit and GCS backups. The 1.1.0 QA fixes that still apply in v2 are the product behaviours: ids never reused, notes and emails keep their role snapshot, the apply form's questionnaire fingerprint (409), the rate limit counting only stored applications and honeypot hits, reassign-rep select, Users admin name editing, Voltax stub (`src/voltax.js`, always `not_configured`; reps enter the Voltax ID by hand), CSV formula guard, `role_change` and `voltax_recorded` event value formats. Everything about Google, uploads, Docker, backups and `dev_mail_log` was removed in 2.0.0. The v1 spec is at commit `8c1d77a`.

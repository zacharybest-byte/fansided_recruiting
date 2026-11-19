# Build notes

## 2.3.0 (questionnaire templates)

- A **questionnaire** is a named, reusable list of questions (up to 5, each up to 500 characters, with a required flag). A role selects one or none. Editing a questionnaire changes the apply form of every role that uses it at once; submitted answers are snapshots (question text + answer) and never change. Admin screens: Manage > Questionnaires (list, new, edit, duplicate, delete) and a Questionnaire select on the role form. Delete is refused while any role uses it.
- **Storage.** `questionnaires(id, name, questions_json, is_sample, created_at, updated_at)`, one JSON array per questionnaire, same shape the per-role questions always had. `job_roles.questionnaire_id` points at it. Names are unique case-insensitively (unique index on `name COLLATE NOCASE`; SQLite folds ASCII only) and at most 80 characters.
- **Migration 4** (additive, one atomic batch with its tracking row): create table, unique index, `ALTER TABLE job_roles ADD COLUMN questionnaire_id`, index, backfill (INSERT...SELECT one questionnaire per role whose `questions_json` is a non-empty array, named "<title cut to 50> questions", plus " (<role id>)" when an earlier role has the same shortened title, then UPDATE pointing each role at it), and a tripwire INSERT that violates NOT NULL (rolling everything back) if any role was left unpointed, a role without questions got one, or the counts differ. "Non-empty array" is decided without JSON functions: trimmed text starts with `[` and, with spaces, tabs and line breaks removed, is not `[]`.
- **Legacy storage.** `job_roles.questions_json` is never read for display any more. It is still WRITTEN as a verbatim copy of the selected questionnaire's `questions_json` (`[]` for none) on every role create/save, every questionnaire save (one batch, `UPDATE job_roles ... WHERE questionnaire_id = ?`) and sample load, so rolling back to 2.2.x shows the right questions. `src/lib/questionnaires.js` `repair()` runs at start-up (one read when clean) for roles written by the older version: legacy questions with no questionnaire, or a legacy copy that differs from the questionnaire's, get a NEW questionnaire made from them and the role is pointed at it (the old version edited that role, so a shared questionnaire is not changed); a role whose legacy questions were emptied loses its questionnaire.
- **Public form.** The fingerprint (`qv`) is the hash of the questions the role currently shows, so editing, swapping, adding or removing a questionnaire while a form is open gives the "questions changed" 409. Residual race: a swap between the fingerprint check and the insert is not guarded in SQL (as before).
- **Sample data** has three shared questionnaires (Team site contributor x3 roles, League-wide writer x2, Entertainment writer x1). Removing the sample data deletes them unless a role still uses them, in which case they are kept and unmarked. A same-named questionnaire made by an admin is reused, never marked as sample.
- **Nav.** "Templates" is now "Email templates". Eight admin links no longer fit beside the user name at 1366 px, so on wide screens Manage is a no-JavaScript `<details>` dropdown (Escape or an outside click also close it, via app.js); the small-screen menu is unchanged.

## 2.2.0 (per-role workflows, copy a role)

Spec: `docs/SPEC.md` (AC-61 to AC-69). Tests: `test/workflow.test.js`, `test/migration.test.js`.

### What changed
- Every role owns an ordered list of stages (`role_stages`): New first, Onboarded and Passed last (fixed), 0 to 6 in-progress stages in between (default Reviewing, Trial). `applications.stage_id` is the source of truth; the legacy `stage` column is still written as the category (`new`, `reviewing` for any in-progress stage, `onboarded`, `passed`) so old queries and exports keep working. Events store stage names.
- Role form: a Workflow section (no JS: six always-present rows, position numbers, clear a name to remove) saved together with the role in ONE guarded batch. Roles list: Duplicate (`/app/admin/roles/new?copy=<id>`).
- Board, move menus, candidate stepper, dashboard counters, search, CSV (`stage` is the name, new `stage_kind`), sample data (two sample roles have their own workflow) all read the role's stages. Dashboard strip: "In progress" replaces "In Trial".
- Moving a candidate to another role maps the stage (kind, same name, first in-progress, New) and logs it.

### Migration 3 (live data: read this)
Additive only, one atomic batch with its tracking row: create `role_stages` + index, `ALTER TABLE applications ADD COLUMN stage_id`, index, backfill (five stages per role in one INSERT...SELECT, one UPDATE pointing each application at the stage of ITS role with the legacy value's name), a tripwire that aborts everything if any application or role is left unmapped, and two triggers that keep `stage_id` right for writers that only know the legacy column. No table rebuild, no DROP/RENAME, no PRAGMA. Concurrent cold starts: the loser fails on "already exists" and re-reads the version. A start-up repair (idempotent, one read when clean) covers rows an older deployment writes after the migration (roles without stages, applications without or with a foreign `stage_id`); pages also repair a role they find without stages.

### Decisions
- Stage ids in forms (`stage`, `from_stage`), not names: renames never break an open tab; a stale or foreign id is "someone else changed this candidate".
- Guards that must abort a whole batch use `abortIf()` (an INSERT that violates NOT NULL when its condition holds), because `db.batch` has no interactive transaction.
- The workflow editor is only applied when the form carries `stage_slots=1`; an old role form (a tab opened before the deploy) saves the role and leaves the workflow alone.
- No unique index on stage names or positions: renames and reorders pass through states a per-statement index would refuse; uniqueness is validated in the app and the stage set is guarded in the batch.
- Known quirk: events from before 2.2.0 hold lower-case words (`reviewing`). They display as "Reviewing". A custom stage named exactly in lower case like a legacy word ("trial") shows capitalised in the event log.

### Stage B: candidates filters and application history
Spec: AC-70, AC-71. Tests: `test/candidates-filters.test.js`.
- `/app/candidates` is now "my candidates, still being worked" by default. `active` means stage kinds new + progress (not onboarded). Everything is GET parameters (`owner`, `status`, `q`, `sort`, `page`); links leave defaults out. Kind comes from `role_stages.kind` with the legacy `applications.stage` as fallback for a row without a stage id. Counts on the status chips are ONE grouped query over the owner + search scope, and the page total is taken from it (no second COUNT).
- Owner is resolved server-side: a rep can only ever get `me` or `all`; admins also get a user id (any existing user) or `none`. Unknown values quietly mean `me`.
- Behaviour change to know about: existing bookmarks of `/app/candidates?q=...` now only search the signed-in user's active candidates. Add `owner=all&status=all` to get the old behaviour.
- Stacked cards on phones use a generic `.table-stack` class with `data-label` on each cell (CSS `attr()`, no JS); the Users admin table uses it too.
- History panel: one query for the other applications (with rep and last stage-change actor as subselects) plus one for their notes. Notes are rendered twice (a `<details>` for the screen and a plain block that is only shown in print), because browsers do not reliably print the content of a closed `<details>`.
- Sample data: Tyler Reyes (earlier Premier League application, passed, two notes) and Daniel Okafor (earlier Lakers application, onboarded, two notes). The sample now holds 20 applications and 8 notes.
- Candidate header: the email is rendered with a `<wbr>` before the @ (test allow-list gained `wbr`).

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

### Fixes from independent QA (second round)
- **Login limits (F-01).** Strict bucket per (email, IP) 5 / 15 min, loose per-email ceiling 50 / hour, per-IP 20 / 15 min. `reserve()` is all-or-nothing: every INSERT is conditioned on every spec being under its limit (own rows excluded), so a refused attempt is recorded nowhere and the victim's retries burn nothing. `rate_limits.grp` (HMAC of the email) lets an admin reset-link creation or a successful set-password/setup delete that email's rows. The account page's current-password check uses the pair and email buckets.
- **IP buckets (F-02).** IPv6 by /64 (`ipBucket`), IPv4-mapped as IPv4; right-most entry of the trusted header. Test helper now sends `x-vercel-forwarded-for` (production header name).
- **Apply limit (F-03).** The limit row is the first statement of the apply batch; person, application and event inserts are conditioned on that row existing. Replaces check-then-record.
- **Emails / names (F-04, F-05).** Strict allow-list email check (also refuses `@sample.invalid`); mailto hrefs percent-encode the address. People keep their first name and LinkedIn (LinkedIn fills when empty); `applications.applicant_name` / `applicant_linkedin` (baseline migration, no production data) keep what was typed and the candidate page shows it when it differs.
- **Sample data (F-06).** Sample people live on `@sample.invalid`, which apply refuses (simpler than reserving the `sample.*@example.com` namespace). First insert guarded in SQL; a failed load is a flash message.
- **Smaller (F-07..F-16).** printable-ASCII `next`; token-guessing GETs throttled (30 / 15 min, valid tokens refunded) and POST budget taken after CSRF; SETUP_TOKEN 32+ chars / 10 distinct, SESSION_SECRET trimmed and 16 distinct; GET `/app` no longer writes (POST `/app/seen`); webhook timeout 1.5 s; `turso://` URLs, Turso client timeout 8 s; `Allow` on 405 and canonical ids only (`01` is 404); `/thanks#top` redirect (the form action's `#apply` was inherited); flash cookie signed with HMAC(SESSION_SECRET). Left as is: Node's 431 (F-14), no per-rep scoping (F-15, documented in the README).

## v1 history (1.0.0 and 1.1.0)

v1 was a single-VM Docker app: Google sign-in, Gmail API sending, SQLite on a mounted disk, uploads, a systemd unit and GCS backups. The 1.1.0 QA fixes that still apply in v2 are the product behaviours: ids never reused, notes and emails keep their role snapshot, the apply form's questionnaire fingerprint (409), the rate limit counting only stored applications and honeypot hits, reassign-rep select, Users admin name editing, Voltax stub (`src/voltax.js`, always `not_configured`; reps enter the Voltax ID by hand), CSV formula guard, `role_change` and `voltax_recorded` event value formats. Everything about Google, uploads, Docker, backups and `dev_mail_log` was removed in 2.0.0. The v1 spec is at commit `8c1d77a`.

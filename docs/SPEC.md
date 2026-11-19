# FanSided Recruit: Version 2 Spec

Status: ready to build · Owner: Zach · Contract: [`SCOPE-V2.md`](SCOPE-V2.md) · Replaces the v1 spec (git tag/commit `8c1d77a`)

## 1. Goal

One cheap, simple, in-house place for FanSided onboarding reps to post contributor roles, collect
applications, move candidates through a fixed pipeline, email them from their own Gmail, and export to
CSV. v2 keeps the v1.1 product and changes how it is hosted, stored and signed in to, so that it ships
by importing a GitHub repo into Vercel and adding one Turso database from the Vercel dashboard.
**If a feature is not in this document, it is not in v2.** Priorities, in order: secure, easy to ship, light.

## 2. Technical constraints

- Node 22. **Zero npm dependencies** (`package.json` has no `dependencies`/`devDependencies`). Only
  `node:*` built-ins and global `fetch`.
- One request handler `(req, res)` used two ways: exported from `api/index.js` for Vercel, and wrapped in
  `http.createServer` for `npm run dev` / `npm start`. No build step.
- **Serverless-safe:** nothing may depend on in-memory state between requests. Sessions, CSRF, rate limits
  and "last visit" live in the database or in signed values. A module-level cache is allowed only as an
  optimisation (for example "migrations already checked in this instance").
- **Database behind one async interface** (`src/lib/db/`):
  `db.all(sql, args)`, `db.get(sql, args)`, `db.run(sql, args) -> { changes, lastInsertRowid }`,
  `db.batch([{ sql, args }, ...]) -> results[]` (atomic: all statements commit or none do), `db.close()`.
  Positional `?` parameters only. Two drivers:
  - `sqlite`: `node:sqlite` file under `./data` (local dev and tests only; `node:sqlite` is required lazily
    so it is never loaded on Vercel).
  - `turso`: `fetch` to `POST {TURSO_DATABASE_URL}/v2/pipeline` with `Authorization: Bearer {TURSO_AUTH_TOKEN}`
    (`libsql://` is rewritten to `https://`). Stateless: every pipeline ends with `close`; no batons are kept.
  - No interactive transactions. Every multi-statement write is a single `db.batch`. Read-then-write rules
    (last-admin guard, single-use tokens, setup-once, stage compare) are enforced inside the SQL of the
    batch (`WHERE` guards / `INSERT ... SELECT ... WHERE`), never only by a prior read.
- **Migrations:** numbered list, tracked in table `schema_migrations(version, applied_at)`. Cold start does
  one cheap read (`SELECT MAX(version)`); each pending migration plus its tracking row is one atomic batch,
  so two concurrent cold starts cannot double-apply. v2 is a **fresh baseline schema**: a v1 SQLite file is
  not migrated (v1 never ran in production).
- Server-rendered HTML, full-page POST/redirect/GET. One CSS file, one small external JS file. Every screen
  works without JS except conveniences. No inline script or style anywhere.
- Low traffic (a handful of reps, a few hundred applications a month). No queues, caches or workers.

## 3. Users and permissions

| Who | How they get in | Can do |
|---|---|---|
| Public applicant | No login | View open roles, apply |
| Rep | Email + password; active row in `users` | View all roles and candidates; change stages; notes; compose/log emails; move candidate to another role; record Voltax info; reassign a role's rep; export CSV; change own password |
| Admin | Same, `role = admin` | Everything a rep can do, plus roles, users (invite, reset link, role, name, deactivate), templates, delete candidate, sample data |

Reps see every role (PTO cover). The dashboard defaults to "my roles".

## 4. Screens

### Public
1. **Openings** `/`: open roles grouped by vertical; `?source=x` is carried onto role links.
2. **Role + apply form** `/roles/:id` (POST `/roles/:id/apply`, `application/x-www-form-urlencoded`):
   full name*, email*, LinkedIn/portfolio URL, **resume link** (optional), writing-sample links*
   (one per line, at least one), the role's 0-5 questions, "How did you hear about us?", hidden `source`,
   hidden questionnaire fingerprint `qv`, honeypot. **All links must be `https://`** (a bare
   `example.com/x` gets `https://` added; `http://` and every other scheme is rejected with a field error).
   No file upload. Closed/unknown role: "no longer open" page (404). Validation errors re-show the form
   with values kept.
3. **Thanks** `/thanks`.

### Sign-in
4. **Login** `/login`: email + password. Any failure shows the same message ("Email or password is
   incorrect."); rate-limited attempts show "Too many attempts. Try again later." whether or not the
   account exists. Text: "Forgot your password? Ask an admin for a reset link." `next` is honoured only for
   `/app...` paths made of printable ASCII.
5. **First-admin setup** `/setup?token=SETUP_TOKEN`: set a password for `ADMIN_EMAIL`. Works only while no
   active admin has a password; afterwards (and for a wrong/missing token, or missing env) it is a 404.
6. **Set password** `/set-password?token=...`: reached from an invite or reset link. Shows the account
   email, asks for a new password twice. Invalid, used or expired token: one generic "This link is no
   longer valid. Ask an admin for a new one." page. Success redirects to `/login`.
7. **Account** `/app/account`: change own password (current + new twice).

### Internal (login required)
8. **Dashboard** `/app`: summary strip (Open roles, **New applications** = kind new, **In progress** = every
   in-progress stage, Onboarded this month); roles assigned to me, each with a counter of THAT role's own stages
   (New, its in-progress stages, Onboarded, Passed; wraps cleanly up to nine); the **New** count is highlighted per
   role, with "+N since your last visit" where N > 0. Toggle "All roles". Link to Export.
9. **Role pipeline** `/app/roles/:id`: header with Reassign rep; one column per stage of the role, in order
   (3 to 9; the board scrolls inside its own box when columns would be narrower than 12.5rem, and stacks into
   sections under 900 px); inline "Move to…" lists the role's other stages. Colours by kind: New = Yeti Blue,
   in-progress = FanSided Blue (one hue; the name tells them apart), Onboarded = green, Passed = gray.
10. **Candidate** `/app/applications/:id`: header; Change stage (+ Voltax ID/date on Onboarded); Record Voltax;
    Move to another role; application details (resume link, sample links, answers, source); Notes;
    **Compose email**; Activity (events + logged emails); admin-only Delete candidate.
    - **Application history** (2.2.0, stage B): when the person has any other application, a full-width panel sits
      directly under the stepper (before the two columns). One summary line ("Applied 3 times before: 1 onboarded,
      1 passed, 1 still in progress."), then every other application newest first: role title and site, outcome badge
      (Onboarded / Passed / still in <stage>) with the date that outcome was reached, applied date, assigned rep,
      who last moved it, number of notes, the notes inline in a collapsed `<details>` ("Show 2 notes from this
      application": author, friendly time, text) and "Open this application". The panel prints expanded. With no
      other application the left column has one quiet line, "First application from this person." Notes are
      already visible to every signed-in user; no new permission. Deleting a person deletes their applications, so
      a deleted candidate has no history. A long email wraps at the @ in the header.
    - **Candidates** `/app/candidates` (2.2.0, stage B): all state is in GET parameters (works without JS,
      bookmarkable, defaults left out of links). `owner=`: `me` (default: roles whose assigned rep is the signed-in
      user), `all`; admins also `owner=<user id>` and `owner=none` (roles without a rep). A rep passing another id,
      `none` or junk gets their own list. Admins get a "Rep" select (active users + "Unassigned roles") with a Show
      button. `status=`: `active` (default: kinds new + progress), `new`, `progress`, `onboarded`, `passed`, `all`;
      unknown values fall back to active, so passed candidates are hidden until the "Passed" or "All statuses" chip
      is used. Chips carry counts for the current owner + search scope (one grouped COUNT). `q` (name or email) and
      `sort=stage_age` (longest in stage first; default most recently applied first) combine with both; pagination,
      chips, the search form and the rep form preserve every parameter. A summary line says what is shown ("12 active
      candidates on your roles"), "Clear filters" appears when anything is non-default, and empty states say what to
      change. Columns: candidate (name, email), role and site, stage name with kind dot, rep, applied, days in
      stage. Under 700 px the table becomes stacked cards (the Users admin table too).
    - Compose email: pick template, **Load** (GET `?template=ID`) fills subject/body with merge fields
      resolved (unknown `{{x}}` stays literal and shows a warning); rep edits; two submit buttons
      **Open in Gmail** and **Open in mail app** on a form with `target="_blank"`. The POST logs the email
      and returns a small hand-off page containing the compose link
      (`https://mail.google.com/mail/?view=cm&fs=1&to=..&su=..&body=..` or `mailto:`), which the external
      JS follows automatically and a no-JS user clicks. The recipient is always the person's stored email,
      never a form field. The logged email appears in Activity as "opened in Gmail" / "opened in mail app".
11. **Templates admin** `/app/admin/templates`, **Roles admin** `/app/admin/roles`: as v1, plus per role:
    - **Workflow** section on the role form. New, Onboarded and Passed are shown read-only. Six rows (the role's
      own in-progress stages first, then blank spare rows) each have a name (1 to 30 characters, unique in the
      role ignoring case, not one of the three fixed names) and a **Position** number. A filled blank row adds a
      stage; clearing the name of a stage removes it, which is refused with "Move the N candidates out of X
      before removing it." while it has candidates; renaming keeps candidates where they are. The whole form
      (role fields + workflow) is ONE batch with SQL guards that abort it all if the stage list changed or a
      removed stage gained a candidate meanwhile (409, nothing saved). A form without the editor (an old tab)
      leaves the workflow alone. Errors use the error-summary pattern.
    - **Duplicate** link per role: `GET /app/admin/roles/new?copy=<id>` shows the new-role form pre-filled
      ("Copy of <title>", vertical, site, description, questions with their required flags and order, the
      workflow, the assigned rep when still active; status Closed). Nothing is created until Save; candidates
      are never copied; an unknown or malformed id gives the plain empty form. Admin only.
12. **Users admin** `/app/admin/users`: add user (email, name, role) creates the user without a password and
    shows a **single-use invite link** to copy; per user: edit name, change role, deactivate/reactivate,
    **Create reset link** (shown once to copy). Status column: Active / Invite pending / Deactivated.
13. **Sample data** `/app/admin/sample`: **Load sample data** / **Remove sample data**.
14. **Export** `/app/export`: as v1.

## 5. Data model

Integer `id INTEGER PRIMARY KEY AUTOINCREMENT` (ids are never reused); timestamps ISO-8601 UTC text.

- **schema_migrations**: `version` (PK), `applied_at`
- **users**: `email` (unique, lowercase), `name`, `role` (admin|rep), `active`, `password_hash` (NULL until
  set; `scrypt$N$r$p$saltB64$hashB64`), `password_changed_at`, `dashboard_seen_at`, `created_at`
- **sessions**: `token_hash` (PK; SHA-256 of the cookie token), `user_id`, `created_at`, `expires_at`
- **auth_tokens**: `user_id`, `kind` (invite|reset), `token_hash` (unique; SHA-256), `expires_at`,
  `used_at`, `created_by_user_id`, `created_at`
- **rate_limits**: `key` (text; HMAC of bucket + IP or email, never the raw value), `at`; index on `(key, at)`
- **job_roles**: v1 columns + `is_sample`
- **people**: v1 columns + `is_sample`
- **applications**: v1 columns minus `file_path`/`file_name`, plus `resume_url`, plus (migration 3)
  `stage_id` (nullable INTEGER, no declared FK): the **source of truth** for where the candidate is. The legacy
  `stage` column (CHECK-limited to the five old values) is still written as the stage's CATEGORY
  (new -> `new`, any in-progress stage -> `reviewing`, onboarded, passed; a legacy `trial` row is read as
  in-progress) so old queries keep working.
- **role_stages** (migration 3): `id`, `role_id`, `position`, `name`, `kind` (new|progress|onboarded|passed),
  `created_at`; index `(role_id, position)`. Every role has `New` (position 0, kind new), 0 to 6 in-progress stages,
  then `Onboarded` and `Passed`. Default for new roles and for every existing role: Reviewing, Trial.
  `application_events` keep text values: they store stage NAMES (rows written before 2.2.0 hold the lower-case
  legacy words, which are displayed as their capitalised label).
- **Migration 3 is additive and atomic**: CREATE TABLE role_stages, its index, `ALTER TABLE applications ADD COLUMN
  stage_id`, an index, one INSERT...SELECT backfilling five stages per role, one UPDATE pointing every application at
  the stage of its own role that matches its legacy value, a tripwire INSERT that aborts the whole batch if any
  application or role would be left unmapped, and two triggers (`applications_stage_id_on_insert`,
  `applications_stage_id_on_stage`) that keep `stage_id` consistent for a writer that only knows the legacy column
  (an older deployment still running during a rollout). Nothing is rebuilt, dropped or renamed. A start-up repair
  (`stages.repair`, idempotent, one read when there is nothing to do) re-points applications and gives stages to roles
  written by an older deployment after the migration.
- **application_events**: as v1 (append-only trigger refusing UPDATE)
- **notes**: as v1.1 (with `role_id`)
- **email_templates**: as v1 (4 seeded templates)
- **emails_sent**: `person_id`, `application_id`, `role_id`, `template_id` (nullable), `sender_user_id`,
  `to_email`, `subject`, `body`, `via` (gmail|mailto), `sent_at`. A row means "the rep opened a compose
  window with this text", not "delivered".
- **deletion_log**: `deleted_person_id`, `actor_user_id`, `at` (no personal data)

Removed: `users.google_refresh_token_enc`, `sessions.csrf_token`, `dev_mail_log`, upload columns.

## 6. Behaviour details

Unchanged from v1.1 unless stated: applying (dedupe by email, new application each time, initial
`stage_change` event), stage change, move to another role, reassign, Voltax stub (`src/voltax.js`),
questionnaire fingerprint (409 + "questions changed"), role snapshot on notes/emails, CSV export (columns,
formula guard, RFC 4180), templates and merge fields, delete candidate. Timezone is fixed to
`America/New_York`.

- **Atomic writes.** Apply (person upsert + application + event + rate-limit row), stage change
  (+ events), role move, deactivate (+ kill sessions), password set/change (+ kill sessions + consume
  token), delete candidate (+ `deletion_log`), sample load/remove are each one `db.batch`.
- **Passwords.** `crypto.scrypt` (async), N=32768, r=8, p=1, 16-byte random salt per user, 32-byte key,
  parameters stored in the hash string; `timingSafeEqual` compare. Length 12-200 characters. Login for an
  unknown or password-less account still runs one scrypt against a dummy hash.
- **Invite / reset links.** 32 random bytes, base64url; only the SHA-256 is stored. Invite expires in
  7 days, reset in 24 hours. Creating a link invalidates the user's earlier unused links. Using a link sets
  the password, marks the token used and deletes all the user's sessions in one guarded batch (a second
  use, a race, an expired token or a deactivated user changes nothing). The link is rendered once in the
  POST response (`Cache-Control: no-store`), never stored in plain text or logged.
- **Setup link.** `SETUP_TOKEN` (>= 32 chars, >= 10 distinct) compared timing-safe. Invalid-token GETs of `/setup` and `/set-password` are limited to 30 per IP per 15 min (valid tokens do not count); the POST budget is taken only after the CSRF check. The password write is guarded in SQL by
  "no active admin has a password", so it works once. `ADMIN_EMAIL` becomes an active admin.
- **Sessions.** 32-byte random token in cookie `sid` (`HttpOnly; Secure; SameSite=Lax; Path=/`, 14 days);
  DB stores its SHA-256. A new token is issued at every login (no pre-login session exists). Logout
  deletes the row. Deactivation, password change and password reset delete all the user's sessions
  (password change then issues a fresh one for the current browser). Expired rows are pruned at login.
- **CSRF.** Internal POSTs: hidden field = `HMAC-SHA256(SESSION_SECRET, "csrf:" + session token)`.
  Pre-session POSTs (apply, login, setup, set-password): double-submit cookie whose value is a random nonce
  plus its HMAC under `SESSION_SECRET`; the field must equal the cookie and the HMAC must verify.
  Missing/invalid token: 403, nothing changes. No GET changes state: the dashboard "seen" stamp is moved by the POST `/app/seen` ("Mark as seen", CSRF-protected).
- **Rate limits (DB).** Rows in `rate_limits` (`key` = HMAC, optional `grp`), counted inside the window, old rows
  pruned opportunistically. Every limit is reserved atomically in the same batch as the work it guards, and a
  reservation is all-or-nothing: a request refused by one limit is recorded against none.
  Apply: 10 stored applications/honeypot hits per IP per hour (the application inserts depend on the reserved
  row). Login: 5 failures per (email, IP) and 20 per IP per 15 min, 50 per email per hour, checked before the
  password is verified; `grp` ties an email's rows together so an admin reset can clear them. Setup and
  set-password POSTs (after CSRF): 10 per IP per 15 min; invalid-token GETs of those pages: 30 per IP per 15 min.
  Client IP: `x-vercel-forwarded-for` on Vercel (right-most entry), socket address locally; IPv6 by /64.
- **Dashboard counts.** New per role from live data. "Since your last visit" = applications with
  `applied_at > users.dashboard_seen_at`; only the explicit "Mark as seen" POST stamps `dashboard_seen_at = now`
  (viewing the dashboard never writes). Until a user has marked something as seen nothing is shown.
- **Webhook.** If `NOTIFY_WEBHOOK_URL` (https only) is set, after an application is stored:
  `POST {"text": "New application for <role title>: <BASE_URL>/app/applications/<id>"}` with a 1.5-second
  timeout, awaited, errors swallowed. The text never contains the applicant's name, email or answers.
  Failure is logged with the application id only and never affects the applicant's response.
- **Sample data.** Load inserts 3 sample roles and ~8 clearly fake people (`Sample ... (demo)`,
  `@sample.invalid`, a reserved non-deliverable domain the public apply form refuses), with applications across all stages, notes and events, flagged `is_sample`. Refused if
  sample data is already loaded; the first insert is guarded in SQL and a load that fails (for example two at once) becomes a flash message, not a 500. Remove deletes sample people and everything attached to them, and sample
  roles; a sample role that has real applications is closed and kept. Neither touches real data.
- **Base URL.** `BASE_URL`, else `https://` + `VERCEL_PROJECT_PRODUCTION_URL`, else `https://` + `VERCEL_URL`,
  else the request host (non-production only). Used for invite/reset links and the webhook link.

## 7. Security and privacy

- Admin-only routes (`/app/admin/*`, delete candidate) enforced server-side on every request; cannot
  deactivate or demote yourself or the last active admin with a password (guard inside the SQL).
- Only parameterised SQL. Request bodies capped at 512 KB (413). Length limits on every field (name 200,
  email 254, URLs 2,000, answers 5,000, note 10,000, email subject 200, email body 4,000, template body 10,000).
- Escape-by-default templating. User URLs are rendered as links only when `https:`; all external links
  carry `rel="noopener noreferrer"`.
- Headers on **every** response (pages, errors, static files, redirects):
  `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and in
  production `Strict-Transport-Security: max-age=63072000; includeSubDomains`. Internal and token pages:
  `Cache-Control: no-store`.
- Logs carry ids only: never applicant or user names/emails, passwords, tokens or secrets.
- Production (`NODE_ENV=production` or running on Vercel) refuses to serve without `SESSION_SECRET`
  (>= 32 chars, >= 16 distinct), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`: `npm start` exits non-zero; the Vercel function
  answers 500 with a generic page and logs the missing variable **names**. There is no dev-login bypass in
  any mode. Outside production a missing `SESSION_SECRET` falls back to a fixed dev value with a warning,
  and the server prints the `/setup` link when no admin has a password.
- Delete candidate hard-deletes person, applications, events, notes and email records in one batch and
  writes one PII-free `deletion_log` row.

## 8. Configuration (complete list)

| Var | Required | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | production | Injected by the Vercel Turso integration. Absent locally = `node:sqlite` in `./data`. `http://` is accepted only for `localhost`/`127.0.0.1` (the test fake). |
| `SESSION_SECRET` | production | trimmed; >= 32 chars with >= 16 distinct; CSRF, flash and key hashing |
| `ADMIN_EMAIL`, `SETUP_TOKEN` | first run | First-admin setup link |
| `BASE_URL` | no | Public URL for links (see §6) |
| `NOTIFY_WEBHOOK_URL` | no | Google Chat / Slack incoming webhook |

`PORT` (default 3000) is honoured for local runs only. Nothing else is read.

## 9. Repo layout and deliverables

`api/index.js` (exports the handler; the app is created once at module scope), `vercel.json` (rewrites `/(.*)` to
`/api/index`, `functions["api/index.js"].includeFiles = "public/**"`, and a `headers` block for the CDN-servable
`/style.css` and `/app.js`), `public/` (`style.css` and `app.js` only; assets are requested as `/public/...` and
served by the function), `src/` (app: `app.js`, `server.js` for local runs, `lib/`, `routes/`, `voltax.js`), `test/`
(incl. the fake `/v2/pipeline` server), `scripts/fake-turso.js` (runs the fake for local production-like testing),
one-page `README.md`, `docs/`, `.env.example` (the seven settings). Removed: `Dockerfile`, `.dockerignore`, `deploy/`,
`scripts/backup.js`, `scripts/seed.js`, Google/Gmail/multipart/token-encryption code.
`package.json`: version `2.0.0`, `"engines": { "node": "22.x" }`, no dependencies, scripts `start`, `dev`, `test`.
Client IP: `x-vercel-forwarded-for` on Vercel, the socket address locally.

## 10. Acceptance checks

Kept from v1 (numbers unchanged; wording updated where v2 changes the mechanism):

- **AC-01** `/` lists every open role grouped by vertical, no closed roles, without login.
- **AC-02** A closed role shows "no longer open"; a POST to apply for it creates nothing.
- **AC-03** `?source=` survives from `/` to the stored `source_tag`.
- **AC-04** The role page shows exactly that role's questions; a missing required answer shows an error and keeps the other values.
- **AC-05** No name, invalid email or no writing-sample link is rejected with field errors. An email is one plain address: one `@`, a local part of letters, digits and `. _ + -`, a dotted domain; anything containing `? & = % / #`, whitespace, quotes, angle brackets, commas or semicolons is refused, as is the sample domain `@sample.invalid`. Every `mailto:` link percent-encodes the address.
- **AC-06** A valid submission creates one application in New with one system `stage_change` event and redirects to `/thanks`.
- **AC-07** Same email in different case twice: one person, two applications. The person keeps the first name and LinkedIn (a LinkedIn is filled in only while empty); each application stores the name and LinkedIn as submitted and the candidate page shows them when they differ.
- **AC-08** Answers are stored with the question text; later question edits do not change them.
- **AC-11** A filled honeypot shows thanks and stores nothing. The 11th stored submission from one IP within an hour is rejected, **and still is after the process restarts** (limit is in the DB), **and under parallel requests**: the limit is reserved inside the apply batch, so 30 simultaneous submissions from one IP store exactly 10. IPv6 addresses are bucketed by /64.
- **AC-15** A rep gets 403 on every `/app/admin/*` route (GET and POST, including unknown paths) and on candidate delete.
- **AC-16** An internal POST without a valid CSRF token returns 403 and changes nothing.
- **AC-17** The session cookie is HttpOnly, Secure, SameSite=Lax. After logout or deactivation the old cookie no longer works.
- **AC-18** Dashboard shows a rep's assigned roles with correct per-stage counts; "All roles" shows every role.
- **AC-19** Pipeline shows the role's stages in order (New, Reviewing, Trial, Onboarded, Passed by default).
- **AC-20** New -> Reviewing updates the stage and adds one event with from, to, actor, timestamp.
- **AC-21** After three stage changes there are exactly four events in order, none modified; UPDATE on the event table is refused.
- **AC-22** Onboarded with Voltax ID and date saves both, sets `onboarded_at`, calls `voltax.createUser` (`not_configured`).
- **AC-23** Move to another role changes where it appears, adds `role_change`, keeps notes, emails, events.
- **AC-24** A note shows author and time and appears on the person's other applications.
- **AC-25** Prior applications, notes and emails show on the candidate page.
- **AC-26** Loading a template fills the three merge fields; an unknown field shows a warning.
- **AC-28** Admin can create, edit, delete templates.
- **AC-29** Admin can create a role with up to 5 questions, edit and close it; closed roles vanish from `/` but stay internally.
- **AC-30** Admin can add a user, change rep to admin, deactivate. Cannot deactivate or demote themselves or the last admin.
- **AC-31** Reassigning a role updates both reps' dashboards.
- **AC-32** CSV export: §6 columns, one row per application, date filter, `=`-prefixed cells guarded.
- **AC-33** Delete candidate removes person, applications, events, notes, email records and adds one `deletion_log` row holding no personal data.
- **AC-34** `<script>` entered in any field is shown escaped on every page.

Retired: AC-09, AC-10 (uploads), AC-12 (notification email), AC-13, AC-14 (Google sign-in), AC-27 (Gmail send), AC-35 (container restart).

New in v2:

Database and hosting
- **AC-36** The whole integration suite passes on the `sqlite` driver and on the `turso` driver against the local fake `/v2/pipeline`; plain `node --test` runs both.
- **AC-37** The Turso driver sends `POST /v2/pipeline` with the Bearer token and typed arguments, ends every pipeline with `close`, maps integer/float/text/null results to JS values, and turns an error result or non-2xx status into a thrown error that does not include the token.
- **AC-38** `db.batch` is atomic on both drivers: when a later statement fails, earlier statements in the batch are not persisted.
- **AC-39** Migrations: a fresh database is fully migrated on first request; a second start performs no schema writes; two concurrent first starts leave exactly one copy of the schema and seed templates.
- **AC-40** No in-memory state: with the app instance recreated between every request (same database), login, an authenticated page, an internal POST (CSRF), apply rate limiting and login rate limiting all still behave correctly.
- **AC-41** `require('./api/index.js')` exports a function `(req, res)` that serves `/` and the static assets; `vercel.json` routes all paths to it; `package.json` has no dependencies and `engines.node` is `22.x`.
- **AC-42** In production mode, missing/short `SESSION_SECRET` or missing Turso variables: `npm start` exits non-zero and the handler answers 500 without leaking values. No dev-login route exists (`POST /auth/dev` is 404).

Password sign-in
- **AC-43** Correct email + password signs in and issues a new session token; the DB holds only the token's hash. Wrong password, unknown email, deactivated user and password-less user all get the same status and message and no session.
- **AC-44** Passwords are stored as salted scrypt (two users with the same password have different hashes; the plain password appears nowhere in the DB); passwords under 12 or over 200 characters are refused everywhere a password is set.
- **AC-45** Login failures are limited per (email, IP) to 5 per 15 minutes (strict), per email to 50 per hour (a loose ceiling, so strangers cannot lock a user out) and per IP to 20 per 15 minutes; the correct password is refused while a limit applies. The limits are stored in the DB (HMAC keys) and expire; an attempt refused by a limit is recorded against no bucket; a success leaves no rows. Failures from IP A never block the same user's correct login from IP B. Creating an admin reset link, or using one (or the setup link), clears that email's recorded failures.
- **AC-46** `next` only redirects to `/app...` paths; `//evil.example`, `/\evil`, `https://evil.example` and `/app//evil` fall back to `/app`.
- **AC-47** Changing your password requires the current password, kills every other session of that user, and keeps the current browser signed in with a new token; the old password stops working.

Invites, resets, setup
- **AC-48** Adding a user shows an invite link once; the DB stores only the token hash; the user cannot sign in until the link is used; using it sets the password and the user can sign in.
- **AC-49** An invite/reset link works exactly once; a used, expired, superseded or unknown token, or one for a deactivated user, shows the generic invalid-link page and changes nothing.
- **AC-50** An admin-created reset link sets a new password and kills all that user's sessions. A rep cannot create invite or reset links (403).
- **AC-51** `/setup?token=` with the right `SETUP_TOKEN` sets the first admin's password; a wrong token is 404; once an active admin has a password the correct token is 404 too (GET and POST), including under two concurrent POSTs (only one wins).

Email, alerts, links
- **AC-52** "Open in Gmail" returns a hand-off page whose link is `https://mail.google.com/mail/?view=cm&fs=1&to=<person email>&su=<subject>&body=<body>` correctly percent-encoded (newlines, `&`, `#`, non-ASCII), and logs one `emails_sent` row (subject, body, template, rep, role, via gmail). "Open in mail app" does the same with a `mailto:` link (via mailto). The recipient cannot be overridden from the form.
- **AC-53** The apply form accepts `https://` links only for LinkedIn, resume and samples: `http://`, `javascript:`, `data:` are rejected with field errors; stored non-https values are never rendered as links. `multipart/form-data` posts are refused (415) and no file route exists.
- **AC-54** With `NOTIFY_WEBHOOK_URL` set, a stored application sends one `POST {"text": ...}` containing the role title and candidate link and **not** the applicant's name or email. A webhook that errors, returns 500 or hangs past the timeout still results in a stored application and a redirect to `/thanks`. Without the variable nothing is sent.
- **AC-55** The dashboard highlights the New count per role and shows "+N since your last visit" for applications that arrived after the stamp `dashboard_seen_at`. Viewing the dashboard (GET) never writes; the CSRF-protected "Mark as seen" POST moves the stamp and clears the "+N".

Security and data
- **AC-56** Every response (HTML, redirect, 403/404/413/500, static file) carries the §7 headers; HSTS only in production; no page contains inline `<script>` content, inline event handlers or `style=` attributes.
- **AC-57** A body over 512 KB gets 413; over-length fields get field errors or 400 and are not stored.
- **AC-58** SQL metacharacters (`' OR 1=1 --`, `"; DROP TABLE users; --`) in login, apply, notes, search/filter parameters and ids are stored/handled as plain text and change nothing else; non-numeric ids give 404.
- **AC-59** Log output for apply, login failure, invite creation, webhook failure and delete candidate contains ids only (no applicant/user email or name, no token, no password).
- **AC-60** Load sample data creates the flagged roles, people (all `@sample.invalid`) and applications in every stage (two people also have an earlier application with notes); loading twice is refused; Remove sample data deletes them and leaves real roles, people and applications untouched; a rep gets 403 on both; two simultaneous loads give no 500 and exactly one set of data; a real applicant using `sample.one@example.com` is a normal applicant.

Workflows and copying roles (2.2.0). Tested on both drivers in `test/workflow.test.js` and `test/migration.test.js`.
- **AC-61** Migration 3 on a database at the previous schema with applications in all five legacy stages across several roles: every application points at the stage of its own role with the legacy value's name; all other tables and columns are unchanged and nothing is lost; running start-up twice is a no-op; a failure anywhere (including the tripwire) leaves the database exactly as it was; three concurrent migrators end with one workflow per role; the first request of the real app on an old database migrates it and the pages work.
- **AC-62** Role form: new roles default to Reviewing and Trial; stages are stored in position order, trimmed; 0 to 6 custom stages; validation (duplicate names ignoring case, the three fixed names, over 30 characters, bad position) uses the error summary, keeps what was typed and creates nothing.
- **AC-63** Editing: rename keeps candidates in place; add, reorder, remove in one save; removing a stage with candidates is refused naming the stage and count and saves nothing; a candidate arriving in a stage being removed, or another admin changing the stage list, between page load and save aborts the whole batch (409, nothing saved); a form without the editor leaves the workflow alone; a stage id of another role is refused.
- **AC-64** Board columns, "Move to…", candidate stepper, dashboard counters, search and CSV (`stage` = name, `stage_kind`) follow the role's workflow; the dashboard strip shows New applications / In progress / Onboarded this month; Voltax fields follow kind `onboarded`.
- **AC-65** Stage moves carry stage ids (`from_stage` and `stage`); a stale id, an id of another role, a name or a stage removed meanwhile writes nothing and flashes the conflict message; events store names; the legacy `stage` column holds the category.
- **AC-66** Moving a candidate to another role maps the stage (kind, then same name ignoring case, then the target's first in-progress stage, then New) and records `role_change` plus a `stage_change` when the name changes; a target workflow that changes meanwhile writes nothing.
- **AC-67** Stage names are escaped on the board, stepper, badges, dashboard, search, forms, flashes and event log; a formula-like stage name is neutralised in the CSV; reps get 403 on every workflow/role admin route; the new forms require the CSRF token.
- **AC-68** Duplicate: the roles list links `?copy=<id>`; the form is pre-filled (title "Copy of ", status Closed, questions with required flags, workflow, active rep); GET creates nothing; saving creates an independent role without candidates; malformed ids give the plain form; admin only.
- **AC-69** Sample data: two of the six sample roles have their own workflows; removing the sample data also removes their stages (roles kept because of real applicants keep theirs).
- **AC-70** Candidates tab (`test/candidates-filters.test.js`, both drivers): default owner is me and status active for reps and admins; `owner=all`; admin `owner=<id>` and `none`; a rep passing another id/none/junk gets their own list; every status value, default hides passed, unknown values fall back; chip counts follow owner and search; q, sort and page combine and every link keeps the other parameters; columns, stacked-card markup, Clear filters, empty states; XSS in q/owner/status/sort and in user names; signed-out redirect.
- **AC-71** Application history: panel under the stepper with summary line, newest first, outcome badge and date, rep and last actor, note counts, collapsed notes (also rendered for print), "Open this application" links; escaped role titles and note text; no panel and the quiet line for a first-time applicant; no other person's applications; sample data gives two people a history; the long email wraps at the @.

## 11. Not in v2 (later)

Resume file upload, Google sign-in, sending mail from the app, self-service "forgot password" email, Gemini
scouting, in-tool reports, automatic Voltax creation, AI candidate search, revenue tie-in, job-board
integrations, migrating a v1 SQLite file. (Per-role custom stages shipped in 2.2.0.)

# FanSided Recruit: Version 1 Spec

Status: ready to build · Owner: Zach · Audience: the engineer building v1

## 1. Goal

Give FanSided onboarding reps one cheap, simple, in-house place to post open contributor roles, collect applications, move candidates through a fixed pipeline, email them, and export the data to the existing Google Sheets reports. It replaces a paid ATS for our own team. **It is not a Comeet clone.** If a feature is not in this document, it is not in v1.

## 2. Technical constraints (design screens to fit these)

- Node 22, built-in `http` server, built-in `node:sqlite`. **Zero npm dependencies**. Multipart parsing, OAuth, and the Gmail calls are written by hand with `fetch` and `node:crypto`.
- Server-rendered HTML forms with full-page POST/redirect/GET. Vanilla JS only where it clearly helps (for example, "confirm delete" or showing the Voltax fields when Onboarded is picked). Every screen must work without JS, except the convenience bits.
- One Docker container plus one persistent disk at `DATA_DIR` that holds the SQLite file and uploads.
- Low traffic: a handful of reps and a few hundred applications a month. No queues, no caching layer, no background workers. Emails are sent inline during the request.

## 3. Users and permissions

| Who | How they get in | Can do |
|---|---|---|
| Public applicant | No login | View open roles, submit an application |
| Rep | Google sign-in, email must be an active row in `users` | View all roles and candidates; change stages; add notes; send emails; move a candidate to another role; record Voltax info; reassign a role's rep; export CSV |
| Admin | Same as rep, with `role = admin` | Everything a rep can do, plus manage roles, users and email templates, and delete candidates |

Reps can see every role, not just their own, so a teammate can cover during PTO. The dashboard still defaults to "my roles".

## 4. Screens

### Public (no login)

1. **Openings list** `/`. Shows open roles grouped by vertical: title, site name, a one-line description excerpt, and an Apply link. Closed roles are not shown. If the page URL has `?source=x`, every role link carries that parameter forward.
2. **Role page and apply form** `/roles/:id`. Shows the full description, then the form:
   - Full name (required), email (required), LinkedIn/portfolio URL (optional)
   - Writing sample links (textarea, one URL per line, at least one required)
   - File upload (optional; one file; PDF/DOC/DOCX; at most `MAX_UPLOAD_MB`)
   - The role's questionnaire, 0-5 questions, each a textarea, each with its own required flag
   - "How did you hear about us?" select: LinkedIn, Indeed, X/Twitter, FanSided site, Referral, Other
   - Hidden `source` field, filled from `?source=`
   - Hidden honeypot field
   - A closed or unknown role shows a "This role is no longer open" page with a link back to `/`.
   - If validation fails, the form is shown again with the entered values kept and errors next to the fields. The file has to be chosen again.
3. **Thank-you** `/thanks`. Shows a static confirmation. The applicant gets no auto-reply in v1 (see §7).

### Internal (login required)

4. **Login** `/login`. Shows one "Sign in with Google" button. An email that is not allowed sees "Your account isn't authorised. Ask an admin." No session is created.
5. **Dashboard** `/app`. Shows a table of roles assigned to me with the count of candidates in each stage. New counts are highlighted. A toggle switches to "All roles". There is also a link to Export.
6. **Role pipeline** `/app/roles/:id`. Shows the role header (status, assigned rep, and a **Reassign rep** select with a Save button). Below that, candidates are grouped into five sections in this order: New, Reviewing, Trial, Onboarded, Passed. Each row shows name, email, applied date, source, and days in the current stage, and has an inline stage select with a Move button. Clicking a row opens the candidate page. There is no drag-and-drop.
7. **Candidate page** `/app/applications/:id`. This page is for one application, shown in the context of the person.
   - Header: name, email, LinkedIn, current role, and current stage
   - **Change stage** form. When Onboarded is picked, it also shows Voltax user ID and onboarded date (default today)
   - **Move to another role** form: a select of all roles plus a Move button
   - Application details: sample links, a file download link, questionnaire answers (question text as it was at apply time), source, and how they heard about us
   - **Notes**: a list, newest first, with author and time, plus an add-note textarea. Notes are tied to the person and tagged with the application they were written on
   - **Send email**: template select, then a Load button that fills the subject and body with merge fields resolved. The rep can edit both before Send
   - **Activity**: the stage and role change log, and sent emails (subject, sender, time, expandable body)
   - **History**: the person's other applications (role, applied date, final stage), each with a link. Notes and emails from all applications appear in the lists above, tagged with their role
   - Admin only: **Delete candidate** (see §8)
8. **Templates admin** `/app/admin/templates` (admin). Lists templates and lets an admin create, edit and delete them. Each template has a name, subject and plain-text body. The page lists the available merge fields.
9. **Roles admin** `/app/admin/roles` (admin). Lists all roles with their status, and lets an admin create and edit them: title, vertical (free text with a datalist of existing verticals), site name, description (plain text, newlines kept), status (open/closed), assigned rep, and up to 5 questions (text plus a required checkbox). Roles are closed, never deleted.
10. **Users admin** `/app/admin/users` (admin). Lists users and lets an admin add one (email, name, admin/rep), change the role, and deactivate or reactivate. An admin cannot deactivate themselves or the last active admin. If the user being deactivated still has roles assigned, a warning is shown first.
11. **Export** `/app/export`. Has optional applied-from and applied-to dates and a Download CSV button. See §6.

## 5. Data model (SQLite)

Every table has an integer `id` primary key. Timestamps are ISO-8601 UTC text.

- **users**: `email` (unique, lowercase), `name`, `role` (admin|rep), `active` (0/1), `google_refresh_token_enc`, `created_at`
- **sessions**: `id` (random 32-byte hex), `user_id`, `csrf_token`, `expires_at`
- **job_roles**: `title`, `vertical`, `site_name`, `description`, `status` (open|closed), `assigned_user_id`, `questions_json` (`[{text, required}]`), `created_at`, `updated_at`
- **people**: `email` (unique, lowercase and trimmed; this is the dedupe key), `name`, `linkedin_url`, `created_at`, `updated_at`. Name and LinkedIn are overwritten by the person's latest application.
- **applications**: `person_id`, `role_id` (current role), `stage` (new|reviewing|trial|onboarded|passed), `sample_links` (newline text), `file_path`, `file_name`, `answers_json` (`[{question, answer}]`, a snapshot taken at apply time), `heard_from`, `source_tag`, `applied_at`, `stage_changed_at`, `onboarded_at`, `voltax_user_id`, `voltax_onboarded_on`
- **application_events**: append-only, `application_id`, `type` (stage_change|role_change|voltax_recorded), `from_value`, `to_value`, `actor_user_id` (NULL means the system, for the initial New), `at`. No UPDATE or DELETE is ever issued against this table, except as part of candidate deletion (§8).
- **notes**: `person_id`, `application_id`, `author_user_id`, `body`, `created_at`
- **email_templates**: `name`, `subject`, `body`, `updated_at`
- **emails_sent**: `person_id`, `application_id`, `template_id` (nullable), `sender_user_id`, `to_email`, `subject`, `body`, `gmail_message_id`, `status` (sent|failed), `error`, `sent_at`
- **deletion_log**: `deleted_person_id`, `actor_user_id`, `at`. It holds no personal data.

Schema migrations are a numbered list of SQL strings applied at startup and tracked in `PRAGMA user_version`. Seed data: 4 templates (Thanks for applying, Trial invite, Welcome aboard, Not a fit this time) and the admin users listed in `ADMIN_EMAILS`.

## 6. Behaviour details

- **Applying.** Look up the person by normalised email and create the person if there is none. Always create a new application with stage `new`, plus one `stage_change` event (`from` NULL, `to` new, system actor). Reapplying to the same role creates a second application. This is deliberate and keeps the history simple.
- **Stage change.** Update `stage` and `stage_changed_at`, and insert an event with the actor and time. When the new stage is Onboarded, also set `onboarded_at`, save `voltax_user_id` and `voltax_onboarded_on` if entered, add a `voltax_recorded` event when entered, and call `voltax.createUser(person, application)` (see below). Picking the current stage again does nothing.
- **Move to another role.** Update `role_id` and insert a `role_change` event (from and to role titles plus ids). The stage, notes, emails and events stay on the same application.
- **Reassign role.** Update `job_roles.assigned_user_id`. Only active users can be picked. Future application notifications go to the new rep.
- **Voltax adapter.** `src/voltax.js` exports `createUser()`. In v1 it returns `{ status: "not_configured" }` and does nothing else. The UI always offers manual entry. When API access arrives (from Stephen), only this file changes.
- **CSV export.** One row per application, UTF-8, RFC 4180 quoting. Columns: `application_id, applied_at, name, email, role_title, vertical, site_name, assigned_rep, source_tag, heard_from, stage, stage_changed_at, onboarded_at, voltax_user_id, linkedin_url`. Dates are `YYYY-MM-DD HH:MM` in `APP_TIMEZONE`. Any cell that starts with `= + - @` gets a leading `'` to prevent formula injection. The file is named `fansided-applications-YYYY-MM-DD.csv`.

## 7. Email behaviour

- **Sending as the rep.** At Google sign-in, request the scopes `openid email profile https://www.googleapis.com/auth/gmail.send` with `access_type=offline`. Store the refresh token encrypted with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`. Send with Gmail `users.messages.send` (a raw RFC 2822 message, base64url, plain text, UTF-8 subject encoded) from the signed-in rep's address.
- **Merge fields.** `{{first_name}}` is the first word of the person's name. `{{role_title}}` is the application's current role. `{{rep_name}}` is the sender's name. Unknown `{{x}}` stays as literal text, and the Load preview shows a warning so the rep can fix it before sending.
- **Logging.** Every attempt is written to `emails_sent`. A failure (for example, a revoked token) is logged as `failed` with the error, and the rep sees "Email not sent: please sign out and in again."
- **New-application notification.** On each new application, email the role's assigned rep ("New application: {name} for {role_title}", with a link to the candidate page). It is sent through the Gmail API using that rep's own stored token, addressed to themselves, so v1 needs no SMTP service. If the rep has no valid token, use the first active admin's token. If that also fails, log to stdout. The application is saved either way. Notifications are not logged on the candidate.
- No automatic emails to applicants in v1.

## 8. Security and privacy basics

- **Allowlist.** After Google OAuth, fetch userinfo. Sign-in is allowed only when `email_verified` is true, the email's domain is in `ALLOWED_EMAIL_DOMAINS` (if that is set), and there is an active row in `users`. Check the OAuth `state` parameter (random, stored in a short-lived cookie).
- **Sessions.** The random session id is stored in the `sessions` table. The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`, with a 14-day expiry. Logout deletes the row. Deactivating a user deletes their sessions.
- **CSRF.** Every internal POST must include the session's `csrf_token` in a hidden field, or it is rejected with 403. The public apply form uses a double-submit cookie token.
- **Uploads.** Accept one file of at most `MAX_UPLOAD_MB` (default 10). Allowed extensions are .pdf, .doc and .docx, and the magic bytes must match (`%PDF`, `D0 CF 11 E0`, `PK`). The file is stored as `DATA_DIR/uploads/<random>.<ext>` and the original name is stored only in the database. Downloads require login and are served with `Content-Disposition: attachment`. The total request body is capped at the limit plus 1 MB, and anything bigger gets a 413.
- **Abuse.** If the honeypot is filled, the server pretends the submit succeeded and saves nothing. The apply endpoint is limited in memory to 10 submissions per IP per hour. Inputs are length-limited (name 200, answers 5,000, links 2,000 characters).
- **Output.** All HTML output is escaped by default. URLs are rendered as links only if they are `http(s)`. Every response sends `Content-Security-Policy: default-src 'self'` and `X-Content-Type-Options: nosniff`.
- **Delete candidate (data requests).** Admin only, with a confirmation step. It hard-deletes the person, their applications, events, notes, sent-email records and uploaded files in one transaction, then writes `deletion_log`.
- Every internal route checks the session, and admin routes also check the role.

## 9. Configuration (env vars)

| Var | Purpose |
|---|---|
| `PORT` | Listen port (default 3000) |
| `BASE_URL` | Public URL, used for OAuth redirects and links in emails |
| `DATA_DIR` | Persistent disk path (SQLite file and `uploads/`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client |
| `ALLOWED_EMAIL_DOMAINS` | Comma list, for example `fansided.com,minutemedia.com` (optional extra gate) |
| `ADMIN_EMAILS` | Comma list, upserted as active admins at startup (bootstrap) |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key (base64) for encrypting refresh tokens |
| `MAX_UPLOAD_MB` | Upload limit (default 10) |
| `APP_TIMEZONE` | Display and export timezone (default `America/New_York`) |
| `VOLTAX_API_URL`, `VOLTAX_API_KEY` | Reserved, unused in v1 |

## 10. Acceptance checks

- **AC-01** `/` lists every open role grouped by vertical and shows no closed roles, without a login.
- **AC-02** `/roles/:id` for a closed role shows "no longer open", and a POST to apply for it creates nothing.
- **AC-03** Visiting `/?source=linkedin-nfl` and clicking a role keeps `source=linkedin-nfl`, and the submitted application has `source_tag = linkedin-nfl`.
- **AC-04** The role page shows exactly that role's questions. Leaving a required question empty shows an error, and the other entered values are kept.
- **AC-05** A submission with no name, an invalid email, or no writing sample link is rejected with field errors.
- **AC-06** A valid submission creates one application in stage New with one `stage_change` event (system actor), and redirects to `/thanks`.
- **AC-07** Submitting the apply form twice with the same email (in different case) creates one person and two applications.
- **AC-08** Questionnaire answers are stored with the question text. Editing the role's questions later does not change the answers shown on existing applications.
- **AC-09** Uploading a 9 MB PDF succeeds. An 11 MB file gets 413 or a size error. A `.exe` renamed to `.pdf` is rejected.
- **AC-10** An uploaded file can be downloaded by a signed-in user and returns 302-to-login or 401 when not signed in.
- **AC-11** A filled honeypot shows the thanks page and stores nothing. The 11th submission from one IP within an hour is rejected.
- **AC-12** A new application sends a notification email to the role's assigned rep. If sending fails, the application is still saved.
- **AC-13** A Google account whose email is not an active user (or is outside `ALLOWED_EMAIL_DOMAINS`) cannot sign in and gets no session.
- **AC-14** Emails in `ADMIN_EMAILS` can sign in as admin on a fresh database.
- **AC-15** A rep gets 403 on every `/app/admin/*` route and on candidate delete.
- **AC-16** An internal POST without a valid CSRF token returns 403 and changes nothing.
- **AC-17** The session cookie is HttpOnly, Secure and SameSite=Lax. After logout or deactivation, the old cookie no longer works.
- **AC-18** The dashboard shows a signed-in rep their assigned roles with correct per-stage counts, and "All roles" shows every role.
- **AC-19** The role pipeline shows candidates in the five fixed stages, in order.
- **AC-20** Moving a candidate from New to Reviewing updates the stage and adds one event with from, to, the actor and a timestamp.
- **AC-21** After three stage changes, the application has exactly four events in order, and none of them was modified.
- **AC-22** Moving to Onboarded with a Voltax ID and date saves both, sets `onboarded_at`, and calls `voltax.createUser`, which returns `not_configured` without error.
- **AC-23** Moving a candidate to another role changes the role it appears under, adds a `role_change` event, and keeps its notes, emails and events.
- **AC-24** A note added on the candidate page shows its author and time, and also appears when the same person's other application is opened.
- **AC-25** When the person has applied before, the candidate page shows their prior applications with role, date and final stage, plus prior notes and emails.
- **AC-26** Loading a template fills `{{first_name}}`, `{{role_title}}` and `{{rep_name}}` correctly. An unknown field shows a warning.
- **AC-27** Sending an email calls Gmail as the signed-in rep and logs it on the candidate with the subject, body, sender and time. A Gmail error is logged as `failed` and shown to the rep.
- **AC-28** An admin can create, edit and delete templates, and changes apply the next time a template is loaded.
- **AC-29** An admin can create a role with up to 5 questions, edit it, and close it. A closed role disappears from `/` but stays visible internally with its candidates.
- **AC-30** An admin can add a user, change rep to admin, and deactivate a user. An admin cannot deactivate themselves or the last admin.
- **AC-31** Reassigning a role to another rep updates the dashboard of both reps, and the next application notifies the new rep.
- **AC-32** The CSV export has the columns in §6, one row per application, and respects the date filter. A value starting with `=` is prefixed with `'`. The file opens correctly in Google Sheets.
- **AC-33** Deleting a candidate removes the person, their applications, events, notes, email records and files from disk, and adds one `deletion_log` row.
- **AC-34** User-entered `<script>` in any field is shown escaped on every page.
- **AC-35** After the container restarts, all data and uploads are still there (they live on `DATA_DIR`), and migrations do not re-run.

## 11. Later (explicitly not v1)

- Automatic Voltax user creation (fill in `voltax.js` once Stephen provides API access)
- Job-board integrations (LinkedIn, Indeed posting or import)
- Built-in reports such as time-in-stage and source conversion (the event log already supports them)
- Search and filtering across candidates
- Per-role custom stages and workflows
- Automatic PTO coverage and rules-based reassignment
- Applicant auto-replies and scheduled emails
- LinkedIn profile import, AI scouting, revenue tracking

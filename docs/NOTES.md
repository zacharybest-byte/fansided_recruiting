# v1 build notes: stubs, interpretations and test coverage

## 1.0.0 (first build)

Everything in `docs/SPEC.md` is implemented. This file lists what is stubbed, where the
spec left room and a choice was made, and which acceptance checks are not fully automated.

### Stubbed or not reachable from the build sandbox

- **Voltax.** `src/voltax.js` exports `createUser()`, which returns
  `{ status: "not_configured" }` and does nothing else. It is called on every move to
  Onboarded. Reps always enter the Voltax user ID by hand. When Stephen provides API
  access, only this file changes.
- **Google (OIDC sign-in and Gmail send).** This is implemented for real in
  `src/lib/google.js` against Google's documented endpoints:
  - `accounts.google.com/o/oauth2/v2/auth`
  - `oauth2.googleapis.com/token`, for the code exchange and refresh-token grants
  - `openidconnect.googleapis.com/v1/userinfo`
  - `gmail.googleapis.com/gmail/v1/users/me/messages/send`, with a base64url RFC 2822
    message

  The build sandbox had no network, so this code has **not been run against real
  Google**. The tests drive the real code path end to end through an injected fake of
  those endpoints (`test/fake-google.js`). Do one manual sign-in and one send on staging
  before go-live.
- **Development switches.** These are not in the spec:
  - `DEV_LOGIN=1` lets you sign in as any active, allowlisted user without Google. It
    still applies the users-table and domain checks, and startup is refused when
    `NODE_ENV=production`.
  - `EMAIL_MODE=log` writes outgoing mail to stdout and to a `dev_mail_log` table
    instead of calling Gmail.

### Small additions and interpretations

| Area | Decision |
|---|---|
| Schema | Extra table `dev_mail_log`, only written when `EMAIL_MODE=log`. A SQLite trigger refuses any `UPDATE` on `application_events`, so the log is append-only at the database level. `DELETE` is still allowed for candidate deletion. |
| Env vars | Added `DEV_LOGIN`, `EMAIL_MODE`, `TRUST_PROXY` (number of reverse proxies, used to read the client IP for the rate limit) and `QUIET` (silences logs, for tests). |
| Voltax entry | Besides the fields on the Change stage form, an already-Onboarded candidate has a small **Record Voltax** form, for when the ID is only known later. Saving it adds a `voltax_recorded` event. The Voltax fields on the stage form are always visible without JS. With JS, they show only when Onboarded is picked. |
| Pipeline quick move | Moving a candidate to Onboarded from the pipeline row works and calls `voltax.createUser`, but it has no Voltax fields. Those are entered on the candidate page. |
| Event values | `role_change` stores `from_value` and `to_value` as `"Role title (#id)"`. `voltax_recorded` stores `"<voltax id> (onboarded YYYY-MM-DD)"`. |
| Notifications | If a role has no assigned rep, or the rep is deactivated, the notification goes to the first active admin. A rep's revoked refresh token (`invalid_grant`) is cleared, so later notifications use the admin's token straight away. |
| Sign-in | Google only returns a refresh token on first consent. If a rep signs in and the app has no usable token for them, the app sends them back to Google once with `prompt=consent`. If the rep unticks the Gmail permission, sign-in still works and they see a warning. |
| Admin guards | As well as refusing to deactivate yourself or the last active admin, the app refuses to **demote** the last active admin. The deactivation warning lists every role still assigned to the user, open or closed. |
| Bootstrap admins | `ADMIN_EMAILS` are upserted as active admins on every start. To deactivate one permanently, remove them from `ADMIN_EMAILS` first. |
| Apply form | "How did you hear about us?" is optional. If given, it must be one of the six options. Each writing-sample line must be an http(s) URL; a bare `example.com/post` gets `https://` added. Whitespace and newlines in the name are collapsed. The rate limit counts every POST to the apply endpoint, including invalid ones and honeypot hits. It is in memory and resets on restart. |
| Closed or unknown role | Returns the "This role is no longer open" page with HTTP 404. |
| Oversized upload | A body over `MAX_UPLOAD_MB` + 1 MB gets 413 and a plain "file too large" page. A file over the limit but under the body cap gets a field error on the re-shown form. |
| Email composer | **Load** is a plain GET (`?template=ID`), so it works without JS. The rep can edit the subject and body before sending. |
| CSV | No BOM, CRLF line endings. The formula-injection guard also prefixes cells that start with a tab or CR (OWASP guidance), on top of `= + - @`. The date filter is inclusive and uses `APP_TIMEZONE` days. |
| Headers | Every response also sends `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`. Internal pages are `Cache-Control: no-store`. |
| Cookies | The session cookie is always `Secure`, even in dev. Browsers that treat `http://localhost` as a secure context (Chrome, Firefox, Edge) accept it. |
| Layout | Spec's file list has `src/lib/voltax`; the spec itself says `src/voltax.js`, which is what is used. |

### Acceptance checks: automated coverage

`npm test` (equivalent to `node --test`) covers AC-01 to AC-35. Each check has its own
named test, except AC-20/21 and AC-24/25, which are tested together. A few are covered
with limits:

- **AC-13, AC-14, AC-27 (Google).** These run the real OAuth and Gmail code against a
  fake Google, not against Google itself.
- **AC-17 (Secure flag).** The test checks the `Set-Cookie` attributes. It cannot test
  how a real browser handles them.
- **AC-32 ("opens correctly in Google Sheets").** The test checks RFC 4180 output,
  including quoting, CRLF, UTF-8 and the formula guard. Importing into Sheets was not
  tested.
- **AC-35 (container restart).** The test closes the app and starts it again on the same
  `DATA_DIR`. A real `docker restart` with a mounted volume was not tested, because the
  build sandbox has no Docker daemon. The `Dockerfile` was written but not built here.

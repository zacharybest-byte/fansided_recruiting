# FanSided Recruit

FanSided's in-house tool for onboarding reps: post contributor roles, collect applications, move candidates
through a pipeline you shape per role (always New first, Onboarded and Passed last; Reviewing and Trial by default), email them from your own Gmail, export to CSV.
One Node function on Vercel, one Turso database, zero npm dependencies. Version 2.3.0.

## Deploy in 5 steps

1. Push this repo to GitHub and import it in Vercel (Framework Preset "Other", no build command, no install step needed).
2. In the Vercel dashboard open Storage (Marketplace), add Turso and connect it to the project. This injects `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
3. In Settings, Environment Variables add `SESSION_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), `ADMIN_EMAIL`, `SETUP_TOKEN` (same command, 32+ characters), and optionally `NOTIFY_WEBHOOK_URL` and `BASE_URL`.
4. Redeploy, open `https://<your-site>/setup?token=<SETUP_TOKEN>` and set the admin password.
5. Sign in, go to Users and invite the team (copy each link and send it), optionally load Sample data for the demo, then delete `SETUP_TOKEN` from Vercel.

## Run locally

```
cp .env.example .env     # set SESSION_SECRET (optional locally), ADMIN_EMAIL, SETUP_TOKEN (32+ chars)
npm run dev              # http://localhost:3000, data in ./data (node:sqlite); prints the /setup link
npm test                 # whole suite on the sqlite driver and on the Turso driver (fake), about 35 s
```

Production-like run with the Turso driver against the local fake of Turso's HTTP API:

```
node scripts/fake-turso.js --port 8080 --token dev-token &
NODE_ENV=production SESSION_SECRET=<32+ chars> TURSO_DATABASE_URL=http://127.0.0.1:8080 TURSO_AUTH_TOKEN=dev-token ADMIN_EMAIL=you@example.com SETUP_TOKEN=<32+ chars> npm start
```

## Settings

| Variable | Needed | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | production | Set by the Turso integration. Unset locally = SQLite file in `./data`. |
| `SESSION_SECRET` | production | 32+ random characters (16+ distinct); signs CSRF tokens, the flash cookie and rate-limit keys. |
| `ADMIN_EMAIL`, `SETUP_TOKEN` | first run | The `/setup?token=` link for the first admin. Remove `SETUP_TOKEN` afterwards. |
| `BASE_URL` | optional | Public address used in invite links and alerts. Default: the Vercel URL. |
| `NOTIFY_WEBHOOK_URL` | optional | Google Chat or Slack incoming webhook (https). |

## Email and alerts

On a candidate page pick a template, edit the text and click "Open in Gmail" (or "Open in mail app"): a compose
window opens with the text filled in and the click is logged on the candidate. Nothing is sent by the app.
The dashboard shows the New count per role and "+N since your last visit" (the "Mark as seen" button moves that mark); with `NOTIFY_WEBHOOK_URL` each new
application posts the role title and a link (never the applicant's name or email).

## How it works

Every signed-in rep can see all candidates (there is no per-rep scoping; assignment only decides whose dashboard lists a role).
Rate limits count per client IP (IPv6 by /64); a proxy or CDN placed in front of Vercel makes all users share one IP bucket.

## Data deletion

Admins can delete a candidate from the candidate page: the person, applications, notes, email records and events
are removed, and one log row without personal data is kept. Sample data has its own Remove button.

## Not tested on real infrastructure

The build sandbox had no network. Verified only against local fakes and the Vercel/Turso documentation:

- Vercel deployment: the rewrite to `/api/index`, `functions.includeFiles` for `public/**`, `req.body` and stream behaviour (the reader accepts either), `req.url` after the rewrite, CDN-served `/style.css` and `/app.js` with the `vercel.json` headers, the `x-vercel-forwarded-for` client-IP header, and cold-start time with scrypt.
- Turso: the real `/v2/pipeline` (`batch` conditions, error shapes), authentication, the `libsql://` / `turso://` to `https://` rewrite, foreign-key behaviour, and the variable names injected by the integration.
- Gmail compose URL with very long bodies; Google Chat and Slack webhook acceptance of the `{"text": ...}` payload.
- Turso: `db.batch` has never run on a real server, a batch must finish inside Turso's ~5 s transaction window (client timeout 8 s), and `test/fake-turso.js` is our own reading of the docs, so it may deviate.
- Logs: Vercel and Turso platform logs may record the `/setup?token=` and `/set-password?token=` query strings. Remove `SETUP_TOKEN` after setup; invite and reset links are single-use.

## Brand assets

The official FanSided brand kit (July 2026) is applied through CSS custom properties at the top of `public/style.css`
(FanSided Blue `#062f4d`, Yeti Blue `#5A97C1`, Black `#111111`, Gray `#999999`, White `#F6F6F6`).

- **Logo**: `public/logo.png` (368 x 96, generated from the supplied `fansided-primary-wordmark.png`, 6906 x 1800).
  It is only ever scaled proportionally (CSS sets the height, the width stays auto). To swap it, make a new PNG that is
  96 px tall with the same transparent-background wordmark, update the `width`/`height` attributes in `src/lib/layout.js`
  (`logoImg`) and the dimensions in `test/brand.test.js` if the aspect ratio changes, then run `node scripts/embed-assets.js`.
- **Favicon**: `public/favicon.svg` is a placeholder (white block F on a FanSided Blue rounded square).
- **Fonts**: headlines Public Sans Black (900), body Public Sans Medium (500). Drop `PublicSans-Black.woff2` (or `.ttf`) and
  `PublicSans-Medium.woff2` (or `.ttf`) into `public/fonts/`, then run `node scripts/embed-assets.js`. The `@font-face`
  blocks in `public/style.css` already point at those names (with `local()` first and `font-display: swap`). Until the files
  exist the requests 404 quietly and the system font stack is used (headings 800, body 400). Bold text (700) resolves to the
  Black face when it is present, because only Black and Medium are loaded.
- **Embedding**: `scripts/embed-assets.js` writes `src/lib/assets.generated.js`, which carries the CSS, JS and SVG as text and
  the logo and fonts as base64, so everything is served on Vercel even if `public/` is not bundled with the function. A test
  fails if the embedded copy differs from `public/`.
- The Content-Security-Policy allows `font-src 'self'` and `img-src 'self'` only: no external fonts or images.

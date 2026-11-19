# FanSided Recruit

FanSided's in-house tool for contributor recruiting. Onboarding reps post open roles,
applicants apply on a public page, and reps move candidates through a fixed pipeline
(New, Reviewing, Trial, Onboarded, Passed). Reps add notes, email candidates from their
own Gmail, and export everything to CSV for the Google Sheets reports. It replaces a paid
ATS for our own team. The full spec is in [`docs/SPEC.md`](docs/SPEC.md), and what is
stubbed or interpreted is in [`docs/NOTES.md`](docs/NOTES.md).

- Node 22 (22.13 or newer), built-in `http` and `node:sqlite`. **No npm dependencies.**
- Server-rendered HTML; one CSS file and a few lines of optional JS.
- One container plus one persistent disk (`DATA_DIR`) holding the SQLite file and uploads.

## Run it locally (dev mode)

```sh
cd fansided-recruit
npm run seed        # demo admin, 2 reps, 3 roles, a few applications in ./data
npm run dev         # http://localhost:3000
```

Open <http://localhost:3000/login> and sign in as `admin@fansided.com` (admin),
`rep.one@fansided.com` or `rep.two@fansided.com` (reps). The public openings page is
<http://localhost:3000/>.

`npm run dev` sets `DEV_LOGIN=1` (sign in as any active user without Google) and
`EMAIL_MODE=log` (outgoing mail is written to stdout and the `dev_mail_log` table instead
of being sent). The server refuses to start with `DEV_LOGIN=1` when `NODE_ENV=production`.

The session cookie is always `Secure`. Chrome, Firefox and Edge accept Secure cookies on
`http://localhost`; if your browser does not, use one of those for local testing.

Other commands:

```sh
npm test            # node --test: all automated acceptance checks
npm start           # production start (env vars, or a .env file; see .env.example)
node scripts/backup.js /path/to/copy.sqlite   # consistent DB snapshot, safe while running
```

## Configuration

All configuration is environment variables. See [`.env.example`](.env.example) for every
variable with comments. `npm start`, `npm run dev` and `npm run seed` also load a `.env`
file from the project folder if there is one (`node --env-file-if-exists=.env`). Never
commit `.env`. In Docker, pass the file with `--env-file` instead (see the deploy section).

In production, `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`TOKEN_ENCRYPTION_KEY` are required (the app will not start without them). Generate the
encryption key with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep that key safe and stable. It encrypts each rep's Google refresh token (AES-256-GCM).
If it changes, reps only need to sign out and in again.

`ADMIN_EMAILS` is upserted as active admins on every start, so you can always get in on a
fresh database. Because of that, to remove a bootstrap admin, take them out of
`ADMIN_EMAILS` first. Bootstrap admins start without a display name (it fills in from
Google at their first sign-in). Admins can edit any user's display name under *Users*.

## Set up Google sign-in and Gmail sending

The app signs reps in with Google (OpenID Connect) and sends email through the Gmail API
as the signed-in rep, so it needs one OAuth client in a Google Cloud project.

1. **Pick a project.** In the [Google Cloud console](https://console.cloud.google.com/),
   create or choose a project (for example `fansided-recruit`). Ideally use the same
   project you deploy to.
2. **Enable the Gmail API.** Go to *APIs & Services → Library*, search for **Gmail API**
   and click **Enable**.
3. **Configure the consent screen.** Go to *APIs & Services → OAuth consent screen*
   (newer consoles call this *Google Auth Platform*).
   - **Audience / User type: Internal.** This option only exists when **the Google Cloud
     project itself belongs to your Google Workspace organisation** (it sits under the
     org in the resource hierarchy, not in someone's personal account). It then allows
     only accounts from that organisation. Internal apps need no Google verification,
     and refresh tokens do not expire after 7 days.
   - If reps are spread across separate Workspace organisations (for example
     `fansided.com` and `minutemedia.com` are different orgs), or the project is not in
     the org, you have to choose **External**. While the app is in *Testing* status, only
     the listed test users can sign in and **refresh tokens expire after 7 days**, so
     reps would have to sign in again weekly to keep sending email. For long-term use,
     publish the app. Because `gmail.send` is a sensitive scope, Google will ask for
     verification.
   - **Branding:** app name "FanSided Recruit", a support email, and your domain under
     authorised domains.
   - **Data access / Scopes:** add `openid`, `.../auth/userinfo.email`,
     `.../auth/userinfo.profile` and `https://www.googleapis.com/auth/gmail.send`.
4. **Create the OAuth client.** Go to *APIs & Services → Credentials → Create
   credentials → OAuth client ID*.
   - Application type: **Web application**.
   - Authorised redirect URIs: `https://YOUR-DOMAIN/auth/google/callback` (it must
     equal `BASE_URL` + `/auth/google/callback`). For local testing against real Google,
     add `http://localhost:3000/auth/google/callback` as well.
   - Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` and
     `GOOGLE_CLIENT_SECRET`.
5. **Check the Workspace API controls (Workspace admin).** Some organisations restrict
   Gmail scopes for third-party and internal apps. If reps see "This app is blocked" or
   "Access blocked", a Workspace super admin must trust the app. In the *Google Admin
   console*, go to *Security → Access and data control → API controls → Manage
   Third-Party App Access*, add the app by its OAuth **Client ID**, and set it to
   **Trusted**.
6. **Add people.** Put your own address in `ADMIN_EMAILS` and start the app. Sign in,
   then add reps under *Users*. Optionally set `ALLOWED_EMAIL_DOMAINS` as an extra gate.

How it behaves:

- Sign-in requests `openid email profile https://www.googleapis.com/auth/gmail.send` with
  `access_type=offline`. Google only returns a refresh token the first time a user
  consents. If a rep signs in and the app has no usable token for them, it sends them
  through Google once more with `prompt=consent` to get one.
- On Google's consent screen a rep can untick "Send email on your behalf". They can still
  sign in, but they are warned that they cannot send email until they sign in again and
  allow it.
- If a token is revoked, sending fails, the attempt is logged as `failed`, and the rep sees
  "Email not sent: please sign out and in again."
- New-application notifications go to the role's assigned rep, sent from that rep's own
  Gmail to themselves. If that fails, the app tries the first active admin's Gmail. If
  that fails too, it logs the application id to stdout. The application is saved either
  way.

## Data retention and deleting a candidate

*Delete candidate* (admin) hard-deletes the person, their applications, events, notes,
sent-email records and uploaded files from the live database and disk. Some copies live
outside the database and are **not** removed by that button:

| Where | What it holds | How to purge |
|---|---|---|
| Daily DB snapshots in `gs://BUCKET/db/` | Full database copies | They expire after 30 days (lifecycle rule below). For an urgent request, delete the snapshots taken before the deletion: `gcloud storage rm gs://BUCKET/db/recruit-YYYY-MM-DD.sqlite`. Disk snapshots, if enabled, expire after their retention period, or delete them in *Compute Engine → Snapshots*. |
| `gs://BUCKET/uploads/` | Uploaded files | The backup script mirrors with `--delete-unmatched-destination-objects`, so deleted files leave the bucket at the next nightly run. |
| Reps' Gmail mailboxes | Sent candidate emails and new-application notifications (they include the applicant's name) | Delete them in Gmail if a request requires it. |
| Container logs | In production, logs carry application and user ids only, never applicant names or emails. Logs rotate at 5 × 10 MB. | `sudo systemctl restart fansided-recruit` starts a fresh log. |
| `dev_mail_log` table (only with `EMAIL_MODE=log`, i.e. development) | Full notification text | `node -e "new (require('node:sqlite').DatabaseSync)('data/recruit.sqlite').exec('DELETE FROM dev_mail_log')"`. In dev mode, stdout also prints notification subjects. |

`deletion_log` keeps only the deleted person's id, the admin and the time. Ids are never
reused, so that id can never point at someone else.

## Deploy to Google Cloud

SQLite is a file on disk, so **the app must run as exactly one instance with a real
persistent disk**. It cannot scale out, and it must not sit on a network filesystem that
lacks proper file locking. For a handful of reps and a few hundred applications a month,
one small VM is plenty.

### Recommended: one Compute Engine VM with a persistent disk

Cost is roughly an e2-small plus a 10 GB disk and a static IP. TLS comes from Caddy (free
Let's Encrypt certificates), so no load balancer is needed. The container is run by a
systemd unit that refuses to start unless the data disk is mounted.

```sh
PROJECT=your-project; ZONE=us-east1-b; REGION=us-east1
gcloud config set project $PROJECT

# 1. A persistent data disk (kept if the VM is deleted) and a static IP.
gcloud compute disks create recruit-data --size=10GB --type=pd-balanced --zone=$ZONE
gcloud compute addresses create recruit-ip --region=$REGION
gcloud compute addresses describe recruit-ip --region=$REGION --format='value(address)'
#    -> point a DNS A record (e.g. recruit.fansided.com) at this IP.

# 2. The VM (Debian 12 already includes the gcloud CLI, which the backups use).
gcloud compute instances create recruit \
  --zone=$ZONE --machine-type=e2-small \
  --image-family=debian-12 --image-project=debian-cloud \
  --disk=name=recruit-data,device-name=recruit-data,mode=rw,auto-delete=no \
  --address=recruit-ip --tags=http-server,https-server \
  --scopes=cloud-platform
gcloud compute firewall-rules create allow-web --allow=tcp:80,tcp:443 --target-tags=http-server,https-server
```

On the VM (`gcloud compute ssh recruit --zone=$ZONE`):

```sh
# Format (first time only!) and mount the data disk. "nofail" keeps the VM bootable if the
# disk is missing; the systemd unit below then refuses to start the app.
sudo mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard /dev/disk/by-id/google-recruit-data
sudo mkdir -p /mnt/recruit
echo "UUID=$(sudo blkid -s UUID -o value /dev/disk/by-id/google-recruit-data) /mnt/recruit ext4 discard,defaults,nofail 0 2" | sudo tee -a /etc/fstab
sudo mount -a
sudo touch /mnt/recruit/.recruit-data-disk  # marker: "this is the real data disk"
sudo chown 1000:1000 /mnt/recruit           # the container runs as the non-root "node" user (uid 1000)

# Docker, Caddy, git.
sudo apt-get update && sudo apt-get install -y docker.io caddy git

# Build the image, tagged with the git commit, and mark it as the one to run.
git clone <your-repo-url> fansided-recruit && cd fansided-recruit
SHA=$(git rev-parse --short HEAD)
sudo docker build -t fansided-recruit:$SHA .
sudo docker tag fansided-recruit:$SHA fansided-recruit:current

# Secrets live in a root-only env file on the VM (never in git).
sudo install -m 600 /dev/null /etc/fansided-recruit.env
sudo nano /etc/fansided-recruit.env         # fill in from .env.example, with DATA_DIR=/data, TRUST_PROXY=1

# The systemd unit (RequiresMountsFor=/mnt/recruit, log rotation 5 x 10 MB).
sudo cp deploy/fansided-recruit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fansided-recruit
sudo systemctl status fansided-recruit      # logs: sudo journalctl -u fansided-recruit  /  sudo docker logs recruit
```

Then set up Caddy for HTTPS. Put this in `/etc/caddy/Caddyfile` and run
`sudo systemctl reload caddy`:

```
recruit.fansided.com {
    reverse_proxy 127.0.0.1:3000
}
```

#### Upgrades and rollback

Every image is tagged with its git commit, and `fansided-recruit:current` is the one the
service runs.

```sh
cd ~/fansided-recruit && git pull
sudo BUCKET=gs://your-project-recruit-backups /usr/local/bin/recruit-backup   # backup before upgrading
SHA=$(git rev-parse --short HEAD)
sudo docker build -t fansided-recruit:$SHA .
sudo docker tag fansided-recruit:$SHA fansided-recruit:current
sudo systemctl restart fansided-recruit     # a few seconds of downtime; migrations run on start
echo "$(date -u +%FT%TZ) $SHA" | sudo tee -a /var/log/recruit-deploys.log
```

To roll back, point `current` at the previous commit's image and restart:

```sh
sudo docker images fansided-recruit         # or see /var/log/recruit-deploys.log
sudo docker tag fansided-recruit:<previous-sha> fansided-recruit:current
sudo systemctl restart fansided-recruit
```

Migrations only go forward. Older code tolerates the newer schema when a migration only
adds columns or tables (true for every migration so far, see `docs/NOTES.md`). If a
release notes a breaking migration, roll back by also restoring the backup taken before
the upgrade (see *Restore* below). Prune old images now and then with
`sudo docker image prune`.

#### Backups: daily copy to Cloud Storage

```sh
BUCKET=gs://your-project-recruit-backups
gcloud storage buckets create $BUCKET --location=$REGION --uniform-bucket-level-access
# Database snapshots (db/) are kept 30 days. uploads/ is a mirror, not a history.
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["db/"]}}]}' > /tmp/lc.json
gcloud storage buckets update $BUCKET --lifecycle-file=/tmp/lc.json
# Let the VM's service account write to the bucket.
SA=$(gcloud compute instances describe recruit --zone=$ZONE --format='value(serviceAccounts[0].email)')
gcloud storage buckets add-iam-policy-binding $BUCKET --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
```

On the VM, install the backup script and a cron entry:

```sh
sudo install -m 755 ~/fansided-recruit/deploy/backup-to-gcs.sh /usr/local/bin/recruit-backup
sudo tee /etc/cron.d/recruit-backup >/dev/null <<'CRON'
BUCKET=gs://your-project-recruit-backups
15 7 * * * root /usr/local/bin/recruit-backup >> /var/log/recruit-backup.log 2>&1
CRON
sudo BUCKET=gs://your-project-recruit-backups /usr/local/bin/recruit-backup   # test it once now
```

[`deploy/backup-to-gcs.sh`](deploy/backup-to-gcs.sh) runs with `set -euo pipefail` and
logs every step. It:

- checks that the data disk is mounted (by looking for the marker file);
- writes a consistent snapshot with SQLite `VACUUM INTO` (a plain `cp` of a live WAL-mode
  database might not be consistent) and uploads it to `db/recruit-YYYY-MM-DD.sqlite`;
- mirrors `uploads/` with `--delete-unmatched-destination-objects`, so files of deleted
  candidates also leave the bucket. The disk check prevents an empty directory from
  wiping the mirror.

As a second safety net, you can add a daily snapshot schedule on the disk:

```sh
gcloud compute resource-policies create snapshot-schedule recruit-daily --region=$REGION \
  --daily-schedule --start-time=08:00 --max-retention-days=14
gcloud compute disks add-resource-policies recruit-data --zone=$ZONE --resource-policies=recruit-daily
```

**Restore:** `sudo systemctl stop fansided-recruit`, then copy a snapshot to
`/mnt/recruit/recruit.sqlite` and delete any `recruit.sqlite-wal` and `-shm` files next to
it. Restore files with `gcloud storage rsync --recursive $BUCKET/uploads /mnt/recruit/uploads`,
run `sudo chown -R 1000:1000 /mnt/recruit`, then `sudo systemctl start fansided-recruit`.

### Alternative: Cloud Run with a mounted volume (not recommended)

Cloud Run can mount two kinds of volume. Neither is a good home for SQLite:

- **Cloud Storage FUSE volumes have no file locking and do not support SQLite's
  writes.** Do not use them for this app. You will corrupt the database.
- **NFS volumes (Filestore)** work better, but SQLite's locking over NFS is not reliable.
  Filestore's smallest tier also costs far more than a VM. During a deploy, Cloud Run can
  briefly run the old and new revisions at the same time, which means two writers on one
  database file.

If you still choose Cloud Run, use Filestore NFS and cap it at one instance:

```sh
gcloud run deploy fansided-recruit --image=REGION-docker.pkg.dev/$PROJECT/apps/fansided-recruit \
  --region=$REGION --execution-environment=gen2 \
  --max-instances=1 --concurrency=80 \
  --add-volume=name=data,type=nfs,location=FILESTORE_IP:/recruit \
  --add-volume-mount=volume=data,mount-path=/data \
  --set-env-vars=NODE_ENV=production,DATA_DIR=/data,TRUST_PROXY=1,BASE_URL=https://...,ADMIN_EMAILS=...,GOOGLE_CLIENT_ID=... \
  --set-secrets=GOOGLE_CLIENT_SECRET=recruit-google-secret:latest,TOKEN_ENCRYPTION_KEY=recruit-token-key:latest \
  --allow-unauthenticated
```

Deploy during quiet hours. You will also need your own backup job, because
`deploy/backup-to-gcs.sh` assumes Docker on a VM. The VM path above is simpler, cheaper
and safer.

## Project layout

```
src/server.js          entry point: config, DB, routing, error handling
src/voltax.js          Voltax adapter (stub in v1; the only file to change when the API arrives)
src/routes/            public.js (openings, apply, thanks), auth.js, dashboard.js (dashboard,
                       pipeline, reassign, export), candidates.js, admin.js
src/lib/               db (schema + migrations), auth (sessions, allowlist), csrf, multipart,
                       render (escaping html`` tag), layout, email (merge fields, RFC 2822,
                       Gmail/log delivery), google (OAuth + Gmail via fetch), crypto (AES-256-GCM),
                       csv, time (time zones via Intl), http (body limits, router), cookies, config
public/                style.css, app.js
scripts/               seed.js, backup.js
deploy/                fansided-recruit.service (systemd unit), backup-to-gcs.sh (daily backup)
test/                  node:test suites (one per area) + helpers and a fake Google
```

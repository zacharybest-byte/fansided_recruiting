#!/usr/bin/env bash
# Daily backup: consistent SQLite snapshot + uploads, copied to Cloud Storage.
# Install as /usr/local/bin/recruit-backup and run from cron (see README).
#   BUCKET      gs://... bucket (required)
#   DATA_MOUNT  host path of the data disk (default /mnt/recruit)
#   CONTAINER   app container name (default recruit)
set -euo pipefail

BUCKET="${BUCKET:?Set BUCKET, e.g. BUCKET=gs://my-project-recruit-backups}"
DATA_MOUNT="${DATA_MOUNT:-/mnt/recruit}"
CONTAINER="${CONTAINER:-recruit}"
STAMP="$(date -u +%F)"

log() { echo "$(date -u +%FT%TZ) recruit-backup: $*"; }
trap 'log "FAILED at line $LINENO (exit $?)"' ERR

log "start (bucket=$BUCKET, data=$DATA_MOUNT)"
# Never sync from an unmounted/empty directory: that would delete the uploads backup.
[[ -f "$DATA_MOUNT/.recruit-data-disk" ]] || { log "data disk marker missing; is the disk mounted?"; exit 1; }
[[ -f "$DATA_MOUNT/recruit.sqlite" ]] || { log "no database at $DATA_MOUNT/recruit.sqlite"; exit 1; }

log "writing SQLite snapshot (VACUUM INTO)"
docker exec "$CONTAINER" node --disable-warning=ExperimentalWarning scripts/backup.js /data/backups/recruit.sqlite
[[ -s "$DATA_MOUNT/backups/recruit.sqlite" ]] || { log "snapshot is empty"; exit 1; }

log "uploading database snapshot to $BUCKET/db/recruit-$STAMP.sqlite"
gcloud storage cp "$DATA_MOUNT/backups/recruit.sqlite" "$BUCKET/db/recruit-$STAMP.sqlite"

# Mirror uploads; files of deleted candidates are removed from the bucket too.
log "syncing uploads to $BUCKET/uploads"
mkdir -p "$DATA_MOUNT/uploads"
gcloud storage rsync --recursive --delete-unmatched-destination-objects "$DATA_MOUNT/uploads" "$BUCKET/uploads"

rm -f "$DATA_MOUNT/backups/recruit.sqlite"
log "done"

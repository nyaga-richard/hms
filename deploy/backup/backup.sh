#!/bin/sh
# Nightly logical backup (custom format, compressed) + retention. Runs inside the db-backup container.
set -eu
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="/backups/hms-${STAMP}.dump"
pg_dump -Fc -Z 6 -f "$OUT"
echo "[hms-backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"
find /backups -name 'hms-*.dump' -mtime +"${BACKUP_KEEP_DAYS:-14}" -print -delete | sed 's/^/[hms-backup] pruned /'

#!/usr/bin/env bash
# Local (non-Docker) PostgreSQL helper for development sandboxes. Production uses docker-compose.
# The live cluster lives in .cache/pgdata (kept out of git and workspace snapshots — it is large and
# not portable). Persistent state is carried as a compact dump: see scripts/dev-snapshot.sh / dev-up.sh.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PGDATA=${PGDATA:-$ROOT/.cache/pgdata}
LOG=${PGLOG:-$ROOT/.cache/pgrun/pg.log}
BIN=${PGBIN:-/usr/lib/postgresql/17/bin}
mkdir -p "$(dirname "$LOG")"
case "${1:-start}" in
  start)
    [ -f "$PGDATA/PG_VERSION" ] || { echo "No cluster at $PGDATA — run scripts/dev-up.sh"; exit 1; }
    chmod 700 "$PGDATA"
    # empty dirs are not always preserved by backups – recreate the ones PostgreSQL requires
    for d in pg_notify pg_commit_ts pg_dynshmem pg_replslot pg_serial pg_snapshots pg_stat pg_stat_tmp pg_tblspc pg_twophase pg_wal/archive_status pg_wal/summaries pg_logical/snapshots pg_logical/mappings pg_xact pg_multixact/members pg_multixact/offsets pg_subtrans; do mkdir -p "$PGDATA/$d"; done
    if [ -f "$PGDATA/postmaster.pid" ] && ! kill -0 "$(head -1 "$PGDATA/postmaster.pid")" 2>/dev/null; then rm -f "$PGDATA/postmaster.pid"; fi
    "$BIN/pg_ctl" -D "$PGDATA" -l "$LOG" start ;;
  stop) "$BIN/pg_ctl" -D "$PGDATA" stop -m fast ;;
  status) "$BIN/pg_ctl" -D "$PGDATA" status ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac

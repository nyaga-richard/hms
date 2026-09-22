#!/usr/bin/env bash
# Refresh the compact development snapshot (data/dev-snapshot.dump) from the local `hms` database.
# The dump (custom format, compressed, < 1 MB) is what survives sandbox resets; the raw cluster does not.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=${PGBIN:-/usr/lib/postgresql/17/bin}
mkdir -p "$ROOT/data"
"$BIN/pg_dump" -h 127.0.0.1 -U hms -Fc -Z 9 -f "$ROOT/data/dev-snapshot.dump" hms
ls -la "$ROOT/data/dev-snapshot.dump"

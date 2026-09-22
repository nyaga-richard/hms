#!/usr/bin/env bash
# One-shot local (non-Docker) bring-up for development sandboxes:
#   PostgreSQL cluster (.cache/pgdata) -> role + databases -> data (restore data/dev-snapshot.dump, else migrate+seed)
#   -> npm dependencies. Servers are started separately (npm run dev:backend / dev:frontend).
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
BIN=${PGBIN:-/usr/lib/postgresql/17/bin}
PGDATA=${PGDATA:-$ROOT/.cache/pgdata}
SNAPSHOT=${SNAPSHOT:-$ROOT/data/dev-snapshot.dump}
export PGHOST=127.0.0.1

if [ ! -x "$BIN/pg_ctl" ]; then
  echo "PostgreSQL 17 binaries not found at $BIN — installing (Debian/Ubuntu)…"
  sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-17 postgresql-client-17 >/dev/null
  sudo systemctl stop postgresql 2>/dev/null || true
  sudo pkill -f "postgresql/17/bin/postgres -D /var/lib" 2>/dev/null || true
fi

FRESH=0
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "Initialising local PostgreSQL cluster at $PGDATA…"
  mkdir -p "$PGDATA"
  mkdir -p "$ROOT/.cache/pgrun"
  "$BIN/initdb" -D "$PGDATA" -U postgres --auth=trust -c "unix_socket_directories=$ROOT/.cache/pgrun" -c "listen_addresses=127.0.0.1" >/dev/null
  FRESH=1
fi
if ! "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  "$ROOT/scripts/dev-pg.sh" start
  for i in $(seq 1 20); do "$BIN/pg_isready" -h 127.0.0.1 -q && break; sleep 0.5; done
fi

psql -U postgres -Atc "SELECT 1 FROM pg_roles WHERE rolname='hms'" | grep -q 1 || psql -U postgres -qc "CREATE ROLE hms LOGIN PASSWORD 'hms_dev_password'"
for db in hms hms_test; do
  psql -U postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || psql -U postgres -qc "CREATE DATABASE $db OWNER hms"
done

[ -f .env ] || cp .env.example .env
[ -d node_modules/next ] || npm install --no-audit --no-fund

if [ "$FRESH" = 1 ] || [ "$(psql -U hms hms -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = "0" ]; then
  if [ -f "$SNAPSHOT" ]; then
    echo "Restoring development snapshot $SNAPSHOT…"
    "$BIN/pg_restore" -U hms -d hms --no-owner --role=hms "$SNAPSHOT"
  else
    echo "No snapshot found — running migrations + demo seed…"
    npm run migrate && npm run seed
  fi
fi
echo "Ready.  API:  npm run dev:backend     UI:  npm run dev:frontend     (admin / Password123)"

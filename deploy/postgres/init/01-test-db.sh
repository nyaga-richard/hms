#!/bin/sh
# Runs once on first cluster initialisation: create the test database used by `npm test`.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  SELECT 'CREATE DATABASE hms_test OWNER hms' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hms_test')\gexec
SQL

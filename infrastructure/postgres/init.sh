#!/bin/sh
# Runs once on first start of an empty data volume. Each service gets its own database AND its own login role that
# can reach only that database, so a compromised service cannot read another service's data.
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set (hex only: openssl rand -hex 24)}"
for svc in users products inventory orders payments notifications; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE ${svc}_svc LOGIN PASSWORD '${APP_DB_PASSWORD}';
CREATE DATABASE ${svc} OWNER ${svc}_svc;
REVOKE ALL ON DATABASE ${svc} FROM PUBLIC;
SQL
done

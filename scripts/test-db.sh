#!/usr/bin/env sh
# Creates <service>_test databases and applies each service's SQL migrations (what `prisma migrate deploy` applies).
# Uses the standard PG* variables; defaults match docker-compose / CI.
set -eu
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for dir in "$ROOT"/apps/*/prisma/migrations; do
  [ -d "$dir" ] || continue
  ls "$dir"/*/migration.sql >/dev/null 2>&1 || continue
  svc="$(basename "$(dirname "$(dirname "$dir")")" | sed 's/-service$//')"
  # <svc>_test is used by each service's own tests; saga_<svc> by the cross-service saga tests.
  for db in "${svc}_test" "saga_${svc}"; do
    psql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" -c "CREATE DATABASE ${db}"
    for f in "$dir"/*/migration.sql; do
      psql -v ON_ERROR_STOP=1 -q -d "$db" -f "$f"
    done
    echo "prepared ${db}"
  done
done

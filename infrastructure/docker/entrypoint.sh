#!/bin/sh
set -eu
# Apply this service's migrations before starting. Safe to run from several replicas at once: Prisma takes an
# advisory lock. Set RUN_MIGRATIONS=false when migrations are run as a separate release step instead.
if [ "${RUN_MIGRATIONS:-true}" = "true" ] && [ -f prisma/schema.prisma ]; then
  node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
fi
exec node dist/index.js

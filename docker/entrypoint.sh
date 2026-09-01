#!/bin/sh
set -e

echo "[entrypoint] Starting Simmetric Chat (single-container / standalone mode)..."
echo "[entrypoint] Node version: $(node --version)"
echo "[entrypoint] NODE_ENV: ${NODE_ENV:-production}"

# ─── Production secret provisioning (Phase 162/163 parity) ─────────────
# Parity with docker/entrypoint-server.sh: in standalone production the
# server fail-louds on unset ENCRYPTION_KEY (Phase 162) and the widget API
# key auto-seed HMACs with API_KEY_HMAC_SECRET (Phase 163). Provision both
# BEFORE prisma/migrations, sourced from the same helper the split image
# uses — operator env wins, then persisted /app/storage values, else
# generate-once + persist with the loud backup warning.
if [ "${NODE_ENV:-production}" = "production" ]; then
  . /app/provision-encryption-key.sh /app/storage
  if [ -z "${ENCRYPTION_KEY:-}" ]; then
    echo "ERROR: ENCRYPTION_KEY could not be provisioned — refusing to boot; see docs/ENCRYPTION_KEY_ROTATION.md" >&2
    exit 1
  fi
  if [ -z "${API_KEY_HMAC_SECRET:-}" ]; then
    echo "ERROR: API_KEY_HMAC_SECRET could not be provisioned — refusing to boot" >&2
    exit 1
  fi
fi

# Initialize PostgreSQL data directory if empty
if [ ! -f /var/lib/postgresql/data/PG_VERSION ]; then
  echo "[entrypoint] Initializing PostgreSQL data directory..."
  initdb -D /var/lib/postgresql/data -U "${POSTGRES_USER:-simmetricchat}" --auth-host=md5 --auth-local=trust
  echo "host all all 127.0.0.1/32 md5" >> /var/lib/postgresql/data/pg_hba.conf
  echo "host all all ::1/128 md5" >> /var/lib/postgresql/data/pg_hba.conf
fi

# Start PostgreSQL in background (it will be managed by supervisord later,
# but we need it for Prisma migrations which run before supervisord starts)
echo "[entrypoint] Starting PostgreSQL for migrations..."
pg_ctl -D /var/lib/postgresql/data -l /tmp/pg-init.log -o "-c listen_addresses=localhost" start
until pg_isready -U "${POSTGRES_USER:-simmetricchat}" -d "${POSTGRES_DB:-simmetricchat}" > /dev/null 2>&1; do
  echo "[entrypoint] Waiting for PostgreSQL to be ready..."
  sleep 1
done
echo "[entrypoint] PostgreSQL is ready."

# Create database if it doesn't exist
POSTGRES_DB="${POSTGRES_DB:-simmetricchat}"
POSTGRES_USER="${POSTGRES_USER:-simmetricchat}"
PGPASSWORD="${POSTGRES_PASSWORD:-simmetricchat}" psql -U "$POSTGRES_USER" -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB'" | grep -q 1 \
  || createdb -U "$POSTGRES_USER" "$POSTGRES_DB"

# Run Prisma client generation and migrations
if [ -n "$DATABASE_URL" ]; then
  echo "[entrypoint] Generating Prisma client..."
  cd /app/packages/server
  npx prisma generate
  node scripts/fix-prisma-pnpm.cjs 2>/dev/null || true
  echo "[entrypoint] Running database migrations..."
  npx prisma migrate deploy
  cd /app
fi

# Stop PostgreSQL so supervisord can take over
echo "[entrypoint] Stopping temporary PostgreSQL..."
pg_ctl -D /var/lib/postgresql/data stop
sleep 2

# Start all services via supervisord
echo "[entrypoint] Launching all services via supervisord..."
echo "[entrypoint] Services: postgres, server (:${SERVER_PORT:-3000}), collector (:${COLLECTOR_PORT:-3210}), widget (:${WIDGET_PORT:-3211})"
exec supervisord -c /etc/supervisord.conf

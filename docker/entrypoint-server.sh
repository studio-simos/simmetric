#!/bin/sh
set -e

# ─── Production secret provisioning ────────────────────────────────────
# Phase 162 hard-default (ENCRYPTION_KEY) + Phase 163 HMAC (API key auto-seed):
# the server fails when these secrets are unset in production. Provision both
# BEFORE any prisma step (generate/migrate/seed) so a missing or corrupt key
# fails fast here instead of repeating the whole cycle on every restart of
# the crash loop.
#
# Sourcing exports ENCRYPTION_KEY + API_KEY_HMAC_SECRET for the final
# `exec node ...`:
#   - operator-supplied values (env / env_file ../.env) always win
#   - otherwise values are restored from /app/storage/ (server-storage volume)
#   - else generated once + persisted (loud backup warning on first boot)
# Dev (docker-compose.dev.yml sets NODE_ENV=development) skips provisioning
# entirely — dev keeps the scrypt fallback (Phase 162 D-03).
if [ "${NODE_ENV:-production}" = "production" ]; then
  . /app/provision-encryption-key.sh /app/storage
  if [ -z "${ENCRYPTION_KEY:-}" ]; then
    echo "ERROR: ENCRYPTION_KEY could not be provisioned — refusing to run migrations/boot; see docs/ENCRYPTION_KEY_ROTATION.md" >&2
    exit 1
  fi
  if [ -z "${API_KEY_HMAC_SECRET:-}" ]; then
    echo "ERROR: API_KEY_HMAC_SECRET could not be provisioned — refusing to run migrations/boot" >&2
    exit 1
  fi
fi

echo "[entrypoint-server] Generating Prisma client..."
cd /app/packages/server
npx prisma generate
node scripts/fix-prisma-pnpm.cjs
echo "[entrypoint-server] Running Prisma migrations..."
npx prisma migrate deploy
echo "[entrypoint-server] Seeding default data..."
npx prisma db seed || echo "[entrypoint-server] WARNING: Seed failed, continuing boot. The app may work with existing data."
cd /app

echo "[entrypoint-server] Starting Simmetric Chat server on port ${SERVER_PORT:-3000}..."
exec node packages/server/dist/index.js
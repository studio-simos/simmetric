-- =============================================================================
-- Phase 163 (Keyed-HMAC API Keys — SCALE-03, CC-02 documented exception).
-- DESTRUCTIVE — drops the bcrypt `hashedKey` column and adds the HMAC-SHA256
-- `key_hash` column. Bcrypt hashes CANNOT convert to HMAC digests (different
-- algorithms), so all existing api_keys rows are invalidated by design (D-02).
-- The operator re-issues keys per the KEY-03 runbook (docs/API_KEY_MIGRATION.md,
-- created in Plan 02). The widget service-account key is re-seeded by
-- seedService.seedWidgetApiKey on the next boot (D-04).
--
-- This is the ONE documented additive-only exception (CC-02 in REQUIREMENTS.md,
-- case #2 from docs/MIGRATION_SAFETY.md:93 — schema refactor with explicit
-- consent + runbook). `pnpm audit:migrations` classifies it as destructive
-- (DROP COLUMN regex); CI's migration-safety-check job blocks the PR unless
-- PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION is set as a GitHub repo Variable.
-- =============================================================================

-- Drop the bcrypt column (its unique index is dropped automatically by Postgres
-- when the column goes away).
ALTER TABLE "api_keys" DROP COLUMN "hashedKey";

-- Existing rows are invalidated by design (D-02): their bcrypt hashes are gone
-- (dropped above) and cannot be converted to HMAC digests. Delete them so the
-- NOT NULL column can be added without a default. The widget service-account
-- key is re-seeded by seedService.seedWidgetApiKey on the next boot (D-04);
-- user-created admin keys are re-issued via the admin UI (KEY-03 runbook).
DELETE FROM "api_keys";

-- Add the HMAC-SHA256 hex digest column (64 chars). NOT NULL — every row must
-- carry a digest. The table is small (service accounts + admin keys); the
-- widget key is re-seeded on next boot, user-created admin keys are re-issued
-- via the admin UI. No backfill is possible (bcrypt hashes are irreversible
-- and use a different algorithm than HMAC).
ALTER TABLE "api_keys" ADD COLUMN "key_hash" TEXT NOT NULL;

-- Create the unique index backing the @unique constraint on key_hash. This is
-- the O(1) constant-time lookup index that validateApiKey's findUnique uses.
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
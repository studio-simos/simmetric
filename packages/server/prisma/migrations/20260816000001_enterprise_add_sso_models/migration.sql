-- =============================================================================
-- Phase 143 (SSO Extraction — EPA-03) enterprise SSO models migration
-- D-05: idempotent (CREATE TABLE IF NOT EXISTS)
-- =============================================================================
--
-- This migration is the enterprise companion to the `schema-enterprise.prisma`
-- Prisma fragment (D-04). The three SSO tables (`sso_configs`,
-- `identity_providers`, `scim_groups`) were originally created by the squashed
-- baseline `00000000000000_init`. Per D-06, that baseline migration is LEFT
-- UNTOUCHED — it already creates these tables for every install that has run
-- it.
--
-- Idempotency contract (D-05):
--   - EXISTING installs (already ran the baseline): every statement below is
--     a no-op. `CREATE TABLE IF NOT EXISTS` skips tables that already exist;
--     `CREATE UNIQUE INDEX IF NOT EXISTS` skips indexes that already exist;
--     the foreign-key constraint is added inside a `DO $$ ... END $$` block
--     guarded by a `pg_constraint` existence check (Postgres has no
--     `ADD CONSTRAINT IF NOT EXISTS` syntax).
--   - FRESH installs (pristine DB): the baseline `00000000000000_init` runs
--     FIRST and creates these tables; this migration then runs and is a
--     no-op for the same reason. The `IF NOT EXISTS` clauses make the order
--     irrelevant — even if this migration ran before the baseline, it would
--     create the tables and the baseline's `CREATE TABLE` would then skip
--     them (the baseline is NOT `IF NOT EXISTS`, but it runs first by
--     filename sort, so the fresh path is baseline-then-enterprise).
--
-- The `audit:migrations` scanner classifies this migration as `additive`
-- (no destructive operations: no DROP, no ALTER TABLE ... DROP COLUMN,
-- no TRUNCATE). The DDL is byte-equivalent to the baseline's three
-- CreateTable blocks + two unique indexes + one FK constraint.
--
-- Table names match the `@@map` directives in `schema-enterprise.prisma`
-- (and previously in `schema.prisma`) — the generated Prisma client reads
-- the same physical tables. No data migration.
-- =============================================================================

-- CreateTable (sso_configs) — singleton SSO configuration row.
-- The `clientSecretEncrypted` column stores the AES-256-GCM ciphertext
-- ("iv:authTag:ciphertext"); never plaintext (T-113-01-01).
CREATE TABLE IF NOT EXISTS "sso_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "clientSecretEncrypted" TEXT,
    "discoveryUrl" TEXT,
    "entryPoint" TEXT,
    "cert" TEXT,
    "entityId" TEXT,
    "redirectUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable (identity_providers) — external IdP link per user.
-- One row per (provider, providerUserId); user deletion cascades their IdP
-- links (onDelete: Cascade — D-03).
CREATE TABLE IF NOT EXISTS "identity_providers" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable (scim_groups) — SCIM-provisioned groups (IdP-managed lifecycle,
-- hard-deleted by design).
CREATE TABLE IF NOT EXISTS "scim_groups" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "members" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — unique (provider, providerUserId) on identity_providers.
CREATE UNIQUE INDEX IF NOT EXISTS "identity_providers_provider_providerUserId_key"
    ON "identity_providers"("provider", "providerUserId");

-- CreateIndex — unique externalId on scim_groups.
CREATE UNIQUE INDEX IF NOT EXISTS "scim_groups_externalId_key"
    ON "scim_groups"("externalId");

-- AddForeignKey — identity_providers.userId → users.id ON DELETE CASCADE.
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; guard with a DO block +
-- pg_constraint lookup (D-05 idempotency).
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'identity_providers_userId_fkey'
    ) THEN
        ALTER TABLE "identity_providers"
            ADD CONSTRAINT "identity_providers_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
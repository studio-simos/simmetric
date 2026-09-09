-- Phase 182 M1 (SAAS-01a): create tenancy root + default-org INSERT — additive-only per audit gate
--
-- SAAS-01a: the default org lives INSIDE this migration (NOT the seed) because
-- docker/entrypoint-server.sh runs `migrate deploy` → `db seed` with seed-failure
-- TOLERATED (`|| echo WARNING`) — a fresh install must never boot org-less.
-- Bare `ON CONFLICT DO NOTHING` covers both conflict surfaces (id PK + slug unique)
-- — idempotent re-run, and a no-op on air-gap upgrades that already carry the row.
--
-- Additive-only: CREATE TABLE ×2, CREATE INDEX ×4, INSERT ×1. No ALTER, no drops.
-- No ADD COLUMN here (Pitfall 1 discipline: create/widen/backfill/tighten are
-- separate migrations — M2 owns the column adds).
--
-- The DEFAULT_ORG_ID literal mirrors packages/shared/src/constants/organization.ts
-- (migrations are raw SQL artifacts — the shared constant is for TS code; the
-- literal is allowed here per the repo debt-table rule: migrations/seed/fixtures).

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleInOrg" TEXT NOT NULL DEFAULT 'member', -- owner | admin | member (enum-as-string, research A8)
    "deletedAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");

-- CreateIndex
CREATE INDEX "organization_members_organizationId_idx" ON "organization_members"("organizationId");

-- CreateIndex
-- Partial unique (D-05 spike verdict: object `where: { deletedAt: null }` syntax accepted
-- by prisma validate/generate on 7.10.0 — Plan 01 confirmed this branch). Soft-deleted
-- rows (tombstones) free the (organizationId, userId) slot so a member can be re-added
-- (P2002 tombstone class). Index name is M4-swap-stable (Plan 01 landed the partial
-- variant, so M4 omits the swap pair entirely).
CREATE UNIQUE INDEX "organization_members_organizationId_userId_key" ON "organization_members"("organizationId", "userId") WHERE ("deletedAt" IS NULL);

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The locked default org — INSIDE the migration, NOT the seed (SAAS-01a).
-- id: DEFAULT_ORG_ID (00000000-0000-0000-0000-000000000000), name 'Default',
-- slug 'default', plan 'free'. Bare ON CONFLICT covers id PK + slug unique.
INSERT INTO "organizations" ("id","name","slug","plan","updatedAt")
VALUES ('00000000-0000-0000-0000-000000000000', 'Default', 'default', 'free', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
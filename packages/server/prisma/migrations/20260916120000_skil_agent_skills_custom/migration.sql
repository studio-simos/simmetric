-- Phase 190 (SKIL-01 D-02): AgentSkill wakes — additive columns for custom
-- prompt-template skills (TODO/CUSTOM_SKILLS_SPEC.md §2.2). Additive-only:
-- every added column is nullable or carries a default, so there is NO
-- UPDATE/INSERT/DELETE backfill arm (Prisma generated none — the statement
-- set below is verbatim from `prisma migrate diff --from-migrations`).
--
-- Zero-rows rationale (RESEARCH Runtime State Inventory): the agent_skills
-- table is DORMANT — zero rows in every deployment (no runtime writer existed
-- before this phase; verified by grep + psql count on the dev DB), so
--   - "slug" TEXT NOT NULL (no default) is safe without a backfill;
--   - the partial unique index (WHERE "deletedAt" IS NULL) cannot collide.
--
-- Statements: ALTER TABLE ADD COLUMN ×10, CREATE INDEX ×2 (one partial unique
-- per Pitfall 4 — tombstones free the slug; OrganizationMember precedent),
-- ADD CONSTRAINT (FK) ×3. No INSERT/UPDATE/DELETE/DROP/TRUNCATE.
--
-- organizationId: tenancy seam (v0.24 M2 convention) with the DEFAULT_ORG_ID
-- literal mirroring packages/shared/src/constants/organization.ts.

-- AlterTable
ALTER TABLE "agent_skills" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "inputSchema" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN     "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "organizationId" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
ADD COLUMN     "skillMode" TEXT NOT NULL DEFAULT 'prompt',
ADD COLUMN     "slug" TEXT NOT NULL,
ADD COLUMN     "userId" TEXT,
ADD COLUMN     "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX "agent_skills_organizationId_idx" ON "agent_skills"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_skills_slug_key" ON "agent_skills"("slug") WHERE ("deletedAt" IS NULL);

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
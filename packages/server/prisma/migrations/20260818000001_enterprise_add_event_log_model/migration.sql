-- =============================================================================
-- Phase 144 (Audit Log Extraction — EPA-04) enterprise event_logs model
-- migration
-- D-04: idempotent (CREATE TABLE IF NOT EXISTS) — mirrors the Phase 143
-- SSO migration pattern.
-- =============================================================================
--
-- This migration is the enterprise companion to the `EventLog` model in
-- `schema-enterprise.prisma` (D-03). The `event_logs` table was originally
-- created by the squashed baseline `00000000000000_init` (lines 312-321 +
-- indexes at lines 882/885). Per D-04, that baseline migration is LEFT
-- UNTOUCHED — it already creates this table for every install that has run
-- it.
--
-- Idempotency contract (D-04):
--   - EXISTING installs (already ran the baseline): every statement below is
--     a no-op. `CREATE TABLE IF NOT EXISTS` skips the table that already
--     exists; `CREATE INDEX IF NOT EXISTS` skips indexes that already exist.
--   - FRESH installs (pristine DB): the baseline `00000000000000_init` runs
--     FIRST and creates the `event_logs` table + its two indexes + the
--     `event_logs_userId_fkey` FK constraint; this migration then runs and
--     is a no-op for the same reason. The `IF NOT EXISTS` clauses make the
--     order irrelevant — even if this migration ran before the baseline, it
--     would create the table and the baseline's `CREATE TABLE` would then
--     skip it (the baseline is NOT `IF NOT EXISTS`, but it runs first by
--     filename sort, so the fresh path is baseline-then-enterprise).
--
-- The `audit:migrations` scanner classifies this migration as `additive`
-- (no destructive operations: no DROP, no ALTER TABLE ... DROP COLUMN,
-- no TRUNCATE, no DELETE). The DDL is byte-equivalent to the baseline's
-- `event_logs` CreateTable block + two indexes. No FK constraint is
-- re-declared here — the baseline already created `event_logs_userId_fkey`
-- (line 1065), and `ADD CONSTRAINT IF NOT EXISTS` is not universally
-- supported; re-adding it would fail on existing installs. The Prisma
-- `User.eventLogs` back-relation resolves at `prisma generate` time
-- (cross-fragment relation — Phase 141 verdict (a), Phase 143 precedent).
--
-- Table name matches the `@@map("event_logs")` directive in
-- `schema-enterprise.prisma` — the generated Prisma client reads the same
-- physical table. No data migration.
-- =============================================================================

-- CreateTable (event_logs) — the immutable audit log table.
-- See D-05 (the companion migration `20260818000002_enterprise_event_logs_insert_only_grant`)
-- for the INSERT-only grant that enforces append-only semantics at the DB
-- level (SC-4).
CREATE TABLE IF NOT EXISTS "event_logs" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — composite (entityType, entityId) for entity-scoped queries.
CREATE INDEX IF NOT EXISTS "event_logs_entityType_entityId_idx"
    ON "event_logs"("entityType", "entityId");

-- CreateIndex — userId for user-scoped queries (admin viewer filters).
CREATE INDEX IF NOT EXISTS "event_logs_userId_idx"
    ON "event_logs"("userId");
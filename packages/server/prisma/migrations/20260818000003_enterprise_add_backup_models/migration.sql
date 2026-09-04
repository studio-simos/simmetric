-- =============================================================================
-- Phase 146 (Backup Extraction — EPA-06) enterprise backup models migration
-- D-12: idempotent (CREATE TABLE IF NOT EXISTS) — mirrors the Phase 143 SSO
-- + Phase 144 event_logs migration pattern.
-- =============================================================================
--
-- This migration is the enterprise companion to the 3 backup models
-- (`BackupDestination`, `BackupJob`, `BackupLog`) moved from `schema.prisma`
-- to `schema-enterprise.prisma` (D-11). The `backup_destinations`,
-- `backup_jobs`, and `backup_logs` tables were originally created by the
-- squashed baseline `00000000000000_init` (lines 698-753 + the index at
-- line 972 + FK constraints at lines 1152-1164). Per D-12, that baseline
-- migration is LEFT UNTOUCHED — it already creates these tables for every
-- install that has run it.
--
-- Idempotency contract (D-12):
--   - EXISTING installs (already ran the baseline): every statement below is
--     a no-op. `CREATE TABLE IF NOT EXISTS` skips tables that already exist;
--     `CREATE INDEX IF NOT EXISTS` skips indexes that already exist.
--   - FRESH installs (pristine DB): the baseline `00000000000000_init` runs
--     FIRST and creates the 3 backup tables + their index + FK constraints;
--     this migration then runs and is a no-op for the same reason. The
--     `IF NOT EXISTS` clauses make the order irrelevant.
--
-- The `audit:migrations` scanner classifies this migration as `additive`
-- (no destructive operations: no DROP, no ALTER TABLE ... DROP COLUMN,
-- no TRUNCATE, no DELETE). The DDL is byte-equivalent to the baseline's
-- CreateTable blocks. No FK constraint is re-declared here — the baseline
-- already created `backup_destinations_createdBy_fkey`,
-- `backup_jobs_destinationId_fkey`, `backup_logs_destinationId_fkey`,
-- `backup_logs_jobId_fkey`, and `backup_logs_restoredBy_fkey`, and
-- `ADD CONSTRAINT IF NOT EXISTS` is not universally supported; re-adding
-- would fail on existing installs. The Prisma `User.backupDestinations` +
-- `User.restoredBackups` back-relations resolve at `prisma generate` time
-- (cross-fragment relation — Phase 141 verdict (a), Phase 143/144 precedent).
--
-- Table names match the `@@map` directives in `schema-enterprise.prisma` —
-- the generated Prisma client reads the same physical tables. No data
-- migration.
-- =============================================================================

-- CreateTable (backup_destinations) — encrypted-config backup target.
CREATE TABLE IF NOT EXISTS "backup_destinations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "lastTestedAt" TIMESTAMP(3),
    "lastTestError" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable (backup_jobs) — scheduled backup job definition.
CREATE TABLE IF NOT EXISTS "backup_jobs" (
    "id" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "cronExpression" TEXT,
    "time" TEXT,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable (backup_logs) — per-run backup log (status: running|success|failed|restored).
CREATE TABLE IF NOT EXISTS "backup_logs" (
    "id" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "jobId" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "checksum" TEXT,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restoredAt" TIMESTAMP(3),
    "restoredBy" TEXT,

    CONSTRAINT "backup_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — composite (destinationId, createdAt) for destination-scoped log queries.
CREATE INDEX IF NOT EXISTS "backup_logs_destinationId_createdAt_idx"
    ON "backup_logs"("destinationId", "createdAt");
/*
  Warnings: (none — 204-03 removed the generated `memories.embedding SET
  NOT NULL` drift-repair arm, see below)

*/
-- Phase 195 (MCPO-01 D-01/D-02): MCPConnection OAuth columns — 8 additive
-- columns for the outbound OAuth 2.0 authorization-code flow (provider
-- registry + state/PKCE + token lifecycle land in the same phase). No DML:
-- every statement is ADD COLUMN (existing rows keep the neutral defaults
-- authType='none' / oauthStatus='none' — no backfill per D-02; nullable
-- columns stay NULL).
--
-- Phase 204-03 (D-04 evidence arm): the originally generated
-- `memories.embedding SET NOT NULL` trailing arm is REMOVED. It was the
-- Prisma-generated counterpart of the hand-authored 20260921110000 DROP NOT
-- NULL gate fix (Phase 194-02), intended as a no-op drift repair against the
-- then-drifted live DB (0 memories rows). But applied AFTER 20260921110000 in
-- every fresh migration chain (fresh template/CI/prod rebuilds), it
-- RE-TIGHTENED the column to NOT NULL, reintroducing the exact 23502 failure
-- 194-02 fixed — verified live 2026-09-23: a freshly migrated worker DB
-- reported embedding NOT NULL with 20260921110000 recorded applied. Schema
-- truth: schema.prisma declares `embedding Unsupported("vector(384)?")`
-- (nullable). Removing the arm realigns the chain with schema.prisma; the
-- dev-DB column is repaired environmentally (DROP NOT NULL) in the same
-- phase. Non-additive statement count change only in the already-applied
-- 20260922085410 dir per the D-09 environmental-repair clause (no NEW
-- migration directory).
--
-- WR-04 CHECKSUM NOTE (204-REVIEW): this file was edited AFTER it was
-- applied on dev/prod/CI-template DBs (recorded 2026-09-22). The edited
-- file's checksum no longer matches the one recorded in `_prisma_migrations`
-- on those environments — the next `prisma migrate deploy`/`migrate dev`
-- there FAILS LOUD with the modified-migration error. Reconcile via the
-- runbook in docs/MIGRATION_SAFETY.md ("Editing an Already-Applied
-- Migration"): `npx prisma migrate resolve --applied
-- 20260922085410_20260922000000_mcp_connection_oauth_columns` (metadata-only,
-- no SQL re-execution). Fresh chains are unaffected. Do NOT re-run this
-- file's SQL on a migrated environment (duplicate-column errors).
--
-- Statements: ALTER TABLE ADD COLUMN ×8.
-- No INSERT/UPDATE/DELETE/DROP/TRUNCATE.

-- AlterTable
ALTER TABLE "mcp_connections" ADD COLUMN     "authType" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "credentialsEncrypted" TEXT,
ADD COLUMN     "oauthClientId" TEXT,
ADD COLUMN     "oauthError" TEXT,
ADD COLUMN     "oauthProvider" TEXT,
ADD COLUMN     "oauthScopes" TEXT,
ADD COLUMN     "oauthStatus" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3);

-- =============================================================================
-- Phase 144 (Audit Log Extraction — EPA-04) INSERT-only grant migration
-- D-05 (SC-4 — the #1 immutability guarantee): creates a Postgres role with
-- ONLY INSERT on event_logs. UPDATE/DELETE on event_logs is IMPOSSIBLE for
-- this role — the DB enforces the immutability guarantee at the privilege
-- level, not in application code.
-- =============================================================================
--
-- The enterprise audit writer (`simmetric-enterprise/src/services/auditLogService.ts`)
-- connects as this role via a DEDICATED `pg.Pool` when `AUDIT_WRITER_PASSWORD`
-- is set (NOT `SET ROLE` on the Prisma connection — see 144-RESEARCH Finding 1:
-- `@prisma/adapter-pg` uses a pooled connection and `SET ROLE` does NOT
-- persist across pool checkouts; a subsequent query may run as the app role
-- with full privileges. The dedicated pool guarantees every query runs as
-- the INSERT-only role).
--
-- Idempotency contract (D-05):
--   - The `CREATE ROLE` is wrapped in a `DO $$ ... IF NOT EXISTS ... END $$`
--     block guarded by a `pg_roles` lookup — safe for existing DBs that
--     already have the role (no-op) and fresh DBs (creates it).
--   - `GRANT INSERT` is idempotent (re-granting a privilege you already have
--     is a no-op).
--   - `REVOKE UPDATE, DELETE` is idempotent (revoking a privilege that is
--     absent is a no-op). Belt-and-braces: protects against a future
--     migration accidentally granting UPDATE/DELETE to PUBLIC — this role
--     stays INSERT-only regardless.
--
-- The role is created WITHOUT a password (`CREATE ROLE simmetric_audit_writer
-- LOGIN;` — no `PASSWORD` clause). `prisma migrate deploy` does NOT
-- substitute env vars into SQL, so the password cannot be injected at
-- migration time. The admin sets the password via a separate documented
-- step in the enterprise README:
--   ALTER ROLE simmetric_audit_writer PASSWORD '<strong-password>';
-- The runtime enterprise writer reads `AUDIT_WRITER_PASSWORD` from env and
-- connects as this role. This keeps the migration env-agnostic.
--
-- The `audit:migrations` scanner classifies this migration as `additive`
-- (no destructive operations: no DROP, no ALTER TABLE ... DROP COLUMN,
-- no TRUNCATE, no DELETE. `CREATE ROLE`, `GRANT`, `REVOKE` are NOT in the
-- `DESTRUCTIVE_PATTERNS` allowlist at `packages/server/scripts/audit-migrations.ts:31-40`).
-- =============================================================================

-- Create the role WITHOUT a password (idempotent — DO block + pg_roles check).
-- The admin sets the password via a separate documented step:
--   ALTER ROLE simmetric_audit_writer PASSWORD '<strong-password>';
-- This keeps the migration env-agnostic (prisma migrate deploy does not
-- substitute env vars into SQL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simmetric_audit_writer') THEN
    CREATE ROLE simmetric_audit_writer LOGIN;
  END IF;
END $$;

-- Grant ONLY INSERT. The role cannot SELECT, UPDATE, or DELETE — every
-- query on the enterprise writer's dedicated pg.Pool is an INSERT.
GRANT INSERT ON "event_logs" TO simmetric_audit_writer;

-- Revoke UPDATE/DELETE (idempotent — they may not be granted; REVOKE is a
-- no-op if the privilege is absent). Belt-and-braces: even if a future
-- migration accidentally grants UPDATE/DELETE to PUBLIC, this role stays
-- INSERT-only.
REVOKE UPDATE, DELETE ON "event_logs" FROM simmetric_audit_writer;

-- NOTE: The app's default role (the one in DATABASE_URL) retains ALL
-- privileges on event_logs (it's the table owner per the baseline
-- migration). This is INTENTIONAL — the admin reader (GET /api/event-logs)
-- uses the default connection via ctx.prisma and needs SELECT. The
-- immutability guarantee applies ONLY to the simmetric_audit_writer role
-- (the write path). A future retention/purge mechanism would use a third
-- elevated role (simmetric_audit_admin with DELETE) — deferred per
-- CONTEXT.md.
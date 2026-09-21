-- Phase 189 (WSIS-01/02, D-24): additive workspace-access role machinery +
-- LDAP-pulled-forward assignment provenance. One migration, five columns:
--
--   workspace_access."role"        TEXT NOT NULL DEFAULT 'viewer'
--   workspace_access."grantedBy"   TEXT (nullable)
--   users."hasOnboarded"           BOOLEAN NOT NULL DEFAULT false
--   projects."isPersonal"          BOOLEAN NOT NULL DEFAULT false
--   user_roles."assignedVia"       TEXT NOT NULL DEFAULT 'manual'
--
-- Order is LOAD-BEARING for workspace_access."role" (Pitfall 1 — research):
-- ADD COLUMN ... NOT NULL DEFAULT 'viewer' fills every pre-existing row with
-- 'viewer', and a later guarded UPDATE WHERE "role" IS NULL can never match on
-- a NOT NULL DEFAULT column. The D-12 backfill must therefore run as an
-- UNCONDITIONAL UPDATE immediately after the ADD: every row present at
-- migration time predates role grading (enforcement was access-binary, not
-- role-graded), and pre-phase grants already permitted chat-create + upload —
-- defaulting them to 'viewer' would silently strip abilities the moment
-- enforcement flips (WSIS-04 lockout class, PITFALLS #8). D-12 deliberately
-- diverges from the spec §4 "viewer" suggestion. After this migration the
-- grant endpoint always writes role explicitly, so the unconditional UPDATE is
-- safe. grantedBy is added nullable WITHOUT a default — NULL marks legacy rows
-- (audit-distinguishable from admin-granted rows, D-12).
--
-- user_roles."assignedVia": NOT NULL DEFAULT 'manual' fills existing rows
-- implicitly; the guarded UPDATE is a harmless idempotent re-pin of the LDAP
-- §3.3 contract (Phase 193's sync guard deletes only assignedVia = 'ldap' rows;
-- legacy rows must read 'manual').
--
-- Booleans: additive with default false — zero behavior change for existing
-- rows. Personal workspaces are NEVER created here (D-01: lazy on-demand
-- provisioning only; no auto-created rows).
--
-- Additive-only: ALTER TABLE ADD COLUMN + guarded UPDATEs. Zero INSERT
-- statements, zero row-removal statements of any kind.

-- workspace_access: role (ADD before UPDATE — see header) + nullable grantedBy
ALTER TABLE "workspace_access" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'viewer';
UPDATE "workspace_access" SET "role" = 'editor';
ALTER TABLE "workspace_access" ADD COLUMN "grantedBy" TEXT;

-- user_roles: assignedVia (existing rows fill 'manual' implicitly; guarded
-- re-run is harmless per LDAP spec §3.3)
ALTER TABLE "user_roles" ADD COLUMN "assignedVia" TEXT NOT NULL DEFAULT 'manual';
UPDATE "user_roles" SET "assignedVia" = 'manual' WHERE "assignedVia" IS NULL;

-- users: onboarding state (D-03)
ALTER TABLE "users" ADD COLUMN "hasOnboarded" BOOLEAN NOT NULL DEFAULT false;

-- projects: explicit personal-workspace flag (D-02 — single source of truth
-- for the max_workspaces exemption; the name-convention sketch is rejected)
ALTER TABLE "projects" ADD COLUMN "isPersonal" BOOLEAN NOT NULL DEFAULT false;
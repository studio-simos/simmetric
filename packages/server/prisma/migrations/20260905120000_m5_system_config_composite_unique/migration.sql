-- Phase 183 M5 (SAAS-02): SystemConfig unique swap — scalar `key @unique` →
-- composite (organizationId, key) + the Pitfall-P1 partial unique (ADOPTED per
-- the Plan-03 blocking checkpoint; research recommendation) — additive-only
-- per audit gate.
--
-- Geometry after this migration:
--   1. Composite unique (organizationId, key) — two orgs can override the same
--      key (per-tenant config cascade, SAAS-02). NULL-org rows do NOT collide
--      under the composite (Postgres NULLs-distinct default).
--   2. Partial unique (key) WHERE organizationId IS NULL — restores DB-level
--      global-row uniqueness the composite cannot provide: without it, two
--      concurrent global-row creates of the same key both succeed with NO
--      P2002 (RESEARCH Pitfall P1, highest severity), silently opening the
--      TOCTOU window on the upsertSystemConfigRow helper's race backstop
--      (Phase 183-01). M1 partial-unique precedent; partialIndexes preview
--      flag enabled repo-wide since Phase 182-01 (D-05 spike verdict).
--
-- Why this lands compile-clean (zero call-site breakage): all ~27 former
-- `where: { key }` sites (systemConfigService, routes ×4, builtinSkills,
-- seed.ts, routes/system wizard tx, both operator scripts) were migrated to
-- find-first-then-write in Phase 183 Plans 01/02 (upsertSystemConfigRow
-- helper + inline script shape) — Plans 01/02 typecheck sweeps prove the
-- swap needs zero production edits. The generated compound input
-- SystemConfigOrganizationIdKeyCompoundUniqueInput = { organizationId: string;
-- key: string } accepts NO null member (research Q2 verdict confirmed on
-- 7.10.0), so find-first-then-write stays the sanctioned global-row path.
--
-- Constraint swaps (plain, NO CONCURRENTLY — Prisma transactional migrations
-- cannot carry it; air-gap traffic profile acceptable per the M4 precedent):
-- system_config is a small table (tens of rows) — deploy-window lock is
-- negligible (T-183-06 accepted).
--
-- DROP INDEX is whitelisted additive by the audit gate's pattern-4 lookahead
-- (audit-migrations.ts:36-39) — data is never lost (M4 DlpPattern swap
-- precedent :136-137).

-- Scalar unique drop (D-08 one-way swap; rollback requires a second migration).
DROP INDEX "system_config_key_key";

-- Composite unique: per-org override coexistence (org-a and org-b can both
-- override LLM_PROVIDER); duplicate org-row inserts raise P2002.
CREATE UNIQUE INDEX "system_config_organizationId_key_key" ON "system_config"("organizationId","key");

-- Partial unique: global rows (organizationId IS NULL) are unique on key —
-- duplicate global inserts raise P2002, restoring the helper's race backstop.
CREATE UNIQUE INDEX "system_config_key_key_null_org" ON "system_config"("key") WHERE "organizationId" IS NULL;
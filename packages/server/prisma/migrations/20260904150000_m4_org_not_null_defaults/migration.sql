-- Phase 182 M4 (SAAS-01b): tighten NOT NULL + SET DEFAULT ×26 + the one DlpPattern unique swap — additive-only per audit gate
--
-- Per table (26 = 25 standard promise-list tables + backup_destinations;
-- system_config EXCLUDED from BOTH statements — Plan 01 declares its column
-- nullable with NO default, so adding either here would contradict the schema
-- and self-trigger the migrate-dev drift STOP; its NULL-org rows are the
-- Tier A′ global-row substrate, Phase 183's swap deferral keeps the scalar
-- `key @unique` byte-identical):
--   1. SET NOT NULL — full-table validation scan per table, one at a time
--      (T-182-05 mitigation; Postgres skips the scan when a CHECK proves
--      no NULLs — the M3 guarantee is what makes this scan cheap).
--   2. SET DEFAULT '00000000-0000-0000-0000-000000000000' — the compile-blast-
--      radius mitigation (research Pitfall 4): raw-SQL INSERTs without the org
--      column keep working, mirroring the Prisma-level @default so the ~250
--      create() call sites typecheck unchanged.
--
-- Constraint swaps (plain, NO CONCURRENTLY — Prisma transactional migrations
-- cannot carry it; air-gap traffic profile acceptable per Pitfall 3 carve-out):
--   - DlpPattern: `name @unique` → composite (organizationId, name) — the ONLY
--     existing-unique rewrite of the phase (D-06 freeze). The SystemConfig swap
--     is DEFERRED to Phase 183 — no system_config DROP INDEX here.
--   - OrganizationMember partial swap: OMITTED — M1 already emitted the partial
--     variant (Plan 01 D-05 spike verdict: where: { deletedAt: null } accepted),
--     so the swap pair is a name-stable no-op.
--
-- DROP INDEX is whitelisted additive by the audit gate's pattern-4 lookahead
-- (audit-migrations.ts:36-39) — data is never lost.

-- projects
ALTER TABLE "projects" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- workspaces
ALTER TABLE "workspaces" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "workspaces" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- workspace_access
ALTER TABLE "workspace_access" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "workspace_access" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- project_access
ALTER TABLE "project_access" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "project_access" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- providers
ALTER TABLE "providers" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "providers" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- provider_models
ALTER TABLE "provider_models" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "provider_models" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- archives
ALTER TABLE "archives" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "archives" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- widgets
ALTER TABLE "widgets" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "widgets" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- widget_workspaces
ALTER TABLE "widget_workspaces" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "widget_workspaces" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- workspace_templates
ALTER TABLE "workspace_templates" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "workspace_templates" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- dlp_patterns
ALTER TABLE "dlp_patterns" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "dlp_patterns" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- webhooks
ALTER TABLE "webhooks" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "webhooks" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- workspace_token_usage
ALTER TABLE "workspace_token_usage" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "workspace_token_usage" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- api_keys
ALTER TABLE "api_keys" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "api_keys" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- workspace_agent_configs
ALTER TABLE "workspace_agent_configs" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "workspace_agent_configs" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- chats
ALTER TABLE "chats" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "chats" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- chat_folders
ALTER TABLE "chat_folders" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "chat_folders" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- chat_messages
ALTER TABLE "chat_messages" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "chat_messages" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- documents
ALTER TABLE "documents" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- upload_drafts
ALTER TABLE "upload_drafts" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "upload_drafts" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- ocr_jobs
ALTER TABLE "ocr_jobs" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "ocr_jobs" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- archive_import_jobs
ALTER TABLE "archive_import_jobs" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "archive_import_jobs" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- synthesis_runs
ALTER TABLE "synthesis_runs" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "synthesis_runs" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- mcp_connections
ALTER TABLE "mcp_connections" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "mcp_connections" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- push_subscriptions
ALTER TABLE "push_subscriptions" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "push_subscriptions" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- backup_destinations (enterprise fragment)
ALTER TABLE "backup_destinations" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "backup_destinations" ALTER COLUMN "organizationId" SET DEFAULT '00000000-0000-0000-0000-000000000000';

-- The ONE unique swap: DlpPattern name → (organizationId, name) composite.
-- Two orgs can now define same-named patterns; built-in seeds pin to the
-- default org via M3.
DROP INDEX "dlp_patterns_name_key";
CREATE UNIQUE INDEX "dlp_patterns_organizationId_name_key" ON "dlp_patterns"("organizationId","name");
-- Phase 182 M2 (SAAS-01b): add organizationId column + FK + index ×27 — additive-only per audit gate
--
-- Per-table statement order (one block per table, lock-timeout attribution per-table,
-- Pitfall 1 discipline): ADD COLUMN (metadata-only in PG, no rewrite) → ADD CONSTRAINT
-- FK without NOT NULL (defers the full-table FK validation scan to M4) → CREATE INDEX.
-- No SET DEFAULT / SET NOT NULL here (both land in M4 with the M3 guarantee in place).
--
-- FK policy: ON DELETE RESTRICT (soft-delete norm — an org is never hard-deleted while
-- children exist; no cascade of tenant data, D-04). ON UPDATE CASCADE.
--
-- 27 tables = 26 community promise-list tables + backup_destinations (enterprise
-- fragment — Plan 01 declares the column there; this migration migrates it too or
-- `prisma migrate dev` proposes a drift migration). system_config is INCLUDED for
-- the column/FK/index but its column stays NULLABLE — Tier A′ global-row substrate
-- (no SET NOT NULL, no SET DEFAULT, no backfill in M3, per the Phase 183 deferral).
--
-- workspace_token_usage additionally gets the composite (organizationId, createdAt)
-- index matching Plan 01's @@index([organizationId, createdAt]).
-- workspace_access / project_access / widget_workspaces keep their composite PKs —
-- column + FK + index only, no unique change.

-- projects
ALTER TABLE "projects" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "projects" ADD CONSTRAINT "projects_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "projects_organizationId_idx" ON "projects"("organizationId");

-- workspaces
ALTER TABLE "workspaces" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "workspaces_organizationId_idx" ON "workspaces"("organizationId");

-- workspace_access
ALTER TABLE "workspace_access" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "workspace_access" ADD CONSTRAINT "workspace_access_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "workspace_access_organizationId_idx" ON "workspace_access"("organizationId");

-- project_access
ALTER TABLE "project_access" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "project_access_organizationId_idx" ON "project_access"("organizationId");

-- providers
ALTER TABLE "providers" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "providers" ADD CONSTRAINT "providers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "providers_organizationId_idx" ON "providers"("organizationId");

-- provider_models
ALTER TABLE "provider_models" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "provider_models_organizationId_idx" ON "provider_models"("organizationId");

-- archives
ALTER TABLE "archives" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "archives" ADD CONSTRAINT "archives_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "archives_organizationId_idx" ON "archives"("organizationId");

-- widgets
ALTER TABLE "widgets" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "widgets_organizationId_idx" ON "widgets"("organizationId");

-- widget_workspaces
ALTER TABLE "widget_workspaces" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "widget_workspaces" ADD CONSTRAINT "widget_workspaces_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "widget_workspaces_organizationId_idx" ON "widget_workspaces"("organizationId");

-- workspace_templates
ALTER TABLE "workspace_templates" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "workspace_templates_organizationId_idx" ON "workspace_templates"("organizationId");

-- dlp_patterns
ALTER TABLE "dlp_patterns" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "dlp_patterns" ADD CONSTRAINT "dlp_patterns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "dlp_patterns_organizationId_idx" ON "dlp_patterns"("organizationId");

-- webhooks
ALTER TABLE "webhooks" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "webhooks_organizationId_idx" ON "webhooks"("organizationId");

-- workspace_token_usage (+ composite index per Plan 01 @@index)
ALTER TABLE "workspace_token_usage" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "workspace_token_usage" ADD CONSTRAINT "workspace_token_usage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "workspace_token_usage_organizationId_idx" ON "workspace_token_usage"("organizationId");
CREATE INDEX "workspace_token_usage_organizationId_createdAt_idx" ON "workspace_token_usage"("organizationId", "createdAt");

-- api_keys
ALTER TABLE "api_keys" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "api_keys_organizationId_idx" ON "api_keys"("organizationId");

-- workspace_agent_configs
ALTER TABLE "workspace_agent_configs" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "workspace_agent_configs" ADD CONSTRAINT "workspace_agent_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "workspace_agent_configs_organizationId_idx" ON "workspace_agent_configs"("organizationId");

-- chats
ALTER TABLE "chats" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "chats" ADD CONSTRAINT "chats_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "chats_organizationId_idx" ON "chats"("organizationId");

-- chat_folders
ALTER TABLE "chat_folders" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "chat_folders" ADD CONSTRAINT "chat_folders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "chat_folders_organizationId_idx" ON "chat_folders"("organizationId");

-- chat_messages
ALTER TABLE "chat_messages" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "chat_messages_organizationId_idx" ON "chat_messages"("organizationId");

-- documents
ALTER TABLE "documents" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "documents" ADD CONSTRAINT "documents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "documents_organizationId_idx" ON "documents"("organizationId");

-- upload_drafts
ALTER TABLE "upload_drafts" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "upload_drafts" ADD CONSTRAINT "upload_drafts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "upload_drafts_organizationId_idx" ON "upload_drafts"("organizationId");

-- ocr_jobs
ALTER TABLE "ocr_jobs" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ocr_jobs_organizationId_idx" ON "ocr_jobs"("organizationId");

-- archive_import_jobs
ALTER TABLE "archive_import_jobs" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "archive_import_jobs" ADD CONSTRAINT "archive_import_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "archive_import_jobs_organizationId_idx" ON "archive_import_jobs"("organizationId");

-- synthesis_runs
ALTER TABLE "synthesis_runs" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "synthesis_runs" ADD CONSTRAINT "synthesis_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "synthesis_runs_organizationId_idx" ON "synthesis_runs"("organizationId");

-- mcp_connections
ALTER TABLE "mcp_connections" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "mcp_connections_organizationId_idx" ON "mcp_connections"("organizationId");

-- push_subscriptions
ALTER TABLE "push_subscriptions" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "push_subscriptions_organizationId_idx" ON "push_subscriptions"("organizationId");

-- system_config (column stays NULLABLE — Tier A′ global-row substrate, Phase 183 deferral)
ALTER TABLE "system_config" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "system_config" ADD CONSTRAINT "system_config_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "system_config_organizationId_idx" ON "system_config"("organizationId");

-- backup_destinations (enterprise fragment — Plan 01 schema-enterprise.prisma)
ALTER TABLE "backup_destinations" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "backup_destinations_organizationId_idx" ON "backup_destinations"("organizationId");
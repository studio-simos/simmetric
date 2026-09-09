-- Phase 182 M3 (SAAS-01b): idempotent null-guarded org backfill — additive-only per audit gate
--
-- Every existing row of the 26 tenant tables (25 community promise-list tables +
-- backup_destinations) gets organizationId = DEFAULT_ORG_ID. The global-config
-- table is DELIBERATELY EXCLUDED: its rows stay NULL-org as the Tier A′ global-row
-- substrate (Phase 183 consumes the NULLs-distinct composite semantics there —
-- backfilling it would hollow that design; M4 never tightens it either).
--
-- Guard shape: plain WHERE "organizationId" IS NULL — org backfill intentionally
-- covers ALL rows including soft-deleted tombstones (unlike the ArchivePage variant
-- in searchVectorMultiBackfill.ts, which skips tombstones).
--
-- High-volume tables (chats, chat_messages, synthesis_runs) use a PL/pgSQL DO block
-- copying the repo idiom (searchVectorMultiBackfill.ts:57-70): bounded LIMIT 500
-- batches, loop until zero rows affected, self-contained + re-runnable on
-- crash-resume (migrate deploy runs each migration in one transaction — a mid-M3
-- failure rolls back the whole file and a re-deploy resumes cleanly because every
-- statement here is null-guarded and re-runnable).
--
-- Statement order keeps children after parents (projects → workspaces → chats/
-- chat_messages/chat_folders → documents → the rest). Order never changes the
-- outcome (every backfill targets the fixed default UUID) — kept parent-first
-- per the research probe edge anyway.
--
-- Additive-only: UPDATE (null-guarded) + INSERT (NOT EXISTS-guarded). Zero
-- row-removal statements of any kind.

-- projects
UPDATE "projects" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- workspaces
UPDATE "workspaces" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- workspace_access
UPDATE "workspace_access" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- project_access
UPDATE "project_access" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- providers
UPDATE "providers" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- provider_models
UPDATE "provider_models" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- archives
UPDATE "archives" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- widgets
UPDATE "widgets" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- widget_workspaces
UPDATE "widget_workspaces" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- workspace_templates
UPDATE "workspace_templates" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- dlp_patterns
UPDATE "dlp_patterns" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- webhooks
UPDATE "webhooks" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- workspace_token_usage
UPDATE "workspace_token_usage" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- api_keys
UPDATE "api_keys" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- workspace_agent_configs
UPDATE "workspace_agent_configs" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- chats (high-volume — bounded-batch DO block, re-runnable on crash-resume)
DO $$
DECLARE
  batch INTEGER;
BEGIN
  LOOP
    UPDATE "chats" SET "organizationId" = '00000000-0000-0000-0000-000000000000'
    WHERE "id" IN (
      SELECT "id" FROM "chats" WHERE "organizationId" IS NULL LIMIT 500
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    EXIT WHEN batch = 0;
  END LOOP;
END
$$;

-- chat_folders
UPDATE "chat_folders" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- chat_messages (high-volume — bounded-batch DO block)
DO $$
DECLARE
  batch INTEGER;
BEGIN
  LOOP
    UPDATE "chat_messages" SET "organizationId" = '00000000-0000-0000-0000-000000000000'
    WHERE "id" IN (
      SELECT "id" FROM "chat_messages" WHERE "organizationId" IS NULL LIMIT 500
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    EXIT WHEN batch = 0;
  END LOOP;
END
$$;

-- documents
UPDATE "documents" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- upload_drafts
UPDATE "upload_drafts" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- ocr_jobs
UPDATE "ocr_jobs" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- archive_import_jobs
UPDATE "archive_import_jobs" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- synthesis_runs (high-volume — bounded-batch DO block)
DO $$
DECLARE
  batch INTEGER;
BEGIN
  LOOP
    UPDATE "synthesis_runs" SET "organizationId" = '00000000-0000-0000-0000-000000000000'
    WHERE "id" IN (
      SELECT "id" FROM "synthesis_runs" WHERE "organizationId" IS NULL LIMIT 500
    );
    GET DIAGNOSTICS batch = ROW_COUNT;
    EXIT WHEN batch = 0;
  END LOOP;
END
$$;

-- mcp_connections
UPDATE "mcp_connections" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- push_subscriptions
UPDATE "push_subscriptions" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- backup_destinations (enterprise fragment)
UPDATE "backup_destinations" SET "organizationId" = '00000000-0000-0000-0000-000000000000' WHERE "organizationId" IS NULL;

-- Membership backfill (D-01 air-gap rule: every EXISTING user gets exactly one
-- default-org OrganizationMember row). The users⋈user_roles⋈roles join is 1:N —
-- a user with >=2 roles yields >=2 candidate rows, and the second insert would
-- violate organization_members(organizationId, userId) and abort the whole
-- migration on multi-role installs. DISTINCT ON (u.id) with admin-preference
-- ORDER BY collapses the fan-out to one row per user (T-182-06b mitigation).
-- The NOT EXISTS guard makes the insert idempotent (safe re-run after crash).
INSERT INTO "organization_members" ("id", "organizationId", "userId", "roleInOrg", "joinedAt")
SELECT
  gen_random_uuid(),
  '00000000-0000-0000-0000-000000000000',
  candidates.uid,
  CASE WHEN candidates.rname = 'admin' THEN 'admin' ELSE 'member' END,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (u."id") u."id" AS uid, r."name" AS rname
  FROM "users" u
  LEFT JOIN "user_roles" ur ON ur."userId" = u."id"
  LEFT JOIN "roles" r ON r."id" = ur."roleId"
  ORDER BY u."id", (r."name" = 'admin') DESC
) candidates
WHERE NOT EXISTS (
  SELECT 1 FROM "organization_members" om
  WHERE om."userId" = candidates.uid
    AND om."organizationId" = '00000000-0000-0000-0000-000000000000'
);
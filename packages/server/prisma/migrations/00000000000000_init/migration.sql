-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OcrJobType" AS ENUM ('OCR', 'URL');

-- CreateEnum
CREATE TYPE "OcrJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SynthesisRunStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'APPROVED', 'REJECTED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "WikiEditRunStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'REVERTED');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('user', 'context');

-- CreateEnum
CREATE TYPE "MemorySensitivity" AS ENUM ('low', 'medium', 'high');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "avatar" TEXT,
    "customInstructions" TEXT,
    "textSize" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionName" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionName")
);

-- CreateTable
CREATE TABLE "role_menu_sections" (
    "roleId" TEXT NOT NULL,
    "menuSection" TEXT NOT NULL,

    CONSTRAINT "role_menu_sections_pkey" PRIMARY KEY ("roleId","menuSection")
);

-- CreateTable
CREATE TABLE "project_access" (
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_access_pkey" PRIMARY KEY ("userId","projectId")
);

-- CreateTable
CREATE TABLE "workspace_access" (
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_access_pkey" PRIMARY KEY ("userId","workspaceId")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT,
    "embeddingModel" TEXT NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2',
    "allowMemberUploads" BOOLEAN NOT NULL DEFAULT true,
    "icon" TEXT,
    "templateId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'New Chat',
    "prompt" TEXT,
    "titleSource" TEXT NOT NULL DEFAULT 'auto',
    "model" TEXT NOT NULL DEFAULT 'qwen2.5:3b',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "providerId" TEXT,
    "folderId" TEXT,
    "archiveId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_folders" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_pins" (
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_pins_pkey" PRIMARY KEY ("userId","chatId")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" TEXT,
    "attachedDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "embeddingModel" TEXT NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusMessage" TEXT,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "vectorCleanupAt" TIMESTAMP(3),
    "vectorCleanupAttempts" INTEGER NOT NULL DEFAULT 0,
    "vectorCleanupFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkText" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "embeddingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "searchVector" tsvector,
    "searchVectorMulti" tsvector,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archives" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "autoIndex" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "archives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_pages" (
    "id" TEXT NOT NULL,
    "archiveId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "frontmatter" JSONB,
    "bodyText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "vectorContentHash" TEXT,
    "vectorProvider" TEXT,
    "lastIndexedAt" TIMESTAMP(3),
    "wikilinks" TEXT[],
    "createdBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchVector" tsvector,
    "searchVectorMulti" tsvector,

    CONSTRAINT "archive_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_models" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "isLocal" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isEmbedding" BOOLEAN NOT NULL DEFAULT false,
    "isOcr" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "temperature" DOUBLE PRECISION,
    "maxTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "lastUsed" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_agent_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL DEFAULT 'You are a helpful AI assistant with access to workspace documents and tools.',
    "enabledSkills" TEXT NOT NULL DEFAULT '["rag_search","workspace_memory"]',
    "constraints" TEXT DEFAULT '{}',
    "parsingConfig" TEXT DEFAULT '{}',
    "model" TEXT NOT NULL DEFAULT 'qwen2.5:3b',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxIterations" INTEGER NOT NULL DEFAULT 7,
    "providerId" TEXT,
    "planMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_agent_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_skills" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'builtin',
    "config" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_catalog_entries" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "transportType" TEXT NOT NULL DEFAULT 'sse',
    "headers" TEXT NOT NULL DEFAULT '{}',
    "description" TEXT,
    "category" TEXT,
    "version" TEXT,
    "author" TEXT,
    "verificationTier" TEXT NOT NULL DEFAULT 'unverified',
    "healthStatus" TEXT NOT NULL DEFAULT 'healthy',
    "lastHealthCheck" TIMESTAMP(3),
    "lastHealthError" TEXT,
    "lastCommitDate" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_catalog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_presets" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT,
    "defaultModel" TEXT,
    "authMethod" TEXT NOT NULL,
    "docsUrl" TEXT NOT NULL,
    "requiresOAuth" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "workspaceId" TEXT,
    "name" TEXT NOT NULL,
    "transportType" TEXT NOT NULL DEFAULT 'sse',
    "url" TEXT NOT NULL,
    "headers" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncAt" TIMESTAMP(3),
    "catalogEntryId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_mcp_pins" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_mcp_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_templates" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "skills" TEXT NOT NULL DEFAULT '["rag_search","workspace_memory"]',
    "parsingConfig" TEXT NOT NULL DEFAULT '{}',
    "constraints" TEXT NOT NULL DEFAULT '{}',
    "embeddingModel" TEXT,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_token_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "modelDisplayName" TEXT,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT NOT NULL,
    "secret" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keys" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widgets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "welcomeMessage" TEXT,
    "fallbackMessage" TEXT DEFAULT 'I don''t have an answer for that. Please contact us for more help.',
    "position" TEXT NOT NULL DEFAULT 'bottom-right',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "logoUrl" TEXT,
    "primaryColor" TEXT DEFAULT '#4c6ef5',
    "botName" TEXT DEFAULT 'AI Assistant',
    "avatarUrl" TEXT,
    "allowedOrigins" TEXT,
    "autoOpenDelay" INTEGER,
    "autoOpenUrlPatterns" TEXT,
    "exitIntentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "exitIntentCooldownMs" INTEGER NOT NULL DEFAULT 1800000,
    "leadCaptureEnabled" BOOLEAN NOT NULL DEFAULT false,
    "leadCapturePrompt" TEXT,
    "rateLimitPerMinute" INTEGER,
    "sessionLimitPerDay" INTEGER,
    "localizedTexts" JSONB,
    "suggestedQuestions" JSONB,
    "credits" JSONB,
    "fallbackLocale" TEXT NOT NULL DEFAULT 'en',
    "archiveId" TEXT,
    "responseProviderId" TEXT,
    "responseModel" TEXT,
    "createdBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_workspaces" (
    "widgetId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,

    CONSTRAINT "widget_workspaces_pkey" PRIMARY KEY ("widgetId","workspaceId")
);

-- CreateTable
CREATE TABLE "widget_sessions" (
    "id" TEXT NOT NULL,
    "widgetId" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "ipAddress" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "conversationCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_leads" (
    "id" TEXT NOT NULL,
    "widgetId" TEXT NOT NULL,
    "sessionId" TEXT,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "transcript" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_events" (
    "id" TEXT NOT NULL,
    "widgetId" TEXT NOT NULL,
    "sessionId" TEXT,
    "query" TEXT NOT NULL,
    "topicCategory" TEXT NOT NULL DEFAULT 'general',
    "hasCitations" BOOLEAN NOT NULL DEFAULT false,
    "qualityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "responseLength" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_jobs" (
    "id" TEXT NOT NULL,
    "archiveId" TEXT NOT NULL,
    "type" "OcrJobType" NOT NULL,
    "status" "OcrJobStatus" NOT NULL DEFAULT 'PENDING',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalPages" INTEGER,
    "processedPages" INTEGER NOT NULL DEFAULT 0,
    "currentPage" INTEGER,
    "modelName" TEXT,
    "ocrMode" TEXT,
    "customInstructions" TEXT,
    "sourceFileName" TEXT,
    "contentHash" TEXT,
    "result" JSONB,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ocr_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_import_jobs" (
    "id" TEXT NOT NULL,
    "archiveId" TEXT NOT NULL,
    "documentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "sourceFileName" TEXT,
    "contentHash" TEXT,
    "result" JSONB,
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archive_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "synthesis_runs" (
    "id" TEXT NOT NULL,
    "archiveId" TEXT NOT NULL,
    "status" "SynthesisRunStatus" NOT NULL DEFAULT 'PENDING',
    "name" TEXT NOT NULL DEFAULT '',
    "pagesRead" INTEGER NOT NULL DEFAULT 0,
    "pagesWritten" INTEGER NOT NULL DEFAULT 0,
    "pagesProposed" INTEGER NOT NULL DEFAULT 0,
    "pagesApplied" INTEGER NOT NULL DEFAULT 0,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "llmCallsUsed" INTEGER NOT NULL DEFAULT 0,
    "contradictionsFound" INTEGER NOT NULL DEFAULT 0,
    "previewJson" JSONB,
    "error" TEXT,
    "approvedBy" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "synthesis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wiki_edit_runs" (
    "id" TEXT NOT NULL,
    "archiveId" TEXT NOT NULL,
    "pageSlug" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previewJson" JSONB NOT NULL,
    "status" "WikiEditRunStatus" NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wiki_edit_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_configs" (
    "id" TEXT NOT NULL,
    "archiveId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archive_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_schema_templates" (
    "id" TEXT NOT NULL,
    "archiveId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "pageTypes" JSONB,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "archive_schema_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_drafts" (
    "id" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "assignedArchiveId" TEXT,
    "ragEnabled" BOOLEAN NOT NULL DEFAULT false,
    "kbEnabled" BOOLEAN NOT NULL DEFAULT false,
    "filePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT NOT NULL,
    "parseStatus" TEXT NOT NULL DEFAULT 'uploaded',
    "ragJobId" TEXT,
    "kbJobId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_drafts_pkey" PRIMARY KEY ("id")
);

-- pgvector extension (required by memories.embedding vector(384) — Phase 91 first server-side use; idempotent)
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "MemoryType" NOT NULL,
    "path" TEXT,
    "content" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "sensitivity" "MemorySensitivity" NOT NULL DEFAULT 'low',
    "embedding" vector(384) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dlp_patterns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "patternFlags" TEXT NOT NULL DEFAULT 'gu',
    "replacement" TEXT NOT NULL DEFAULT '[REDACTED]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dlp_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "clientSecretEncrypted" TEXT,
    "discoveryUrl" TEXT,
    "entryPoint" TEXT,
    "cert" TEXT,
    "entityId" TEXT,
    "redirectUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sso_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_providers" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scim_groups" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "members" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scim_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "userId" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_destinations" (
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

-- CreateTable
CREATE TABLE "backup_jobs" (
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

-- CreateTable
CREATE TABLE "backup_logs" (
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

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "projects_createdBy_name_key" ON "projects"("createdBy", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_projectId_name_key" ON "workspaces"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "documents_cacheKey_key" ON "documents"("cacheKey");

-- CreateIndex
CREATE INDEX "document_chunks_searchVector_idx" ON "document_chunks" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "document_chunks_searchVectorMulti_idx" ON "document_chunks" USING GIN ("searchVectorMulti");

-- CreateIndex
CREATE UNIQUE INDEX "archives_slug_key" ON "archives"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "archives_createdBy_name_key" ON "archives"("createdBy", "name");

-- CreateIndex
CREATE INDEX "archive_pages_archiveId_category_idx" ON "archive_pages"("archiveId", "category");

-- CreateIndex
CREATE INDEX "archive_pages_searchVector_idx" ON "archive_pages" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "archive_pages_searchVectorMulti_idx" ON "archive_pages" USING GIN ("searchVectorMulti");

-- CreateIndex
CREATE UNIQUE INDEX "archive_pages_archiveId_slug_key" ON "archive_pages"("archiveId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_key_key" ON "system_config"("key");

-- CreateIndex
CREATE UNIQUE INDEX "provider_models_providerId_name_key" ON "provider_models"("providerId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_agent_configs_workspaceId_key" ON "workspace_agent_configs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_skills_name_key" ON "agent_skills"("name");

-- CreateIndex
CREATE UNIQUE INDEX "provider_presets_slug_key" ON "provider_presets"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "chat_mcp_pins_chatId_connectionId_key" ON "chat_mcp_pins"("chatId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_templates_slug_key" ON "workspace_templates"("slug");

-- CreateIndex
CREATE INDEX "workspace_token_usage_workspaceId_createdAt_idx" ON "workspace_token_usage"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "workspace_token_usage_userId_idx" ON "workspace_token_usage"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "widget_sessions_sessionToken_key" ON "widget_sessions"("sessionToken");

-- CreateIndex
CREATE INDEX "widget_sessions_sessionToken_idx" ON "widget_sessions"("sessionToken");

-- CreateIndex
CREATE INDEX "widget_sessions_widgetId_idx" ON "widget_sessions"("widgetId");

-- CreateIndex
CREATE INDEX "widget_leads_widgetId_idx" ON "widget_leads"("widgetId");

-- CreateIndex
CREATE INDEX "widget_leads_email_idx" ON "widget_leads"("email");

-- CreateIndex
CREATE INDEX "widget_leads_createdAt_idx" ON "widget_leads"("createdAt");

-- CreateIndex
CREATE INDEX "widget_events_widgetId_createdAt_idx" ON "widget_events"("widgetId", "createdAt");

-- CreateIndex
CREATE INDEX "widget_events_topicCategory_idx" ON "widget_events"("topicCategory");

-- CreateIndex
CREATE INDEX "widget_events_createdAt_idx" ON "widget_events"("createdAt");

-- CreateIndex
CREATE INDEX "ocr_jobs_archiveId_createdAt_idx" ON "ocr_jobs"("archiveId", "createdAt");

-- CreateIndex
CREATE INDEX "ocr_jobs_archiveId_status_idx" ON "ocr_jobs"("archiveId", "status");

-- CreateIndex
CREATE INDEX "archive_import_jobs_archiveId_status_idx" ON "archive_import_jobs"("archiveId", "status");

-- CreateIndex
CREATE INDEX "synthesis_runs_archiveId_createdAt_idx" ON "synthesis_runs"("archiveId", "createdAt");

-- CreateIndex
CREATE INDEX "synthesis_runs_archiveId_status_idx" ON "synthesis_runs"("archiveId", "status");

-- CreateIndex
CREATE INDEX "wiki_edit_runs_archiveId_status_idx" ON "wiki_edit_runs"("archiveId", "status");

-- CreateIndex
CREATE INDEX "wiki_edit_runs_createdBy_status_idx" ON "wiki_edit_runs"("createdBy", "status");

-- CreateIndex
CREATE UNIQUE INDEX "archive_configs_archiveId_key" ON "archive_configs"("archiveId");

-- CreateIndex
CREATE INDEX "upload_drafts_uploadedBy_deletedAt_idx" ON "upload_drafts"("uploadedBy", "deletedAt");

-- CreateIndex
CREATE INDEX "memories_userId_workspaceId_idx" ON "memories"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "memories_userId_workspaceId_path_key" ON "memories"("userId", "workspaceId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "dlp_patterns_name_key" ON "dlp_patterns"("name");

-- CreateIndex
CREATE UNIQUE INDEX "identity_providers_provider_providerUserId_key" ON "identity_providers"("provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "scim_groups_externalId_key" ON "scim_groups"("externalId");

-- CreateIndex
CREATE INDEX "event_logs_entityType_entityId_idx" ON "event_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "event_logs_userId_idx" ON "event_logs"("userId");

-- CreateIndex
CREATE INDEX "backup_logs_destinationId_createdAt_idx" ON "backup_logs"("destinationId", "createdAt");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionName_fkey" FOREIGN KEY ("permissionName") REFERENCES "permissions"("name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_menu_sections" ADD CONSTRAINT "role_menu_sections_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_access" ADD CONSTRAINT "workspace_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_access" ADD CONSTRAINT "workspace_access_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "workspace_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "chat_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chats" ADD CONSTRAINT "chats_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_folders" ADD CONSTRAINT "chat_folders_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_pins" ADD CONSTRAINT "chat_pins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_pins" ADD CONSTRAINT "chat_pins_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archives" ADD CONSTRAINT "archives_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_pages" ADD CONSTRAINT "archive_pages_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_pages" ADD CONSTRAINT "archive_pages_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_agent_configs" ADD CONSTRAINT "workspace_agent_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_catalogEntryId_fkey" FOREIGN KEY ("catalogEntryId") REFERENCES "mcp_catalog_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_mcp_pins" ADD CONSTRAINT "chat_mcp_pins_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_mcp_pins" ADD CONSTRAINT "chat_mcp_pins_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "mcp_connections"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_mcp_pins" ADD CONSTRAINT "chat_mcp_pins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_workspaces" ADD CONSTRAINT "widget_workspaces_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_workspaces" ADD CONSTRAINT "widget_workspaces_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_leads" ADD CONSTRAINT "widget_leads_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_leads" ADD CONSTRAINT "widget_leads_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "widget_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_widgetId_fkey" FOREIGN KEY ("widgetId") REFERENCES "widgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "widget_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_jobs" ADD CONSTRAINT "ocr_jobs_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_import_jobs" ADD CONSTRAINT "archive_import_jobs_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_import_jobs" ADD CONSTRAINT "archive_import_jobs_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synthesis_runs" ADD CONSTRAINT "synthesis_runs_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synthesis_runs" ADD CONSTRAINT "synthesis_runs_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "synthesis_runs" ADD CONSTRAINT "synthesis_runs_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_edit_runs" ADD CONSTRAINT "wiki_edit_runs_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_edit_runs" ADD CONSTRAINT "wiki_edit_runs_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wiki_edit_runs" ADD CONSTRAINT "wiki_edit_runs_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_configs" ADD CONSTRAINT "archive_configs_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_schema_templates" ADD CONSTRAINT "archive_schema_templates_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "archives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_drafts" ADD CONSTRAINT "upload_drafts_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_drafts" ADD CONSTRAINT "upload_drafts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_drafts" ADD CONSTRAINT "upload_drafts_assignedArchiveId_fkey" FOREIGN KEY ("assignedArchiveId") REFERENCES "archives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_logs" ADD CONSTRAINT "event_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "backup_destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_logs" ADD CONSTRAINT "backup_logs_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "backup_destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_logs" ADD CONSTRAINT "backup_logs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "backup_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_logs" ADD CONSTRAINT "backup_logs_restoredBy_fkey" FOREIGN KEY ("restoredBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


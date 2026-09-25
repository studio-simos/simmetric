-- Phase 198 (ECCO-01 D-01/D-02): chat-connector schema v2 — three NEW tables
-- (chat_connectors / connector_sessions / connector_messages) + their indexes
-- and FKs. Strictly ADDITIVE (D-02): zero DML against pre-existing tables —
-- no INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER on existing columns; backfill =
-- none. Column set per TODO/EXTERNAL_CHAT_CONNECTORS_SPEC.md §7.3 (D-01):
-- SAAS-01b organizationId sentinel, AES-256-GCM secret blobs
-- (botTokenEncrypted/configEncrypted), BigInt pollOffset (int32 overflow
-- horizon), enum-as-string pollMode/healthStatus, soft delete on the
-- connector only (sessions hard-expire, messages append-only).

-- CreateTable
CREATE TABLE "chat_connectors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "botTokenEncrypted" TEXT,
    "configEncrypted" TEXT,
    "workspaceId" TEXT NOT NULL,
    "archiveId" TEXT,
    "responseProviderId" TEXT,
    "responseModel" TEXT,
    "botUsername" TEXT,
    "botDisplayName" TEXT,
    "welcomeMessage" TEXT,
    "fallbackMessage" TEXT DEFAULT 'I don''t have an answer for that. Please contact us for more help.',
    "fallbackLocale" TEXT NOT NULL DEFAULT 'en',
    "localizedTexts" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "pollMode" TEXT NOT NULL DEFAULT 'polling',
    "pollOffset" BIGINT NOT NULL DEFAULT 0,
    "rateLimitPerMinute" INTEGER,
    "sessionLimitPerDay" INTEGER,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastWebhookAt" TIMESTAMP(3),
    "lastPollAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_sessions" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "platformUserName" TEXT,
    "chatId" TEXT,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_messages" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "platformMessageId" TEXT,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_connectors_organizationId_idx" ON "chat_connectors"("organizationId");

-- CreateIndex
CREATE INDEX "chat_connectors_workspaceId_isEnabled_idx" ON "chat_connectors"("workspaceId", "isEnabled");

-- CreateIndex
CREATE INDEX "chat_connectors_platform_isEnabled_idx" ON "chat_connectors"("platform", "isEnabled");

-- CreateIndex
CREATE INDEX "connector_sessions_expiresAt_idx" ON "connector_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "connector_sessions_connectorId_platformUserId_key" ON "connector_sessions"("connectorId", "platformUserId");

-- CreateIndex
CREATE INDEX "connector_messages_connectorId_createdAt_idx" ON "connector_messages"("connectorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "connector_messages_connectorId_platformMessageId_key" ON "connector_messages"("connectorId", "platformMessageId");

-- AddForeignKey
ALTER TABLE "chat_connectors" ADD CONSTRAINT "chat_connectors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_connectors" ADD CONSTRAINT "chat_connectors_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_connectors" ADD CONSTRAINT "chat_connectors_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_sessions" ADD CONSTRAINT "connector_sessions_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "chat_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_sessions" ADD CONSTRAINT "connector_sessions_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_messages" ADD CONSTRAINT "connector_messages_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "chat_connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_messages" ADD CONSTRAINT "connector_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "connector_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

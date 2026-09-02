<!-- generated-by: gsd-doc-writer -->

# @simmetric-chat/shared

Shared kernel for the Simmetric Chat monorepo. Contains TypeScript types, Zod validation schemas, and constants used by the server, collector, frontend, and widget packages. Only runtime dependency: `zod`.

Part of the [Simmetric Chat](../../README.md) monorepo.

## Directory Structure

```
src/
├── types/          # Shared TypeScript interfaces and type aliases
├── schemas/        # Zod validation schemas and inferred input types
├── constants/      # RBAC permissions, license feature flags, provider presets, config defaults
├── utils/          # Pure read-side helpers (sanitizeFileName)
└── index.ts        # Barrel export: re-exports types, schemas, constants, and utils
```

### Types (`src/types/`)

Domain interfaces for entities used across the monorepo. Defined in `src/types/index.ts` and `src/types/provider.ts`:

- `User`, `UserWithRoles`, `Role`, `RoleWithPermissions`
- `Project`, `Workspace`
- `Chat`, `ChatMessage`, `ChatMessageMetadata`, `SourceCitation`, `MessageRole`
- `Document`, `DocumentChunk`, `ChunkMetadata`, `DocumentType`, `DocumentStatus`
- `SystemConfigEntry`, `SettingsEntry`
- `EventLog`, `EntityType` (17 entity types: chat, project, workspace, document, user, mcp_connection, dlp, archive, archive_page, archive_import, ocr_job, synthesis_run, wiki_edit, backup_destination, backup_job, provider, memory)
- `LicenseInfo`
- `ApiKey`
- `Widget`, `WidgetWorkspace`, `WidgetSession`, `WidgetLead`
- `WidgetEvent`, `DailyWidgetAnalytics`, `TopicDistribution`, `WidgetAnalyticsResponse`
- `ChatExportData`, `ChatExportItem`, `ChatExportMessage`, `ChatImportPreview`
- `Provider`, `ProviderModel`, `ProviderConfig`, `ProviderWithModels`, `ProviderPreset`
- `BackupDestination`, `BackupJob`, `BackupLog`, `DestinationType`, `DestinationStatus`
- `LLMProvider` (openai, anthropic, ollama, openrouter), `VectorDBProvider` (lancedb, qdrant, pgvector, chroma), `EmbeddingProvider` (local, openai)

**`SourceCitation`** is the citation supertype shared by chat metadata, SSE `citations` events, and export payloads. Its `source` field is a 6-value producer union — `"rag" | "archive" | "tool" | "web" | "memory" | "workspace"` — where `"workspace"` is a legacy alias retained for backward compatibility with persisted data. The pure read-side helper `normalizeSource()` maps the legacy alias `"workspace"` → canonical `"rag"` at the producer boundary (display/telemetry only; no write-side mutation).

### Schemas (`src/schemas/`)

Zod schemas for request/response validation. Each schema file exports both the `z.object()` schema and an inferred `*Input` type. 30 schema files total:

- `auth.schema.ts` — `loginSchema`, `registerSchema`, `adminRegisterSchema`, `changePasswordSchema`, `setInitialPasswordSchema`, `updateUserSchema`
- `archive.schema.ts` — `createArchiveSchema`, `updateArchiveSchema`, `createPageSchema`, `updatePageSchema`, `archiveSearchQuerySchema`, `archiveConfigSchema`, `archiveSchemaTemplateSchema`, `updateArchiveConfigSchema`, `copyToArchiveRequestSchema`, `copyToArchiveBatchRequestSchema`, `archiveLocalLLMConfigSchema`
- `backup.schema.ts` — `createBackupDestinationSchema`, `updateBackupDestinationSchema`, `backupDestinationIdParamSchema`, `restoreSelectiveSchema`, `restoreRequestSchema`, `restoreDryRunResponseSchema`, `restoreResponseSchema`, `backupLogIdParamSchema`, `backupLogStatusSchema`, `backupLogListQuerySchema`, `backupLogsResponseSchema`, plus per-destination config schemas (local, s3, s3_compatible, google_drive, dropbox, sftp, ftp, email)
- `backupJob.schema.ts` — `createBackupJobSchema`, `updateBackupJobSchema`, `toggleBackupJobSchema`, `backupJobIdParamSchema`, `frequencySchema`
- `chat.schema.ts` — `sendMessageSchema`, `createChatSchema`, `updateChatSchema`, `renameChatSchema`, `updateChatModelSchema`, `linkArchiveSchema`, `updateWorkspaceAgentConfigSchema`, `agentPlanStepSchema`, `agentPlanSchema`, `createFolderSchema`, `updateFolderSchema`, `moveChatSchema`, `chatExportQuerySchema`, `chatImportPreviewSchema`, `editMessageSchema`, `chatRequestSchema`
- `chatRetention.schema.ts` — `chatRetentionSchema` (requires `confirmDataLoss: true` for the chat retention write contract)
- `config.schema.ts` — `setConfigSchema`, `bulkSetConfigSchema`, `configKeySchema`
- `document.schema.ts` — `uploadDocumentSchema`, `processDocumentSchema`, `youtubeTranscriptSchema`, `documentTypeSchema`
- `entity.schema.ts` — Response-shaped schemas: `userResponseSchema`, `projectResponseSchema`, `workspaceResponseSchema`, `chatResponseSchema`, `chatMessageResponseSchema`, `documentResponseSchema`, `apiKeyResponseSchema`, `apiKeyCreateResponseSchema`, `eventLogResponseSchema`
- `filter.schema.ts` — `updateFilterSchema` (filter plugin admin API, Phase 100)
- `graphWiki.schema.ts` — `graphWikiTriggerSchema` (POST /api/synthesis/trigger-graph-wiki request shape)
- `ingest.schema.ts` — Collector↔server ingestion contract: `IngestChunkSchema`, `IngestResponseSchema`, `IngestStatusCallbackSchema`, `ReembedChunkSchema`, `ReembedRequestSchema`, `WikiPagesIngestSchema`, `IngestQueryRequestSchema`, `IngestDeleteRequestSchema`, `IngestUploadBodySchema`, `RerankRequestSchema`, `archivePageParseRequestSchema`, `archivePageParseCallbackSchema`, `safeIdSchema`
- `license.schema.ts` — `licensePayloadSchema` (JWT payload shape inside a license token)
- `mcpConnection.schema.ts` — `createMcpConnectionSchema`, `updateMcpConnectionSchema`, `toggleMcpConnectionSchema`, `mcpConnectionIdParamSchema`, `mcpCatalogEntryIdParamSchema`, `installMcpServerSchema`, `uninstallMcpServerSchema`, `mcpHeadersSchema`, `healthStatusSchema`, `verificationTierSchema`
- `mcpPins.schema.ts` — `createMcpPinSchema`, `chatIdParamSchema`, `mcpPinIdParamSchema`
- `memory.schema.ts` — Per-user-per-workspace memory (Phase 97): `memoryTypeSchema`, `memorySensitivitySchema`, `dottedPathSchema`, `createMemorySchema`, `updateMemorySchema`, `memoryIdParamSchema`, `memoryExportQuerySchema`, `memoryListQuerySchema`, plus the auto-extraction JSON ops gate `memoryOpSchema`, `memoryOpsSchema`, `validateMemoryOperations`
- `ocr.schema.ts` — `ocrJobRequestSchema`, `batchOcrJobRequestSchema`, `urlIngestionRequestSchema`, `ocrJobApproveSchema`, `ocrJobRejectSchema`, `ocrPageResultSchema`, `ocrJobResultSchema`, `ocrModelConfigSchema`, `ocrModelCatalogSchema`, `ocrUnknownModelErrorSchema`, `ocrPreviewRequestSchema`, `ocrPreferencesSchema`
- `plugin.schema.ts` — Enterprise plugin contract (Phase 140): `PluginContext`, `EnterprisePlugin`, `AuditLog`, `AuditLogEvent`, `ConfigKeyValidator`, `MinimalPrismaClient`, `MinimalExpressApp`, `MinimalLogger`, `PluginScheduler`, `API_VERSION` (structural interfaces only — no express/prisma imports, per the zero-dep rule)
- `postProcessing.schema.ts` — `autoTagsSchema` (LLM JSON output validation for auto tags + follow-up suggestions)
- `project.schema.ts` — `createProjectSchema`, `updateProjectSchema`
- `provider.schema.ts` — `createProviderSchema`, `updateProviderSchema`, `updateProviderModelSchema`, `chatModelOverrideSchema`, `providerTypeSchema`, `providerPresetIdParamSchema`, `installProviderPresetSchema`
- `role.schema.ts` — `createRoleSchema`, `updateRoleSchema`, `assignRoleSchema`, `grantWorkspaceAccessSchema`, `grantProjectAccessSchema`, `roleIdParamSchema`
- `sso.schema.ts` — Enterprise SSO (Phase 113): `saveSsoConfigSchema`, `ssoConfigResponseSchema` (client secret is plaintext on input only; the response exposes `clientSecretConfigured: boolean`)
- `synthesis.schema.ts` — `synthesisPreviewSchema`, `synthesisApproveRejectSchema`, `synthesisTriggerSchema`, `synthesisRunStatusSchema`, `synthesisConfidenceSchema`, `renameSynthesisRunSchema`
- `system.schema.ts` — `initializeSchema`
- `toolCall.schema.ts` — `nativeToolCallSchema` (normalized ollama-js `tool_calls[]` dispatch shape)
- `uploadDraft.schema.ts` — Upload draft pipeline (Phase 68): `createUploadDraftSchema`, `createUploadDraftUrlSchema`, `assignDraftSchema`, `renameUploadSchema`, `draftDestinationSchema`, `draftMimeTypeSchema`, `UPLOAD_DRAFT_STATUSES`, `uploadDraftStatusSchema`
- `widget.schema.ts` — `createWidgetSchema`, `updateWidgetSchema`, `widgetChatRequestSchema`, `widgetSessionCreateSchema`, `widgetConfigResponseSchema`, `widgetSessionResponseSchema`, `widgetSessionIncrementSchema`, `widgetSearchRequestSchema`, `widgetTriggerConfigSchema`, `widgetLeadCaptureSchema`, `widgetLeadSubmitSchema`, `widgetLeadExportQuerySchema`, `widgetAnalyticsQuerySchema`; also `WIDGET_LOCALES` / `widgetLocaleSchema` (8 locales: en, de, es, fr, it, ru, zh, pt — mirroring the frontend `ALL_LANGUAGES`) and the pure read-side helpers `resolveWidgetTexts()` / `resolveSuggestedQuestions()` (exact locale → fallbackLocale → legacy → en resolution chain)
- `wiki.schema.ts` — `wikiQueryParamsSchema`, `wikiWritePreviewSchema`, `wikiWriteApproveRejectSchema`, `wikilinkResolveSchema`, `wikiDistillSchema`, `mergePagesSchema`
- `workspace.schema.ts` — `createWorkspaceSchema`, `updateWorkspaceSchema`, `permanentDeleteWorkspacesSchema`

### Constants (`src/constants/`)

- `permissions.ts` — `PERMISSION_NAMES` (31 RBAC permission strings), `permissionNameSchema`, `PermissionName` type, `MENU_SECTIONS` (13 sections), `menuSectionSchema`, `MenuSection` type, `DEFAULT_ROLE_MENU_SECTIONS`, `DEFAULT_ADMIN_ROLE`, `DEFAULT_USER_ROLE`, `DEFAULT_ROLES`, `CONFIG_DEFAULTS`, `SETTINGS_TAB_PERMISSIONS`
- `license.ts` — `FEATURE_FLAGS` (11 feature flags: enterprise-only flags + numeric limits — commodity flags were removed in Phase 140), `FeatureFlag` type, `COMMUNITY_FEATURE_DEFAULTS`, `ENTERPRISE_FEATURE_DEFAULTS`, `LICENSE_TIERS`, `LicenseTier` type
- `providerPresets.ts` — `PROVIDER_PRESETS` (one-click LLM provider catalog entries), `PROVIDER_PRESET_CATEGORIES`, `ProviderPresetConstant`, `ProviderPresetCategory` types

### Utils (`src/utils/`)

- `fileName.ts` — `sanitizeFileName(name, fallback?)`: single source of truth for filename sanitization across server, collector, and frontend. Strips spaces, path separators, control characters, non-ASCII characters, and traversal sequences; preserves a lowercase extension; caps at 255 chars.

## Usage

Import from the package barrel — types, schemas, and constants are all re-exported from `src/index.ts`:

```ts
import { z } from "zod";
import { loginSchema, type LoginInput } from "@simmetric-chat/shared";
import { PERMISSION_NAMES, FEATURE_FLAGS } from "@simmetric-chat/shared";
import { sanitizeFileName } from "@simmetric-chat/shared";

// Validate with safeParse (never parse) so bad input returns 400, not 500
const result = loginSchema.safeParse({ email: "a@b.c", password: "secret" });
if (result.success) {
  const input: LoginInput = result.data;
}
```

## Key Conventions

- **No business logic** — This package contains only types, schemas, and constants. It must never import runtime dependencies other than `zod`.
- **No circular dependencies** — `shared` is the leaf node in the monorepo dependency graph. It must not import from `server`, `collector`, `frontend`, or `widget`.
- **Barrel exports** — `src/index.ts` re-exports from `types`, `schemas`, `constants`, and `utils`. Subdirectories also maintain `index.ts` barrel files.
- **Schema naming** — Files use `camelCase.schema.ts` (e.g., `auth.schema.ts`). Inferred types use the schema name without "Schema" plus an `Input` suffix (e.g., `loginSchema` -> `LoginInput`).

## How to Add New Shared Types or Schemas

1. Create or edit the relevant file in `src/types/` or `src/schemas/`.
2. Export the schema and its inferred type:
   ```ts
   export const myFeatureSchema = z.object({ name: z.string().min(1) });
   export type MyFeatureInput = z.infer<typeof myFeatureSchema>;
   ```
3. Re-export from the subdirectory `index.ts` (e.g., `src/schemas/index.ts`).
4. Run `pnpm typecheck` and `pnpm test` from the monorepo root to ensure downstream packages compile.

## Monorepo Dependency Graph

`shared` is the only cross-package import. All other packages import from it, but never the reverse:

```
shared <- server
shared <- collector
shared <- frontend
shared <- widget
```

The Turborepo build pipeline enforces this: `shared` must build before any consuming package. Server, collector, and widget map `@simmetric-chat/shared` to `shared/dist/index.js` (tsconfig + jest), so **`pnpm --filter @simmetric-chat/shared build` is required** before their build/lint/typecheck/test runs. The frontend aliases shared **source** (`../shared/src/index.ts` in vite + jest) and does not need the build. Turbo caches downstream tasks on `^build` — after editing `src/`, rebuild shared or run via turbo, or server tests hit a stale `dist/`.

## Testing

```bash
# Run tests for this package only
pnpm --filter @simmetric-chat/shared test
```

Tests are co-located in `src/__tests__/` (16 test files):
- `schemas.test.ts` — Core schema validation and shared type assertions
- `archiveSchemas.test.ts` — Archive schema validation
- `envSchema.test.ts` — Env schema validation per package
- `featureFlags.test.ts` — `FEATURE_FLAGS` regression guard (removed commodity flags must not reappear)
- `fileName.test.ts` — `sanitizeFileName` contract (traversal neutralization, extension preservation, 255-char cap)
- `ingestSchemas.test.ts` — Ingest contract schema validation (incl. `chunkText` Bug B regression guard)
- `loadEnv.test.ts` — `loadRootEnv()` marker-walk resolution and merge behavior
- `mcp-connection-schema.test.ts` — MCP connection schema validation
- `mcpHeadersSchema.test.ts` — MCP headers schema validation
- `ocrSchemas.test.ts` — OCR schema validation
- `pluginSchema.test.ts` — Enterprise plugin contract (`API_VERSION`, `PluginContext` / `EnterprisePlugin` structural interfaces)
- `sourceCitation.test.ts` — `SourceCitation.source` 6-value union + `normalizeSource()` behavior
- `widget-flags.test.ts` — Widget feature flag validation
- `widget-schemas.test.ts` — Widget schema validation
- `widgetLocalization.test.ts` — `resolveWidgetTexts()` / `resolveSuggestedQuestions()` resolution chain behavior
- `widgetLocalesParity.test.ts` — `WIDGET_LOCALES` ↔ frontend `ALL_LANGUAGES` set-parity guard (reads the frontend i18n source directly)

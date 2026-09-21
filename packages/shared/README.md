<!-- generated-by: gsd-doc-writer -->

# @simmetric-chat/shared

Shared kernel for the Simmetric Chat monorepo. Contains TypeScript types, Zod validation schemas, constants, and zero-dependency config loaders used by the server, collector, frontend, and widget packages. Only runtime dependency: `zod`.

Part of the [Simmetric Chat](../../README.md) monorepo.

## Directory Structure

```
src/
├── types/          # Shared TypeScript interfaces and type aliases
├── schemas/        # Zod validation schemas and inferred input types
├── constants/      # RBAC permissions, license feature flags, provider presets, org constants, config defaults
├── config/         # Zero-dependency root .env loader (Node-consumers only)
├── utils/          # Pure read-side helpers (sanitizeFileName)
└── index.ts        # Barrel export: re-exports types, schemas, constants, config loaders, and utils
```

### Types (`src/types/`)

Domain interfaces for entities used across the monorepo. Defined in `src/types/index.ts` and `src/types/provider.ts`:

- `User`, `UserWithRoles`, `Role`, `RoleWithPermissions`
- `Project`, `Workspace`
- `Chat`, `ChatMessage`, `ChatMessageMetadata`, `SourceCitation`, `MessageRole`
- `Document`, `DocumentChunk`, `ChunkMetadata`, `DocumentType`, `DocumentStatus`
- `SystemConfigEntry`, `SettingsEntry`
- `EventLog`, `EntityType` (20 entity types: chat, project, workspace, document, user, mcp_connection, mcp_catalog_entry, dlp, archive, archive_page, archive_import, ocr_job, synthesis_run, wiki_edit, backup_destination, backup_job, provider, memory, skill, upload_draft)
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

Zod schemas for request/response validation. Many schema files export both the `z.object()` schema and an inferred `*Input` type (some define their inferred types — and occasionally helper schemas — privately without exporting them). 36 schema files total:

- `archive.schema.ts` — `createArchiveSchema`, `updateArchiveSchema`, `createPageSchema`, `updatePageSchema`, `archiveSearchQuerySchema`, `archiveConfigSchema` (with a file-private `.partial()` variant `updateArchiveConfigSchema`), `archiveSchemaTemplateSchema`, `copyToArchiveRequestSchema`, `copyToArchiveBatchRequestSchema`, plus a file-private `archiveLocalLLMConfigSchema` (its `ArchiveLocalLLMConfig` type is exported)
- `auth.schema.ts` — `loginSchema`, `registerSchema`, `adminRegisterSchema`, `adminResetPasswordSchema`, `changePasswordSchema`, `setInitialPasswordSchema`, `updateUserSchema`
- `backup.schema.ts` — Backup destination config schemas (local, s3, s3_compatible, google_drive, dropbox, sftp, ftp, email — most file-private), `createBackupDestinationSchema`, `updateBackupDestinationSchema`, `backupDestinationIdParamSchema`, restore schemas (`restoreRequestSchema` with a `selective: "db" | "files" | "complete"` enum, `restoreDryRunResponseSchema`, `restoreResponseSchema` — some file-private), and backup-log schemas (`backupLogIdParamSchema`, `backupLogStatusSchema`, `backupLogListQuerySchema`, `backupLogsResponseSchema`)
- `backupJob.schema.ts` — Backup job CRUD split out of `backup.schema.ts`: `frequencySchema` (daily/weekly/monthly/manual), `createBackupJobSchema`, `updateBackupJobSchema`, `toggleBackupJobSchema`, `backupJobIdParamSchema`
- `chat.schema.ts` — `chatRequestSchema`, `renameChatSchema`, `updateChatModelSchema`, `linkArchiveSchema`, `createFolderSchema`, `updateFolderSchema`, `moveChatSchema`, `editMessageSchema`, plus the `AgentPlan` type. Also defines file-private helpers (`sendMessageSchema`, `createChatSchema`, `updateChatSchema`, `updateWorkspaceAgentConfigSchema`, `agentPlanStepSchema`, `chatExportQuerySchema`, `chatImportPreviewSchema`) consumed server-side via direct file imports
- `chatRetention.schema.ts` — `chatRetentionSchema` (requires `confirmDataLoss: true` for the chat retention write contract)
- `config.schema.ts` — `configKeySchema` (the settings-key enum), `bulkSetConfigSchema`, `ConfigKey`/`SetConfigInput` types (`setConfigSchema` is defined in-file but not re-exported through the barrel)
- `dlp.schema.ts` — DLP pattern configuration: `createDlpPatternSchema`, `updateDlpPatternSchema`, `testPatternSchema`, `dlpPatternIdParamSchema`
- `dlpDocumentScan.schema.ts` — Document-PII scan/unmask pipeline (Phase 189/192): `DLP_ENTITY_CLASSES`, `dlpEntityClassSchema`, `dlpScanJobPayloadSchema`, eval result schemas (`dlpEvalResultSchema`, `dlpEvalRunResponseSchema`, `dlpEvalNoRunArmSchema`), `dlpBackfillRequestSchema`/`dlpBackfillResponseSchema`, `dlpUnmaskQuerySchema`, `nerResponseSchema`
- `document.schema.ts` — `documentTypeSchema`, `uploadDocumentSchema`, `processDocumentSchema`, `youtubeTranscriptSchema`, `bulkDeleteDocumentsSchema`
- `env.schema.ts` — Shared env-config surface (server + collector): `embeddingProviderSchema`, `vectorDbProviderSchema`, `ollamaKeepAliveSchema`, plus `EMBEDDING_PROVIDERS` / `VECTOR_DB_PROVIDERS` constant lists
- `filter.schema.ts` — `updateFilterSchema` (filter plugin admin API, Phase 100)
- `graphWiki.schema.ts` — `graphWikiTriggerSchema` (POST /api/synthesis/trigger-graph-wiki request shape)
- `ingest.schema.ts` — Collector↔server ingestion contract: `IngestChunkSchema`, `IngestResponseSchema`, `IngestStatusCallbackSchema`, `ReembedRequestSchema`, `WikiPagesIngestSchema`, `RagMetadataFilterSchema` (+ `ragFilterDocumentTypeSchema`, `HybridSearchFilters` type), `IngestQueryRequestSchema`, `RerankRequestSchema`, `IngestDeleteRequestSchema`, `IngestUploadBodySchema`, `archivePageParseRequestSchema`, `archivePageParseCallbackSchema`; the `safeIdSchema` allowlist regex (`A-Za-z0-9_:-`) and `ReembedChunkSchema` are file-private
- `license.schema.ts` — `licensePayloadSchema` (JWT payload shape inside a license token)
- `mcpConnection.schema.ts` — `createMcpConnectionSchema`, `updateMcpConnectionSchema`, `toggleMcpConnectionSchema`, `mcpConnectionIdParamSchema`, `mcpCatalogEntryIdParamSchema`, `installMcpServerSchema`, `uninstallMcpServerSchema`, `mcpHeadersSchema` (file-private `healthStatusSchema` / `verificationTierSchema` enums)
- `mcpPins.schema.ts` — `createMcpPinSchema`, `chatIdParamSchema`, `mcpPinIdParamSchema`
- `memory.schema.ts` — Per-user-per-workspace memory (Phase 97): `createMemorySchema`, `updateMemorySchema`, `memoryIdParamSchema`, `memoryExportQuerySchema`, `memoryListQuerySchema`, plus the auto-extraction JSON ops gate `memoryOpsSchema` / `validateMemoryOperations` and the `MemoryOp` type. `memoryTypeSchema` (`user` | `context`), `memorySensitivitySchema`, `dottedPathSchema`, and `memoryOpSchema` are file-private
- `ocr.schema.ts` — `ocrJobRequestSchema`, `urlIngestionRequestSchema`, `ocrJobApproveSchema`, `ocrJobRejectSchema`, `ocrPageResultSchema`, `ocrJobResultSchema`, `ocrPreviewRequestSchema`, `ocrPreferencesSchema`, `ocrPageRetryRequestSchema` (file-private: `batchOcrJobRequestSchema`, `ocrModelConfigSchema`, `ocrModelCatalogSchema`, `ocrUnknownModelErrorSchema`)
- `organization.schema.ts` — Org membership (Phase 182 tenancy model): `roleInOrgSchema` (owner/admin/member, enum-as-string from `ROLE_IN_ORG_VALUES`) and the `RoleInOrgInput` type
- `personalWorkspace.schema.ts` — `createPersonalWorkspaceSchema` (Phase 183 personal workspace provisioning)
- `plugin.schema.ts` — Enterprise + SaaS plugin contracts (structural interfaces only — no express/prisma imports, per the zero-dep rule): `PluginContext`, `EnterprisePlugin`, `SaaSPluginContext extends PluginContext` and `SaaSPlugin` (Phase 186 SAAS-05, contract v2 — `API_VERSION = 2` is the SAAS loader gate; `enterpriseLoader` keeps accepting v1), `AuditLog`, `AuditLogEvent`, `ConfigKeyValidator`, `MinimalPrismaClient`, `MinimalExpressApp`, `MinimalLogger`, `PluginScheduler`, plus placeholder hook interfaces (`BillingProvider`, `QuotaEnforcer`, `PlanResolver`, `TenantProvisioner`)
- `postProcessing.schema.ts` — `autoTagsSchema` (LLM JSON output validation for auto tags + follow-up suggestions), `batchedPostProcessingSchema`
- `project.schema.ts` — `createProjectSchema`, `updateProjectSchema`
- `provider.schema.ts` — `providerTypeSchema`, `createProviderSchema`, `updateProviderSchema`, `updateProviderModelSchema`, `providerPresetIdParamSchema`, `installProviderPresetSchema` (file-private `chatModelOverrideSchema`)
- `role.schema.ts` — `createRoleSchema`, `updateRoleSchema`, `roleIdParamSchema`, plus file-private `assignRoleSchema`, `grantWorkspaceAccessSchema`, `grantProjectAccessSchema`
- `skill.schema.ts` — Custom prompt skills (Phase 190): `createSkillSchema`, `updateSkillSchema`, `testSkillSchema`, `skillCallSchema`, `skillIdParamSchema`, `RESERVED_SLUGS` (slug regex, prompt-template placeholder validation, and tool-call/syntax-marker guards are file-private)
- `sso.schema.ts` — Enterprise SSO (Phase 113, widened by Phase 193 LDAP): `saveSsoConfigSchema`, `ssoConfigResponseSchema` (client secret is plaintext on input only; the response exposes `clientSecretConfigured: boolean`), plus the LDAP additions `ldapLoginSchema`, `ldapMapRowSchema`, `ldapMapPutSchema`
- `synthesis.schema.ts` — `synthesisApproveRejectSchema`, `synthesisTriggerSchema`, `renameSynthesisRunSchema` and the exported types `SynthesisPreview` / `SynthesisConfidence` (the status/confidence enums are file-private)
- `system.schema.ts` — `initializeSchema`
- `toolCall.schema.ts` — `nativeToolCallSchema` (normalized ollama-js `tool_calls[]` dispatch shape)
- `uploadDraft.schema.ts` — Upload draft pipeline (Phase 68): `createUploadDraftSchema`, `createUploadDraftUrlSchema`, `assignDraftSchema`, `cancelDraftLegSchema`, `renameUploadSchema` (file-private: `draftDestinationSchema`, `draftMimeTypeSchema`, `UPLOAD_DRAFT_STATUSES`, `uploadDraftStatusSchema`)
- `widget.schema.ts` — `createWidgetSchema`, `updateWidgetSchema`, `widgetChatRequestSchema`, `widgetSessionCreateSchema`, `widgetConfigResponseSchema`, `widgetSessionResponseSchema`, `widgetSessionIncrementSchema`, `widgetSearchRequestSchema`, `widgetLeadSubmitSchema`, `widgetAnalyticsQuerySchema`, `widgetWorkspaceArchiveFilterSchema`, `widgetCreditsSchema`, `widgetContactOptionsSchema`, `isHttpUrl`, `WIDGET_LOCALES` (8 locales: en, de, es, fr, it, ru, zh, pt — mirroring the frontend `ALL_LANGUAGES`) and the pure read-side helpers `resolveWidgetTexts()` / `resolveSuggestedQuestions()` (merge order is `{ ...texts.en, ...texts[fallbackLocale], ...texts[locale] }`, then legacy scalar defaults are applied after the blob — so exact locale > fallbackLocale > en > legacy scalars). `widgetLocaleSchema`, `widgetTriggerConfigSchema`, `widgetLeadCaptureSchema`, `widgetLeadExportQuerySchema` are file-private
- `wiki.schema.ts` — `wikiWritePreviewSchema`, `wikiWriteApproveRejectSchema`, `wikilinkResolveSchema`, `wikiDistillSchema`, `mergePagesSchema` (file-private `wikiQueryParamsSchema`)
- `workspace.schema.ts` — `createWorkspaceSchema`, `updateWorkspaceSchema`, `permanentDeleteWorkspacesSchema`
- `workspaceAccess.schema.ts` — Workspace access grants (Phase 189): `grantWorkspaceAccessRouteSchema`, `bulkGrantWorkspaceAccessSchema`, `workspaceAccessListEntrySchema`, `workspaceAccessParamsSchema`

### Constants (`src/constants/`)

- `permissions.ts` — `PERMISSION_NAMES` (36 RBAC permission strings, last added: `dlp:unmask` — Phase 192), `permissionNameSchema`, `PermissionName` type, `MENU_SECTIONS` (14 sections, last added: `skills` — Phase 190), `menuSectionSchema`, `MenuSection` type, `DEFAULT_ROLE_MENU_SECTIONS`, `DEFAULT_ADMIN_ROLE`, `DEFAULT_USER_ROLE`, `DEFAULT_ROLES`, `CONFIG_DEFAULTS` (DB-configurable setting defaults), `SETTINGS_TAB_PERMISSIONS`
- `license.ts` — `FEATURE_FLAGS` (12 feature flags: enterprise-only flags + numeric limits including `max_skills` — commodity flags were removed in Phase 140), `FeatureFlag` type, `COMMUNITY_FEATURE_DEFAULTS`, `ENTERPRISE_FEATURE_DEFAULTS`, `LICENSE_TIERS`, `LicenseTier` type
- `organization.ts` — Default-org tenancy constants (Phase 182): `DEFAULT_ORG_ID` (fixed all-zero UUID, the air-gap tenancy root), `ROLE_IN_ORG_VALUES` (owner/admin/member), `RoleInOrg` type. `DEFAULT_ORG_ID` is re-exported through `constants/index.ts`; `ROLE_IN_ORG_VALUES` is consumed only by `schemas/organization.schema.ts` and is deliberately not in the barrel
- `providerPresets.ts` — `PROVIDER_PRESETS` (21 one-click LLM provider catalog entries: 13 OpenAI-compatible, 2 Native, 1 Local, 4 OAuth (manual)), `PROVIDER_PRESET_CATEGORIES`, `ProviderPresetCategory` types

### Config loaders (`src/config/`)

- `loadEnv.ts` — Zero-dependency root `.env` loader: `loadRootEnv()`, `findRepoRoot()`, `resolveRootEnvPath()`, `RootEnvResult`. Walks up from the calling directory to the repo root (marker: `pnpm-workspace.yaml`), reads the root `.env` and fills keys absent from `process.env` (precedence: `process.env` > root `.env` > Zod default; presence — never truthiness — defines a key). Uses only `node:fs` + `node:path` — the frontend aliases this barrel's SOURCE into the browser bundle, so a third-party parser import would drag `node:fs` into the browser graph (pinned by a guard test in `loadEnv.test.ts`). Never throws, never exits; a missing marker is a graceful no-op (Tauri packaged layout, containers via compose `env_file`)

### Utils (`src/utils/`)

- `fileName.ts` — `sanitizeFileName(name, fallback?)`: single source of truth for filename sanitization across server, collector, and frontend. Strips spaces, path separators, control characters, non-ASCII characters, and traversal sequences; preserves a lowercase extension; caps at 255 chars.

## Usage

Import from the package barrel — types, schemas, most constants, and the config loaders are re-exported from `src/index.ts`. Exception: `FEATURE_FLAGS` and `LICENSE_TIERS` are NOT re-exported through `constants/index.ts`, and the package `exports` map exposes only the `"."` entry (no subpath exports) — import them via a relative path to the source file within the monorepo:

```ts
import { z } from "zod";
import { loginSchema, type LoginInput } from "@simmetric-chat/shared";
import { PERMISSION_NAMES } from "@simmetric-chat/shared";
import { FEATURE_FLAGS } from "../shared/src/constants/license"; // relative path — no subpath export
import { loadRootEnv } from "@simmetric-chat/shared";
import { sanitizeFileName } from "@simmetric-chat/shared";

// Validate with safeParse (never parse) so bad input returns 400, not 500
const result = loginSchema.safeParse({ email: "a@b.c", password: "secret" });
if (result.success) {
  const input: LoginInput = result.data;
}
```

`loadRootEnv` / `findRepoRoot` are for Node consumers only (server, collector, widget) — the browser bundle must never value-import them or `node:fs` enters the graph (pinned by a guard test).

## Key Conventions

- **No business logic** — This package contains only types, schemas, constants, and pure helpers. It must never import runtime dependencies other than `zod` (the config loader's `node:fs`/`node:path` are Node builtins, allowed for the `config/` directory only).
- **No circular dependencies** — `shared` is the leaf node in the monorepo dependency graph. It must not import from `server`, `collector`, `frontend`, or `widget`.
- **Barrel exports** — `src/index.ts` re-exports from `types`, `schemas`, `constants`, `config/loadEnv` (explicit named exports), and `utils/fileName`. The `types/`, `schemas/`, and `constants/` subdirectories maintain their own `index.ts` barrel files (`src/utils/` and `src/config/` have none).
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
5. If the shared package gained a NEW file, note that sibling `file:` snapshots (simmetric-enterprise, simmetric-saas) can go stale — see the shared `AGENTS.md` gotcha (run `pnpm install` there before starting docker).

## Monorepo Dependency Graph

`shared` is the only cross-package import. All other packages import from it, but never the reverse:

```
shared <- server
shared <- collector
shared <- frontend
shared <- widget
```

The Turborepo build pipeline enforces this: `shared` must build before any consuming package. Server and collector jest configs map `@simmetric-chat/shared` to `shared/dist/index.js`, while the widget's jest config maps to shared **source** (`../shared/src/index.ts`); at runtime, dist resolution happens via `node_modules` (no tsconfig `paths` mapping). **`pnpm --filter @simmetric-chat/shared build` is required** before server/collector build/lint/typecheck/test runs. The frontend aliases shared **source** (`../shared/src/index.ts` in vite + jest) and does not need the build. Turbo caches downstream tasks on `^build` — after editing `src/`, rebuild shared or run via turbo, or server tests hit a stale `dist/`.

## Testing

```bash
# Run tests for this package only
pnpm --filter @simmetric-chat/shared test
```

Tests are co-located in `src/__tests__/` (20 test files):
- `archiveSchemas.test.ts` — Archive schema validation
- `chatSchemaAttachedArchives.test.ts` — `chatRequestSchema.attachedArchiveIds` additive-optional transport boundary + the widget structural strip (Phase 191)
- `dlpDocumentScanSchemas.test.ts` — DLP document-scan/unmask schema validation
- `envSchema.test.ts` — Env schema validation per package
- `featureFlags.test.ts` — `FEATURE_FLAGS` regression guard (removed commodity flags must not reappear)
- `fileName.test.ts` — `sanitizeFileName` contract (traversal neutralization, extension preservation, 255-char cap)
- `ingestSchemas.test.ts` — Ingest contract schema validation (incl. `chunkText` Bug B regression guard)
- `loadEnv.test.ts` — `loadRootEnv()` marker-walk resolution, merge behavior, and the browser-barrel guard
- `mcp-connection-schema.test.ts` — MCP connection schema validation
- `mcpHeadersSchema.test.ts` — MCP headers schema validation
- `ocrSchemas.test.ts` — OCR schema validation
- `pluginSchema.test.ts` — Plugin contracts (`API_VERSION`, `PluginContext` / `EnterprisePlugin` structural interfaces)
- `schemas.test.ts` — Core schema validation and shared type assertions
- `skillSchemas.test.ts` — Skill schema validation (slug/prompt-template guards)
- `sourceCitation.test.ts` — `SourceCitation.source` 6-value union + `normalizeSource()` behavior
- `ssoSchemasLdap.test.ts` — SSO schema additive-widening invariant for the LDAP provider additions (Phase 193)
- `widget-flags.test.ts` — Widget feature flag validation
- `widget-schemas.test.ts` — Widget schema validation
- `widgetLocalization.test.ts` — `resolveWidgetTexts()` / `resolveSuggestedQuestions()` resolution chain behavior
- `widgetLocalesParity.test.ts` — `WIDGET_LOCALES` ↔ frontend `ALL_LANGUAGES` set-parity guard (reads the frontend i18n source directly)
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

export { loginSchema, registerSchema, adminRegisterSchema, adminResetPasswordSchema, changePasswordSchema, setInitialPasswordSchema, updateUserSchema } from "./auth.schema";
export type { LoginInput, RegisterInput } from "./auth.schema";

export { createArchiveSchema, updateArchiveSchema, createPageSchema, updatePageSchema, archiveSearchQuerySchema, archiveConfigSchema, archiveSchemaTemplateSchema, copyToArchiveRequestSchema, copyToArchiveBatchRequestSchema } from "./archive.schema";
export type { CreateArchiveInput, UpdateArchiveInput, CreatePageInput, UpdatePageInput, ArchiveSearchQuery, ArchiveConfigInput, ArchiveSchemaTemplateInput, ArchiveLocalLLMConfig } from "./archive.schema";

export { createProjectSchema, updateProjectSchema } from "./project.schema";
export type { CreateProjectInput } from "./project.schema";

export { createWorkspaceSchema, updateWorkspaceSchema, permanentDeleteWorkspacesSchema } from "./workspace.schema";

export { chatRequestSchema, renameChatSchema, updateChatModelSchema, linkArchiveSchema, createFolderSchema, updateFolderSchema, moveChatSchema, editMessageSchema } from "./chat.schema";
export type { AgentPlan } from "./chat.schema";

export { bulkDeleteDocumentsSchema } from "./document.schema";

export { configKeySchema, bulkSetConfigSchema } from "./config.schema";
export type { ConfigKey, SetConfigInput } from "./config.schema";

export { chatRetentionSchema } from "./chatRetention.schema";

export { createRoleSchema, updateRoleSchema, grantWorkspaceAccessSchema, roleIdParamSchema } from "./role.schema";

// Phase 182 (SAAS-01d/D-04) — org membership contracts (roleInOrg tier above the 31-permission RBAC).
export { roleInOrgSchema, createOrganizationMemberSchema } from "./organization.schema";
export type { RoleInOrgInput, CreateOrganizationMemberInput } from "./organization.schema";



export { licensePayloadSchema } from "./license.schema";
export type { LicensePayload } from "./license.schema";

export { initializeSchema } from "./system.schema";
export type { InitializeInput } from "./system.schema";

export { widgetChatRequestSchema, widgetSessionCreateSchema, createWidgetSchema, updateWidgetSchema, widgetSessionIncrementSchema, widgetSearchRequestSchema, widgetLeadSubmitSchema, widgetAnalyticsQuerySchema, WIDGET_LOCALES, isHttpUrl, resolveWidgetTexts, resolveSuggestedQuestions } from "./widget.schema";
export type { WidgetConfigResponse, WidgetCredits } from "./widget.schema";

export { createMcpConnectionSchema, updateMcpConnectionSchema, toggleMcpConnectionSchema, mcpConnectionIdParamSchema, mcpCatalogEntryIdParamSchema, installMcpServerSchema, uninstallMcpServerSchema, mcpHeadersSchema } from "./mcpConnection.schema";


export { chatIdParamSchema, createMcpPinSchema, mcpPinIdParamSchema } from "./mcpPins.schema";


export { ocrJobApproveSchema, ocrJobRejectSchema, ocrPreviewRequestSchema, ocrPreferencesSchema } from "./ocr.schema";
export type { OcrModelConfig } from "./ocr.schema";

export { wikiWritePreviewSchema, wikiWriteApproveRejectSchema, wikilinkResolveSchema, wikiDistillSchema, mergePagesSchema } from "./wiki.schema";


export { providerTypeSchema, createProviderSchema, updateProviderSchema, updateProviderModelSchema, providerPresetIdParamSchema, installProviderPresetSchema } from "./provider.schema";
export type { ProviderType } from "./provider.schema";




export { synthesisApproveRejectSchema, synthesisTriggerSchema, renameSynthesisRunSchema } from "./synthesis.schema";
export type { SynthesisPreview, SynthesisConfidence } from "./synthesis.schema";

export { IngestResponseSchema, IngestStatusCallbackSchema, ReembedRequestSchema, WikiPagesIngestSchema, IngestQueryRequestSchema, IngestDeleteRequestSchema, IngestUploadBodySchema, RerankRequestSchema, archivePageParseRequestSchema, archivePageParseCallbackSchema, RagMetadataFilterSchema } from "./ingest.schema";
export type { HybridSearchFilters } from "./ingest.schema";

export { createUploadDraftSchema, createUploadDraftUrlSchema, assignDraftSchema, renameUploadSchema } from "./uploadDraft.schema";
export type { AssignDraftInput, DraftDestination } from "./uploadDraft.schema";

export { nativeToolCallSchema } from "./toolCall.schema";


// Phase 97 (MEM-01) — per-user-per-workspace Memory request validation.
export { createMemorySchema, updateMemorySchema, memoryIdParamSchema, memoryExportQuerySchema, memoryListQuerySchema } from "./memory.schema";


// Phase 97 (MEM-03) — auto-extraction JSON ops gate (trust boundary between
// extraction LLM output and the Prisma write path).
export { memoryOpsSchema, validateMemoryOperations } from "./memory.schema";
export type { MemoryOp } from "./memory.schema";

// Phase 98 (POST-01 D-06) — auto tags + follow-up suggestion LLM JSON validation.
// Phase 157 (CSW-12 D-08) — batched title + tags + follow-up LLM JSON validation.
export { autoTagsSchema, batchedPostProcessingSchema } from "./postProcessing.schema";


// Phase 100 (PLG-01 D-04) — filter plugin admin API request schema.
export { updateFilterSchema } from "./filter.schema";

// Phase 113 (AUTH-01) — Enterprise SSO config write/response contracts.
export { } from "./sso.schema";
export type { SaveSsoConfigInput, SsoConfigResponse } from "./sso.schema";

// Quick 260808-p5y — public SSO status response contract (login page).
export type { SsoStatusResponse } from "./sso.schema";

// Phase 143 (D-07) — pure OIDC provider derivation (shared single source of
// truth; community auth.ts imports it, enterprise keeps a local copy for now).
export { getOidcProviderFromDiscoveryUrl } from "./sso.schema";

// Phase 153 (WIKI-01) — graph-wiki trigger request validation (separate
// endpoint from the LLM synthesis trigger; D-01 + A2).
export { graphWikiTriggerSchema } from "./graphWiki.schema";

// Phase 140 (EPA-01) — Enterprise Plugin Architecture contract.
/**
 * @enterpriseConsumed — RUNTIME-imported by the private enterprise repo
 * (routes/sso.ts safeParse). knip cannot see the root link: dep.
 */
export { saveSsoConfigSchema } from "./sso.schema";
/**
 * @enterpriseConsumed — imported (type) by the private enterprise repo.
 */
export type { EnterprisePlugin, MinimalExpressApp, MinimalLogger } from "./plugin.schema";
// Structural interfaces (no express/@prisma/client import — shared zero-dep rule).
export { API_VERSION } from "./plugin.schema";
export type { PluginContext, MinimalPrismaClient, PluginScheduler, AuditLog, AuditLogEvent, ConfigKeyValidator } from "./plugin.schema";
// Phase 186 (SAAS-05) — contract v2: SaaS plugin seam + minimal Part I hook
// interfaces (D-01/D-03/D-04/D-06/D-07).
export type {
  SaaSPluginContext,
  SaaSPlugin,
  BillingProvider,
  QuotaEnforcer,
  PlanResolver,
  TenantProvisioner,
} from "./plugin.schema";

// Phase 146 (EPA-06) — backup/restore contracts for the Settings Backup page.
// De-exported by the Phase 180-01 dead-code sweep (4fd76c5f) because knip
// cannot see the private enterprise sibling repo; restored (gap G-186-01,
// Plan 06) for the enterprise backup routes (backupDestinations.ts,
// backupJobs.ts, restore.ts), which import the RUNTIME names listed below.
// Tag format follows the Phase 140 block: one JSDoc tag per export
// statement (knip's tag extraction reads the comment directly above each
// export — a block-level tag above the FIRST statement does not cover the
// statements that follow).
/**
 * @enterpriseConsumed — RUNTIME-imported by the private enterprise repo
 * (routes/backupDestinations.ts, routes/backupJobs.ts, routes/restore.ts
 * safeParse). knip cannot see the private repo. Consumed subset: the 10
 * runtime schema names below; frequencySchema/Frequency and the Input types
 * ride along per the schema-export-pairs-with-its-type convention.
 */
export {
  createBackupDestinationSchema,
  updateBackupDestinationSchema,
  backupDestinationIdParamSchema,
  restoreRequestSchema,
  backupLogIdParamSchema,
  backupLogListQuerySchema,
} from "./backup.schema";
/**
 * @enterpriseConsumed — inferred Input types of the schemas above (shared
 * repo convention: a schema export pairs with its inferred type).
 */
export type {
  CreateBackupDestinationInput,
  UpdateBackupDestinationInput,
  BackupDestinationIdParam,
  RestoreRequestInput,
  BackupLogIdParam,
  BackupLogListQuery,
} from "./backup.schema";
/**
 * @enterpriseConsumed — RUNTIME-imported by the private enterprise repo
 * (routes/backupJobs.ts safeParse): the 4 backup-job CRUD schemas.
 */
export {
  frequencySchema,
  createBackupJobSchema,
  updateBackupJobSchema,
  toggleBackupJobSchema,
  backupJobIdParamSchema,
} from "./backupJob.schema";
/**
 * @enterpriseConsumed — inferred types of the backup-job schemas above
 * (Frequency + 4 Input types, shared repo convention).
 */
export type {
  Frequency,
  CreateBackupJobInput,
  UpdateBackupJobInput,
  ToggleBackupJobInput,
  BackupJobIdParam,
} from "./backupJob.schema";
// Quick 260829-ony — DLP pattern configuration contract (DLP_FEATURES_SPEC §2.3).
export { createDlpPatternSchema, updateDlpPatternSchema, testPatternSchema } from "./dlp.schema";
export type { DlpPatternResponse } from "./dlp.schema";
export { dlpPatternIdParamSchema } from "./dlp.schema";

// Phase 176 (CF-01/D-01) — shared env-config surface (server + collector
// config/env.ts consume these fields; single source kills the "update BOTH"
// duplication). Zero deps beyond zod.
export { embeddingProviderSchema, vectorDbProviderSchema, ollamaKeepAliveSchema } from "./env.schema";

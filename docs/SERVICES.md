
# Server Services

This document describes the service layer of the Simmetric Chat server (`packages/server/src/services/`) — 77 modules that implement the domain logic behind the Express routes. Services are plain TypeScript modules (no framework coupling) that consume the Prisma singleton (`packages/server/src/utils/prisma.ts`), the validated env config (`getEnv()`), the Redis singleton (`getRedis()`), the pg-boss job queue (`getBoss()`), and the winston logger. They are consumed by route handlers (`packages/server/src/routes/`) and by the agent subsystem (`packages/server/src/agent/`), and several of them register pg-boss cron jobs at boot. The layer follows three invariants: **graceful degradation** (Redis, pg-boss, and external providers may be absent — every consumer checks for `null` and falls back), **single-instance singletons** (Redis, pg-boss, encryption keys, license state are cached module-level), and **IoC seams for the enterprise plugin** (`setAuditLogDelegate`, `registerConfigKeyValidator`, `setLimitOverride` are injected by `enterpriseLoader.ts` at boot).

## Service Domains

| Domain | Services | Consumed by |
|---|---|---|
| Auth & identity | `authService`, `apiKeyService`, `tokenRevocation` | `routes/auth.ts`, `routes/apiKeys.ts`, `middleware/auth.ts` |
| License & enterprise seam | `licenseService`, `license-public-key`, `enterpriseLoader`, `eventLogService`, `systemConfigService` (config-key validator seam) | `middleware/license.ts`, `index.ts` boot sequence |
| Agent orchestration support | `agentBudgetService`, `providerService`, `providerCapabilities`, `ollamaClient`, `ollamaAutoDetectService`, `templateService`, `postProcessingService` | `agent/orchestrator.ts`, `agent/builtinSkills.ts`, `agent/modelFallback.ts`, `routes/chatAgentConfig.ts`, `routes/providers.ts` |
| Chat & streaming | `chatArchiveService`, `chatExportService`, `chatImportService` | `routes/chatCrud.ts`, `routes/chatExport.ts`, `routes/chatImport.ts` |
| Search & RAG | `hybridSearchService`, `ftsService`, `rerankService`, `wikiEmbeddingService`, `ragOcrService` | `agent/builtinSkills.ts`, `routes/internalWidget.ts`, `routes/documents.ts`, `routes/archiveSearch.ts` |
| Wiki & archive | `archiveService`, `archivePageService`, `archiveIndexService`, `archiveConfigService`, `archiveGraphService`, `archiveRelatedService`, `archiveInventoryService`, `archiveBacklinkService`, `archiveMaintenanceService`, `archiveLogService`, `archiveSchemaValidator`, `archiveSchemaTemplatesService`, `wikiWriteService`, `wikiLinkService`, `wikiLockService`, `wikiMarkdownService`, `wikiGraphService`, `wikiGraphStage` | `routes/archives.ts`, `routes/archivePages.ts`, `routes/wikiChat.ts`, `routes/archiveGraph.ts`, `routes/archiveSchemaTemplates.ts`, `routes/wikiLinks.ts` |
| Ingestion & uploads | `uploadDraftService`, `archiveImportService`, `ocrJobService` | `routes/uploads.ts`, `routes/archives.ts`, `routes/ocr.ts`, `routes/documents.ts` |
| Synthesis | `synthesisService` (facade), `synthesis/synthesisStages.ts`, `synthesisBudgetService`, `synthesisContradictionService`, `synthesisFidelityService`, `synthesisOrphanService`, `synthesisPageWriter`, `synthesisTriggerService` | `routes/synthesis.ts` |
| Webhooks, push & widget | `webhookService`, `widgetAnalyticsService`, `widgetCacheBustService`, `avatarService` | `routes/webhooks.ts`, `routes/push.ts`, `routes/internalWidget.ts`, `routes/widgets.ts` |
| Schedulers & jobs (pg-boss cron) | `jobQueue`, `chatMessageReaperJob`, `uploadDraftReaperJob`, `vectorCleanupJob`, `synthesisReaperJob`, `mcpReaperJob`, `mcpHealthCheckJob`, `archiveConsistencyService` (scheduler) | `index.ts` production boot block |
| MCP | `mcpUninstallService` | `routes/mcp.ts`, `agent/mcpClient.ts` |
| Web search & DLP | `webSearchService`, `dlpFilter` | `agent/builtinSkills.ts`, `routes/chat.ts`, `agent/memoryService.ts` |
| Infrastructure & misc | `redisService`, `distributedLock`, `encryptionService`, `seedService`, `topicClassificationService`, `webSearchService` helpers, backfill scripts (`rawSourcesRenameBackfill`, `archivePageTitleBackfill`, `searchVectorMultiBackfill`, `archiveLocalLLMOnlyPropagation`) | boot, `routes/settings.ts`, `routes/system.ts` |

## Key Services by Domain

### Auth, API keys, and token revocation

- **`authService.ts`** — `register`, `login`, `generateToken`, `verifyToken`, `getUserWithRoles`, `getCachedUserWithRoles`, `invalidateAuthCache`. bcrypt (12 salt rounds) password hashing, JWT issuance/verification, and role/permission loading with an optional Redis auth cache.
- **`apiKeyService.ts`** — `createApiKey`, `validateApiKey`, `listApiKeys`, `revokeApiKey`, plus `getHmacSecret`/`hmacSha256`. Widget/API keys are verified via a deterministic HMAC-SHA256 digest against a single indexed `findUnique({ key_hash })` — no bcrypt loop (; added the original `take: 10` bcrypt cap).
- **`tokenRevocation.ts`** — `isTokenRevoked`, `revokeToken`. JWT `jti` blacklist stored as `rev:jti:<jti>` keys in Redis (TTL = session expiry); degrades to allow-all when Redis is absent.

### License and enterprise plugin seam

- **`licenseService.ts`** — `initLicense`, `getLicenseInfo`, `verifyLicenseKey`, `isFeatureEnabled`, `getFeatureLimit`, `setLimitOverride`, `clearLimitOverrides`. Local, read-only RS256 JWT validation against `LICENSE_PUBLIC_KEY`; tier features come from `COMMUNITY_FEATURE_DEFAULTS`/`ENTERPRISE_FEATURE_DEFAULTS` in `@simmetric-chat/shared`. `setLimitOverride`/`clearLimitOverrides` back the enterprise plugin's `ctx.overrideFeatureLimit` (overrides are cleared at the start of every `initLicense()`).
- **`license-public-key.ts`** — exports `LICENSE_PUBLIC_KEY_PEM`, the embedded verification key.
- **`enterpriseLoader.ts`** — `loadEnterprisePlugin(app)`, `shutdownEnterprisePlugin()`, `__pluginResolver`. The single `require.resolve("@simmetric-chat/enterprise")` seam; absent package → info-level community mode, broken install → `process.exit(1)`.
- **`eventLogService.ts`** — `logEvent`, `setAuditLogDelegate`. Community audit/event shim that maps entity actions to webhook events (`chat.created`, `document.uploaded`, …) and no-ops unless the enterprise plugin injects a writer via `setAuditLogDelegate` (IoC).
- **`systemConfigService.ts`** — `getAllSettings`, `getSetting`, `updateSettings`, `seedConfigDefaults`, `ensureSetupWizardMode`, `registerConfigKeyValidator`. Settings resolving DB > ENV > default for UI-editable keys (ENV-only for ALWAYS_READONLY infra keys); `registerConfigKeyValidator` lets the enterprise branding validator reject non-Enterprise `BRANDING_*` keys.

### Agent orchestration support

- **`agentBudgetService.ts`** — `AgentBudgetTracker`, `LoopDetector`, `AgentConcurrencyError`, `AgentSkillTimeoutError`, `truncateToolOutput`, `isToolResult`, `truncateContextToByteBudget`. Watchdogs for the ReAct loop: wallclock timeout, token budget, context byte cap, tool-output truncation, per-skill timeout, loop detection, and per-user concurrency cap.
- **`providerService.ts`** — `listProviders`, `createProvider`, `updateProvider`, `deleteProvider`, `listModels`, `refreshModels`, `setDefaultProvider`, `setDefaultModel`, `resolveProviderConfig`, `callNonStreamingLLM`, `startOllamaPull`, `validateOllamaModelAvailability`, plus Gemini body/response helpers. Provider registry CRUD and the resolution chain (per-chat override → workspace default → global default → env).
- **`providerCapabilities.ts`** — `EMBEDDING_PATTERNS`, `CAPABILITY_OVERRIDES`, `NATIVE_TOOLS_OVERRIDES`, `findPresetNativeToolsReliable`. Capability inference (embedding, native tool support) per provider type/preset.
- **`ollamaClient.ts` / `ollamaAutoDetectService.ts`** — `getOllamaClient` (shared fetch-based client) and `autoDetectOllama` (boot-time reachability check + model auto-selection from `/api/tags`).
- **`templateService.ts`** — `getTemplateForWorkspace`, `listTemplates`, `resolveSystemPrompt`, `resolveSkills`, `saveTemplateToFile`, `seedTemplates`. Chat-agent template resolution with workspace-scoped config (used by the orchestrator to build the system prompt and skill list).
- **`postProcessingService.ts`** — `generateAutoTitle`, `generateTagsAndFollowUps`, `generateBatchedTitleTagsAndFollowUps`. Post-chat title/tag generation via the configured LLM.

### Chat, export, and import

- **`chatArchiveService.ts`** — `linkArchive`. Links a chat to an archive with workspace-scoped IDOR checks (discriminated-union not-found, never throws).
- **`chatExportService.ts`** — `exportWorkspaceChats`, `exportSingleChat`, `sanitizeFilename`. Markdown/JSON chat export.
- **`chatImportService.ts`** — `detectImportFormat`, `parseChatGPT`, `parseClaude`, `parseOpenWebUI`, `parseGeneric`, `generateImportPreview`, `importChats`. Multi-format chat history import with preview.

### Search & RAG

- **`hybridSearchService.ts`** — `hybridSearch`, `hybridSearchWithRerank`, `multiWorkspaceHybridSearch`, `checkCollectorHealth`. Fusion of Postgres FTS (tsvector) with vector search via the collector (RRF, `RRF_K = 60`); optional cross-encoder rerank pass.
- **`ftsService.ts`** — `MULTI_CONFIG_TSVECTOR`, `MULTI_CONFIG_TSQUERY`, `MULTI_CONFIG_PLAINTO_TSQUERY`, `initPostgreSQLFTS`, `ftsSearch`. Parameterized multi-config (per-column weight) tsvector/tsquery fragments used via `Prisma.raw` — the single source of FTS expression truth (CI grep gate).
- **`rerankService.ts`** — `rerankCandidates`. Forwards query/candidate pairs to the collector's CrossEncoder when `rag_reranker_enabled` is on; returns candidates unchanged when off (DB > ENV > default).
- **`wikiEmbeddingService.ts`** — `indexWikiPage`, `indexAllWikiPages`, `deleteWikiVectors`. Keeps wiki page vectors in sync with the resolved vector provider.
- **`ragOcrService.ts`** — `extractTextFromPdf`, `cleanupOcrTextFile`. Server-side PDF text extraction for the RAG leg.

### Wiki & archive

- **`archiveService.ts`** — `createArchive`, `getArchive(s)`, `updateArchive`, `deleteArchive`, `createArchiveFromTemplate`. Archive CRUD.
- **`archivePageService.ts`** — `createPage`, `getPage`, `getPages`, `updatePage`, `deletePage`, `deleteGeneratedPages`, `rebuildIndex`. Archive page CRUD with git-backed writes.
- **`archiveIndexService.ts`** — `generateIndexFile`, `rebuildAllIndexFiles`. Markdown index generation per archive.
- **`archiveConfigService.ts`** — `getArchiveConfig`, `setArchiveConfig`, `deleteArchiveConfig`, `getSynthesisOverrides`. Per-archive synthesis/parsing config.
- **`archiveGraphService.ts` / `archiveRelatedService.ts`** — `buildArchiveGraph`, `computeRelatedPairs`, `computeRelatedCounts`. Graph construction and related-page discovery (link/embedding hybrid).
- **`archiveBacklinkService.ts`** — `establishBacklinks`, `propagateRename`. Wikilink backlink maintenance on page write/rename.
- **`archiveMaintenanceService.ts`** — `getMaintenanceSuggestions`. Surfaces stale/contradiction/redlink pages.
- **`archiveSchemaValidator.ts`** — `validatePageContent`, `validateSlugAgainstConvention`. Blocks human writes on errors, warns for agent writes.
- **`archiveSchemaTemplatesService.ts`** — `listTemplates`, `getTemplate`, `createTemplate`, `applyTemplate`, `seedBuiltInTemplates`. Reusable schema templates.
- **`wikiWriteService.ts`** — `generatePreview`, `applyWikiEdit`, `revertWikiEdit`, `destructiveClassifier`. Agent wiki write pipeline (preview → apply → revert) with destructiveness classification.
- **`wikiLinkService.ts`** — `resolveWikilinks`, `extractWikilinkSlugs`, `redirectWikilinks`. Wikilink resolution and redirect following.
- **`wikiLockService.ts`** — `withPageLock`. Per-`{archiveId}:{slug}` async write lock spanning filesystem, DB, and git commit.
- **`wikiMarkdownService.ts`** — `generateWikiMarkdown`, `indexArticle`, `communityArticle`, `godNodeArticle`. Deterministic markdown generation for graph runs.
- **`wikiGraphService.ts`** — `buildGraphologyGraph`, `computeGodNodes`, `detectCommunities`, `mulberry32`, `cyrb53`. Deterministic graph pipeline (graphology 0.26.0 + Louvain pinned exactly; golden-snapshot tested).
- **`wikiGraphStage.ts`** — `runWikiGraphPipeline`. Full graph run orchestration (stages → markdown → git commit).

### Ingestion & uploads

- **`uploadDraftService.ts`** — `dispatchUploadDraft`, `dispatchRagLeg`, `dispatchKbLeg`, `dispatchKbLegUrl`, `enrichDraftWithLegStatus`. Fan-out of uploads to the collector RAG leg and the archive KB leg (`Promise.allSettled`; per-leg failure does not invalidate the other).
- **`archiveImportService.ts`** — `dispatchCopyDocToArchive`, `dispatchUploadToArchive`, `handleArchiveImportCallback`, `assertDocumentReadAccess`. Feeds the collector's parse-only pipeline via HTTP with `COLLECTOR_SECRET`.
- **`ocrJobService.ts`** — `createOcrJob`, `startOcrJob`, `updateJobProgress`, `completeOcrJob`, `failOcrJob`, `getOcrJob`, `getNextPendingJob`, `resetStaleJobs`, `getActiveJobCount`, `cleanupOrphanedRawFiles`. OCR job lifecycle (polled by the scheduler, HTTP-only with the collector).

### Synthesis

- **`synthesisService.ts`** — facade preserving the public surface: `runSynthesisPipeline`, `callSynthesisLLM`, `getSynthesisConfig`, `defaultRunName`, `defaultWikiGraphRunName`. Pipeline body lives in `synthesis/synthesisStages.ts` (`runPipelineStages`, `callSynthesisLLMStage`, …).
- **`synthesisBudgetService.ts`** — `BudgetTracker`, `loadBudgetConfig`. Token/call/page budgets per run.
- **`synthesisContradictionService.ts`** — `detectContradictions`, `jaccardPairCandidates`, `judgePairContradiction`, `buildContradictionMarker`, `extractClaimSummary`. Jaccard (threshold 0.15) + LLM judge contradiction detection.
- **`synthesisOrphanService.ts`** — `detectOrphanPages`, `detectBrokenWikilinks`.
- **`synthesisPageWriter.ts`** — `buildSourceFrontmatter`, `applyApprovedChanges`. Persists approved synthesis changes to pages.
- **`synthesisTriggerService.ts`** — `onOcrJobCompleted`, `getNextSynthesisJob`, `getPendingSynthesisCount`, `isCooldownActive`. Cooldown-gated queue for post-OCR synthesis runs.
- **`synthesisFidelityService.ts`** — `runFidelitySample`. Weekly (Sun 03:00) fidelity sampling of synthesis output.

### Webhooks, push, and widget

- **`webhookService.ts`** — `dispatchWebhookEvent`. Fan-out of events (`*` or explicit list) to enabled webhook URLs with retry/backoff (`MAX_RETRIES = 3`), non-blocking.
- **`widgetAnalyticsService.ts`** — `recordWidgetEvent`, `getWidgetAnalyticsDaily`, `getWidgetTopicDistribution`, `getWidgetAnalyticsSummary`. Topic classification-backed analytics for widget conversations.
- **`widgetCacheBustService.ts`** — `fireWidgetCacheBust`. Fire-and-forget HTTP POST to the widget service's config cache-bust endpoint (5-minute widget config cache).
- **`avatarService.ts`** — `avatarUpload`, `resizeAvatar`, `deleteOldAvatars`, `removeAvatarFiles` (sizes 32/64/128, max 512 KB). Note: Web Push lives in `routes/push.ts` (`sendPushNotification` with VAPID), not in a service module.

### Schedulers & jobs (pg-boss cron, production boot)

All schedulers run only when `getBoss()` is non-null; otherwise they log a warn and skip (no fallback timers). Registered in `index.ts`'s `NODE_ENV === "production"` boot block:

- **`jobQueue.ts`** — `startJobQueue`, `stopJobQueue`, `getBoss`, `schedule`, `createQueue`. pg-boss singleton with its own `pg.Pool` (never touches the Prisma adapter pool); `start()` failure degrades to `null` without throwing.
- **`chatMessageReaperJob.ts`** — `initChatMessageReaperScheduler`, `runReaperCycle`. Daily 03:00 chat-message retention reaper (retention settings, hard delete of expired messages).
- **`uploadDraftReaperJob.ts`** — `initUploadDraftReaperScheduler`, `runReaperCycle`. Daily 03:00 reaper for expired `UploadDraft`s.
- **`vectorCleanupJob.ts`** — `initVectorCleanupScheduler`, `runVectorCleanupCycle`. Purges orphaned vector chunks for soft-deleted documents (retry-aware).
- **`synthesisReaperJob.ts`** — `initSynthesisReaperScheduler`, `runSynthesisReaperCycle`. 15-min reaper flipping orphaned `PROCESSING` runs to `FAILED`.
- **`mcpReaperJob.ts`** — `initMCPReaperScheduler`, `runReaperCycle`, `runReconnectCycle`. 5-min probe of MCP connections (`listTools`), disconnects stale ones, reconnects enabled.
- **`mcpHealthCheckJob.ts`** — `initMCPHealthCheckScheduler`, `runHealthCheckCycle`, `pingMCPServer`.
- **`archiveConsistencyService.ts`** — `initWikiConsistencyScheduler`, `runWikiConsistencyCheck`, `reindexDriftedPages`. Wiki index consistency drift check.

### MCP

- **`mcpUninstallService.ts`** — `uninstallMcpServer`. Atomic marketplace MCP uninstall: disconnect transport → unregister skills → hard-delete record (pins survive).

### Infrastructure

- **`redisService.ts`** — `getRedis`, `isRedisAvailable`. Lazy ioredis singleton; `null` when `REDIS_URL` absent or connection fails.
- **`distributedLock.ts`** — `getRedlock`, `withDistributedLock`, `acquireRedisLock`, `releaseRedisLock`, `acquireBackupMutex`, `releaseBackupMutex`. Redis-based mutexes for backup and cross-instance jobs; degrade to no-op/in-memory when Redis is absent.
- **`encryptionService.ts`** — `encrypt`, `decrypt`, `getDecryptKeyChain`, `maskApiKey`. AES-256-GCM; key from `ENCRYPTION_KEY` (base64, 32 raw bytes) when set, else legacy `scryptSync(JWT_SECRET)` derivation (backward-compatible).
- **`seedService.ts`** — `seedPermissions`, `seedRoles`, `seedMenuSections`, `seedCatalogEntries`, `seedServiceAccount`, `seedWidgetApiKey`, `seedBootstrapAdmin`, `seedDatabase`. Idempotent bootstrap seeding.
- **`topicClassificationService.ts`** — `classifyTopic`, `TOPIC_CATEGORIES` (`pricing | support | product | technical | general`). LLM prompt classification with "general" fallback.
- **Backfill scripts** — one-shot migrations: `rawSourcesRenameBackfill` (`renameRawToRawSources`), `archivePageTitleBackfill` (`backfillArchivePageTitles`), `searchVectorMultiBackfill` (`backfillSearchVectorMulti`), `archiveLocalLLMOnlyPropagation` (`backfillLocalLLMOnlyPropagation`).

## Usage Patterns

### Pattern 1 — Route handler → service with schema validation

Routes validate input with shared Zod schemas (`safeParse`, never `parse`), then call service functions that return typed results or throw. Errors surface through the standard `{ error: string }` envelope (400 adds `details`).

```ts
// routes/auth.ts (pattern as implemented by authService consumers)
import { register, login } from "../services/authService";
import { loginSchema } from "@simmetric-chat/shared";

router.post("/login", async (req, res) => {
const parsed = loginSchema.safeParse(req.body);
if (!parsed.success) {
return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
}
const result = await login(parsed.data); // throws on bad credentials
res.json(result);
});
```

### Pattern 2 — Graceful degradation: always check the optional singleton

Optional infrastructure (Redis, pg-boss) must never break the request path. Consumers check `getRedis()`/`getBoss()` for `null` and fall back to in-process behavior:

```ts
import { getRedis } from "../services/redisService";

const redis = getRedis();
if (redis) {
await redis.set(`key`, value, "EX", ttl);
} else {
// single-instance fallback: in-memory or DB-backed behavior
}
```

The same pattern applies to pg-boss schedulers: `getBoss() === null` means the 7 production-boot cron jobs (the wiki-consistency scheduler registers outside that block) are offline but REST/SSE keep working, and to the enterprise plugin: `logEvent()` no-ops in community builds until `setAuditLogDelegate` is injected.

### Pattern 3 — Agent skills consume services directly

Built-in agent skills are thin wrappers over services — e.g., `agent/builtinSkills.ts` calls `hybridSearchWithRerank` (search), `searchWeb` (web search), `getPage` (wiki read), `generatePreview` (wiki write), and `getSetting` (config) — so any service used by a skill must stay dependency-light and non-blocking.

## Related Documents

- `docs/ARCHITECTURE.md` — system-level view, data flow, component diagram
- `docs/CONFIGURATION.md` — environment variables consumed by these services (`AGENT_*` budgets, `ENCRYPTION_KEY`, `VAPID_*`, `REDIS_URL`, `COLLECTOR_SECRET`, …)
- `docs/SCALING.md` — Redis scale layer, pg-boss job queue, distributed locks
- `docs/ENTERPRISE_PLUGIN.md` — `PluginContext` contract injected through `enterpriseLoader.ts`
- `docs/API.md` — endpoint reference backed by these services

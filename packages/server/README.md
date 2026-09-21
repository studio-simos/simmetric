<!-- generated-by: gsd-doc-writer -->
# @simmetric-chat/server

Express API backend for Simmetric Chat. Handles authentication, RBAC, agent orchestration with SSE streaming, document management, workspace/project scoping, webhooks, push notifications, analytics, MCP marketplace, per-chat model management, and the embeddable widget system.

Part of the [Simmetric Chat](../../README.md) monorepo. This is a **private package** — it is not published to any registry; it is built and run from the workspace.

## Overview

This package is the core HTTP API server for the Simmetric Chat platform. It exposes REST + SSE endpoints consumed by the frontend, collector, and external widget clients, and orchestrates LLM interactions via a ReAct agent loop with hybrid RAG search.

- **Port**: `3000` (configurable via `SERVER_PORT`)
- **Protocol**: HTTP/SSE (Web Push via VAPID)
- **ORM**: Prisma 7.10 with PostgreSQL (`@prisma/adapter-pg` + `pg` Pool, singleton at `src/utils/prisma.ts` with the `withSoftDelete()` helper — never `new PrismaClient()` outside the singleton)
- **Job scheduling**: pg-boss 12.28 cron jobs (MCP health check, MCP/synthesis/upload-draft/chat-message reapers, vector cleanup, fidelity sampling, wiki consistency) — graceful degradation to offline when Postgres is unavailable; the OCR and synthesis pipelines run as in-process 10-second pollers
- **Auth**: JWT (Bearer, with UUIDv4 `jti` claims) and API keys (`X-Api-Key`, HMAC-SHA256 verified)
- **Module system**: CommonJS, TypeScript target `ES2022`, `strict: true`
- **Enterprise plugin seam**: optional `@simmetric-chat/enterprise` peer dependency loaded via `src/services/enterpriseLoader.ts` (SSO/SCIM, audit log, white-label branding, backups). Absent = community mode (graceful); broken install = fail-loud `process.exit(1)`. See `docs/ENTERPRISE_PLUGIN.md`.
- **Scale layer (v0.19)**: optional Redis (`REDIS_URL`) enables multi-instance horizontal scaling — shared rate-limit stores, distributed locks (redlock), JWT `jti` revocation blacklist, auth-context caching, SSE pub/sub fan-out, and system-config caching. All Redis features degrade gracefully to single-instance mode when `REDIS_URL` is absent.

## Entry Points

| File | Purpose |
|------|---------|
| `src/index.ts` | Main application entry point — exports `createApp()` (used by supertest integration tests) and `mountCatchAlls()`; when run directly it boots: production guards (`ENCRYPTION_KEY` fail-loud, `REDIS_URL` advisory) → `prisma.$connect()` → auto-seed (roles/permissions/menu sections → `initLicense()` → workspace templates → config defaults + setup-wizard-mode derivation → MCP catalog, widget service account + widget API-key row, bootstrap admin → idempotent backfills) → `initPostgreSQLFTS()` → `initFilters()` → `autoDetectOllama()` → `startJobQueue()` (pg-boss) → `loadEnterprisePlugin(app)` → `mountCatchAlls()` → Ollama model refresh → production-only schedulers (MCP health check, MCP/synthesis/upload-draft/chat-message reapers, vector cleanup, fidelity sampling, MCP connection init) → OCR + synthesis pipeline pollers and the wiki-consistency cron (run in dev and production alike) → graceful shutdown (SIGTERM/SIGINT) |
| `dist/index.js` | Compiled output for production (`pnpm build` then `pnpm start`, guarded by `check:build-freshness`) |

Production boot requires `ENCRYPTION_KEY` (fail-loud `process.exit(1)` when unset — the legacy `scryptSync(JWT_SECRET)` fallback is disabled in production).

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server with `tsx watch` (auto-reload on change) |
| `pnpm start` | Verify build freshness then run compiled production build (`node dist/index.js`) |
| `pnpm build` | Compile TypeScript to `dist/` (via `tsconfig.build.json`) and copy workspace templates (`src/templates/*.json` → `dist/templates/`) |
| `pnpm typecheck` | Run `tsc --noEmit` |
| `pnpm lint` | Run ESLint on `src/` |
| `pnpm test` | Run Jest unit tests (mocked DB, `@swc/jest` transform) |
| `pnpm test:integration` | Run Jest integration tests against real PostgreSQL (per-file worker DBs) |
| `pnpm db:generate` | Regenerate Prisma client + run `scripts/fix-prisma-pnpm.cjs` symlink fix |
| `pnpm db:migrate` | Apply Prisma migrations interactively |
| `pnpm db:migrate:guard` / `pnpm db:migrate:reset:guard` | Guarded migration/reset runners (safety checks before destructive DB operations) |
| `pnpm db:seed` | Seed default roles, permissions, templates, config |
| `pnpm audit:migrations` | Audit Prisma migrations for destructive operations (regenerates `docs/MIGRATION_AUDIT.md`) |
| `pnpm generate-apikey` | Generate a widget API key for internal auth |
| `pnpm rotate-encryption-key` | Rotate the AES-256-GCM encryption key |
| `pnpm verify-encryption-key` | Verify encryption key integrity |
| `pnpm license:check` | License diagnostics CLI — exit codes: `0` valid/entitled, `1` key does not entitle, `2` env error; `-- --json` for machine-readable output |
| `pnpm check:build-freshness` | CI/local guard ensuring `dist/` is up to date with `src/` |
| `pnpm smoke:ollama` | Dual-runtime (tsx CJS vs node dist) `ollama` package resolution gate |
| `pnpm smoke:license-e2e` | End-to-end gate for the license diagnostics surface (diagnose endpoint + CLI, canary-absence checks) |
| `pnpm smoke:multi-instance` | Two-instance Redis scale smoke (jti revocation, shared rate-limit bucket, distributed locks) |

Run any of these from the workspace root with `pnpm --filter server <script>` (e.g. `pnpm --filter server test`).

## Directory Structure

```
src/
  index.ts              # Express app bootstrap (createApp + mountCatchAlls), boot sequence
  routes/               # Domain route files (one per resource, 49 files)
  services/             # Business logic and domain services (78 files, incl. synthesis/)
  middleware/           # Express middleware (auth, RBAC, rate limit, license, widget CORS, archiveAccess, uploadGate)
  agent/                # ReAct orchestrator, LLM streaming (llmStreaming/), MCP client/server, skills, memory
  config/               # Environment validation (env.ts), Swagger spec (swagger.ts)
  filters/              # Content filter plugin chain (filterRegistry, filterChain, plugins/dlp.ts)
  ocr/                  # OCR pipeline internals (modelRegistry, stages, quality scoring, pdf renderer)
  urlIngestion/         # URL ingestion pipeline
  utils/                # Prisma singleton, logger, file/archive helpers
  types/                # Ambient type declarations (redlock.d.ts, swagger-jsdoc.d.ts)
  generated/            # Generated Prisma client output
  templates/            # Workspace template definitions (JSON)
  smoke/                # Runtime smoke scripts (ollamaJs.smoke.ts)
  __tests__/            # Unit and integration tests + helpers/fixtures (233 TS files: 220 test files + helpers/fixtures)
  __mocks__/            # Test mocks
prisma/
  schema.prisma         # Database schema (single source of truth)
  schema-enterprise.prisma  # SSO schema fragment (SsoConfig/IdentityProvider/ScimGroup; merged at generate time via prismaSchemaFolder)
  seed.ts               # `prisma db seed` — idempotent RBAC seed
  migrations/           # Prisma migration files
scripts/
  generate-widget-apikey.js
  fix-prisma-pnpm.cjs
  audit-migrations.ts
  migrate-guard.ts
  migrate-reset-guard.ts
  check-license.ts
  rotate-encryption-key.ts
  verify-encryption-key.ts
  smoke-license-e2e.ts
  smoke-multi-instance.ts
  backfill-model-display-names.ts
  fix-ollama-baseurl.js
  check-build-freshness.cjs
  reindex-chunkids.ts
  reindex-archive-wiki.ts
  inspect-embeddings.ts
  inspect-mcp.ts
  inspect-rag.ts
  replay-agent.ts
  fix-vector-url.ts
  verify-squash-identity.ts
  verify-squash-seed.ts
  istruzioni-widget-apikey.txt
  __tests__/            # Script unit tests (check-license, reindex-chunkids)
```

### Key Directories

- **`routes/`** — HTTP route handlers. One file per domain: `auth.ts`, `users.ts`, `roles.ts`, `workspaces.ts`, `projects.ts`, `documents.ts`, `chat.ts` + chat splits (`chatCrud.ts`, `chatList.ts`, `chatAgentConfig.ts`, `chatExport.ts`, `chatImport.ts`, `chatRetention.ts`, `chatTokens.ts`), `widgets.ts`, `internalWidget.ts`, `mcp.ts`, `mcpPins.ts`, `marketplace.ts`, `archives.ts` + archive splits (`archiveIndex.ts`, `archivePages.ts`, `archiveSearch.ts`, `archiveGraph.ts`, `archiveConfig.ts`, `archiveExport.ts`, `archiveImport.ts`, `archiveSchemaTemplates.ts`), `synthesis.ts`, `ocr.ts`, `providers.ts`, `providerPresets.ts`, `analytics.ts`, `settings.ts`, `system.ts`, `license.ts`, `templates.ts`, `skills.ts`, `uploads.ts`, `wikilinks.ts`, `wikiChat.ts`, `webhooks.ts`, `push.ts`, `apiKeys.ts`, `health.ts`, `memories.ts`, `filters.ts`, `dlpPatterns.ts`, `e2eHelpers.ts`. SSO (SAML/OIDC), SCIM, and backup routes are mounted by the enterprise plugin (`ctx.mountProtected` / `ctx.mountPublic`) — in a community build those paths 404.
- **`services/`** — Business logic: `authService.ts`, `apiKeyService.ts`, `licenseService.ts`, `webhookService.ts`, `systemConfigService.ts`, `hybridSearchService.ts`, `ftsService.ts`, `encryptionService.ts`, `archiveService.ts`, `synthesisService.ts`, `ocrJobService.ts`, `providerService.ts`, `agentBudgetService.ts`, `dlpFilter.ts`, `seedService.ts`, `eventLogService.ts`, `templateService.ts`, `redisService.ts`, `distributedLock.ts`, `tokenRevocation.ts`, `jobQueue.ts` (pg-boss singleton), `enterpriseLoader.ts`, `webSearchService.ts`, `uploadDraftService.ts`, `avatarService.ts`, `ollamaAutoDetectService.ts`, `rerankService.ts`, `postProcessingService.ts`, and more (78 files, incl. `synthesis/`).
- **`middleware/`** — Cross-cutting concerns: `auth.ts` (JWT/API key + jti revocation), `rbac.ts` (role/permission checks + IDOR prevention), `rateLimit.ts` (tiered rate limiting, Redis-backed when available), `license.ts` (feature gating, HTTP 402), `widgetCors.ts` (dynamic CORS for widget embeds), `archiveAccess.ts` (archive-scoped access), `uploadGate.ts` (non-admin upload gating).
- **`agent/`** — Agent orchestration (`orchestrator.ts`), LLM streaming adapters (`llmStreaming/` — per-provider parsers for Ollama/OpenAI/Anthropic/Gemini + reasoning formats; facade at `llmStreaming.ts`), built-in skills (`builtinSkills.ts`), skill registry (`skills.ts`), MCP client/server (`mcpClient.ts`, `mcpServer.ts`), implicit tool-call mapping (`implicitToolCall.ts`), tool-call resolver (`toolCallResolver.ts`), model fallback (`modelFallback.ts`), plan parser/runner (`planParser.ts`, `planRunner.ts`), context compaction (`contextCompaction.ts`), citation dedup (`citationDedup.ts`), memory subsystem (`memoryExtraction.ts`, `memoryRetrieval.ts`, `memoryPathRank.ts`, `memorySandbox.ts`, `memoryService.ts`), agent types (`agentTypes.ts`).
- **`filters/`** — Content filter plugin chain: `filterRegistry.ts`, `filterChain.ts`, `initFilters.ts`, and the DLP plugin (`plugins/dlp.ts`, priority -1) wrapping `src/services/dlpFilter.ts`.
- **`config/`** — `env.ts` validates all environment variables via Zod on startup (`getEnv()` cached, `process.exit(1)` on invalid). `swagger.ts` configures OpenAPI 3.0 documentation (swagger-jsdoc 6.x + swagger-ui-express 5.x) served at `/api-docs`.

## Subsystems

### Authentication & RBAC

- **JWT auth**: Bearer tokens validated by `authMiddleware`; `SESSION_EXPIRY` controls lifetime (default 24h, no refresh). Every token minted by `generateToken` carries a UUIDv4 `jti` claim (`authService.ts`), enabling per-token revocation (see Redis Scale Layer below).
- **API key auth**: `X-Api-Key` header with `sk-` prefix, verified with HMAC-SHA256 against the base64 32-byte `API_KEY_HMAC_SECRET` (`apiKeyService.ts`). The raw key is shown only once at creation.
- **Forced first-login password change**: new users are created with `mustChangePassword: true` (see `authService.ts`). The frontend gates the password-change flow on this flag, and `/set-initial-password` is itself gated on `mustChangePassword` to prevent account takeover.
- **Self-service Registration**: closed by default. `ALLOW_REGISTRATION` defaults to `false` in `src/config/env.ts`; when false, only admins can create users via the admin panel.
- **RBAC**: 31 permissions defined in `packages/shared/src/constants/permissions.ts` (workspace, project, chat, document, admin, creation, provider, archive, backup, memory, filters groups). 2 default roles seeded: `admin`, `user` (admin acts as superuser). 13 menu sections control sidebar visibility (`dashboard`, `chat`, `documents`, `knowledgeBase`, `workspaces`, `projects`, `marketplace`, `mcpConnections`, `eventLog`, `analytics`, `widget`, `settings`, `uploads`) via the `RoleMenuSection` join table.
- **IDOR prevention**: `requireProjectAccess` and `requireWorkspaceAccess` middleware verify ownership/access on every relevant route; soft-deletable queries include `where: { deletedAt: null }` via the `withSoftDelete()` helper. Chat-scoped `archiveId` is threaded deterministically (LLM-passed `metadata.archiveId` ignored for wiki skills) to prevent cross-archive IDOR.

### SSO (SAML / OIDC / SCIM) — enterprise plugin

SSO lives in the `@simmetric-chat/enterprise` plugin (mounted via `ctx.mountPublic` / `ctx.mountProtected` in `register(ctx)`): SAML 2.0 SP-initiated login (`/api/auth/saml/*`), OIDC/OAuth with built-in Google/GitHub/Microsoft providers (`/api/auth/oidc/:provider/login`), and SCIM 2.0 provisioning (`/scim/v2`, Bearer-token auth via `SCIM_BEARER_TOKEN`). The community build exposes none of these paths (they 404). Both SSO flows use JIT user provisioning and replay-protection (SAML `InResponseTo` validation, OIDC `nonce` + signed state cookies). See `docs/ENTERPRISE_PLUGIN.md`.

### Agent & RAG

- **ReAct orchestrator** (`src/agent/orchestrator.ts`): iterative tool-calling loop with wallclock/token/context/loop abort reasons enforced by `agentBudgetService.ts`. Skills are sandboxed — only registered skills can be invoked.
- **Skill registry** (`src/agent/skills.ts`): `registerSkill()` / `getSkillsForWorkspace()` / `resolveSkillsForChat()`. Seven built-in skills (`rag_search`, `memory_search`, `web_search`, `workspace_memory`, `document_temp_process`, `wiki_query`, `wiki_write`) registered on module import; MCP skills registered dynamically with `mcp_${connectionId}_${toolName}` namespacing. `web_search` is double-gated (`ALLOW_WEB_SEARCH` env hard gate + the `web_search_provider` SystemConfig — the old `web_search` license flag was removed in Phase 140); memory retrieval/extraction is always-ON since Phase 140 (the `memory_enabled` license gate was removed — the only gate is `AGENT_MEMORY_REVIEW_INTERVAL` > 0).
- **Implicit tool-call mapping** (`src/agent/implicitToolCall.ts`): maps raw `<search><query>` XML emitted by some cloud providers to skill invocations (exact/endsWith matching, no `includes`). Wired into both ReAct loops.
- **Tool-call resolver** (`src/agent/toolCallResolver.ts`) + **model fallback** (`src/agent/modelFallback.ts`): parse tool calls across the provider formats; `buildFallbackConfig` builds an env-based provider config when DB resolution fails, and `shouldFallbackForDoneReason` maps the LLM termination reason (`doneReason`) to an auto-fallback decision.
- **Hybrid RAG** (`src/services/hybridSearchService.ts`): merges vector store results (LanceDB default, Qdrant, pgvector, or Chroma — resolved via collector HTTP API) with PostgreSQL tsvector full-text search via Reciprocal Rank Fusion with `RRF_K = 60`. Results are tagged `vector`, `fts`, `both`, or `archive`. Multi-workspace queries use a second-pass RRF merge across per-workspace result sets.
- **LLM streaming** (`src/agent/llmStreaming/`): unified SSE output for Ollama, OpenAI, Anthropic, OpenRouter, and Gemini providers (plus any OpenAI-compatible endpoint via the `openai` adapter), with per-provider parsers and reasoning-format support (ollama-thinking, deepseek-tag, gpt-oss-harmony, openai-reasoning, anthropic-thinking-delta). SSE events: `token`, `thinking`, `status`, `plan`, `wiki_edit`, `citations`, `done`, `error`. The `done` event carries `chatId`, `messageId`, `iterations`, `tokenUsage`, `model`, `providerType`, `mcpSources`, `resolvedWikilinks`, `doneReason`, `pipeline`, and `dlp_matches` (when DLP is enabled and matches were found).
- **Model resolution priority**: per-request override (request body > widget pin) → chat provider/model (`chat.providerId`/`chat.model`) → workspace agent config model → default provider (`Provider.isDefault`) → any enabled provider → environment fallback (`LLM_PROVIDER`, `LLM_MODEL`). Provider/model availability is refreshed at startup (`refreshModels` for Ollama providers) and on demand (`POST /api/providers/:id/models/refresh`).

### License Gating

- **Feature flags** (`src/middleware/license.ts`): `requireFeature(flag)` gates boolean enterprise features with HTTP 402 `{ error, feature, tier }`; `requireFeatureLimit(flag, model)` gates numeric limits. 11 flags defined in `packages/shared/src/constants/license.ts`: `sso_enabled`, `audit_log_immutable`, `white_label`, `max_workspaces` (Community 3), `max_projects` (Community 3), `custom_agents` (Community 3), `widget_enabled`, `max_widgets` (Community 1), `backup_enabled`, `max_backup_destinations` (Community 1), `widget_credits_editing`. Community defaults are all-off / limited; Enterprise defaults unlock everything (`Infinity` for numeric limits).
- **Graceful degradation**: `getLicenseInfo()` checks expiration at runtime. An expired Enterprise license automatically reverts to Community tier — no restart needed (limit overrides are cleared reactively).
- **Diagnostics**: two operator-facing surfaces built on the shared `verifyLicenseKey` verifier:
  - `GET /api/license/diagnose` — admin-only endpoint returning tier, licensee, expiry, the closed verification reason enum (`ok` / `missing` / `expired` / `bad-signature` / `malformed` / `schema-mismatch`), env presence booleans, and structural JWT checks. The response body is string-redacted: any occurrence of `LICENSE_KEY` is replaced with `[REDACTED]` (canary-absence guarantee — the raw token never leaves the server).
  - `pnpm license:check` CLI (`scripts/check-license.ts`) — exit-code contract for operators: `0` = valid Enterprise key or Community-entitled state (no key configured), `1` = key exists but does not entitle, `2` = env/config error. `-- --json` emits a machine-readable `CheckResult`. stdout/stderr never carry the key, secret, or decoded payload.

### Redis Scale Layer (v0.19)

When `REDIS_URL` is set, the server operates in multi-instance mode: multiple instances share one Redis for cross-instance state. When absent, every consumer degrades gracefully to single-instance behavior (in-memory / DB fallbacks) — Redis is never required. All interactions go through the lazy singleton `getRedis()` in `src/services/redisService.ts` (ioredis, exponential-backoff reconnect capped at 2s, non-blocking `[redis]`-prefixed warnings on failure). Consumers:

- **Rate-limit stores** (`src/middleware/rateLimit.ts`): the express-rate-limit tier buckets (`rl:auth:` 10/min per IP prod, `rl:api:` 200/min per IP prod, `rl:lead:` 3/h per IP, `rl:probe:` 10/min per IP) back onto `rate-limit-redis` stores when Redis is available; otherwise in-process `MemoryStore` (single-instance). Widget-originated upstream calls are skipped by the API limiter (`X-Widget-Id` header — the widget service throttles them per-widget instead).
- **JWT jti revocation** (`src/services/tokenRevocation.ts`): tokens minted with a UUIDv4 `jti` are checked against a `rev:jti:{jti}` key (SET + TTL, default 86400s) in `authMiddleware` and the auth/register/OCR query-token paths — a blacklisted jti returns 401 "Token revoked" on every instance. Pre-deploy tokens without a `jti` are unaffected.
- **Auth-context cache** (`src/services/authService.ts`): `getCachedUserWithRoles` caches user+roles on `auth:user:{userId}` with TTL = `SESSION_EXPIRY / 1000`, falling through to the DB on miss. `invalidateAuthCache` (fire-and-forget `DEL`) is called on role change, password change, and user delete to prevent stale privilege escalation.
- **SSE pub/sub fan-out** (`src/routes/chat.ts`): each streaming chat publishes events to `sse:chat:{chatId}` after the local write; other instances subscribe via `redis.duplicate()` so any instance can serve a chat stream, not just the one that started it. Single-instance mode skips pub/sub entirely.
- **Distributed locks** (`src/services/distributedLock.ts`): redlock 5.0.0-beta.2 singleton with `retryCount: 0`. `withDistributedLock(resource, durationMs, routine)` wraps the routine in `redlock.using()` (auto-extension heartbeat) and returns `null` on contention (skip — another instance holds the lock); when Redis is absent the routine runs locally and the caller's own guards (`isRunning`, PG mutex) stay authoritative. The legacy backup-mutex/lock helpers moved to the enterprise plugin.
- **System-config cache** (`src/services/systemConfigService.ts`): non-`ALWAYS_READONLY` settings are cached on `config:{key}` (TTL 300s) and invalidated on write; ENV-only keys skip Redis entirely.

### Job Scheduling (pg-boss)

`src/services/jobQueue.ts` manages the `PgBoss` singleton (own `pg.Pool`, auto-creates the `pgboss` schema). `start()` failure degrades to `getBoss() === null` — never throws, never exits. Cron jobs (registered at boot; all production-only except wiki consistency, which registers in every mode):

| Queue | Schedule | Purpose |
|-------|----------|---------|
| `healthcheck_mcp` | every 30 min | Marketplace MCP server health checks |
| `reaper_mcp` | every 5 min | Probes `listTools` on enabled connections, disconnects stale ones |
| `reaper_synthesis` | every 15 min | Flips orphaned `PROCESSING` synthesis runs to `FAILED` |
| `fidelity_sampling` | weekly Sun 03:00 UTC | Synthesis output quality sampling |
| `cleanup_vector` | every 5 min | Retries pending collector vector purges for soft-deleted documents (tombstones a doc after 10 failed attempts) |
| `reaper_upload-draft` | daily 03:00 UTC (cron configurable via the `upload_draft_reaper_cron` SystemConfig) | Soft-deletes expired UploadDrafts + best-effort unlink |
| `reaper_chat-message` | daily 03:00 UTC | Two-pass soft/hard chat-message retention purge (7-day grace, audit logged) |
| `consistency_archive` | hourly | Archive wiki graph drift detection + reindex |

The OCR/URL ingestion pipeline and the synthesis pipeline run as in-process 10-second pollers (with `isRunning` guards and a 2-job concurrency cap for OCR), in dev and production alike. The backup scheduler is registered by the enterprise plugin via the scheduler lifecycle hook. Shutdown drains pg-boss in-flight jobs (4.5s cap) before enterprise teardown and `prisma.$disconnect()`.

### Other Subsystems

- **Synthesis pipeline** (`src/services/synthesisService.ts`): 5-pass pipeline with budget tracking, approval flow, contradiction detection, and scheduled runs. Schemas in `packages/shared/src/schemas/synthesis.schema.ts`.
- **Wiki system**: `[[Page Title]]` wikilink resolution, write preview/approve flow, distillation triggers into the synthesis pipeline. `wiki_query` / `wiki_write` built-in skills; graph services (`wikiGraphService.ts`, `wikiLinkService.ts`, `wikiMarkdownService.ts`) with graphology for graph analytics.
- **OCR pipeline** (`src/services/ocrJobService.ts` + `src/ocr/`): job lifecycle (PENDING → PROCESSING → COMPLETED/FAILED/CANCELLED) with approve/reject actions on completed output (approval creates the archive page), vision pipeline stages (grounding cleanup, hallucination guard, quality scoring, PDF renderer), model catalog, per-user preferences. New OCR models addable via configuration without code changes.
- **Marketplace**: MCP server catalog with install/uninstall, per-chat pin resolution, trust tiers (`official` / `verified_community` / `unverified`).
- **DLP filter** (`src/services/dlpFilter.ts` + `src/filters/plugins/dlp.ts`): regex-based PII scanning (email, credit_card, ssn, api_key, aws_key, private_key) for air-gap privacy. Registered as a filter plugin at priority -1 via `initFilters()`, toggled by the `DLP_ENABLED` system config. Applied to both agent input and SSE output (progressive flush with tail-holdback).
- **MCP connections**: admin CRUD at `/api/mcp-connections`, live status map, test endpoint (10s timeout), `sse` and `streamable-http` transports; MCP server mounted at `/api/mcp` (SSE + message endpoints, protected by the `MCP_API_KEY` Bearer secret or localhost-only fallback).
- **Widget API**: admin CRUD at `/api/widgets` (license-gated); internal API at `/api/internal/widget` (API-key auth, dynamic per-origin CORS via `widgetCors.ts`).
- **Push notifications** (VAPID Web Push via `web-push`; auto-generated keys in dev), **webhooks** (HMAC-SHA256, exponential backoff retry, auto-disable after 10 consecutive failures), **OpenAPI docs** at `/api-docs` (swagger-jsdoc 6.x + swagger-ui-express 5.x), **Winston** structured logging to `storage/logs/`.
- **Memories** (`src/routes/memories.ts`): per-user memory CRUD with auto-extraction every `AGENT_MEMORY_REVIEW_INTERVAL` turns and a `<memory_context>` system-message injection capped by `AGENT_MEMORY_CHAR_LIMIT`. Always-on since Phase 140 (the `memory_enabled` license gate was removed).
- **Filter plugins** (`src/filters/` + `src/routes/filters.ts`): runtime-registered content filter plugins (DLP at priority -1), discovered at startup via `initFilters()`.

## Dependencies

### Internal

- `@simmetric-chat/shared` — Shared types, Zod schemas, constants, permissions (workspace dependency; must be built before server/collector runs: `pnpm --filter @simmetric-chat/shared build`)
- `@simmetric-chat/enterprise` — optional peer dependency (the enterprise plugin; not published, air-gap installed). See `docs/ENTERPRISE_PLUGIN.md`.

### External (key)

- `express` (^5.2.1) — HTTP framework
- `prisma` + `@prisma/client` + `@prisma/adapter-pg` + `@prisma/client-runtime-utils` (^7.10.0) — ORM with PostgreSQL driver adapter
- `pg` (^8.23.0) — PostgreSQL driver (Prisma adapter + pg-boss own pool)
- `pg-boss` (^12.28.0) — cron job queue (reapers, health checks, fidelity sampling, wiki consistency)
- `ioredis` (^5.11.1) + `rate-limit-redis` (^6.0.1) + `redlock` (5.0.0-beta.2) — Redis scale layer (v0.19)
- `@modelcontextprotocol/sdk` (^1.30.0) — MCP client/server
- `jsonwebtoken` (^9.0.3) — JWT auth
- `axios` (^1.19.0) — HTTP client (collector callbacks, LLM APIs, webhooks)
- `helmet` (^8.3.0) — Security headers
- `cors` (^2.8.6) — CORS (allowlist from `ALLOWED_ORIGINS`)
- `cookie-parser` (^1.4.7) — Signed cookies (OIDC state/nonce, SSO session)
- `express-rate-limit` (^8.6.2) — Rate limiting
- `winston` (^3.19.0) — Structured logging
- `web-push` (^3.6.7) — VAPID push notifications
- `swagger-jsdoc` (^6.3.0) + `swagger-ui-express` (^5.0.1) — OpenAPI docs at `/api-docs`
- `jsonrepair` (^3.15.0) — Malformed-JSON fallback for tool-call parsing
- `puppeteer` (^25.9.0) + `@mozilla/readability` — URL ingestion / readability
- `pdfjs-dist` (^6.2.108), `sharp` (^0.35.3) — Document parsing and image processing
- `graphology` (0.26.0) + `graphology-communities-louvain` — wiki graph analytics
- `zod` (^4.4.3) — Schema validation
- `dompurify` (^3.4.14) + `jsdom` (^29.1.1) + `turndown` (^7.2.4) + `markdown-it` (^14.3.0) — HTML/Markdown processing
- `archiver` (^8.0.0) — Archive compression
- `simple-git` (^3.36.0) — Git operations for archive system
- `gray-matter` (^4.0.3) — Frontmatter parsing
- `uuid` (^14.0.2) — ID and API key generation
- `multer` (^2.2.0) — File upload handling
- `dotenv` (^17.4.2) — Environment variable loading
- `tsx` (^4.23.12) — TypeScript execution for dev mode
- `ollama` (^0.6.3) — Ollama client (keep-alive warm KV cache)
- `@tavily/core` (^0.7.8) — Tavily web search
- `@json2csv/plainjs` (^7.0.8) — CSV export (leads, backups)

Test-time: `jest` (^30.4.2) with `@swc/jest` (^0.2.39) transform (`ts-jest` ^29.4.12 retained as rollback only), `supertest` (^7.2.2), `commander` (^15.0.0) for the `license:check` CLI.

See `package.json` for the complete list.

## Environment Variables

The server loads the repo-root `.env` (the single runtime config for all packages; see the root `.env.example`). Tests use `packages/server/.env.test` (must include `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=test`, `COLLECTOR_SECRET`, `API_KEY_HMAC_SECRET`).

Required for startup (Zod-validated in `src/config/env.ts`; `getEnv()` is cached and calls `process.exit(1)` on invalid env):

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for signing JWT tokens (`.min(1)` — required) |
| `COLLECTOR_SECRET` | Secret for server-collector communication on the `X-Collector-Secret` header (`.min(1)` — required) |

`DATABASE_URL` has a code default (`postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat`); `ENCRYPTION_KEY` is required in production only (fail-loud boot refusal when unset).

Commonly configured:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat` |
| `SERVER_PORT` | HTTP port | `3000` |
| `COLLECTOR_PORT` | Collector service port | `3210` |
| `SERVER_URL` | Public server URL | `http://localhost:3000` |
| `COLLECTOR_URL` | Collector service URL | `http://localhost:3210` |
| `WIDGET_SERVICE_URL` | Widget service URL | `http://localhost:3211` |
| `WIDGET_API_KEY` | Shared secret between server and widget service (seedService mints the matching `api_keys` row at boot) | — |
| `ENCRYPTION_KEY` | Base64 32-byte key for AES-256-GCM at rest (falls back to `scryptSync(JWT_SECRET)` in dev/test; required in production) | — |
| `API_KEY_HMAC_SECRET` | Base64 32-byte HMAC-SHA256 signing key for API keys (required when API keys are used) | — |
| `SESSION_EXPIRY` | JWT session lifetime (ms) | `86400000` |
| `REDIS_URL` | Redis connection URL. When set, enables the multi-instance scale layer (shared rate limits, distributed locks, jti revocation, auth/config caches, SSE fan-out); when absent, all features degrade to single-instance mode | — |
| `MCP_API_KEY` | Shared-secret Bearer token for the MCP server; when unset the MCP server is localhost-only | — |
| `LLM_PROVIDER` | Default LLM provider (`openai`, `anthropic`, `ollama`, `openrouter`) | `ollama` |
| `LLM_MODEL` | Default LLM model | `gemma4:latest` |
| `LLM_TEMPERATURE` | LLM temperature (0-2) | `0.7` |
| `LLM_MAX_TOKENS` | Max tokens per completion | `4096` |
| `LLM_TIMEOUT` | LLM request timeout (ms); `0` = no timeout (local LLMs on underpowered hardware need unlimited time) | `0` |
| `LLM_API_KEY` / `LLM_API_BASE_URL` | Optional overrides for the default provider | — |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | OpenAI provider key/model | — |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Anthropic provider key/model | — |
| `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` / `OPENROUTER_MODEL` | OpenRouter provider key / base URL / model | — / `https://openrouter.ai/api` / — |
| `OLLAMA_BASE_URL` | Ollama API base URL | `http://ollama:11434` |
| `OLLAMA_MODEL` / `OLLAMA_API_KEY` | Ollama model override / key | — |
| `OLLAMA_KEEP_ALIVE` | Ollama keep-alive window for warm KV cache | `10m` |
| `EMBEDDING_PROVIDER` | `local`, `openai`, `ollama`, or `hf-local` | `local` |
| `EMBEDDING_MODEL` / `EMBEDDING_API_KEY` | Embedding model name / key for remote providers (optional) | — |
| `VECTOR_DB_PROVIDER` | `lancedb`, `qdrant`, `pgvector`, or `chroma` | `lancedb` |
| `VECTOR_DB_URL` / `VECTOR_DB_API_KEY` | Vector DB connection (for remote providers) | — |
| `ALLOW_WEB_SEARCH` | Enables the `web_search` skill (hard env gate, alongside the `web_search_provider` SystemConfig) | `false` |
| `SEARXNG_URL` | SearXNG instance for web search (air-gap primary) | `http://localhost:8888` |
| `TAVILY_API_KEY` | Optional Tavily cloud search key | — |
| `LICENSE_KEY` | Enterprise license JWT | — |
| `ALLOW_REGISTRATION` | Open user self-service registration | `false` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origin allowlist | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000` |
| `LOG_LEVEL` | Winston log level (`debug`, `info`, `warn`, `error`) | `info` |
| `OCR_MODEL` | OCR model name | `glm-ocr:latest` |
| `OCR_TIMEOUT` | OCR request timeout (ms) | `600000` |
| `OCR_NUM_PREDICT` | Max output tokens for the vision OCR model (min 256) | `8192` |
| `SYNTHESIS_LLM_MODEL` | Model for auto-synthesis pipeline | `gemma4:latest` |
| `AGENT_WALLCLOCK_TIMEOUT_MS` | Max wall-clock time per agent request | `600000` |
| `AGENT_MAX_TOTAL_TOKENS` | Max total tokens per agent request | `200000` |
| `AGENT_MAX_CONTEXT_BYTES` | Context array size cap (bytes) | `500000` |
| `AGENT_MAX_SKILL_EXECUTION_MS` | Per-skill execution timeout | `60000` |
| `AGENT_LOOP_DETECTION_WINDOW` | Abort after N identical (tool, input) in a row | `3` |
| `CHAT_MAX_CONCURRENT_PER_USER` | Per-user concurrent chat cap | `5` |
| `AGENT_MEMORY_REVIEW_INTERVAL` | Turns between automatic memory extractions (0 disables) | `10` |
| `AGENT_MEMORY_CHAR_LIMIT` | Cap for the injected `<memory_context>` block | `2000` |
| `AGENT_MEMORY_DEDUP_THRESHOLD` | Cosine similarity threshold for memory dedup (0.85-0.99) | `0.92` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push VAPID keys (auto-generated when unset in dev) | — |
| `SEED_BOOTSTRAP_ADMIN` | Seed the bootstrap admin when no admin exists yet (literal `false` disables) | `true` |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_EMAIL` | Bootstrap admin credentials (password min 8 chars) | `admin` / `admin123` / `admin@example.com` |
| `DISABLE_TELEMETRY` | Telemetry opt-out | `true` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | SMTP for password reset (features log+skip when unset) | — |
| `PUPPETEER_EXECUTABLE_PATH` | Chromium path for archive PDF export | — |

See `src/config/env.ts` for the complete Zod-validated schema.

## Monorepo Context

The server is one of five packages in the Simmetric Chat monorepo:

```
shared  ←  server
shared  ←  collector
shared  ←  frontend
shared  ←  widget
```

- **Strict boundary**: The server only imports from `@simmetric-chat/shared`. It never imports from `collector`, `frontend`, or `widget`. pnpm strictness enforces no phantom deps.
- **Server-Collector communication** is HTTP-only: the server delegates document ingestion to the collector via POST to `/api/ingest` and receives status callbacks via `PUT /api/documents/:id/status`. `COLLECTOR_SECRET` is validated on both sides (`X-Collector-Secret` header).
- **Frontend communication** goes through the Vite proxy in development (`/api` -> `localhost:3000`) and direct API calls in production.

## Quick Start

```bash
# From the server package directory
cd packages/server

# Install dependencies (run from monorepo root)
pnpm install

# Configure environment — create a .env file with required variables
# Minimum: JWT_SECRET, COLLECTOR_SECRET (DATABASE_URL has a code default)

# Generate Prisma client and run migrations
pnpm db:generate
pnpm db:migrate

# Seed defaults (roles, permissions, config)
pnpm db:seed

# Start development server
pnpm dev
```

The API will be available at `http://localhost:3000`. Swagger UI is served at `/api-docs`.

---

Part of the [Simmetric Chat](../../README.md) monorepo.
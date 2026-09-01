
# Testing Guide

This document describes how tests are organized, configured, and run across the Simmetric Chat monorepo. The project uses **Jest** for unit and integration tests, **Playwright** for end-to-end browser tests, and **supertest** for HTTP integration tests.

---

## Testing Overview

| Layer | Tool | Environment | Database | Location |
|---|---|---|---|---|
| Unit | Jest 30 (`@swc/jest` 0.2.39) | Node / jsdom | Mocked (no DB) | `packages/*/src/__tests__/**/*.test.ts` |
| Integration | Jest 30 + `@swc/jest` + supertest 7 | Node | Real PostgreSQL (per-worker clone) | `packages/server/src/__tests__/**/*.integration.test.ts` |
| Component | Jest 30 + `@testing-library/react` 16 | jsdom (`jest-environment-jsdom` 30) | None | `packages/frontend/src/**/__tests__/**/*.test.{ts,tsx}` |
| E2E | Playwright 1.62 | Chromium | Real PostgreSQL | `e2e/*.spec.ts` |

All Jest configurations are TypeScript-aware via **`@swc/jest`** (SWC/Rust transform), used across all eight Jest configs (shared, server unit, server integration, server integration-nodb, frontend, widget, collector unit, collector integration). `ts-jest` 29.4.12 is retained in each config's `devDependencies` as the **rollback transformer only** (each `jest.config.*` carries a commented header: `// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores it `); it is not used at runtime. The TS 7.x upgrade remains blocked by `ts-jest`'s peer cap (`<7`); SWC's TS parser does not yet handle TS 7's new syntax/overload-resolution, so the swap to `@swc/jest` does not by itself unlock TS 7.

The root `jest.config.cjs` is a multi-project config with **five projects** — shared, server, frontend, collector, and widget — so `pnpm test:all` (plain `jest --config jest.config.cjs`) and `pnpm test` (the same suites via Turborepo, `test` depends on `^build`) run every package suite. The root config also carries `testPathIgnorePatterns: ['check-build-freshness', 'restoreSymlinkTraversal']` — a documented safety net for local `/tmp` quota overflow and env-path issues (see [Known Test Suite Issues](#known-test-suite-issues)); the `restoreSymlinkTraversal` suite no longer exists on disk (removed with the backup-subsystem extraction to the enterprise plugin), but the ignore pattern is kept as a no-op guard. CI runners with ample `/tmp` are unaffected either way.

**Suite snapshot** (test files, verified against the tree — re-check after future phases):

| Package | Unit files | Integration files | Notes |
|---|---|---|---|
| server | 221 in `src/` + 2 script suites | 16 | Colocated `agent/__tests__/`, `ocr/__tests__/`, `urlIngestion/__tests__/`, `scripts/__tests__/` run under the server unit config too |
| shared | 16 | — | Pure Zod schema/constant tests |
| frontend | 126 | — | 97 in `src/__tests__/` + 29 colocated (components, chat, sidebar, ui, utils, i18n, queries) |
| collector | 15 | 2 | Shared maps to `shared/dist` — build shared first |
| widget | 23 | — | Shared maps to shared **source** — no build needed |

---

## Test Commands

Run from the repository root unless noted otherwise.

| Command | What it runs |
|---|---|
| `pnpm test` | Unit tests for all five packages (shared, server, frontend, collector, widget) via Turborepo (`turbo test`, depends on `^build`) — Postgres-free |
| `pnpm test:all` | Unit tests for all five packages via the root Jest multi-project config (plain jest, no turbo) |
| `pnpm --filter server test` | Server package unit tests (`jest`) |
| `pnpm --filter server test:integration` | Server integration tests against real PostgreSQL (`jest --config jest.config.integration.js --forceExit`) |
| `pnpm --filter shared test` | Shared package unit tests |
| `pnpm --filter frontend test` | Frontend component tests (`jest --config jest.config.cjs`) |
| `pnpm --filter widget test` | Widget package unit tests |
| `pnpm --filter collector test` | Collector package unit tests |
| `pnpm --filter collector test:integration` | Collector integration tests against a dedicated `pgvector_test` DB on port 5433 (`jest --config jest.config.integration.cjs`) |
| `pnpm --filter server test -- -t "name"` | Run a single test by name in the server package |
| `pnpm --filter server test -- path/to/file.test.ts` | Run a single test file in the server package (jest positional args pass through) |
| `pnpm --filter frontend test -- -t "name"` | Single test by name in the frontend package |
| `pnpm --filter widget test -- -t "name"` | Single test by name in the widget package |
| `pnpm test:e2e` | Playwright end-to-end browser tests |

> **Turbo/stale-dist gotcha:** turbo caches `test` on `^build`, so after editing `packages/shared/src/`, server and collector tests can run against a stale `shared/dist` unless you rebuild (`pnpm --filter @simmetric-chat/shared build`) or run via turbo (which rebuilds first). The frontend and widget map `@simmetric-chat/shared` to its **source** and do not need the build.

---

## Test Environment (`.env.test`)

Server tests load environment variables from `packages/server/.env.test` via the `src/__tests__/helpers/setupEnv.ts` helper, which must be imported **first** in any server test file that touches `getEnv()`. The helper uses `dotenv.config()` to load the file, then applies fallback values for missing vars (`JWT_SECRET`, `LICENSE_KEY=""`, `COLLECTOR_SECRET`) — except `DATABASE_URL`, which has no fallback: it must be present in `.env.test` for any test that opens a DB connection. The server `jest.config.js` also registers `setupEnv.ts` via the `setupFiles` array, so the env fallbacks take effect even without a per-file import, though the explicit `import "./helpers/setupEnv"` idiom is retained in files for clarity and import-ordering in tests that mock `../config/env`.

The tracked `.env.test` (read these values when debugging env-dependent tests):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes (for integration / any DB-touching unit test) | PostgreSQL connection string for the test database. Local default: `postgresql://simmetricchat:simmetricchat@localhost:5434/simmetricchat_test`. No fallback in `setupEnv.ts`. |
| `JWT_SECRET` | Yes | JWT signing secret. `getEnv()` calls `process.exit(1)` if missing — tests that import `getEnv()` will crash without it. `setupEnv.ts` provides a fallback for unit tests. |
| `NODE_ENV` | Yes | Must be `test`. Controls test-specific code paths and logging. |
| `LICENSE_KEY` | Yes (can be empty) | License key string. Empty string is valid for Community-tier tests. `setupEnv.ts` defaults it to `""`. |
| `COLLECTOR_SECRET` | Yes | Server↔collector shared secret. Validated by Zod in `packages/server/src/config/env.ts` with `.min(1)`. If missing or empty, `getEnv()` calls `process.exit(1)`, crashing **any test suite that touches agent services** (the `AgentBudgetTracker` constructor and other agent code paths read config at import time). `setupEnv.ts` provides a fallback for unit tests. |
| `WIDGET_SERVICE_URL` / `WIDGET_API_KEY` | Optional (unit) | Widget cache-bust handshake defaults (`http://localhost:3211` / `test-key`). |
| `API_KEY_HMAC_SECRET` | Yes (base64 32-byte) | HMAC signing key for API keys. Unit tests use real `crypto.createHmac`, so `.env.test` carries a real (all-zero) 32-byte secret. |

> **Gotcha:** Adding a new server test file that transitively imports agent services (orchestrator, budget service, MCP client) without importing `setupEnv.ts` first will fail with a non-obvious `process.exit(1)` from env validation. Always start such files with `import "./helpers/setupEnv";`.

---

## Unit Tests

Unit tests run against mocked dependencies. No database or network is required — the CI `test-unit` job proves the entire suite runs Postgres-free.

### Server Unit Tests

- **Config:** `packages/server/jest.config.js` (roots: `src` + `scripts`)
- **Pattern:** `**/__tests__/**/*.test.ts` (files matching `*.integration.test.ts` are excluded)
- **Test files:** 221 unit test files in `packages/server/src` — mostly in `src/__tests__/` plus colocated suites under `src/agent/__tests__/` (orchestrator characterization, context compaction, plan mode, reasoning parsers, RAG search filters), `src/ocr/__tests__/` (grounding cleanup, hallucination guard, model registry, OCR pipeline, Ollama vision client, PDF renderer, prompt templates, quality scoring), and `src/urlIngestion/__tests__/` (credibility scoring, URL fetcher, URL pipeline) — plus 2 script test suites under `scripts/__tests__/` (`check-license`, `reindex-chunkids`). Coverage areas include auth, license (Community/Enterprise tiers, feature flags, `requireFeature`/`requireFeatureLimit` middleware, graceful degradation on expiry, `licenseDiagnose`), token revocation (`isTokenRevoked`/`revokeToken` jti blacklist), SSO extraction guard (`ssoExtractionGuard.test.ts` asserts ZERO SSO imports remain in the community tree — the SSO/OIDC/SAML/SCIM routes moved to the enterprise plugin; `auth.test.ts` covers the `GET /api/auth/sso/status` `oidcProvider` derivation), backup extraction guard (ZERO backup code remains — moved to the enterprise plugin), API keys, encryption-key rotation, RBAC, chat rate limiting, chat retention reaper, chat export/import, plan mode, chat tokens, stream persistence, provider presets/resolution/service, workspaces, widget CRUD/cache-bust/session IDOR/archive/rate-limit migration/internal API, MCP client/routes/health-check/reaper/uninstall, marketplace, DLP filter (multibyte), OCR routing, URL ingestion, synthesis pipeline, archive (config/service/export/graph/pages/consistency/templates), Ollama auto-detect, orchestrator, tool-call parsing per provider, FTS service, hybrid search + RRF guard + multi-workspace bias, RAG archive fallback, RAG search skill, wiki embedding/query/write, wikilinks, source-citation seam, uploads + upload gate + upload-draft reaper, document upload/413/delete cascade/IDOR, memories, and chat organization.
- **Mocked Prisma:** `src/__tests__/helpers/mockPrisma.ts` provides `createMockPrisma()` which returns `{ prisma, resetAll }` — a deep-mocked Prisma client with `jest.fn()` on every model method plus `$queryRawUnsafe`/`$executeRawUnsafe` defaults, callable `resetAll()` for per-test hygiene.
- **Module mapping:** `@simmetric-chat/shared` resolves to `<rootDir>/../shared/dist/index.js`. Heavy server dependencies (`uuid`, `jsdom`, `@mozilla/readability`, `turndown`, `archiver`, `pdfjs-dist`, `puppeteer`, `pg-boss`) are mapped to lightweight mocks under `src/__mocks__/`; the integration configs additionally map `openid-client`. **`pg-boss`** (v12.28.0, pure ESM) maps to the manual CJS mock `src/__mocks__/pg-boss.ts` — a stub `PgBoss` class whose instances expose `start`/`stop`/`on`/`schedule`/`createQueue`/`work` as `jest.fn()`. It exists so suites that transitively load `src/index.ts` (which statically imports `./services/jobQueue` → `pg-boss`) don't crash on the ESM import under the CJS `@swc/jest` transform; the dedicated `jobQueue.test.ts` uses its own `jest.mock("pg-boss", ...)` factory for per-test control.
- **Transform ignore:** `pdfjs-dist`, `@napi-rs/canvas`, and the transitive ESM-only `jose`/`oauth4webapi`/`openid-client` packages (pulled in by `passport-saml`/`openid-client`) are excluded from the `transformIgnorePatterns` so `@swc/jest` can process their ESM exports. This is a *scoped* exception (Jest bug #16266) — never a global `transformIgnorePatterns: []`.
- **Setup file:** `src/__tests__/helpers/setupEnv.ts` is registered via `setupFiles`.
- **`@ts-nocheck`:** allowed in `__tests__/` files only (the lint config permits it there and nowhere else).

Example mock setup from a server unit test:

```typescript
import "./helpers/setupEnv";
jest.mock("../utils/prisma", () => {
const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
getEnv: jest.fn(() => ({ JWT_SECRET: "test-secret", COLLECTOR_SECRET: "x", ... })),
}));
```

The `setupEnv.ts` helper pre-loads test environment variables before imports that read `process.env`.

#### `@swc/jest` mock factory pattern

Under `@swc/jest`, the `jest.mock()` factory **cannot reference outer-scope variables** (unlike `babel-plugin-jest-hoist`): SWC hoists ESM imports above `const` initialization, so a factory that closes over a block-scoped `const` hits a temporal-dead-zone (TDZ) error. Two established workarounds:

1. **Factory creates its own `jest.fn()` handles** — the factory builds the mocks internally; tests retrieve them via the mocked imports (import-cast retrieval):

```typescript
jest.mock("../services/jobQueue", () => ({
__esModule: true,
getBoss: jest.fn(),
createQueue: jest.fn().mockResolvedValue(undefined),
schedule: jest.fn().mockResolvedValue(undefined),
}));

import { getBoss, createQueue, schedule } from "../services/jobQueue";
const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;
```

2. **Module-level mutable shared objects** — the factory references module-level `const`s (not block-scoped), so `jest.resetModules()` preserves them across fresh-module re-requires:

```typescript
const mockBossInstance = { start: jest.fn(), stop: jest.fn(), on: jest.fn(), schedule: jest.fn(), createQueue: jest.fn() };
const mockPgBossConstructor = jest.fn(() => mockBossInstance);

jest.mock("pg-boss", () => ({ __esModule: true, PgBoss: mockPgBossConstructor }));
```

A **fresh-module helper** (`jest.resetModules()` + `require(...)`) re-evaluates the module under test so singleton state (e.g., `initAttempted` guards, `originatingChats` Sets) is re-created per test. When a test asserts on logger calls after `resetModules()`, it must re-require `../utils/logger` **inside the test** — `resetModules` re-runs the mock factory and produces a new logger object; a top-level `require` points at a stale instance.

- `jobQueue.test.ts` (7 tests) — pg-boss singleton lifecycle: lazy `getBoss()` null before start, `PgBoss` constructed with `DATABASE_URL` + `start()` + `on("error")` registered at construction, `startJobQueue()` idempotency (`initAttempted` guard), `stopJobQueue()` exact args `{ graceful: true, timeout: 4500 }`, stop no-op when never started, `bossInstance` reset to null after stop, and PG-unavailable degradation (`start()` rejects → caught, `getBoss()` null, error logged, no throw). `schedule()` calls `assertValidQueueName()` first — queue names must match pg-boss 12.28's `assertQueueName` charset (`[a-zA-Z0-9_\-./]`); colon-named queues (e.g. `"healthcheck:mcp"`) crashed the server as an unhandled rejection at boot, fixed by the fail-fast guard (see the scheduler section and [Known Test Suite Issues](#known-test-suite-issues)).
- `sseFanout.test.ts` (12 tests) — 8 single-instance tests (publish-after-write, fire-and-forget publish, `redis.duplicate()` subscribe, relay for non-originating instances, origin-skip double-write prevention, unsubscribe/disconnect on res close, Redis-absent degradation, rate-limit-store coexistence) + 4 cross-instance relay tests that simulate two server instances via two `freshChatModule()` calls (disjoint `originatingChats` Sets) bridged by an enhanced mock Redis whose `publish` fans out to every registered `on("message")` handler.
- `bootOrder.test.ts` (77 assertions) — source-string boot-order invariants (see the dedicated section below).
- `rawEnvReads.test.ts` — raw-env-channel behavioral guard (see [Recent test additions](#recent-test-additions)).
- `seedWidgetApiKey.test.ts` / `apiKeyService.test.ts` — P2002 retry/tolerance suites (see [Recent test additions](#recent-test-additions)).

#### Scheduler tests: pg-boss registration (v1.4 pattern)

The scheduler lifecycle tests assert **pg-boss registration** (`createQueue` + `schedule` + `boss.work`) instead of timer/lock lifecycles. The mock boundary is the `jobQueue` seam (`../services/jobQueue`), **not** pg-boss directly; the `__mocks__/pg-boss.ts` manual mock handles transitive ESM loads for suites that boot `index.ts`. Key assertions: `createQueue(queueName)` precedes `schedule(queueName, cron)` (the queue must exist before scheduling — foreign-key constraint), `boss.work(queueName, handler)` registered once with a function handler, `getBoss() === null` → `logger.warn` + early return (graceful degradation), and the work handler catches cycle errors and resolves (no retry storm). Queue names use underscores, not colons (e.g. `"healthcheck_mcp"` — asserted in `mcpHealthCheck.test.ts`). Applies to `mcpReaper`, `mcpHealthCheck`, `vectorCleanupJob`, `chatMessageReaperJob`, `uploadDraftReaperJob`, `archiveConsistencyService`, and `synthesisReaper.integration` (idempotency via `schedule()` upsert).

### Shared Package Tests

- **Config:** `packages/shared/jest.config.js`
- **Pattern:** `src/__tests__/**/*.test.ts`
- **Test files:** 16 files — `schemas.test.ts`, `envSchema.test.ts` (provider enum widening + default survival + Zod 4 unwrap idioms), `loadEnv.test.ts` (root-env loader: tmp-dir fixtures, process.env hermeticity, module-flag reset), `featureFlags.test.ts`, `widget-flags.test.ts`, `widget-schemas.test.ts`, `mcp-connection-schema.test.ts`, `mcpHeadersSchema.test.ts`, `archiveSchemas.test.ts`, `ocrSchemas.test.ts`, `ingestSchemas.test.ts` (includes the `RagMetadataFilterSchema` / `IngestQueryRequestSchema.filters` contract guard), `sourceCitation.test.ts`, `pluginSchema.test.ts`, `widgetLocalization.test.ts`, `widgetLocalesParity.test.ts` (pins the widget locale set ↔ frontend locales), `fileName.test.ts` (filename sanitization).
- Tests validate Zod schemas, type exports, and constants. No external dependencies are mocked because the shared package has only `zod` as a runtime dependency.

### Widget Package Tests

- **Config:** `packages/widget/jest.config.js`
- **Pattern:** `src/__tests__/**/*.test.ts` (+ `rawEnvReads.test.ts` / `envExampleParity.test.ts` mirrors)
- **Test files:** 23 files — `chat.proxy.test.ts` (SSE proxy route), `chatPanel.seam.test.ts`, `chatPanelLogic.test.ts`, `loader.test.ts`, `rateLimit.test.ts` / `rateLimit.daily.test.ts` / `rateLimit.redis.test.ts`, `redisService.test.ts`, `session-route.test.ts`, `session.test.ts`, `sourceCitationSeam.test.ts`, `useWidgetChat.dedup.test.ts`, `useWidgetConfig.test.ts`, `widgetApi.test.ts`, `globToRegex.test.ts` + `matchUrlPattern.test.ts`, `widgetI18n.test.ts`, `widgetOpenState.test.ts`, `welcomeScreen.seam.test.ts`, `widgetEmbedLayout.seam.test.ts`, `widgetApp.test.ts`, plus the guards `rawEnvReads.test.ts` and `envExampleParity.test.ts`.
- Uses `supertest` for HTTP route tests and Jest for component/hook tests; a `helpers/setupEnv.ts` mirrors the server env-loading pattern.
- `moduleNameMapper` resolves `@simmetric-chat/shared` to the shared **source** (`<rootDir>/../shared/src/index.ts`) — widget does not require the shared build.
- The config redirects `TMPDIR` to `.jest-cache/tmp` to avoid `/tmp` tmpfs quota exhaustion on local runs.

### Collector Unit Tests

- **Config:** `packages/collector/jest.config.js`
- **Pattern:** `src/__tests__/**/*.test.ts` (`*.integration.test.ts` excluded — mirrors the server pattern)
- **Test files:** 15 unit test files — `chromaProvider.test.ts`, `embeddings.test.ts`, `envExampleParity.test.ts`, `hfLocalEmbedding.airgap.test.ts` + `reranker.airgap.test.ts` (network-free `.airgap` suites), `ingest.rerank.test.ts`, `ingest.test.ts`, `ollamaClient.test.ts`, `ollamaKeepAliveEnv.test.ts` (the process.env save/delete/restore hermeticity precedent), `parserOcrRouting.test.ts`, `parser.test.ts`, `pgvectorHelper.test.ts`, `pgVectorProvider.test.ts`, `rawEnvReads.test.ts`, `vectorStore.test.ts`.
- `moduleNameMapper` resolves `@simmetric-chat/shared` to `<rootDir>/../shared/dist/index.js` — the collector build **and** the shared build are required before running collector tests (`pnpm --filter @simmetric-chat/shared build` first).

---

## Recent test additions

The most recent suites added to the tree (patterns worth knowing before writing new tests):

### P2002 unique-constraint retry/tolerance

- `apiKeyService.test.ts` — `createApiKey` retries prefix collisions with a **freshly generated key** (bounded, max 3 attempts): P2002 on first create → retry with a fresh uuid/plain key; P2002 three times → clear thrown error after 3 attempts with a warn per attempt; non-P2002 errors propagate immediately (no retry). Duck-typing detection `(err as { code?: string }).code === "P2002"` — no PrismaClientKnownRequestError import.
- `seedWidgetApiKey.test.ts` — the boot-time widget API key seeder is crash-loop-proof: P2002 on create with the `key_hash` row present → race won by a concurrent boot → resolves with one `create`, info logged; P2002 with the post-P2002 re-check still null (rare 8-hex digest-prefix collision) → resolves with a warn, **no throw, no `process.exit(1)`**; non-P2002 errors are rethrown (the catch swallows only the unique-constraint code).

### RAG metadata-filter threading (, TDD)

- `packages/shared/src/schemas/ingest.schema.ts` gained `RagMetadataFilterSchema` (optional `documentTypes` against a dedicated 6-value `ragFilterDocumentTypeSchema` enum, ISO-parseable `dateFrom`/`dateTo` with `dateFrom <= dateTo` object refine) plus the optional `filters` field on `IngestQueryRequestSchema` — guarded by `ingestSchemas.test.ts` (contract tests for the enum's document-type semantics, date validation, and the `{}`-is-a-no-op byte-identity contract).
- `packages/server/src/__tests__/hybridSearchService.filters.test.ts` — three describe blocks: **byte-identity without filters** (absent/empty filters produce identical calls to the pre-filter contract), **filter threading** through the pgvector/Qdrant/FTS stack (`documentTypes` bound as `text[]` params, `metadata->>`-style predicates with dynamic `$n` composition), and the **post-retrieval `documentIds` backstop** (re-gates only VECTOR-sourced results; FTS results are already SQL-filtered).
- `ftsService.test.ts` covers the optional metadata predicates in the SQL layer; `src/agent/__tests__/ragSearchFilters.test.ts` covers the `rag_search` skill's filter plumbing.
- Collector side: `vectorStore.test.ts`, `pgVectorProvider.test.ts`, `ingest.test.ts`, and `chromaProvider.test.ts` cover provider-specific pre-filters vs degrade-with-warn (LanceDB/Chroma warn + server-side backstop), and ingest re-stamps `documentType`/`documentCreatedAt(+Ms)` so legacy docs regain filterability on admin re-embed.

### Raw-env-reads guards + env-example parity (–178)

- **`rawEnvReads.test.ts`** exists in server, collector, and widget. consolidated env parsing into Zod and added the root-env loader (`loadRootEnv`); these suites are the regression tripwire for the keys that deliberately remain **raw `process.env` reads** outside the schema — server: `API_KEY_HMAC_SECRET` (fail-loud named throws + Buffer return), `ENCRYPTION_KEY` / `LEGACY_PREVIOUS_ENCRYPTION_KEYS` (decrypt key chain), `E2E_RUN` (module-scope `=== "1"` gate in `rateLimit.ts`), `LOG_LEVEL` (module-load read), plus a schema-absence tripwire (raw-only keys must stay out of `Object.keys(getEnv())`). The former `GSD_TEST_MOCK_PLUGIN` seam was removed from production code ( PUB-02) — the suite now pins its no-op status, and the subprocess shutdown test injects its mock plugin via the `tsx -r` bootstrap fixture instead. Doctrine: module-scope save of every touched key, `afterEach` deletes when `ORIGINAL === undefined` (never assign the string `"undefined"`), `jest.resetModules()` + dynamic require wherever the module caches the read.
- **`envExampleParity.test.ts`** exists in server, widget, and collector: a shape-only parity tripwire that introspects each package's Zod envSchema (static `.shape`, never the parsed accessor) and fails the moment a schema key loses documentation in the package's `.env.example`. The server version pins a structural sentinel (83 schema keys).

---

## Integration Tests

Integration tests exercise real HTTP routes against a live Express app and a real PostgreSQL database.

- **Config:** `packages/server/jest.config.integration.js`
- **Pattern:** `src/__tests__/**/*.integration.test.ts`
- **Test files:** 16 files — `auth.integration.test.ts`, `archives.integration.test.ts`, `archiveLocalLLMOnlyPropagation.integration.test.ts`, `archiveSoftDeleteLeak.integration.test.ts`, `chatMessageReaper.integration.test.ts`, `chatModel.integration.test.ts`, `documentCascade.integration.test.ts`, `documentFtsBulkInsert.integration.test.ts`, `memories.integration.test.ts`, `migrateGuard.integration.test.ts`, `nativeToolsIntegration.integration.test.ts`, `pluginShutdown.integration.test.ts`, `settings.integration.test.ts`, `synthesisReaper.integration.test.ts`, `system.integration.test.ts`, `wikiGraphStage.integration.test.ts`.
- **Global setup:** `jest.globalSetup.js`
- **Global teardown:** `jest.globalTeardown.js`
- **Setup after env:** `jest.setup.integration.ts`
- **No-DB variant:** `jest.config.integration-nodb.js` runs integration-pattern tests that do not need a database (e.g., `migrateGuard.integration`) — no global setup/teardown, Prisma mocked at the test level. `npx jest --config jest.config.integration-nodb.js -- migrateGuard.integration`.
- **Run sequentially:** a known worker-DB targeting bug (integration suites can read the cached `getEnv()` `DATABASE_URL` instead of the per-worker URL) means parallel integration runs weaken isolation — run `test:integration` sequentially (tracked as open test-infra debt).

### Test Database Lifecycle

Integration tests use a **template database + per-worker clone** strategy to achieve isolation without paying the full migration cost for every test file.

1. **Template creation (`jest.globalSetup.js`)**
- Drops `simmetricchat_test_template` if it exists.
- Creates a fresh `simmetricchat_test_template` database.
- Runs `prisma migrate deploy` against the template.
- Runs `prisma db seed` to populate default roles, permissions, and system config.

2. **Per-file worker clone (`jest.setup.integration.ts`)**
- Derives a unique worker DB name from the SHA-256 hash of the test file path (e.g., `simmetricchat_test_a1b2c3d4...` — first 16 hex chars).
- Clones the template into the worker DB via `CREATE DATABASE ... TEMPLATE`.
- Overrides `process.env.DATABASE_URL` so the imported Prisma client connects to the worker DB.

3. **Cleanup (`jest.globalTeardown.js`)**
- Drops the template database.
- Drops any residual worker databases matching `simmetricchat_test_%`.

> **Requirement:** The PostgreSQL user must have the `CREATEDB` privilege. The tracked `.env.test` points at `localhost:5434`.

### Collector Integration Tests

The collector package has its own integration harness (`packages/collector/jest.config.integration.cjs`) that targets a **dedicated `pgvector_test` database on port 5433** — never the main DB. Operator must start pgvector on port 5433 before running:

```bash
docker run -d -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
-e POSTGRES_DB=pgvector_test pgvector/pgvector:pg16
```

Two integration files exist: `chromaProvider.integration.test.ts` and `pgVectorProvider.integration.test.ts`. The config probes Postgres in `integration-globalSetup.cjs`, sets `PGVECTOR_AVAILABLE`, and the `setup-integration.ts` setup file guards against the main-DB leak pitfall and sets `PGVECTOR_TEST_URL`. If Postgres is unavailable the suites **skip loudly** (`(PG_AVAILABLE ? describe : describe.skip)`) instead of false-passing. The harness sets a 30s `testTimeout` and `forceExit: true` (lingering `pg.Pool` idle clients). The collector config maps `@simmetric-chat/shared` to `shared/dist` — rebuild shared before running.

### Integration Test Helpers

Import helpers from `src/__tests__/helpers/integration.ts` (re-exports from `testApp.ts`):

- `getTestApp()` — Returns a fresh Express app instance via dynamic import (after `jest.resetModules()`). Call inside `beforeAll`.
- `getTestPrisma()` — Returns the Prisma client connected to the current worker DB.
- `clearTestData()` — Deletes all rows from each mutable table via `prisma.$executeRawUnsafe(`DELETE FROM "<table>"`)` (per-table DELETE, not TRUNCATE). Run in `afterAll` to prevent data leakage between test files sharing the same worker process.

Other helpers in `src/__tests__/helpers/`: `memoryFixtures.ts`, `mockAuth.ts` (forged JWT contexts), `mockCollector.ts`, `echoMcpServer.ts`, `licenseTestKeys.ts`. The mock enterprise plugin for the subprocess shutdown test lives in `src/__tests__/fixtures/` (`enterpriseMockBootstrap.ts` + `enterpriseMockPlugin.cjs`) — loaded via a `tsx -r` bootstrap override of the loader's `__pluginResolver` seam, no production env-var seam (PUB-02).

> **Note:** `--forceExit` is passed to Jest because `createApp()` mounts the MCP server, which leaves async handles open.

---

## Frontend Component Tests

- **Config:** `packages/frontend/jest.config.cjs`
- **Environment:** `jsdom` (`jest-environment-jsdom` 30)
- **Pattern:** `src/**/__tests__/**/*.test.{ts,tsx}`
- **Test files:** 126 total — 97 in `src/__tests__/` plus colocated `__tests__/` directories under `src/components/` (14), `src/components/chat/` (7: ChatCitations, ChatEmptyState, ChatInputArea, ChatMessageList, ChatStreamingIndicator, DlpTextsToggle, PlanBanner), `src/components/sidebar/`, `src/components/ui/` (settings-menu, UserDropdown), `src/utils/__tests__/` (groupChatsByDate, markdown, widgetServiceUrl), `src/i18n/__tests__/` (translations parity), and `src/queries/__tests__/` (useProjects.optimistic). Coverage areas: App, AppSidebar, Archive components (Card/DetailPage/GraphView/Header/PageFullView/Sidebar/ConfigPanel/ExportDialog), CitationPanel, ChatPanel, ChatThemes, Comparison variants, DashboardPage, DLP (DlpAuditPanel, DLPNotice, SettingsDlpPatterns, DlpTextsToggle), DocumentsPage/DocumentViewerPage, EnterpriseModules panels, FiltersTab, KnowledgeBasePage, LoginPage, Marketplace components, MCP popovers/forms, ModelPalette/ModelSelector/ModelComparisonView, OCR preview, Settings tabs (Appearance/General/LLM/Maintenance/Page/Profile/Providers/Templates/WebSearch/DlpPatterns), SetupWizard, SSO panels, Synthesis components, TemplateForm, terminal-style components, TokenCounter, TopBar, UnifiedUploadPage, Widget admin (Detail/Form/LocalizationTab/PreviewPane/CreditsTab/QuestionsTab/snippet), WorkspacesPage, plus hook tests (`useChat.*` variants including streamingContract/characterization, useArchives, useAuth, useDocuments, useLicense, useLinkArchive, useMessageHistory, useModelAvailability, useProjects + optimistic, useRenameSynthesisRun, useTemplates, useUploadDrafts, marketplaceStore, themeStore, uiDensity, uiFontScale), guard/invariant suites (`mainImportOrder`, `noExhaustiveDepsSuppressions`, `sourceCitationSeam`, `ssoTokenHandoff`), and integration-style (`chat-flow.integration`, `feature8.integration`).
- **Tools:** `@testing-library/react` 16, `@testing-library/jest-dom` 6, `jest-environment-jsdom` 30
- **Setup file:** `src/__tests__/jest.setup.ts` — imports `@testing-library/jest-dom` matchers, polyfills `TextEncoder`/`TextDecoder` for jsdom (required by react-router-dom v7), mocks `ResizeObserver` and `Element.prototype.scrollIntoView` (required by Radix UI components), and suppresses known jsdom-only console noise (`not wrapped in act`, `ResizeObserver`, `PointerEvent`).

### Module Mapping

The frontend config maps `@simmetric-chat/shared` to the shared **source** directory and stubs CSS imports:

```javascript
moduleNameMapper: {
"^@simmetric-chat/shared$": "<rootDir>/../shared/src/index.ts",
"^@/(.*)$": "<rootDir>/src/$1",
"\\.(css|less|scss)$": "<rootDir>/src/__tests__/__mocks__/styleMock.cjs",
}
```

The frontend is ESM (`"type": "module"`), so the config sets `extensionsToTreatAsEsm: [".ts", ".tsx"]` and SWC emits `module.type: "esm"` with the React automatic runtime — use `import`/`export` in tests, not `require`.

### Mocking Patterns

- Mock API utilities via `jest.mock("../utils/api")`. Integration-style suites (e.g., `chat-flow.integration.test.tsx`) mock `@microsoft/fetch-event-source` directly and capture its callbacks to drive the SSE event protocol — MSW is not used (its SSE support is limited; a transport mock is more deterministic).
- TanStack Query hooks are tested with a `QueryClientProvider` wrapper and mocked API responses.
- **`renderWithProviders` / `renderHookWithProviders`** (`src/__tests__/test-utils.tsx`) — the standard wrapper for any component or hook that uses TanStack Query. It creates a fresh `QueryClient` with `retry: false` and `staleTime: Infinity` and wraps the UI in a `QueryClientProvider`. Prefer these over raw `render`/`renderHook` from `@testing-library/react` for query-using code.
- React Context providers (ChatContext, ThemeContext, PageMetaContext) are wrapped around components under test.
- Hook tests use `renderHook` from `@testing-library/react` with `act()` for state updates.

---

## E2E Tests

- **Config:** `playwright.config.ts`
- **Test directory:** `./e2e/`
- **Timeout:** 30 seconds per test
- **Retries:** 1
- **Base URL:** `http://localhost:5173`
- **Global setup:** `./e2e/globalSetup.ts` (`DATABASE_URL` falls back to parsing the root `.env` if the env var is unset)

### Web Servers

Playwright automatically starts the dev servers before running tests:

| Server | Command | Port |
|---|---|---|
| Backend | `pnpm --filter server exec tsx src/index.ts` | 3000 |
| Frontend | `pnpm --filter frontend exec vite preview` | 5173 |
| Widget | `pnpm --filter widget exec tsx src/index.ts` | 3211 |

All three use `reuseExistingServer: true` so they do not conflict with an existing `pnpm dev` session. The server and widget run under plain `tsx` (not `tsx watch`) because watch mode stalls on the CI runner. The server webServer also sets `E2E_RUN: "1"`, which makes the server skip `authRateLimiter` for the E2E run — a stale server started without this env (e.g. a leftover `pnpm dev`) will not see `E2E_RUN` and the 429 cascade can reappear; kill stale servers (`lsof -ti:3000`) before a fresh full-suite run.

### Prerequisites

Before `pnpm test:e2e`:

1. Local Postgres running with `prisma migrate deploy` applied.
2. `pnpm --filter @simmetric-chat/shared build` and `pnpm --filter frontend build` (the server/widget resolve shared from `dist/`).
3. The Enterprise license JWT in the gitignored root `.env` (widget creation is license-gated).

### Fixtures and Seeding

`e2e/globalSetup.ts` (idempotent — safe to re-run):

- Logs in as `admin`/`admin123` (boot-seeded) and stores the session.
- Ensures the **hardcoded workspace** exists — `9a334821-b880-411b-affc-805664e7fd66`, the ID hardcoded across all E2E specs in `e2e/fixtures.ts`.
- Creates or reuses the **"E2E Test Widget"** (reuses the existing id instead of piling up widgets) and persists it as `E2E_WIDGET_ID`; seeds the matching widget API key row (HMAC digest of the `sk-` plaintext key shared with the root `.env` `WIDGET_API_KEY`).
- Clears the admin's `mustChangePassword` flag so the force-change modal never blocks flows.

`e2e/fixtures.ts` extends the base Playwright test with:

- `adminPage` — auto-logs in as the default admin user (`admin` / `admin123`).
- `widgetPage` — host page with the real widget loader script mounted. Requires `process.env.E2E_WIDGET_ID`, which `globalSetup.ts` seeds. The fixture obtains a **real session token** via `POST http://localhost:3211/api/sessions` and seeds both audited keys (`sc-widget-<id>-session` + `sc-widget-<id>-messages`) into the **parent page's `sessionStorage`** via `addInitScript` before the loader runs, then navigates to the real-origin host page (`packages/frontend/public/e2e-widget-host.html`).

Example usage:

```typescript
import { test, expect } from "./fixtures";

test("admin dashboard loads", async ({ adminPage }) => {
await adminPage.goto("/settings");
await expect(adminPage.locator("text=Settings")).toBeVisible();
});
```

### E2E Test Files

- `e2e/admin-flow.spec.ts` — Health endpoint, frontend load, login page smoke tests
- `e2e/chat-flow.spec.ts` — End-to-end chat send/stream/citation flow
- `e2e/chat-edit-regenerate.spec.ts` — Chat message edit and regenerate flows
- `e2e/upload-chat-rag.spec.ts` — Upload → chat → RAG citation path
- `e2e/upload-consolidation-removal.spec.ts` — Upload consolidation removal
- `e2e/unified-upload-destinations.spec.ts` — Unified upload destinations UI
- `e2e/widget-embed.spec.ts` — Widget embed lifecycle (5 tests): iframe mount + seeded session reuse, postMessage handshake with session/message persistence across iframe reload, the NO `allow-same-origin` sandbox guardrail, host-FAB open → close → reopen round-trip, and the credits relay firing `window.open` with the default URL. The chat SSE is fully mocked; the loader, iframe HTML, config fetch, and session create run against the real widget service on :3211. Session state is asserted via the parent page's `sessionStorage` (the loader's storage handshake).
- `e2e/synthesis-run.spec.ts` — Synthesis pipeline run
- `e2e/marketplace-lifecycle.spec.ts` — MCP marketplace critical path
- `e2e/mcp-pin-use.spec.ts` — MCP pin and use in chat
- `e2e/theme-switch-hacker.spec.ts` — Theme switch hacker variant
- `e2e/settings-left-menu-nav.spec.ts` — Settings left menu navigation
- `e2e/create-project-sidebar.spec.ts` — Create project from sidebar

> **Combined-run caveat:** all 13 specs pass in isolation, but a combined full-suite run on current source is still unverified (descope decision from the v1.5 milestone, partially unblocked). See [Known Test Suite Issues](#known-test-suite-issues).

---

## Writing a New Test

The project follows a **TDD RED→GREEN convention**: write the failing test first (RED), confirm it fails for the expected reason, then implement the feature and watch it pass (GREEN). Plan tasks are marked `tdd="true"` and the RED commit is made before the implementation commit (recent example: the RAG metadata-filter work enforced RED→GREEN per task). `@ts-nocheck` is allowed in `__tests__/` files only.

### Server Route (Unit)

1. Create `packages/server/src/__tests__/{domain}.test.ts`.
2. **Always import `./helpers/setupEnv` first** so env validation does not `process.exit(1)`.
3. Mock Prisma and any heavy dependencies (env, license service, backup scheduler, etc.).
4. Import `createApp` from `../index` and wrap with `supertest`.
5. Assert on status codes and response bodies.

Example skeleton:

```typescript
import "./helpers/setupEnv";
jest.mock("../utils/prisma", () => {
const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
return { __esModule: true, default: createMockPrisma().prisma };
});

import request from "supertest";
import { createApp } from "../index";

const app = createApp();

describe("GET /api/health", () => {
it("returns 200", async () => {
const res = await request(app).get("/api/health");
expect(res.status).toBe(200);
});
});
```

### Server Route (Integration)

1. Create `packages/server/src/__tests__/{domain}.integration.test.ts`.
2. Import helpers from `./helpers/integration`.
3. Use `getTestApp()` in `beforeAll` and `clearTestData()` in `afterAll`.
4. The database is already seeded with roles and permissions, so you can create users and authenticate immediately.

Example skeleton:

```typescript
import { getTestApp, clearTestData } from "./helpers/integration";
import request from "supertest";

describe("Auth integration", () => {
let app: Express.Application;

beforeAll(async () => {
app = await getTestApp();
});

afterAll(async () => {
await clearTestData();
});

it("creates a user", async () => {
const res = await request(app).post("/api/auth/register").send({
username: "testuser",
password: "Password123!",
email: "test@example.com",
});
expect(res.status).toBe(201);
});
});
```

> **Note:** Self-service registration is gated by `ALLOW_REGISTRATION`. If the route is disabled, use the admin-creation endpoint instead in integration tests.

### Frontend Component

1. Create the test file in a `__tests__/` directory adjacent to the component (`src/__tests__/{ComponentName}.test.tsx` for top-level pages, or co-located under the component's directory).
2. Import `render`, `screen`, and `fireEvent` from `@testing-library/react` — or `renderWithProviders` from `test-utils` for any component using TanStack Query.
3. Mock API utilities or wrap with required context providers as needed.

Example skeleton:

```tsx
import { render, screen } from "@testing-library/react";
import { MyComponent } from "../components/MyComponent";

describe("MyComponent", () => {
it("renders greeting", () => {
render(<MyComponent name="World" />);
expect(screen.getByText("Hello, World")).toBeInTheDocument();
});
});
```

### E2E Flow

1. Create `e2e/{flow}.spec.ts`.
2. Use the `adminPage` fixture for authenticated flows, or `page` / `request` for unauthenticated ones. Use `widgetPage` for widget-embed flows (requires `E2E_WIDGET_ID` seeded by globalSetup).
3. Prefer `locator` assertions with explicit timeouts over `waitForTimeout`.

Example skeleton:

```typescript
import { test, expect } from "./fixtures";

test("create workspace", async ({ adminPage }) => {
await adminPage.goto("/workspaces");
await adminPage.click("text=New Workspace");
await adminPage.fill('input[name="name"]', "Test Workspace");
await adminPage.click("text=Create");
await expect(adminPage.locator("text=Test Workspace")).toBeVisible();
});
```

### Source-String Boot-Order Test

`bootOrder.test.ts` (77 assertions) is a **source-string assertion** suite: it reads `packages/server/src/index.ts` as UTF-8 and regex-matches line-order invariants, failing the build if the boot sequence is reordered. Pattern: `readIndexTsSource()` → `lineNumberOfFirstMatch(lines, /regex/)` → `expect(lineA).toBeLessThan(lineB)`. Invariants covered (adapted from the frontend `mainImportOrder.test.ts` convention):

- `loadEnterprisePlugin(app)` runs after `await prisma.$connect()` and `initLicense()`, before the `NODE_ENV === "production"` scheduler block; `shutdownEnterprisePlugin()` precedes `prisma.$disconnect()` in `gracefulShutdown`.
- `ensureSetupWizardMode()` runs after `seedConfigDefaults()` and before `seedBootstrapAdmin()` (seed-vs-wizard race).
- ENCRYPTION_KEY production hard-default block: after the listening log line, before `prisma.$connect()`, uses `logger.error` + `process.exit(1)` (not `logger.warn`), names `ENCRYPTION_KEY`/`scryptSync`/`ENCRYPTION_KEY_ROTATION.md`, and reads `env.ENCRYPTION_KEY` (not `process.env`).
- REDIS_URL production warning: after the ENCRYPTION_KEY block, before `prisma.$connect()`, mentions `REDIS_URL` + `single-instance`, uses `env.REDIS_URL`.
- pg-boss: `startJobQueue()` after `prisma.$connect()` and before the scheduler block; `stopJobQueue()` after `shutdownMCPConnections()` and before `shutdownEnterprisePlugin()` + `prisma.$disconnect()`.
- Scheduler init async: all 8 `init*Scheduler()` calls are `await`ed and run after `startJobQueue()`; the 7 per-scheduler `shutdown*` calls are absent from `gracefulShutdown`; the 2 non-migrated 10s pollers (`initOcrPipelineScheduler`, `initSynthesisPipelineScheduler`) remain present and NOT awaited.

When adding a new boot-time step, extend this suite with a matching line-order assertion rather than relying on runtime tests. The same convention guards the frontend: `mainImportOrder.test.ts` (bootstrap side-effect import order) and `noExhaustiveDepsSuppressions.test.ts` (lint-suppression guard).

---

## CI/CD Testing

The `.github/workflows/ci.yml` pipeline runs on push/PR to `main`. Testing-relevant jobs:

1. **lint-and-typecheck** — Version-stamp sync check (package.json ↔ latest tag), changelog discipline check, then `pnpm db:generate`, `pnpm lint`, and `pnpm typecheck` across all packages, plus a Prisma 7 client-resolvability check.
2. **test-unit** — Runs `pnpm test` (Jest unit tests via Turborepo) after `pnpm db:generate` and the Prisma resolvability check. Depends on `lint-and-typecheck`. Env: `JWT_SECRET=ci-test-secret-key-32chars-long!!`, `DATABASE_URL=postgresql://simmetricchat:simmetricchat@127.0.0.1:5432/simmetricchat_test`, `LICENSE_KEY=ci-test-license`, `COLLECTOR_SECRET=ci-test-collector-secret`, `NODE_ENV=test`, `NODE_OPTIONS=--max-old-space-size=4096`. Also runs two grep gates (air-gap license service — zero outbound HTTP primitives; FTS locale regression — no english-only tsquery literals outside `ftsService.ts`) and a **test-count guard** (community suite ≤ 3404, 15% over the v1.0 baseline 2960 — counts top-level `packages/server/src/__tests__/*.test.ts` + `packages/frontend/src/__tests__/*.test.tsx` it/test/describe occurrences; exceeding the cap fails the build with a "suite bloat" message).
3. **test-airgap** — Runs the shared/server/frontend unit suites with `NETWORK_EGRESS_BLOCKED=1` (runtime air-gap proof; primary enforcement is the static grep gate in `test-unit`). Depends on `lint-and-typecheck`.
4. **migration-safety-check** — Runs `pnpm audit:migrations`, verifies the committed `docs/MIGRATION_AUDIT.md` is up to date, and if `destructive_count > 0` requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` set to `yes`/`1`/`true`. Depends on `lint-and-typecheck` and `test-unit`.
5. **test-e2e** — Spins up a `pgvector/pgvector:pg16` service container (`simmetricchat`/`simmetricchat`, DB `simmetricchat_test` on :5432), runs `pnpm db:generate`, applies the schema via `prisma migrate deploy` (without it the server's auto-seed crashes and Playwright times out waiting for :3000), builds `@simmetric-chat/shared` and the frontend (server/widget resolve shared from `dist/`), installs Playwright Chromium, then runs `pnpm test:e2e`. Depends on `test-unit`. Same env as `test-unit`.
6. **license-policy-check** — Runs `scripts/license-policy-check.cjs` (per-package `license-checker-rseidelsohn --onlyAllow`) and regenerates + drift-checks `THIRD_PARTY_NOTICES.md` and `docs/LICENSE_AUDIT.md`. Depends on `lint-and-typecheck` and `test-unit`.
7. **build** — Runs `pnpm build` and a build-freshness check (`check-build-freshness.cjs` — a direct script invocation, not the excluded Jest suite). Depends on `lint-and-typecheck`, `test-unit`, `test-airgap`, `migration-safety-check`, `license-policy-check`.
8. **license-keygen** — Rebuilds shared + server, installs the gitignored `license-tools/` deps, runs the round-trip license-key contract test with a throwaway `LICENSE_KEYGEN_SECRET`. Depends on `build`.
9. **security** — Runs `gitleaks-action@v3` (secret scanning). Depends on `lint-and-typecheck`.

### Pipeline Dependencies

```text
lint-and-typecheck
├── test-unit
│ ├── migration-safety-check
│ ├── license-policy-check
│ └── test-e2e
├── test-airgap
└── security
build (needs: lint-and-typecheck, test-unit, test-airgap, migration-safety-check, license-policy-check)
license-keygen (needs: build)
```

### CI Environment

- **Node:** 24
- **pnpm:** 11.24.0 (sourced from `packageManager` in `package.json` via `pnpm/action-setup` — the `version:` input is intentionally omitted; action-setup conflicts if both are set)
- **PostgreSQL:** 16 (`pgvector/pgvector:pg16` service container for e2e)
- **Required env vars in CI:**
- `JWT_SECRET=ci-test-secret-key-32chars-long!!`
- `DATABASE_URL=postgresql://simmetricchat:simmetricchat@127.0.0.1:5432/simmetricchat_test` (test-unit, test-airgap, test-e2e)
- `LICENSE_KEY=ci-test-license`
- `COLLECTOR_SECRET=ci-test-collector-secret`
- `NODE_ENV=test`

### Prisma Client Generation

CI always runs `pnpm db:generate` before any test step because Jest `moduleNameMapper` and integration test imports rely on the generated Prisma client existing on disk. The e2e job additionally runs `prisma migrate deploy` (non-interactive) so the server's boot-time seed service can create `admin`/`admin123` + roles + permissions, and builds `@simmetric-chat/shared` + the frontend because the server and widget resolve the shared package from `dist/`.

---

## Coverage and Quality Gates

### Current Coverage Configuration

No explicit coverage thresholds are configured in the Jest configs at this time. Coverage is not enforced as a blocking gate in CI. The closest size guard is the **test-count guard** in the `test-unit` CI job, which caps the community suite at **3404 tests** (15% over the v1.0 baseline of 2960); exceeding the cap fails the build with a "suite bloat" message.

### Running Coverage Locally

You can generate coverage reports by passing `--coverage` to any Jest command:

```bash
# All packages (root multi-project)
pnpm test:all -- --coverage

# Server only
pnpm --filter server test -- --coverage

# Integration tests
pnpm --filter server test:integration -- --coverage
```

### Quality Practices

- **TDD RED→GREEN:** Write the failing test first, confirm it fails for the expected reason, then implement. Tasks marked `tdd="true"` carry a RED commit preceding the implementation commit.
- **Mock hygiene:** Call `jest.clearAllMocks()` (or the `resetAll()` helper from `createMockPrisma()`) between tests to prevent assertion leakage.
- **Env hermeticity:** When a test touches `process.env`, follow the `ollamaKeepAliveEnv.test.ts` doctrine — save originals at module scope, `afterEach` deletes keys whose original was `undefined` (never assign `undefined` — `process.env` stringifies it to `"undefined"`), restore otherwise; `jest.resetModules()` + dynamic require for module-scope reads.
- **Dynamic imports in integration tests:** Use `jest.resetModules()` before importing `createApp` or Prisma so that each worker DB is picked up correctly.
- **No hard deletes in assertions:** Remember that the application uses soft deletes (`deletedAt`). Queries in tests should match production filters (`where: { deletedAt: null }`).
- **SSE test caution:** Streaming endpoints return `text/event-stream`. Use supertest's `.buffer(false)` or `.parse((res, cb) => res.on('data', cb))` patterns if you need to assert on individual SSE events.
- **Rate limit awareness:** Integration tests hit real rate limiters. If a test creates many requests rapidly, it may receive `429` responses. Use test-specific bypasses or throttle requests. (E2E sets `E2E_RUN=1` on the server to skip `authRateLimiter`.)

---

## Known Test Suite Issues

These are recurring failure patterns to be aware of when investigating flaky or unexpected test results:

- **Root-config ignored suites:** The root `jest.config.cjs` excludes `check-build-freshness` and `restoreSymlinkTraversal` from all projects due to local `/tmp` quota and env-path issues (documented baseline, D-03). The `restoreSymlinkTraversal` suite file no longer exists (removed with the backup-subsystem move to the enterprise plugin) — its ignore pattern is a no-op guard; `check-build-freshness.test.ts` still exists and remains excluded. CI runners with ample `/tmp` are unaffected; the `build` CI job runs the freshness check directly as a script, which is NOT affected by the Jest exclusion.
- **E2E combined-suite run unverified (descope, partially unblocked):** all 13 E2E specs were verified green in isolation, but the combined full-suite run has never been re-run end-to-end on current source (v1.5 descope decision). The pg-boss **colon-queue half of the blocker is FIXED** (`d990c77a`): pg-boss 12.28's `assertQueueName` charset rejects `:` (colon-named queue rows escaped as an unhandled rejection at boot, crash-looping the server); the guard `assertValidQueueName()` in `jobQueue.ts` now fails fast with an actionable message and all 8 scheduler queues use underscore names (e.g., `healthcheck_mcp`). Note: old colon-named rows in an existing `pgboss` schema are NOT migrated — fresh DBs unaffected. The residual half of the E2E blocker is stale-Docker-image pre-Phase-163 schema drift (operator env — rebuild with `--no-cache`); until a combined green run exists, scheduler-interaction regressions surface only in isolation runs.
- **Integration worker-DB targeting bug (open):** `*.integration.test.ts` suites may read the cached `getEnv()` `DATABASE_URL` instead of the per-worker DB URL, weakening isolation — run integration tests sequentially as a workaround (`jest.setup.integration.ts` does override `process.env.DATABASE_URL`, but the `getEnv()` cache can shadow it).
- **Integration harness main-DB leak:** dotenv loading the root `.env` (via `setupEnv.ts` or transitive imports) can win over the worker `DATABASE_URL` override, leaking writes to your local dev DB. If you see test data in the `simmetricchat` database after an integration run, ensure the root `.env` does not pin a `DATABASE_URL` that shadows the worker URL, and prefer clean-shell runs.
- **Flaky `sseFanout` cross-instance relay:** the 4 cross-instance relay tests in `sseFanout.test.ts` can be timing-sensitive when the enhanced mock Redis publish/fan-out races. Re-running the single file (`pnpm --filter server test -- src/__tests__/sseFanout.test.ts`) usually confirms whether the failure is real.
- **Orchestrator unknown-tool edge case:** `orchestrator.test.ts` has an edge case around unknown-tool handling that can produce inconsistent behavior depending on mock setup. If orchestrator tests fail intermittently, verify the mock skill registry is reset between cases.
- **Prisma mock fragility:** `createMockPrisma()` returns deep-mocked Prisma methods, but new Prisma model fields or nested `include`/`select` shapes added to source code without updating the mock can cause tests to pass while masking real query bugs. When adding fields to Prisma models, audit affected unit tests that assert on query arguments.
- **Partial mock Prisma fixtures:** Unit test fixtures that supply only a subset of a Prisma model's fields can produce false positives — the mock returns whatever shape the test provides, so a query that would fail against the real schema passes silently. When a unit test asserts on RAG/chat behavior, prefer full-shape fixtures or cross-check with an integration test against a real worker DB.
- **v1.4 carry-forward (pre-existing, not new regressions):** verified at the v1.4 branch point via `git checkout` + re-run: (1) `packages/server/src/ocr/__tests__/groundingCleanup.test.ts:177` — `no-irregular-whitespace` lint error (a literal U+200B zero-width-space in a test string; the source file is clean); (2) `check-build-freshness.test.ts` — jest failure on local `/tmp` quota overflow (root config already excludes it locally); (3) `enterpriseLoader.test.ts` — jest failure; (4) `orchestrator.maxIterationsBackstop.test.ts:203` — TS2345 typecheck error plus jest failures (`unknown_tool_breaker` ≠ `maxIterations`), carried from -02. None of these block the ship gate; treat them as known debt, not new regressions.

---

## Troubleshooting

### Integration tests fail with "database does not exist"

Ensure PostgreSQL is running locally and the `simmetricchat` user has `CREATEDB` privilege:

```bash
psql -U postgres -c "ALTER USER simmetricchat CREATEDB;"
```

### Tests crash with `process.exit(1)` during env validation

A server test file is missing the `import "./helpers/setupEnv";` line at the top, or `.env.test` is missing one of the required variables (`DATABASE_URL`, `JWT_SECRET`, `NODE_ENV`, `LICENSE_KEY`, `COLLECTOR_SECRET`). The most common culprit is `COLLECTOR_SECRET` — agent service imports read config at import time and will crash the whole suite if it is absent.

### Collector tests fail with "Cannot find module '@simmetric-chat/shared'"

The collector (and server) Jest configs map `@simmetric-chat/shared` to `../shared/dist/index.js`. Rebuild shared first: `pnpm --filter @simmetric-chat/shared build`. The frontend and widget map shared to its source and do not need this.

### Playwright fails with `ECONNREFUSED`

Make sure no other process is using ports 3000, 3211, or 5173, or set `reuseExistingServer: true` (already the default). If the server is slow to start, increase the timeout in `playwright.config.ts`. Also check the 429 cascade case: a stale server without `E2E_RUN=1` will rate-limit the suite — kill it (`lsof -ti:3000`) and re-run.

### Widget-embed E2E fails with "E2E_WIDGET_ID must be seeded"

The `widgetPage` fixture requires `process.env.E2E_WIDGET_ID`, which `e2e/globalSetup.ts` seeds. If globalSetup did not run (e.g., running a single spec with `--no-global-setup`), the fixture fails fast. Run `pnpm test:e2e` normally so globalSetup executes.

### Prisma client not found in tests

Run `pnpm db:generate` after any schema change. Jest `moduleNameMapper` points at generated artifacts that may not exist until then.

### Worker DB accumulation

If Jest is killed mid-run, worker databases may be left behind. Drop them via psql:

```bash
psql -U postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'simmetricchat_test_%';"
```

### Frontend tests fail on CSS imports

The Jest config already stubs CSS with `styleMock.cjs`. If you add a new file type (e.g., `.svg`, `.png`), add it to `moduleNameMapper` or mock it in `__mocks__/`.

---

## See also

- [Documentation index](./INDEX.md)
- [Development Guide](./DEVELOPMENT.md)
- [Configuration](./CONFIGURATION.md)
- [Architecture](./ARCHITECTURE.md)
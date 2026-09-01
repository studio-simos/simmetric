
# Development Guide

This document covers everything you need to develop, debug, and extend Simmetric Chat locally.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [Monorepo Workflow](#monorepo-workflow)
- [Package Structure and Responsibilities](#package-structure-and-responsibilities)
- [Running Services in Development](#running-services-in-development)
- [Database Workflow](#database-workflow)
- [Code Style and Conventions](#code-style-and-conventions)
- [Frontend Development Patterns](#frontend-development-patterns)
- [Backend Development Patterns](#backend-development-patterns)
- [Adding a New Route or Feature](#adding-a-new-route-or-feature)
- [Adding a New Package](#adding-a-new-package)
- [Testing Workflow](#testing-workflow)
- [Debugging Tips](#debugging-tips)
- [Git Workflow and Commit Conventions](#git-workflow-and-commit-conventions)
- [Common Development Commands Reference](#common-development-commands-reference)

---

## Prerequisites

- **Node.js** `>= 24.0.0` (enforced via `engines.node` in root `package.json`)
- **pnpm** `11.24.0` (pinned via `packageManager` field in root `package.json`, includes SHA-512 integrity hash)
- **PostgreSQL** `16`
- **Docker & Docker Compose** (optional but recommended for local PostgreSQL; Redis 7 for the opt-in horizontal-scaling layer)

Verify your environment:

```bash
node -v # should print v24.x.x or higher
pnpm -v # should print 11.24.0
```

No `.nvmrc` or `.node-version` file is present in the repo. Use the `engines` field in root `package.json` as the authoritative version requirement.

---

## Local Setup

### 1. Clone and Install

```bash
git clone https://github.com/simmetric-chat/simmetric-chat simmetric-chat
cd simmetric-chat
pnpm install
```

### 2. Environment Files

**The repo-root `.env` is the single runtime config (beta).** Since , all three Node services (server, collector, widget) call the zero-dependency `loadRootEnv()` helper from `@simmetric-chat/shared` (`packages/shared/src/config/loadEnv.ts`) at module load — `packages/server/src/config/env.ts`, `packages/collector/src/config/env.ts`, and `packages/widget/src/config/env.ts` each invoke `loadRootEnv(__dirname, ...)` before Zod validation. Precedence is **locked**: `process.env` (never overwritten) > repo-root `.env` (fills ONLY absent keys) > Zod default. Presence — never truthiness — defines a key (`KEY=` counts as defined). Root discovery walks up to the marker file `pnpm-workspace.yaml`, so loading stays independent of the operator's working directory. The loader never throws, never calls `process.exit`, and logs key NAMES/counts only — never values.

Recommended: create ONE root `.env` from the tracked root `.env.example` (the comprehensive reference):

```bash
cp .env.example .env
```

The per-package `.env` override layer (`packages/server/.env`, `packages/collector/.env`, `packages/widget/.env`, plus their `.env.example` templates) was **removed** after the transition — the root `.env` is now the single runtime config for every package (resolution: `process.env` > root `.env` > Zod default). The root `.env.example` is the single exhaustive template, organized in per-package sections with `[server]`/`[collector]`/`[widget]` applicability markers. Do not commit any `.env` file.

Edit the file as needed. At minimum you need:

- `DATABASE_URL` — PostgreSQL connection string (also used by pg-boss, which manages its **own** `pg.Pool` — see [Schedulers and Background Jobs](#schedulers-and-background-jobs-pg-boss) below)
- `JWT_SECRET` — min 32 characters for local dev
- `COLLECTOR_SECRET` — required for server↔collector communication (Zod-validated, min 1 char)
- `API_KEY_HMAC_SECRET` — optional; base64-encoded 32-byte HMAC-SHA256 signing key for API keys. Strict base64/32-byte validation lives in `apiKeyService.ts` (consumption site). When unset, `getHmacSecret()` throws (fail-loud 500, not 401) — there is NO JWT_SECRET fallback (decoupled from JWT_SECRET/ENCRYPTION_KEY rotation). `packages/server/.env.test` carries the test value `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` (decodes to 32 zero bytes — valid for HMAC)
- `ENCRYPTION_KEY` — optional in dev/test; base64-encoded 32-byte AES-256-GCM key for data-at-rest encryption (provider API keys, backup destination configs). **Required in production** (`NODE_ENV=production` fails boot without it). When unset in dev/test, `encryptionService.ts` falls back to the legacy `scryptSync(JWT_SECRET)` derivation so existing ciphertexts stay decryptable. Generate with `openssl rand -base64 32`; see `docs/ENCRYPTION_KEY_ROTATION.md`
- `LLM_PROVIDER` / `OLLAMA_BASE_URL` — set to `ollama` and the appropriate Ollama URL:
- **Dev mode (services on host)**: use `http://localhost:11434` — Node services run directly on the host, not in Docker containers
- **Pure Docker deployment**: use `http://ollama:11434` — the Docker container name resolves within the Docker network
- **WIDGET_API_KEY** — required for the widget service (generate with `pnpm --filter server generate-apikey`); lives in the root `.env` (the `[widget]` section documents it)
- `LICENSE_KEY` — optional; only required to unlock Enterprise feature flags (the public key is embedded in the source, so no `LICENSE_SECRET` is needed). Verify the configured license without booting the server via `pnpm license:check` (see [License CLI](#license-cli) below)
- `REDIS_URL` — optional (v0.19 scale layer); when set, enables Redis-backed rate-limit stores, the auth cache, JWT `jti` revocation, SSE pub/sub fan-out, and distributed locks. When absent, every Redis consumer degrades to its in-memory/DB fallback (`getRedis()` returns `null`)

Strictly required by the server's Zod schema (`packages/server/src/config/env.ts`): `JWT_SECRET` and `COLLECTOR_SECRET` (both `.min(1)` — boot fails with the `[env] Missing required key(s): ...` diagnostic). `DATABASE_URL` has a code default (`postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat`); the tracked root `.env.example` uses `localhost:5432` — set whichever matches your Postgres setup.

Server tests use `packages/server/.env.test` (tracked in git; currently carries `DATABASE_URL` (`localhost:5434`), `JWT_SECRET`, `NODE_ENV=test`, `COLLECTOR_SECRET`, `WIDGET_SERVICE_URL`, `WIDGET_API_KEY`, and `API_KEY_HMAC_SECRET`). Note it does **not** carry `LICENSE_KEY` since the public-release prep (2026-08-21) — unit tests mock or stub the license surface. The `smoke:license-e2e` script still reads a `LICENSE_KEY` line from `.env.test` as its test token precondition (Path A, see [License CLI](#license-cli)); if you regenerate the file, keep that line present or the smoke gate throws "Path A precondition broken".

### 3. Database

Start PostgreSQL via Docker Compose (recommended):

```bash
docker compose -f docker/docker-compose.infra.yml up -d postgres
```

Or use a locally installed PostgreSQL 16 instance. Update `DATABASE_URL` accordingly. The `docker-compose.infra.yml` file runs infrastructure only (postgres, optional qdrant) for the host-native `pnpm dev` workflow; the main `docker-compose.yml` keeps PostgreSQL isolated to the Docker network and is for pure-Docker deployments.

### 3b. Redis (Optional, v0.19 Scale Layer)

Redis is **optional** — the entire system runs in single-instance mode without it. To enable horizontal scaling (Redis-backed rate limits, auth cache, JWT `jti` revocation, SSE fan-out, distributed locks), start Redis 7 and set `REDIS_URL`:

```bash
docker run -d --name simmetric-chat-redis -p 6379:6379 redis:7-alpine
```

Then set `REDIS_URL=redis://localhost:6379` in the root `.env` (the single runtime config covers the widget's config cache and rate-limit stores too). Verify with `redis-cli ping` → `PONG`.

> **Pitfall**: the `redis` service in `docker/docker-compose.yml` is `expose:`-only (no host `ports:` mapping, no profile gating) — `docker compose up redis` binds nothing on `localhost:6379`. For host-native `pnpm dev`, use the `docker run` command above (or a compose override that adds `ports: ["6379:6379"]`).

### 4. Prisma Client and Seed

```bash
pnpm db:generate # generate Prisma client for the server package
pnpm db:migrate # apply migrations interactively
pnpm db:seed # seed default roles, permissions, templates, config
```

pg-boss (`pg-boss@^12.28.0`, pulled in by `pnpm install` as a server dependency) creates and auto-migrates its own `pgboss` schema in Postgres on `start()` — **not** a Prisma migration, so it does not affect `pnpm audit:migrations`. No manual setup is needed.

After the first seed, you can log in with the admin credentials created during setup (`admin` / `admin123`). Note: `pnpm db:seed` (`prisma/seed.ts`) sets `mustChangePassword: true` on the seeded admin, prompting a password rotation on first login — matching the bootstrap admin created at server startup via `seedBootstrapAdmin()` in `packages/server/src/services/seedService.ts`.

### 5. Start Development Servers

```bash
pnpm dev
```

This starts all services in parallel via Turborepo:

| Service | Port | Description |
|---------|------|-------------|
| Frontend | `5173` | Vite dev server + React SPA |
| Server | `3000` | Express API |
| Collector | `3210` | Document ingestion microservice |
| Widget | `3211` | Embeddable widget service |

Redis is **not** part of `pnpm dev` — it is an opt-in infra container (see [Redis (Optional)](#3b-redis-optional-v019-scale-layer) above). Without it the server logs `[redis] REDIS_URL not set — operating in single-instance mode` and every Redis consumer falls back to in-memory/DB behavior.

---

## Monorepo Workflow

This project uses **pnpm workspaces** with **Turborepo** for task orchestration.

### Workspace Layout

```text
packages/
server/ # Express API, Prisma, agent orchestration
frontend/ # React 19 SPA, Vite, Tailwind
collector/ # Document parse/chunk/embed/store microservice
shared/ # Zod schemas, TypeScript types, constants
widget/ # Embeddable chat widget (Express + Preact)
```

### Dependency Graph

```text
shared <- server
shared <- collector
shared <- frontend
shared <- widget
```

`shared` is the **only** cross-package import. Server and collector never import each other; they communicate via HTTP APIs (validated by `COLLECTOR_SECRET`). The dependency graph is strictly unidirectional — never import `server` code into `collector` or vice versa. pnpm strictness enforces no phantom dependencies: if a package is used, it must be declared in that module's `package.json`.

### Turborepo Pipeline (`turbo.json`)

| Task | Behavior |
|------|----------|
| `build` | Depends on `^build` and `db:generate` (topological), outputs to `dist/**` |
| `dev` | Persistent, no cache |
| `lint` | Depends on `^build` |
| `typecheck` | Depends on `^build` |
| `test` | Depends on `^build` |
| `db:generate` | No cache |

> **Shared rebuild gotcha:** Turbo caches `build`/`lint`/`typecheck`/`test` on `^build`. After editing `packages/shared/src/`, server/collector/widget builds, jest runs, and typechecks may execute against a **stale `shared/dist`** unless you rebuild (`pnpm --filter @simmetric-chat/shared build`) or run the task through Turbo (which replays the `^build` dependency). No package tsconfig maps `@simmetric-chat/shared` — normal tsc/Node resolution goes through `shared`'s `package.json` `exports` field (which points at `dist/index.js`), and the Jest overrides live in each package's `jest.config.js` `moduleNameMapper`: server and collector map it to `../shared/dist/index.js` (hence the stale-dist gotcha above), while widget and frontend Jest map it to shared **source** (`../shared/src/index.ts`); the **frontend additionally aliases shared source in Vite** (`vite.config.ts`) and never needs the build (the widget's `tsc` build/typecheck still resolves `shared/dist` via the `exports` field).

### Per-Package AGENTS.md

Each package and the repo root carry their own `AGENTS.md` with package-specific commands, conventions, and gotchas. **Read the package file before working inside it:**

- [`AGENTS.md`](../AGENTS.md) — repo layout, enterprise plugin contract, command reference
- [`packages/server/AGENTS.md`](../packages/server/AGENTS.md) — Express 5 API, Prisma 7, boot order, RBAC
- [`packages/frontend/AGENTS.md`](../packages/frontend/AGENTS.md) — React 19 SPA, state golden rule, i18n, chat/SSE internals
- [`packages/collector/AGENTS.md`](../packages/collector/AGENTS.md) — ingest pipeline, no-Prisma constraint
- [`packages/shared/AGENTS.md`](../packages/shared/AGENTS.md) — schema barrel, build requirement
- [`packages/widget/AGENTS.md`](../packages/widget/AGENTS.md) — Preact widget, CJS, i18n parity gate

### Running Commands Per Package

```bash
# Run a script in a single package
pnpm --filter server dev
pnpm --filter frontend dev
pnpm --filter collector dev
pnpm --filter widget dev
pnpm --filter shared build

# Run a command across all packages that define it
pnpm lint # turbo lint
pnpm typecheck # turbo typecheck
pnpm test # turbo test
```

### Installing Dependencies

```bash
# Add a dependency to a specific package
pnpm --filter server add <package>

# Add a dev dependency to the root
pnpm add -D <package> -w
```

Always verify the dependency is declared in the correct `package.json`. pnpm strictness rejects phantom dependencies — if a package is imported, it must be declared in that module's `package.json`.

---

## Package Structure and Responsibilities

### `packages/server/`

- **Entry point**: `src/index.ts` — `createApp()` factory (exported for supertest), mounts 50+ routers, applies helmet/cors/rate-limit, mounts MCP server, connects Prisma, runs auto-seed, initializes license/FTS, starts pg-boss (`startJobQueue()`), loads the enterprise plugin, then registers the 8 pg-boss cron schedulers — 7 awaited `init*Scheduler()` calls (MCP health check, MCP reaper, synthesis reaper, fidelity sampling, vector cleanup, upload-draft reaper, chat-message reaper) inside the `NODE_ENV === "production"` block, and `initWikiConsistencyScheduler` awaited after it, while the 2 `setInterval` pollers (OCR + synthesis, lines 677-678) run outside it un-awaited
- **Routes**: `src/routes/` — one file per domain (`auth.ts`, `chat.ts`, `documents.ts`, `widgets.ts`, `internalWidget.ts`, `mcp.ts` (mounted at `/api/mcp-connections`), `marketplace.ts`, `synthesis.ts`, etc.)
- **Services**: `src/services/` — business logic (`authService.ts`, `licenseService.ts`, `systemConfigService.ts`, `synthesisService.ts`, `hybridSearchService.ts`, `ftsService.ts`, `agentBudgetService.ts`, `providerService.ts`). Job scheduling: `jobQueue.ts` (pg-boss singleton — `startJobQueue`/`stopJobQueue`/`getBoss`/`createQueue`/`schedule` delegators) plus one file per cron job (`mcpReaperJob.ts`, `mcpHealthCheckJob.ts`, `synthesisReaperJob.ts`, `vectorCleanupJob.ts`, `chatMessageReaperJob.ts`, `uploadDraftReaperJob.ts`, `archiveConsistencyService.ts`); the fidelity-sampling scheduler stays inline in `src/index.ts`
- **Middleware**: `src/middleware/` — `auth.ts`, `rbac.ts`, `rateLimit.ts`, `license.ts`, `widgetCors.ts`
- **Agent**: `src/agent/` — `orchestrator.ts`, `builtinSkills.ts`, `skills.ts`, `llmStreaming.ts`, `mcpClient.ts`, `mcpServer.ts`, `implicitToolCall.ts`, `toolCallResolver.ts`, `modelFallback.ts`, `planRunner.ts`
- **Config**: `src/config/env.ts` (Zod-validated env vars via `getEnv()`, cached, `process.exit(1)` on invalid), `src/config/swagger.ts` (OpenAPI)
- **Prisma**: `prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`
- **Utils**: `src/utils/prisma.ts` — singleton Prisma client (`PrismaPg` adapter + `pg` `Pool`), exports `withSoftDelete()`

### `packages/frontend/`

- **Entry point**: `src/main.tsx`
- **Components**: `src/components/` — PascalCase files (`ChatPanel.tsx`, `SettingsPage.tsx`, `MarketplaceCard.tsx`), built with shadcn/ui (`@radix-ui/*` primitives + `class-variance-authority` + `tailwind-merge` + `clsx`)
- **Queries**: `src/queries/` — 28 TanStack Query hook files for REST/CRUD server state (`useAuth`, `useChats`, `useWorkspaces`, `useProjects`, `useProviders`, `useProviderPresets`, `useSettings`, `useLicense`, `useWidgets`, `useArchives`, `useDocuments`, `useSynthesis`, `useMarketplace`, `useMcpConnections`, `useOcrJobs`, `useOcrModels`, `useOcrPreferences`, `useOcrDefaults`, `useUploadDrafts`, `useChatTokens`, `useBackupDestinations`, `useBackupJobs`, `useBackupLogs`, `useFilters`, `useSso`, `useSystem`, `useTemplates`, `useDlpPatterns`); centralized key registry in `queries/keys.ts`
- **Contexts**: `src/contexts/` — React Context for UI lifecycle state (`ChatContext.tsx`, `EnterpriseModulesContext.tsx`, `PageMetaContext.tsx`, `ThemeContext.tsx`)
- **Hooks**: `src/hooks/` — custom hooks including `useChat.ts` (SSE streaming, split from `useChatStreaming`/`useChatPersistence`/`useChatModelSelection`/`useChatPanelState`), `useFeature.ts`, `useKeyboardShortcuts.ts`, `useModelAvailability.ts`, `useModelPalette.ts`, `useSpeechRecognition.ts`, `useMessageHistory.ts`, `useBackupPermission.ts`
- **Utils**: `src/utils/api.ts` — centralized API helpers (`apiGet`, `apiPost`, `apiPut`, `apiPatch`, `apiDelete`, `apiUpload`); `modelDefaults.ts` — per-chat model cascade
- **i18n**: `src/i18n/{en,it,ru,de,fr,es,zh,pt}/translation.json` (8 languages)
- **Vite config**: `vite.config.ts` — proxies `/api`, `/avatars`, and `/branding` to `localhost:3000` (with retry-on-ECONNREFUSED for dev resilience), plus the widget-service routes `^/widget/` and `^/api/(sessions|config|chat|lead)(/|$)` to `localhost:3211` (regex keys precede the generic `/api` key — Vite matches proxy keys in insertion order); `@` alias to `src/`, `@simmetric-chat/shared` alias to `../shared/src/index.ts`. The same proxy map is configured under `preview` for `vite preview` (used by Playwright)

### `packages/collector/`

- **Entry point**: `src/index.ts`
- **Routes**: `src/routes/ingest.ts` — upload, query, YouTube endpoints
- **Services**: `src/services/` — `parser.ts`, `chunker.ts`, `embeddings.ts` (Local `Xenova`/`hf-local`, OpenAI, Ollama providers), `vectorStore.ts` (LanceDB default, Qdrant, Chroma), `pgVectorProvider.ts` (pgvector)
- **Config**: `src/config/env.ts`
- **Constraint**: No Prisma/database access — communicates with server via HTTP only

### `packages/shared/`

- **Types**: `src/types/index.ts` — shared TypeScript interfaces
- **Schemas**: `src/schemas/` — Zod validation schemas (`auth.schema.ts`, `chat.schema.ts`, `widget.schema.ts`, `mcpConnection.schema.ts`, etc.) re-exported from `schemas/index.ts`
- **Constants**: `src/constants/` — `permissions.ts` (31 permissions), `license.ts` (11 feature flags), `providerPresets.ts`
- **Barrel export**: `src/index.ts` re-exports from `types`, `schemas`, `constants`
- **Rule**: no business logic, no runtime dependencies other than `zod`

### `packages/widget/`

- **Entry point**: `src/index.ts` — Express app factory (`createApp()`)
- **Routes**: `src/routes/` — chat, session, config, loader, lead
- **Preact UI**: `src/widget/` — embeddable iframe bundle (NOT React — Preact IIFE, deliberately no shadcn/Radix)
- **Build**: two outputs: `tsc` to `dist/` (server), Vite IIFE to `dist-widget/app.js` (client) via `vite.widget.config.mts`
- **Service**: `src/services/widgetApi.ts` — proxies chat SSE to server with `X-Api-Key` auth
- **i18n**: `src/widget/i18n/{en,it,ru,de,fr,es,zh,pt}.json` (8 locales) — the widget has its own i18next init (`initWidgetI18n()` in `src/widget/i18n/index.ts`, fresh instance per call) and its own parity gate `pnpm --filter widget i18n:check` (exact key parity across ALL 8 locales + no empty-string values — the frontend gate also covers all 8 locales, so the widget gate is stricter only in the non-empty-value check). Locale resolution: `?locale=` (from parent `data-locale`) → `Accept-Language` → server default; an absent `?locale=` is never defaulted to `en`

---

## Running Services in Development

### All Services at Once

```bash
pnpm dev
```

Turborepo runs `dev` scripts in all packages concurrently. The server uses `tsx watch src/index.ts` for hot reload; the frontend uses Vite's HMR. Services communicate via localhost ports.

### Individual Services

```bash
# Server only (with hot reload via tsx watch)
pnpm --filter server dev

# Frontend only (Vite dev server on 5173)
pnpm --filter frontend dev

# Collector only
pnpm --filter collector dev

# Widget only
pnpm --filter widget dev
```

### Frontend Proxy

In development, the Vite dev server proxies `/api`, `/avatars`, and `/branding` to `http://localhost:3000` (and the widget service's routes to `:3211`) with retry-on-ECONNREFUSED for dev resilience (see `configureDevProxy` in `vite.config.ts` — up to 8 retries over ~4s, GET/HEAD only). If the backend stays down, frontend API calls eventually fail with a `Backend unavailable (dev proxy)` JSON error. The proxy only runs in dev mode and `vite preview`; production builds expect the API at the same origin.

### Access Points

| URL | Description |
|-----|-------------|
| `http://localhost:5173` | Frontend SPA |
| `http://localhost:3000/api/health` | Server health check |
| `http://localhost:3000/api-docs` | Swagger UI (OpenAPI 3.0) |
| `http://localhost:3210/api/health` | Collector health check |
| `http://localhost:3211/health` | Widget health check |

---

## Database Workflow

### Schema Location

The canonical Prisma schema lives at `packages/server/prisma/schema.prisma`. Migrations are in `packages/server/prisma/migrations/`.

### Generate Prisma Client

```bash
pnpm db:generate
```

This runs `prisma generate` in the server package and applies a symlink workaround (`scripts/fix-prisma-pnpm.cjs`) for Prisma 7 + pnpm compatibility.

### Migrations vs. db:push

| Command | Use Case |
|---------|----------|
| `pnpm db:migrate` | **Development**: interactive migration creation (`prisma migrate dev`) |
| `pnpm db:migrate -- --name add_widgets` | Create a named migration |
| `prisma migrate deploy` | **Production/CI**: apply pending migrations without interaction |
| `prisma db push` | **Rapid prototyping**: sync schema without migration files (use with caution) |

For local development, prefer `pnpm db:migrate`. For CI and production Docker deployments, use `prisma migrate deploy` (migrations run automatically on container startup via `docker/entrypoint-server.sh`).

### Seeding

```bash
pnpm db:seed
```

Runs `prisma db seed` which executes `prisma/seed.ts`. This creates:

- Default roles (Admin, User) and the `admin` / `admin123` account (idempotent; `mustChangePassword` IS set by `pnpm db:seed` — rotation forced at first login, matching the server-startup `seedBootstrapAdmin()` in `packages/server/src/services/seedService.ts`, which also sets `mustChangePassword: true`)
- Permissions (31 total) mapped to roles
- 13 menu sections per role via `RoleMenuSection`
- Default system configuration values
- Prompt templates

### Resetting the Database

```bash
cd packages/server
npx prisma migrate reset
```

> **Warning**: `prisma migrate reset` drops all data and re-runs migrations. In CI, it requires `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes"`.

For the additive-only migration policy enforced in CI, see [Migration & Restore Safety](./MIGRATION_SAFETY.md). Migration workflow: edit `packages/server/prisma/schema.prisma` → `pnpm db:generate` → `pnpm --filter server db:migrate` → `pnpm db:seed`. Migrations MUST be additive-only (no `DROP TABLE`/`DROP COLUMN`/`DROP INDEX`); after any schema change run `pnpm audit:migrations` and commit the regenerated `docs/MIGRATION_AUDIT.md` in the same PR (the `migration-safety-check` CI job fails on drift). Destructive migrations require explicit consent via the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` repo variable (guards: `pnpm db:migrate:guard`, `pnpm db:migrate:reset:guard`).

### Prisma Best Practices

- **Never instantiate `new PrismaClient()` directly** — always import the singleton from `packages/server/src/utils/prisma.ts`. The singleton installs a `PrismaPg` adapter backed by a `pg` `Pool` (driver-adapter pattern, Prisma 7) and is cached on `globalThis`; it also applies `withSoftDelete()`. The enterprise plugin receives the same singleton via its `PluginContext`.
- Use `withSoftDelete(where)` from `packages/server/src/utils/prisma.ts` to add the `deletedAt: null` soft-delete filter to Prisma `where` clauses without `as any` casts. It is a type-preserving no-op helper.
- All queries on soft-deletable entities (projects, workspaces, documents, widgets, chats, archives) must include `where: { deletedAt: null }`.
- Hard deletes are forbidden in the API. Exception: `MCPConnection` (uninstall) and `ChatMCPPin` (unpin) are hard-deleted by design — no tombstone.
- Use `prisma.$transaction([...])` for multi-step atomic operations.
- The schema is the single source of truth; update `schema.prisma` before writing any migration.

---

## Code Style and Conventions

### ESLint

ESLint 10 flat config at `eslint.config.mjs` (root level). Includes `typescript-eslint` recommended rules (syntax-only — `recommended`, not `recommendedTypeChecked`), `eslint-plugin-react-compiler` (RC), and `eslint-plugin-react-hooks` (registered manually in flat-config format because the plugin's shipped `recommended-latest` config uses the legacy eslintrc array form, which ESLint 10 rejects).

| Rule | Setting |
|------|---------|
| `@typescript-eslint/no-explicit-any` | `warn` |
| `@typescript-eslint/no-unused-vars` | `warn` (args/vars starting with `_` ignored) |
| `@typescript-eslint/no-require-imports` | `off` |
| `@typescript-eslint/no-namespace` | `off` |
| `@typescript-eslint/no-unsafe-function-type` | `warn` (pre-existing debt, tracked for cleanup) |
| `@typescript-eslint/ban-ts-comment` | `off` in `__tests__/` (tests use `@ts-nocheck` intentionally) |
| `no-empty` | `error`, but `allowEmptyCatch: true` |
| `no-useless-assignment` | `off` |
| `no-control-regex` | `off` (deliberate control-char sanitization in `fileUtils.ts`) |
| `no-async-promise-executor` | `warn` (pre-existing debt) |
| `preserve-caught-error` | `error` (0 violations verified) |
| `react-compiler/react-compiler` | `error` in source (off in `__tests__/` — test render-components capture refs for assertions) |
| `react-hooks/rules-of-hooks` | `error` (0 violations verified) |
| `react-hooks/exhaustive-deps` | `warn` |

Files scanned: `packages/*/src/**/*.ts`, `packages/*/src/**/*.tsx`
Ignored: `dist/`, `node_modules/`, `.prisma/`, `src/generated/`, `__mocks__/`, `*.d.ts`, `*.cjs`

> **Note**: `projectService` is intentionally **not** enabled. The config uses only syntax-only `tseslint` rules (`recommended`, not `recommendedTypeChecked`), so no rule consumes TypeScript type information. Re-enable `projectService` only if a `*TypeChecked` ruleset is adopted, and then use a dedicated tsconfig that includes tests.

```bash
pnpm lint # lint all packages
pnpm --filter server lint
```

### Dead-Code Gate (knip)

`knip` runs in CI inside the `lint-and-typecheck` job (`pnpm knip`, ~3s, no build/DB needed) and fails on **new** unused files, dependencies, devDependencies, or exports. Run it locally:

```bash
pnpm knip # full report (exit 1 on findings)
I18N_UNUSED_VERBOSE=1 node packages/frontend/scripts/i18n-usage-check.cjs # list unused i18n keys
```

**Allowlist policy** (`knip.json` — each entry carries an explanatory comment):

| Allowlist | Why |
|-----------|-----|
| `tags: ["-enterpriseConsumed"]` | Exports consumed by the **private enterprise sibling repo** via the root `link:` dependency — knip cannot see it (absent on CI). Tagged: `saveSsoConfigSchema`, `EnterprisePlugin`, `MinimalExpressApp`, `MinimalLogger` (barrel `schemas/index.ts`). When the enterprise package grows its shared-API surface, tag the new export by hand — CI cannot grep the private repo. |
| `ignoreDependencies: ts-jest` | The documented rollback transformer — `git revert <DEP-01 commit>` restores it. Intentionally unused at runtime (all jest configs use `@swc/jest`). |
| `ignoreDependencies: @simmetric-chat/enterprise` | Runtime `require.resolve()` string, no static import (air-gap install seam). |
| `ignore: src/components/ui/**` (frontend) | shadcn/ui generated primitives — pruning fights the CLI generator. |
| `ignoreBinaries: pdftoppm, jest` | System binary (Poppler, installed in Docker images) / direct CLI use. |
| `exclude duplicates` (CLI flag in the `knip` script) | Intentional dual named+default component exports (named for tests, default for pages). |

**Widget i18n inverse report:** both i18n scripts (`packages/frontend/scripts/i18n-usage-check.cjs`, `packages/widget/scripts/i18n-check.cjs`) additionally print a **warning-only** count of defined-but-never-used `en` keys (always exit 0 — key deletion is an 8-locale edit, deferred by policy). Set `I18N_UNUSED_VERBOSE=1` to list them.

### TypeScript Strictness

`strict: true` is enabled in **all five packages** (`server`, `collector`, `frontend`, `shared`, `widget`). Frontend additionally enables `noUnusedLocals` and `noUnusedParameters`.

| Package | `strict` | Module system | Notes |
|---------|----------|---------------|-------|
| root | — | ESM (`"type": "module"`) | Scripts + tooling configs only |
| `frontend` | `true` | ESM (`"type": "module"`, `"module": "ESNext"`) | `noUnusedLocals`, `noUnusedParameters` enabled |
| `shared` | `true` | CommonJS | Emits declarations to `dist/` |
| `server` | `true` | CommonJS | |
| `collector` | `true` | CommonJS | |
| `widget` | `true` | CommonJS | |

Module formats differ per package: root + frontend are ESM; server, collector, shared, and widget are CJS — **respect each package's tsconfig `module` setting** (CJS packages rely on native `__dirname`, which the `__dirname`-relative `.env` resolution depends on).

Target: `ES2022` across all packages. TypeScript version: `^6.0.3` (root dependency). Frontend uses the `react-jsx` transform (no `import React` needed) and `moduleResolution: "bundler"`. No Prettier configuration file is present — formatting is enforced through ESLint and TypeScript strict mode.

### Naming Patterns

| Layer | Pattern | Example |
|-------|---------|---------|
| Server routes | camelCase, domain suffix | `auth.ts`, `apiKeys.ts`, `eventLogs.ts` |
| Server services | camelCase + `Service` suffix | `authService.ts`, `licenseService.ts` |
| Server middleware | camelCase | `auth.ts`, `rbac.ts`, `rateLimit.ts` |
| Frontend components | PascalCase | `ChatPanel.tsx`, `SettingsPage.tsx` |
| Frontend query hooks | camelCase + `use` prefix | `useAuth.ts`, `useChats.ts`, `useWorkspaces.ts` |
| Frontend hooks | camelCase + `use` prefix | `useChat.ts`, `useFeature.ts` |
| Shared schemas | camelCase + `.schema.ts` | `auth.schema.ts`, `widget.schema.ts` |
| Shared types | barrel in `types/index.ts` | `export type LoginInput = z.infer<typeof loginSchema>` |
| Shared constants | camelCase | `permissions.ts`, `license.ts` |
| Test files | co-located `__tests__/` | `*.test.ts`, `*.test.tsx` |
| Mock files | co-located `__mocks__/` | — |

### Import Organization

- **Frontend alias**: `@` resolves to `src/`; `@simmetric-chat/shared` resolves to `../shared/src/index.ts` via Vite config.
- **Server/Collector/Widget**: import shared via `import { ... } from "@simmetric-chat/shared"`.
- **No path aliases within individual packages** — use relative imports (`../utils/api`).
- **Jest mapping**: `@simmetric-chat/shared` resolves to `<rootDir>/../shared/dist/index.js` (server) or `<rootDir>/../shared/src/index.ts` (frontend/widget/shared configs).

### Constants and Types

- Variables/functions: `camelCase` (`createWorkspaceSchema`, `getEnv`, `findUnique`)
- Constants: `SCREAMING_SNAKE_CASE` (`PERMISSION_NAMES`, `FEATURE_FLAGS`, `CONFIG_DEFAULTS`, `MENU_SECTIONS`, `SALT_ROUNDS`)
- Booleans: use `is`/`has`/`should` prefixes (`isAuthenticated`, `isAdmin`, `isStreaming`)
- Types/interfaces: `PascalCase` (`LoginInput`, `ChatMessage`, `SourceCitation`)
- Prisma models: `PascalCase` (`User`, `Workspace`, `Widget`)
- Prisma fields: `camelCase` (`passwordHash`, `createdAt`, `deletedAt`)
- Table names: `@@map("snake_case")` (e.g., `@@map("users")`, `@@map("user_roles")`)
- Composite primary keys via `@@id` (e.g., `WidgetWorkspace` uses `@@id([widgetId, workspaceId])`)

### Zod Schema Patterns

- All request validation schemas live in `packages/shared/src/schemas/` and are re-exported from `packages/shared/src/schemas/index.ts`. Server and collector both validate against the same schemas.
- Named exports: `export const loginSchema = z.object({...})` with `export type LoginInput = z.infer<typeof loginSchema>`.
- UUID validation: `z.string().uuid("Invalid workspace ID")`.
- String length limits: `z.string().min(1).max(50000)` for message content.
- Nullable optional fields: `z.string().max(5000).nullable().optional()`.
- Enum validation: `providerTypeSchema` in `packages/shared/src/schemas/provider.schema.ts` — `z.enum(["ollama", "openai", "anthropic", "openrouter", "gemini", "xiaomi", "minimax"])` (7 values; `openrouter` and the native types are declared for storage, with runtime handlers added incrementally — until a handler ships, `refreshModels`/`streamLLM`/`callNonStreamingLLM` throw "Native handler not yet implemented").
- Permission types use `as const` tuple pattern with `z.enum(PERMISSION_NAMES)`.
- Default values: `z.string().default("Xenova/all-MiniLM-L6-v2")`.
- Use `safeParse` (not `parse`) in route handlers so validation errors return `400` instead of throwing `500`.
- Server env vars are validated via Zod in `packages/server/src/config/env.ts`. `getEnv()` returns a typed `Env` object (cached after first parse) and calls `process.exit(1)` on invalid values — the server never starts in an undefined state.

---

## Frontend Development Patterns

### React 19 + Vite

The frontend is a React 19 SPA built with Vite. No Next.js.

- JSX transform: `react-jsx` (no `import React` needed)
- Module system: ESM (`"type": "module"` in `package.json`, `"module": "ESNext"` in `tsconfig.json`)
- Dev server port: `5173`
- React Compiler: enabled via `babel-plugin-react-compiler` in Vite config (target: 19)

### State Management (Three-Tier Architecture)

Zustand was fully removed on 2026-05-24. The frontend now uses a three-tier state architecture. See `packages/frontend/docs/STATE_MANAGEMENT.md` for the full boundary document.

**Tier 1: TanStack Query** (`src/queries/`) — REST/CRUD server state. 28 hook files using `useQuery`/`useMutation` with centralized key registry in `queries/keys.ts`. Query client defaults: 30s staleTime, 1 retry (skipped for 401/403/429), no mutation retries.

| Hook | Responsibility |
|------|---------------|
| `useAuth` | User session, JWT token, menu sections |
| `useChats` | Chat list per workspace, rename, delete |
| `useWorkspaces` | Workspace CRUD |
| `useProjects` | Project CRUD |
| `useProviders` | LLM providers and available models (30s polling) |
| `useProviderPresets` | Provider preset catalog (one-click OpenAI-compat setup) |
| `useSettings` | System configuration read/write |
| `useLicense` | License tier, feature flags, numeric limits |
| `useWidgets` | Widget CRUD, leads, analytics |
| `useArchives` | Archive list, detail, pages, config |
| `useDocuments` | Document list/CRUD |
| `useSynthesis` | Synthesis runs, pending count |
| `useMarketplace` | MCP catalog, install/uninstall |
| `useMcpConnections` | MCP connection CRUD, status polling |
| `useOcrJobs`, `useOcrModels`, `useOcrPreferences`, `useOcrDefaults` | OCR pipeline |
| `useUploadDrafts` | Pending upload drafts |
| `useChatTokens` | Token usage / budget tracking |
| `useBackupDestinations`, `useBackupJobs`, `useBackupLogs` | Backup system |
| `useFilters` | Filter management (admin, `filters:manage` permission) |
| `useSso` | SSO provider configuration |
| `useSystem` | Setup-wizard system state: initialization check, probe LLM/vector |
| `useTemplates` | Prompt/chat templates |
| `useDlpPatterns` | DLP pattern CRUD + test (admin, `/api/system/dlp/patterns`) |

**Tier 2: React Context** (`src/contexts/`) — UI lifecycle/navigation state:

| Context | Responsibility |
|---------|---------------|
| `ChatContext` | Workspace/chat navigation with imperative setters for non-React callbacks |
| `PageMetaContext` | Page title and metadata |
| `ThemeContext` | Dark/light theme, persisted to localStorage |

**Tier 3: fetchEventSource + useState/useRef** (`src/hooks/useChat.ts` and split siblings) — SSE streaming:

Token-by-token chat streaming via `@microsoft/fetch-event-source`. State via `useState`/`useRef`, NOT TanStack Query (SSE is an open persistent connection, not request/response). `streamingContent` updated with functional `setStreamingContent((prev) => prev + token)` to avoid stale closures.

**Golden rule:** If data originates from a REST endpoint, use TanStack Query. If it streams over SSE, use fetchEventSource + useState/useRef. If it's pure UI state (selected tab, theme, navigation), use React Context. Zustand was removed (2026-05-24) — `src/stores/` no longer exists; don't reintroduce it.

### Component Library (shadcn/ui)

The frontend uses **shadcn/ui** (`shadcn: ^4.19.0`) with Radix primitives (`@radix-ui/*`), `class-variance-authority`, `tailwind-merge`, and `clsx`. Components are built on these primitives — no custom component library from scratch. The widget package deliberately does NOT use shadcn/Radix.

Toast notifications use **sonner** (`sonner: ^2.0.8`) via `src/lib/toast.ts` helpers (`showSuccess`, `showError`, `showInfo`, `toastWithAction`).

### Tailwind CSS + Theming

- Tailwind CSS v4 with PostCSS (`@tailwindcss/postcss`)
- Custom properties in `src/index.css` under `:root` and `.dark`: shadcn tokens (`--background`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, etc.), mapped into Tailwind v4 `@theme inline` color tokens (`--color-background`, `--color-card`, `--color-primary`, …). The `--bg`/`--surface`/`--text-muted`/`--scrollbar-thumb` tokens are **not** defined in any frontend CSS file — components reference them via `var(--…)` fallbacks (e.g., `var(--primary, #4c6ef5)`) or they resolve to the shadcn tokens
- Usage: `bg-[var(--surface)]` not hardcoded colors; `text-[var(--text-muted)]` not `text-gray-500`
- Dark mode: `darkMode: "class"` — toggle `.dark` class on `<html>`
- Transition: `150ms` on `background-color`, `border-color`, `color` for smooth theme switching
- Custom primary scale: the frontend `tailwind.config.ts` only sets `content` and `darkMode: "class"` — the `primary-50` through `primary-900` scale lives in the **widget's** `packages/widget/src/widget/index.css` (`@theme` block, indigo-blue palette)
- Selection/checked-state utility: `data-checked:bg-primary`

### i18n

- `react-i18next` with JSON translation files in `src/i18n/{en,it,ru,de,fr,es,zh,pt}/translation.json` (8 languages)
- All 8 locales are parity-checked against `en` by `pnpm i18n:check` — new UI features MUST include translations for all 8 before merging (frontend namespaces are scoped by the `--namespaces=` list in `packages/frontend/package.json` — currently `chat.palette, chat.comparison, chat.fallback, chat.modelSelector, chat.modelCommand, chat.capabilities, wiki, config, archives, uploads, chat.archive, mcpHelp, documents, synthesis.rename, settings.webSearch, widgets, setup.wizard, workspace, synthesis, ocr` — that list is the source of truth; add new namespaces there. `i18n-usage-check.cjs` additionally fails on `t()` keys absent from `en`)
- Language persisted to `localStorage`
- Parity check before merging: `pnpm i18n:check` (runs `packages/frontend/scripts/i18n-check.cjs` + `i18n-usage-check.cjs` against the configured namespaces, then `packages/widget/scripts/i18n-check.cjs` for the widget's 8 locales — the widget gate also fails on empty-string values; see [Widget i18n](#packageswidget) above)

### SSE Streaming (`useChat`)

- Uses `@microsoft/fetch-event-source`
- Endpoint: `/api/workspaces/:id/chat/stream`
- Events: `token`, `status`, `citations`, `done` (with `model`, `providerType`, `mcpSources`, `resolvedWikilinks`, `pipeline`, `doneReason` — `providerUsed` appears nowhere in the payload), `error`
- Abort via `AbortController`; sending a new message aborts the previous stream
- Errors surfaced via `formatStreamError()` which extracts server `details` for validation failures
- Per-chat model selection persisted via `updateChatModel()` — see [Per-chat Model Selection](#per-chat-model-selection) below

### Per-chat Model Selection

Model resolution priority (highest first):

1. Per-chat override (set via the model palette / `updateChatModel()`)
2. Workspace default
3. Global default
4. Environment variables (`LLM_PROVIDER`, `LLM_MODEL`)

Model availability is polled every 30s by `useProviders`/`useModelAvailability`. The `ModelPalette` (Cmd+K) lets users override the model for the current chat; side-by-side comparison mode (Cmd+Shift+M) sends the same prompt to two models. If a selected model becomes unavailable, the orchestrator falls back to the next priority level gracefully (see `packages/server/src/agent/modelFallback.ts` and `packages/frontend/src/utils/modelDefaults.ts`).

### Keyboard Shortcuts

- `Cmd+K` / `Ctrl+K`: open model palette
- `Cmd+Shift+M` / `Ctrl+Shift+M`: open model comparison
- `Esc`: close palette/comparison
- Registered globally in `useKeyboardShortcuts.ts` (using `useEffectEvent` so the handler always reads fresh props); the palette/comparison components handle their own `Esc`-to-close

---

## Backend Development Patterns

### Express Routes

Route files export a default `Router` instance.

```typescript
import { Router } from "express";
const router = Router();

router.get("/", ...);
router.post("/", ...);

export default router;
```

Mounted in `src/index.ts` with a domain prefix (e.g., `app.use("/api/auth", authRoutes)`). Each public route carries an `@openapi` JSDoc block scanned by `swagger-jsdoc` into the spec served at `/api-docs`.

### Middleware Chain

Typical route middleware stack:

```typescript
router.post(
"/",
authMiddleware,
requirePermission("workspace:write"),
requireWorkspaceAccess,
async (req, res) => { ... }
);
```

| Middleware | Responsibility |
|------------|--------------|
| `authMiddleware` | JWT or API key validation; populates `req.userId`, `req.user` |
| `requirePermission("name")` | RBAC permission check (31 permissions); returns 403 if missing |
| `requireWorkspaceAccess` | IDOR prevention; verifies user owns/has access to workspace |
| `requireProjectAccess` | IDOR prevention for project-scoped resources |
| `rateLimit.ts` | General `apiRateLimiter` (200/min prod, 2000/min dev) and `authRateLimiter` (10/min prod, 100/min dev); `widgetLeadLimiter` for lead submissions (3/hour prod, 30/hour dev); `probeRateLimiter` (10/min prod, 100/min dev) mounted per-route on the public `/api/system/probe-llm` and `/api/system/probe-vector` wizard endpoints to cap the SSRF scan budget. When `REDIS_URL` is set, each limiter attaches a `rate-limit-redis` store on the shared `getRedis()` connection with per-limiter key prefixes (`rl:auth:`, `rl:api:`, `rl:lead:`, `rl:probe:`) so buckets are shared across server instances (v0.19 TEC-03a); without Redis, `express-rate-limit` falls back to its in-process `MemoryStore`. The `apiRateLimiter` `skip: X-Widget-Id` behavior is preserved verbatim (widget-originated upstream calls are throttled by the widget service's per-widget `widgetChatLimiter` instead). The `authRateLimiter` also skips GET requests in dev AND every method when `E2E_RUN=1` (set by `playwright.config.ts` — the 35-test E2E suite would exhaust the 100/min bucket mid-run; the skip is active only under the Playwright harness, never in `pnpm dev`/`pnpm start`/production). The `chatRateLimiter` was removed (Variante A refactor) — the ReAct agent now enforces its own budget via `AgentBudgetTracker` (`agentBudgetService.ts`), with the general `apiRateLimiter` as a coarse global safety net |
| `license.ts` | Feature flag gating (`requireFeature`, `requireFeatureLimit`); 402 on gated feature |

### Roles, Permissions, and Menu Sections

- **Roles**: `admin` (the de-facto superuser — `DEFAULT_ADMIN_ROLE.permissions = [...PERMISSION_NAMES]`, all 31 permissions + all 13 menu sections; no explicit `DEFAULT_SUPERUSER_ROLE` constant exists) and `user` (limited permissions + restricted menu sections)
- **Permissions** (31 total): grouped by resource — Workspace, Project, Chat, Document, Admin (users/settings/roles), Creation, Provider, Archive, Backup, Memory, Filters. Defined in `packages/shared/src/constants/permissions.ts` as an `as const` tuple.
- **Menu sections** (13): `dashboard`, `chat`, `documents`, `knowledgeBase`, `workspaces`, `projects`, `marketplace`, `mcpConnections`, `eventLog`, `analytics`, `widget`, `settings`, `uploads`. Per-role via `RoleMenuSection`. Sidebar visibility is gated client-side using the sections returned by `GET /api/roles/me/menu-sections` (declared in `packages/server/src/routes/roles.ts` before the `/:roleId` route).
- **Registration gating**: `ALLOW_REGISTRATION` env var — `true` for open signup, `false` for admin-only creation.

### License Gating

`packages/server/src/middleware/license.ts` gates enterprise features behind `LICENSE_KEY` (an RS256 JWT verified with the public key embedded in `license-public-key.ts`). Enforced features (11 total, defined in `packages/shared/src/constants/license.ts`): SSO, immutable audit logs, white-label branding, custom agent config (numeric limit), widget system, backup system, widget-credits editing — plus numeric limits — `max_workspaces`, `max_projects`, and `max_widgets` enforced on creation routes via `requireFeatureLimit` (workspaces.ts, projects.ts, widgets.ts); `max_backup_destinations` is enforced in the enterprise package (the 4 backup route groups moved there in , EPA-06); `custom_agents` has no enforcement site yet ( verdict: numeric limit, UI is a future milestone); `max_memories_per_user` was removed in and is not enforced anywhere. Commodity features (web search, webhooks, push notifications, memory, auto title, lead export, widget analytics) are always-ON in Community builds. **Graceful degradation**: expired Enterprise licenses automatically revert to Community at runtime — features silently disable rather than crashing.

#### License CLI

`pnpm license:check` (or `pnpm --filter server license:check`) verifies the configured license **without starting the server**, reusing the same `verifyLicenseKey` code path as startup so verdicts always match runtime behavior:

| Exit code | Meaning |
|-----------|---------|
| `0` | Valid Enterprise key OR Community-entitled state (no `LICENSE_KEY` configured — the normal Community state) |
| `1` | Token doesn't entitle (expired / bad signature / malformed / schema mismatch — key exists but fails verification) |
| `2` | Env/config error (dotenv load failure only) |

```bash
pnpm license:check # human-readable verdict
pnpm license:check -- --json # machine-readable single-line JSON: { tier, expiresAt, reason, exitCode }
```

Security contract: stdout/stderr never carry `LICENSE_KEY` or the decoded payload — only the closed reason enum, tier, and expiry (same canary-absence guarantee as the admin `GET /api/license/diagnose` endpoint). Implementation: `packages/server/scripts/check-license.ts` (commander CLI; note it deliberately does not call `getEnv()` — that function's uncatchable `process.exit(1)` would collide with the exit-code contract).

The end-to-end license diagnostics gate is `pnpm smoke:license-e2e` (`packages/server/scripts/smoke-license-e2e.ts`): it boots one live server instance (port 3102) with the test token read from the `LICENSE_KEY` line in `packages/server/.env.test` — the embedded production public key rejects it (expects Community-degraded `bad-signature` verdicts) — and asserts the boot-log line, the `/api/license/diagnose` response, and the `license:check` CLI exit code, with a cross-cutting canary-absence check that no surface leaks the key or JWT body. Note the committed `.env.test` currently carries **no** `LICENSE_KEY` line (it was removed in the public-release prep), so a local run requires re-adding a test token; it also boots against the **dev** `DATABASE_URL` (`:5432` — `.env.test` points at `:5434` with no live server) and needs a live PostgreSQL on that URL.

### Services

Services export named functions containing business logic. Routes delegate to services rather than inlining logic.

```typescript
// authService.ts
export async function register(data: RegisterInput) { ... }
export async function login(input: LoginInput) { ... }
```

(`createUser`/`validatePassword` do not exist in `authService.ts` — the actual exports are `register`, `login`, `generateToken`, `verifyToken`, `getUserWithRoles`, `getCachedUserWithRoles`, and `invalidateAuthCache`.)

Services re-validate input with `schema.parse()` for defense-in-depth even when the route already validated via `safeParse`.

### Prisma Patterns

- Singleton client: `import prisma from "../utils/prisma"` (uses `PrismaPg` adapter + `pg` `Pool`, cached on `globalThis`)
- Soft deletes: `deletedAt: DateTime?` field; queries filter `where: { deletedAt: null }` — use `withSoftDelete()` from `../utils/prisma` to keep types intact
- No hard deletes in the API (exception: `MCPConnection` uninstall, `ChatMCPPin` unpin)
- `prisma.$transaction([...])` for atomic multi-step operations

### Error Handling

Consistent JSON error format:

```json
{ "error": "string" }
```

Validation errors include `details`:

```json
{ "error": "Invalid request body", "details": { "field": ["message"] } }
```

License/feature errors return `402`:

```json
{ "error": "...", "feature": "widget_enabled", "tier": "community" }
```

Numeric limit errors add `limit` and `current` fields:

```json
{ "error": "...", "feature": "max_widgets", "tier": "enterprise", "limit": 1, "current": 1 }
```

Status code conventions: `400` validation, `401` auth missing/invalid, `403` insufficient permissions, `402` feature/limit gated, `404` not found, `409` conflict, `500` internal (global error handler in `src/index.ts` logs via `logger.error()` and returns `{ error: "Internal server error" }`). 404 catch-all returns `{ error: "Not found" }`. SSE streaming errors are sent as `event: error\ndata: {"error": "..."}\n\n` so the frontend can surface them inline. Catch `err: unknown` and narrow with `err instanceof Error ? err.message : String(err)`. Include a module prefix in log messages: `[widgets]`, `[auth]`, `[mcp]`, `[agent]`.

### Logging

Winston logger with module prefix in brackets: `[server]`, `[agent]`, `[mcp]`, `[provider]`, `[env]`, `[widgets]`, `[skills]`, etc.

- Log level from `LOG_LEVEL` env var (default: `info`)
- Console transport with colorize (development)
- File transports: `storage/logs/error.log` (errors only, 5MB max, 3 files) and `storage/logs/combined.log` (all levels, 5MB max, 5 files)
- Format: `YYYY-MM-DD HH:mm:ss [level]: message {metadata}`
- Sensitive data is **not** redacted from log metadata — the Winston logger (`packages/server/src/utils/logger.ts`) has no redaction format function. Redaction exists only in two other places: DLP content redaction (`packages/server/src/services/dlpFilter.ts` + `src/filters/plugins/dlp.ts`, PII in chat content) and license-route response redaction (`redactSecret()` in `packages/server/src/routes/license.ts`)
- Frontend: `console.*` only (no client-side logging framework)

### Schedulers and Background Jobs (pg-boss)

Since v1.4 the server runs its recurring jobs on **pg-boss** (`pg-boss@^12.28.0`) instead of in-process timers. pg-boss is backed by the **same Postgres** as app data — it manages its own `pg.Pool` (default `max: 10`), keeps its own `pgboss` schema (auto-created + auto-migrated by `start()`), and provides **distributed job dedup** across instances (exactly one server in a fleet fires each scheduled job — see `docs/SCALING.md` §3).

**Singleton and lifecycle** (`packages/server/src/services/jobQueue.ts`):

- `startJobQueue()` — constructs `new PgBoss(getEnv().DATABASE_URL)`, wires `on("error")` (warn-level; pg-boss retries internally) and `on("stopped")`, then `await boss.start()`. **Graceful degradation :** on any failure it logs at error, leaves `getBoss() === null`, and returns normally — the server still boots (REST/SSE unaffected). Never throws, never `process.exit`.
- `getBoss()` — returns the singleton or `null`; every scheduler init checks `getBoss() === null` and logs a warn ("pg-boss unavailable — scheduler offline ") with **no fallback timer**.
- `createQueue(name)` / `schedule(name, cron, data)` — thin delegators. **`createQueue` MUST precede `schedule`** (a schedule references a queue by name; pg-boss throws otherwise). `schedule` is an idempotent upsert (`ON CONFLICT DO UPDATE`) — safe on every boot.
- `stopJobQueue()` — drains in-flight jobs (`stop({ graceful: true, timeout: 4500 })`, 500ms buffer under the 5s shutdown race), null-safe.

**Boot order** (`packages/server/src/index.ts`): `prisma.$connect()` → `initLicense()` → `await startJobQueue()` → `loadEnterprisePlugin(app)` → `mountCatchAlls(app)` → the `NODE_ENV === "production"` block where 7 of the 8 cron schedulers are registered with `await`, then `initWikiConsistencyScheduler` + the 2 pollers run outside it (deterministic order, registration errors surface at boot). The 7 per-scheduler `shutdown*` calls were removed — `stopJobQueue()` drains all workers. Invariants are enforced by `src/__tests__/bootOrder.test.ts` (see [Test Patterns](#test-patterns-v14-additions) below).

**The 8 pg-boss cron schedulers** (all follow the `createQueue` → `schedule` → `boss.work` pattern; the handler receives a `Job[]` array, **not** a single job — iterate with `for...of`, and log-and-resolve rather than re-throw to avoid retry storms):

| Scheduler | File | Cron | Schedule |
|-----------|------|------|----------|
| MCP health check | `src/services/mcpHealthCheckJob.ts` | `*/30 * * * *` | every 30 min |
| MCP reaper | `src/services/mcpReaperJob.ts` | `*/5 * * * *` | every 5 min (probes `listTools`, disconnects stale) |
| Synthesis reaper | `src/services/synthesisReaperJob.ts` | `*/15 * * * *` | every 15 min (flips orphaned `PROCESSING` → `FAILED`) |
| Vector cleanup | `src/services/vectorCleanupJob.ts` | `*/5 * * * *` | every 5 min |
| Wiki/archive consistency | `src/services/archiveConsistencyService.ts` | `0 * * * *` | hourly (`initWikiConsistencyScheduler`) |
| Upload-draft reaper | `src/services/uploadDraftReaperJob.ts` | `0 3 * * *` | daily 03:00 UTC |
| Chat-message reaper | `src/services/chatMessageReaperJob.ts` | `0 3 * * *` | daily 03:00 UTC (retention, D-10/D-12) |
| Fidelity sampling | inline in `src/index.ts` (`initFidelitySamplingScheduler`, queue `fidelity_sampling`) | `0 3 * * 0` | weekly Sunday 03:00 UTC (production only) |

**The 2 remaining `setInterval` pollers** stay in `src/index.ts` and run in both dev and production (10s latency-sensitive polling — cron's 1-minute minimum granularity is too coarse, D-01):

- `initOcrPipelineScheduler()` — polls every 10s for pending OCR/URL jobs, enforces `MAX_CONCURRENT_OCR_JOBS = 2` via `getActiveJobCount()`, `isRunning` overlap guard
- `initSynthesisPipelineScheduler()` — polls every 10s for pending synthesis jobs, `isRunning` overlap guard

These two are **not** awaited and are guarded by a per-cycle `isRunning` overlap flag inside the `setInterval` callback (no `withDistributedLock` — cross-instance duplicate dispatches are absorbed by the claim-conditional `updateMany` at the collector; see `docs/SCALING.md` §6).

---

## Adding a New Route or Feature

### Step-by-Step: Add a Domain Route

1. **Define schema in `packages/shared/src/schemas/`**

Create `myFeature.schema.ts` with Zod schemas and inferred types.

```typescript
import { z } from "zod";
export const createMyFeatureSchema = z.object({ ... });
export type CreateMyFeatureInput = z.infer<typeof createMyFeatureSchema>;
```

Re-export from `packages/shared/src/schemas/index.ts`.

2. **Create route file in `packages/server/src/routes/`**

Name: `myFeature.ts` (camelCase, domain suffix). New endpoints must declare their permission via the RBAC middleware (`packages/server/src/middleware/rbac.ts`); enterprise-gated features go through `packages/server/src/middleware/license.ts` (`402 { error, feature, tier }`).

```typescript
import { Router } from "express";
import { createMyFeatureSchema } from "@simmetric-chat/shared";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

const router = Router();

router.post("/", authMiddleware, requirePermission("workspace:write"), async (req, res) => {
const parsed = createMyFeatureSchema.safeParse(req.body);
if (!parsed.success) {
return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
}
// ... business logic
res.status(201).json(result);
});

export default router;
```

3. **Mount the route in `packages/server/src/index.ts`**

```typescript
import myFeatureRoutes from "./routes/myFeature";
app.use("/api/my-features", myFeatureRoutes);
```

4. **Add service logic in `packages/server/src/services/myFeatureService.ts`**

Keep business logic out of the route file. Export named functions.

5. **Update Prisma schema if needed**

Edit `packages/server/prisma/schema.prisma`, then run:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

After any schema change, run `pnpm audit:migrations` and commit the regenerated `docs/MIGRATION_AUDIT.md` in the same PR (additive-only policy — see [Migration & Restore Safety](./MIGRATION_SAFETY.md)).

6. **Add tests**

Create `packages/server/src/__tests__/myFeature.test.ts` for unit tests or `*.integration.test.ts` for integration tests.

7. **Add i18n keys (if frontend-facing)**

Update all 8 locale files under `packages/frontend/src/i18n/` (`en`, `it`, `ru`, `de`, `fr`, `es`, `zh`, `pt`) — the frontend gate requires exact key parity across all 8 locales (add new namespaces to the `--namespaces=` list in `packages/frontend/package.json` if you introduce a new namespace). If the change touches the widget UI (`packages/widget/src/widget/`), update all 8 widget locale files (`src/widget/i18n/*.json`) — the widget gate requires exact parity across all locales and fails on empty values.

8. **Run checks**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm i18n:check # if frontend strings changed
pnpm changelog:check # if packages/*/src/** changed — add a [Unreleased] CHANGELOG.md bullet
```

---

## Adding a New Package

To add a new package to the monorepo:

1. **Create the package directory** under `packages/<name>/` with its own `package.json`, `tsconfig.json`, and `src/` directory.

2. **Register it in `pnpm-workspace.yaml`** — the glob `packages/*` already covers it, so no edit is needed unless you place it elsewhere.

3. **Declare `@simmetric-chat/shared` as a dependency** if you need shared types/schemas:

```json
"dependencies": {
"@simmetric-chat/shared": "workspace:*"
}
```

4. **Respect the dependency graph**: `shared` is the only cross-package import. The new package may import from `@simmetric-chat/shared` but must not import from `server`, `collector`, `frontend`, or `widget`. If it needs to talk to the server or collector, use HTTP APIs.

5. **Add scripts** (`build`, `dev`, `lint`, `typecheck`, `test`) so Turborepo can orchestrate them. Ensure `build` emits to `dist/**` to match the `turbo.json` outputs.

6. **Declare every runtime dependency** in the package's own `package.json` — pnpm strictness rejects phantom dependencies.

---

## Testing Workflow

### Test Framework

- **Jest** `30.x` with **`@swc/jest`** as the active TypeScript transform (SWC/Rust, swapped in across all 9 jest configs: root `jest.config.cjs`, shared, server (+ `integration` and `integration-nodb` variants), frontend, widget, collector (+ `integration` variant)). `ts-jest` is retained only as a rollback path — 8 of the 9 jest configs carry a comment header `// ts-jest is the rollback transformer — 'git revert <DEP-01 commit>' restores it ` but it is not used at runtime. The exception is the root `jest.config.cjs`, which is a plain `/** @type {import('jest').Config} */` projects aggregator (shared, server, frontend, collector, widget) with no rollback-transformer comment.
- **supertest** for HTTP integration tests (server, widget)
- **`@testing-library/react`** + **`@testing-library/jest-dom`** + **`jest-environment-jsdom`** for component tests (frontend)
- **Playwright** for end-to-end browser tests (`e2e/`, `playwright.config.ts` targeting `localhost:5173`)
- Suite size: the community unit suite is capped at **3404 top-level `it`/`test`/`describe` declarations** (15% over the v1.0 baseline of 2960) — enforced in CI by the `test-unit` job's test-count guard (top-level `__tests__/` files only, not recursive); the E2E suite is 13 spec files / 35 tests (`e2e/*.spec.ts`) <!-- VERIFY: re-check counts after future phases -->
- **Smoke gates** (live-process checks, mirror of `smoke:ollama`): `pnpm smoke:license-e2e` (license diagnostics on one booted server instance, see [License CLI](#license-cli)) and `pnpm smoke:multi-instance` (two server instances sharing Redis; requires Redis on `localhost:6379`, see [Redis / Multi-Instance Issues](#redis--multi-instance-issues))

### /tmp Quota Issues (`os error 122`)

If jest runs fail with `ENOSPC`/`os error 122` on a machine with a small `/tmp` tmpfs quota, the widget jest config already redirects `TMPDIR` to a project-local directory (`packages/widget/jest.config.js` sets `process.env.TMPDIR = <repo>/.jest-cache/tmp`, D-03/). The root `jest.config.cjs` also excludes the two environment-sensitive suites (`check-build-freshness`, `restoreSymlinkTraversal`) from all local runs — they are excluded on `/tmp` overflow + local-path grounds, not code regressions (, D-03; CI runners have ample `/tmp`, so they may pass there). Workaround for other tools: point `TMPDIR` at a workspace-local directory (e.g. `TMPDIR=$PWD/.jest-cache/tmp pnpm test`) or raise the `/tmp` quota.

### Test Commands

```bash
# Unit tests across all packages (mocked DB) via Turborepo
pnpm test

# Root-level unified Jest run (all 5 packages — shared, server, frontend, collector, widget — single config, no Turborepo)
pnpm test:all

# Integration tests (requires real PostgreSQL)
pnpm --filter server test:integration

# End-to-end tests (uses webServer in playwright.config.ts to bootstrap dev servers)
pnpm test:e2e

# License diagnostics end-to-end gate (boots one server instance; needs a LICENSE_KEY line in packages/server/.env.test + live Postgres on the dev DATABASE_URL)
pnpm smoke:license-e2e

# Multi-instance Redis smoke (boots two server instances; needs Redis on localhost:6379)
pnpm smoke:multi-instance
```

### Test File Locations

| Package | Location | Pattern |
|---------|----------|---------|
| Server | `packages/server/src/__tests__/` | `*.test.ts`, `*.integration.test.ts` |
| Frontend | `packages/frontend/src/__tests__/` | `*.test.tsx` |
| Shared | `packages/shared/src/__tests__/` | `*.test.ts` |
| Widget | `packages/widget/src/__tests__/` | `*.test.ts` |
| E2E | `e2e/` | `*.spec.ts` |

### Test Patterns (v1.4 additions)

**pg-boss manual CJS mock** (`packages/server/src/__mocks__/pg-boss.ts`): pg-boss v12.28.0 ships as pure ESM, which throws `SyntaxError: Cannot use import statement outside a module` under the server's `@swc/jest` CommonJS transform when a test transitively loads `src/index.ts` (statically importing `jobQueue.ts` → `pg-boss`). Allowlisting pg-boss in `transformIgnorePatterns` would require also allowlisting its transitive ESM deps — fragile. Instead, `jest.config.js` maps `^pg-boss$` to the manual mock (same established pattern as `__mocks__/puppeteer.ts`). The stub exports `PgBoss` with `start`/`stop`/`on`/`schedule`/`createQueue`/`work` (`work` returns a placeholder worker id — without it, suites that boot `index.ts` crash with "boss.work is not a function"). Dedicated pg-boss unit tests (`jobQueue.test.ts`) do **not** use the manual mock — they use their own `jest.mock("pg-boss", () => ...)` factory for per-test control of `start`/`stop`.

**@swc/jest factory-creates-own-`jest.fn()` pattern** (`jobQueue.test.ts`, mirrors `redisService.test.ts`): inside the `jest.mock("pg-boss", () => ({ ... }))` factory, each mocked method is created with its own `jest.fn()` (e.g. `start: jest.fn()`, `schedule: jest.fn()`). The factory **does not** reference outer-scope `jest.fn()` variables — the mock module is hoisted above the test body, so any outer reference would be in the temporal dead zone and crash. If the test needs to assert on mock calls, use `jest.mocked(...)` or re-import the mock module after `jest.requireMock`.

**Source-string boot-order assertions** (`bootOrder.test.ts`): reads `packages/server/src/index.ts` as UTF-8 and asserts ordering/absence invariants by line number — e.g. `loadEnterprisePlugin(app)` after `await prisma.$connect()`/`initLicense()` and before the `env.NODE_ENV === "production"` block; all 8 `init*Scheduler()` calls are awaited and run after `await startJobQueue()`; the 7 per-scheduler `shutdown*` calls are **absent** from `gracefulShutdown`; `stopJobQueue()` is still present; the 2 pollers are present and **not** awaited. This is the established source-string convention from `packages/frontend/src/__tests__/mainImportOrder.test.ts` — it fails the build if the boot sequence is reordered.

### Running a Single Test

```bash
pnpm --filter server test -- -t "test name" # by name
pnpm --filter server test -- path/to/file.test.ts # by file
pnpm --filter frontend test -- -t "test name"
pnpm --filter widget test -- -t "test name"
```

### Integration Test Setup

Server integration tests use a **worker database** pattern (`jest.config.integration.js`):

1. `jest.globalSetup.js` creates `simmetricchat_test_template`, applies migrations, and seeds.
2. Each test file gets its own cloned database (named by SHA-256 of the test path).
3. Tests use dynamic imports so Prisma picks up the worker-specific `DATABASE_URL`.
4. `jest.globalTeardown.js` drops the template and residual worker DBs.

> **Note**: Integration tests require `packages/server/.env.test` to be present with `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=test`, and `COLLECTOR_SECRET`. Missing `COLLECTOR_SECRET` causes `process.exit(1)` in `AgentBudgetTracker` and crashes any integration suite that touches agent services. (`LICENSE_KEY` is not required — the committed `.env.test` has carried no license token since the public-release prep; license surfaces are mocked or run Community-degraded.)

Helpers:

- `getTestApp()` — fresh Express app instance for supertest
- `getTestPrisma()` — Prisma client connected to the worker DB
- `clearTestData()` — truncates mutable tables between test files

### CI Pipeline

`.github/workflows/ci.yml` runs on push and pull requests to `main`:

1. **`lint-and-typecheck`** — pnpm install (frozen lockfile), db:generate, lint, typecheck, plus the version-stamp sync check (`pnpm version:check` — root `package.json` major.minor must match the latest git tag) and the changelog discipline check (`pnpm changelog:check` — a PR touching `packages/*/src/**` outside `__tests__/` needs a non-empty `[Unreleased]` section)
2. **`test-unit`** — pnpm install, db:generate, PrismaClient-resolvability check (Prisma 7 + pnpm symlink), `pnpm test`, air-gap grep gate (no outbound HTTP primitives in `licenseService.ts`), FTS locale grep gate, and the test-count guard (community suite ≤ 3404 top-level declarations) (needs lint-and-typecheck)
3. **`test-airgap`** — the shared/server/frontend unit suites re-run with `NETWORK_EGRESS_BLOCKED=1` as a runtime air-gap proof (needs lint-and-typecheck)
4. **`migration-safety-check`** — pnpm install, audit:migrations, verifies committed audit report is up to date, enforces consent for destructive migrations via the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` repo variable (needs lint-and-typecheck + test-unit)
5. **`license-policy-check`** — per-package license allowlist (`license-checker-rseidelsohn`), regenerates `THIRD_PARTY_NOTICES.md` + `docs/LICENSE_AUDIT.md` with drift gates, and the project-self license-field check (`pnpm license:check-self`) (needs lint-and-typecheck + test-unit)
6. **`test-e2e`** — pnpm install, db:generate, `prisma migrate deploy`, shared + frontend builds, playwright install, `pnpm test:e2e` with a `pgvector/pgvector:pg16` service (needs test-unit)
7. **`build`** — pnpm install, build, plus a build-freshness check (`pnpm --filter server exec node scripts/check-build-freshness.cjs`) verifying `dist/` is not stale relative to `src/` (needs lint-and-typecheck + test-unit + test-airgap + migration-safety-check + license-policy-check)
8. **`license-keygen`** — round-trip license sign/verify contract test (`license-tools/round-trip.test.js`) against the built `licenseService.js` (needs build)
9. **`security`** — gitleaks secret scan (needs lint-and-typecheck)

All jobs use a least-privilege `contents: read` permission; the workflow env carries `LICENSE_KEY: ci-test-license` (a throwaway literal — the production public key rejects it, so the unit suite runs Community-degraded).

---

## Debugging Tips

### SSE Streaming Issues

- Check the Network tab in DevTools for the `/chat/stream` request.
- Look for `event: error` lines in the SSE stream.
- Server logs tagged `[agent]` show the ReAct loop and any tool call errors.
- If the stream aborts mid-flight, check if a new message was sent (previous stream is aborted via `AbortController`).

### Authentication Issues

- Verify `JWT_SECRET` is set and consistent.
- Check `Authorization: Bearer <token>` header is present on API requests.
- Frontend `useAuth` query only clears the token on `401/403`; `429/500` errors preserve the session to avoid logging users out during transient failures.
- API key auth uses `X-Api-Key` header with `sk-` prefix.

### Prisma Query Debugging

- Set `LOG_LEVEL=debug` to see Prisma queries in logs.
- Use `prisma.$queryRaw` with tagged template literals for raw SQL.
- Check for missing `deletedAt: null` filters on soft-deletable entities.
- Verify the singleton Prisma client is used (not a new `PrismaClient()`).

### Collector Not Processing Documents

- Check collector health: `curl http://localhost:3210/api/health`
- Verify `COLLECTOR_URL` in server `.env` matches the collector port.
- Check server logs for HTTP timeout errors calling the collector.
- Check `storage/uploads/` in the collector package (uploads land in `UPLOADS_DIR`, `packages/collector/src/routes/ingest.ts`). There is no `storage/logs/` directory — the collector logger (`packages/collector/src/utils/logger.ts`) is console-only (winston `Console` transport); the `storage/logs` mention exists solely in a stale test comment.

### Frontend Proxy Errors

- If you see `ECONNREFUSED` on `/api/*` calls, the server is not running on port `3000`. The dev proxy retries before surfacing a `Backend unavailable (dev proxy)` JSON error.
- The Vite proxy only works in dev mode. Production builds expect the API at the same origin.

### License / Feature Flag Issues

- Community tier disables enterprise features (SSO, webhooks, push notifications, widgets, etc.).
- Check `/api/license/info` response for current tier and flags.
- Numeric limits (`max_workspaces`, `max_projects`, `max_widgets`) return `402` with `limit` and `current` fields.
- Expired Enterprise licenses gracefully revert to Community at runtime — features disable rather than crash.
- For a server-free verdict, run `pnpm license:check` (exit `0` = entitled/Community, `1` = token doesn't entitle, `2` = env/config error; `-- --json` for machine-readable output). Admins can also hit `GET /api/license/diagnose` for the full breakdown (tier, expiry, reason, env presence, JWT shape). If a key "doesn't work", check `reason` — a token signed with a private key that doesn't match the embedded public key always reports `bad-signature`, which is the expected Community-degraded state when the wrong keypair is in use.

### Scheduler / pg-boss Issues

- Boot log `[jobQueue] pg-boss started` confirms the queue is up; `[jobQueue] pg-boss start failed — job scheduling unavailable` (error level) means Postgres was unreachable — the server continues booting with all 8 cron schedulers offline (each logs `pg-boss unavailable — scheduler offline ` at warn). This is the designed graceful degradation, not a crash.
- Scheduler init order matters: 7 of the 8 `init*Scheduler()` calls run after `await startJobQueue()` in the `NODE_ENV==="production"` block (fidelity sampling is the 8th, in the same block; `initWikiConsistencyScheduler` + the 2 pollers run outside it). If a scheduler fails to register, the `await` surfaces the error at boot — check the `bootOrder.test.ts` invariants before reordering anything.
- Inspect job state directly in Postgres: `SELECT * FROM pgboss.job WHERE name = '<queue-name>' ORDER BY id DESC LIMIT 10;` (the `pgboss` schema holds `job`, `schedule`, and `archive` tables). Jobs that log-and-resolve never retry — a failing cron cycle shows up in server logs under the `[mcp-reaper]`/`[chat-message-reaper]`/etc. prefixes, not as pg-boss retries.
- pg-boss errors (connection drops, schema drift) are logged at warn via the `on("error")` handler — the queue retries internally, so a single warn is not a failure signal.
- For multi-instance behavior (job dedup via pg-boss, the 2 non-migrated 10s pollers with per-instance `isRunning` guards, shared Postgres pool sizing), see `docs/SCALING.md` — pg-boss is its §3.

### Redis / Multi-Instance Issues

- Server log `[redis] REDIS_URL not set — operating in single-instance mode` is the healthy no-Redis state, not an error.
- If `REDIS_URL` is set but connections fail, the log shows `[redis] Connection error` — confirm Redis actually listens on `localhost:6379` (`redis-cli ping`). Remember the compose `redis` service is `expose:`-only (no profile gating); a plain `docker compose up redis` binds no host port. Use `docker run -d --name simmetric-chat-redis -p 6379:6379 redis:7-alpine` for host-native dev.
- All Redis interactions go through the lazy singleton `getRedis()` (`packages/server/src/services/redisService.ts`; the widget has its own mirror in `packages/widget/src/services/redisService.ts`). Never construct an `ioredis` client ad hoc.
- Shared-state debugging: rate-limit buckets live under `rl:auth:` / `rl:api:` / `rl:lead:` / `rl:probe:` (server) and `rl:` (widget); the JWT revocation blacklist under `rev:jti:{jti}`; the widget config cache under `widget:config:{widgetId}`; SSE fan-out channels under `sse:chat:{chatId}`. Inspect with `redis-cli KEYS '<prefix>*'`.
- Multi-instance behavior is verified end-to-end by `pnpm smoke:multi-instance` (boots two server instances on ports 3100/3101 sharing Redis, then asserts cross-instance `jti` revocation → 401, a shared lead bucket → 429 on the 31st request, and single-executor distributed locking).

### Docker Development

```bash
# Start infrastructure for host-native dev (PostgreSQL; qdrant opt-in)
docker compose -f docker/docker-compose.infra.yml up -d postgres

# Optional: Redis for the horizontal-scaling layer
docker run -d --name simmetric-chat-redis -p 6379:6379 redis:7-alpine

# Pure-Docker deployment stack (includes Redis by default — no profile gating in docker/docker-compose.yml)
docker compose -f docker/docker-compose.yml up --build -d
```

For local LLM with Ollama, pull a model manually:

```bash
docker exec simmetric-chat-ollama ollama pull gemma4:latest
```

---

## Git Workflow and Commit Conventions

### Branch

The default branch is `main`.

### GSD Workflow (repo convention)

Day-to-day work in this repo is routed through the GSD workflow (per [`CONTRIBUTING.md`](../CONTRIBUTING.md) and root [`AGENTS.md`](../AGENTS.md)):

- **Small tasks** → `/gsd:quick` — atomic commits + state tracking, no optional agents.
- **Debugging sessions** → `/gsd:debug` — persistent debugging state across context resets.
- **Planned phase work** → `/gsd:execute-phase` (after `/gsd:plan-phase`); new projects start with `/gsd-new-project` + `/gsd-map-codebase`.
- **Reviews** → `/gsd:code-review` over the files a phase touched.

Inside a GSD workflow, **GSD handles commits atomically — do not commit manually**. GSD planning artifacts live in `.planning/` (gitignored — never stage or commit that directory; quick-task backlog lives under `.planning/quick/` with its own triage gate in `scripts/quick-task-triage-check.cjs`).

For contributors not using the GSD tooling, the ordinary git conventions below apply.

### Commit Message Format

```
<type>(<scope>): <description>
```

| Type | Use |
|------|-----|
| `feat` | New features |
| `fix` | Bug fixes |
| `test` | Test additions/changes |
| `refactor` | Code refactoring |
| `ci` | CI/CD changes |
| `chore` | Maintenance tasks |
| `docs` | Documentation changes |

Examples:

```
feat(chat): add per-chat model selection
fix(rbac): prevent IDOR on workspace delete
test(server): add integration tests for widget routes
docs(quick-260613-v4e): record first-login password change
```

Quick tasks use the `quick-<YYMMDD>-<id>` scope prefix.

### Pull Request Process

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full PR guidelines, including branch naming, commit message format, test requirements, migration safety, i18n requirements, and the review process.

Before opening a PR, ensure:

1. `pnpm lint` passes
2. `pnpm typecheck` passes
3. `pnpm test` passes
4. `pnpm i18n:check` passes (if frontend or widget strings changed)
5. `pnpm audit:migrations` passes and `docs/MIGRATION_AUDIT.md` is committed alongside any schema changes
6. `pnpm changelog:check` passes (a PR touching `packages/*/src/**` outside `__tests__/` needs a `[Unreleased]` entry in `CHANGELOG.md`)
7. New features include tests
8. Schema changes include migrations and seed updates if applicable
9. `pnpm license:check` exits `0` if a license-related change lands (and `pnpm smoke:license-e2e` passes when license code changed)
10. License/Redis behavior changes are covered by the respective smoke gates (`smoke:license-e2e`, `smoke:multi-instance`) where applicable

#### AGPL License Headers and Changelog Discipline

Every TypeScript/TSX source file across all five packages carries the 4-line AGPL header (`// Simmetric Chat — Copyright (C) 2026 Simmetric Chat` / `// SPDX-License-Identifier: AGPL-3.0-or-later` / community-build + LICENSE/NOTICE pointers) — see the top of any `packages/*/src/**/*.ts` file or `scripts/add-headers.cjs` for the canonical text. When creating new source files, copy the header; `pnpm license:check-self` (`scripts/license-check-self.cjs`, also run in CI's `license-policy-check` job) asserts root + all 5 `package.json` `license` fields equal `AGPL-3.0-or-later`.

A PR touching `packages/*/src/**` (excluding `__tests__/` at any depth) must include a non-empty `[Unreleased]` bullet in `CHANGELOG.md` — enforced by `pnpm changelog:check` (`scripts/changelog-check.cjs`) in the CI `lint-and-typecheck` job.

---

## Common Development Commands Reference

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all dependencies |
| `pnpm dev` | Start all dev servers |
| `pnpm build` | Production build all packages |
| `pnpm lint` | ESLint across all packages |
| `pnpm typecheck` | TypeScript checking across all packages |
| `pnpm test` | Unit tests across all packages (Turborepo) |
| `pnpm test:all` | Root-level unified Jest run (all 5 packages — shared, server, frontend, collector, widget) |
| `pnpm test:e2e` | Playwright E2E browser tests |
| `pnpm db:generate` | Regenerate Prisma client |
| `pnpm db:migrate` | Apply migrations interactively |
| `pnpm db:seed` | Seed default roles, permissions, templates, config |
| `pnpm audit:migrations` | Audit Prisma migrations for destructive operations |
| `pnpm db:migrate:guard` | Pre-apply consent guard for `prisma migrate deploy` (refuses destructive migrations without consent) |
| `pnpm db:migrate:reset:guard` | Consent gate for `prisma migrate reset` (`PRISMA_MIGRATE_RESET_CONFIRM=yes` or `--force-accept-data-loss`) |
| `pnpm changelog:check` | Changelog discipline check (`[Unreleased]` non-empty when `packages/*/src/**` changed) |
| `pnpm version:check` | Version-stamp sync check (root package.json major.minor ↔ latest git tag) |
| `pnpm i18n:check` | Validate full 8-locale translation parity (frontend and widget) |
| `pnpm --filter <pkg> dev` | Start a single package in dev mode |
| `pnpm --filter <pkg> test` | Run tests for a single package |
| `pnpm --filter <pkg> test -- -t "name"` | Run a single test by name |
| `pnpm --filter <pkg> test -- path/to/file.test.ts` | Run a single test file |
| `pnpm --filter <pkg> build` | Build a single package |
| `pnpm --filter server test:integration` | Server integration tests (real PostgreSQL) |
| `pnpm --filter server generate-apikey` | Generate widget API key for internal auth |
| `pnpm license:check` | Verify configured license without booting the server (exit 0/1/2; `-- --json` for machine output) |
| `pnpm smoke:license-e2e` | End-to-end license diagnostics gate (one live server instance, canary-absence assertions) |
| `pnpm smoke:multi-instance` | Multi-instance Redis smoke (jti revocation, shared rate-limit bucket, distributed lock) |
| `docker compose -f docker/docker-compose.infra.yml up -d postgres` | Start dev PostgreSQL (host-native `pnpm dev` workflow) |
| `docker run -d --name simmetric-chat-redis -p 6379:6379 redis:7-alpine` | Start optional dev Redis 7 on `localhost:6379` |
| `docker compose -f docker/docker-compose.yml up --build -d` | Full pure-Docker stack (PostgreSQL, Redis, Ollama, Qdrant) |

### Tauri Desktop Commands

| Command | Description |
|---------|-------------|
| `pnpm tauri:dev` | Run Tauri desktop app in dev mode |
| `pnpm tauri:build` | Build Tauri desktop app |
| `pnpm tauri` | Raw Tauri CLI (for advanced usage) |

---

## See also

- [Documentation index](./INDEX.md)
- [Testing Guide](./TESTING.md)
- [Contributing Guide](../CONTRIBUTING.md)
- [Multi-Instance Scaling Guide](./SCALING.md) — horizontal scaling, pg-boss job dedup, Redis layer, ENCRYPTION_KEY/API_KEY_HMAC_SECRET requirements for N-instance deployments
- Per-package guides: [`packages/server/AGENTS.md`](../packages/server/AGENTS.md), [`packages/frontend/AGENTS.md`](../packages/frontend/AGENTS.md), [`packages/collector/AGENTS.md`](../packages/collector/AGENTS.md), [`packages/shared/AGENTS.md`](../packages/shared/AGENTS.md), [`packages/widget/AGENTS.md`](../packages/widget/AGENTS.md)
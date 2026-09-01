# AGENTS.md — @simmetric-chat/server

Express 5 API (port 3000). CJS, TS strict, target ES2022. Entry `src/index.ts` (exports `createApp()` for supertest). Prisma 7 with `@prisma/adapter-pg` driver adapter.

## Commands

```bash
pnpm --filter server dev                # tsx watch src/index.ts
pnpm --filter server test               # unit tests (mocked DB — no Postgres needed)
pnpm --filter server test -- src/__tests__/auth.test.ts   # single file
pnpm --filter server test:integration   # real Postgres, .integration.test.ts files
pnpm --filter server db:generate        # prisma generate + scripts/fix-prisma-pnpm.cjs
pnpm --filter server db:migrate         # prisma migrate dev (interactive)
pnpm --filter server db:seed            # roles, permissions, templates, config
pnpm --filter server audit:migrations   # writes docs/MIGRATION_AUDIT.md + .migration-audit.json
pnpm --filter server start             # check:build-freshness guard, then node dist/index.js
```

- Unit tests load `packages/server/.env.test` via `src/__tests__/helpers/setupEnv.ts` and mock uuid/jsdom/pdfjs/puppeteer/openid-client — they must not require a live DB. Missing `COLLECTOR_SECRET` crashes agent-service tests (`process.exit(1)` in `AgentBudgetTracker`).
- Integration tests need a Postgres user with CREATEDB (globalSetup builds a template DB) and use `localhost:5434` per `.env.test`. No-DB integration subset: `npx jest --config jest.config.integration-nodb.js -- migrateGuard.integration`.
- `pnpm start` refuses to run if `dist/` is stale vs `src/` (CI enforces the same via `check:build-freshness`).

## Prisma / DB rules

- **Never `new PrismaClient()`** — import the singleton from `src/utils/prisma.ts` (driver-adapter pool + `withSoftDelete()`). Soft deletes via `deletedAt` are the norm; hard deletes are the exception (MCPConnection uninstall, ChatMCPPin unpin).
- Schema changes: edit `prisma/schema.prisma` → `db:generate` → `db:migrate` → `db:seed`. **Additive-only**; after any change run `pnpm audit:migrations` and commit the regenerated `docs/MIGRATION_AUDIT.md` in the same PR (CI drift-checks it). Destructive migrations need the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` repo variable.
- Seed templates are read relative to `process.cwd()` (`prisma/templates/`); in Docker they're copied into the image — stale-image seed failures need a `--no-cache` rebuild.

## Architecture

- `src/routes/` — one file per domain (48 files; `chat.ts` split into `chatCrud`/`chatList`/`chatAgentConfig`/`chatExport`/`chatImport`/`chatRetention`/`chatTokens` behind byte-identical facades — keep the split, don't re-merge).
- `src/services/` — business logic (76 files). `src/agent/` — ReAct orchestrator, LLM streaming, MCP client/server, skills. `src/middleware/` — auth, rbac, rateLimit, license, widgetCors, archiveAccess, uploadGate.
- Server↔collector is HTTP-only (`COLLECTOR_SECRET` on `X-Collector-Secret`); never import collector code. Server imports only `@simmetric-chat/shared`.
- Optional Redis scale layer (`REDIS_URL`): rate-limit stores, JWT `jti` revocation, auth/config caches, SSE pub/sub fan-out, redlock. All degrade to single-instance when absent — don't make Redis required.
- SSE chat events: `token`, `status`, `citations`, `done` (with `modelUsed`/`providerUsed`), `error` — the widget proxies the same format.

## Conventions

- New endpoints must declare permissions via `src/middleware/rbac.ts`; enterprise features gate through `src/middleware/license.ts` + `packages/shared/src/constants/license.ts` (402 `{ error, feature, tier }`).
- Validate request bodies with shared Zod schemas + `safeParse`; errors are `{ error: string }` (400 adds `details`). Settings PUT returns `{ updated, rejected }` — partial success is normal.
- Env is Zod-validated in `src/config/env.ts` (`getEnv()` cached, `process.exit(1)` on invalid). Precedence (code-verified in `systemConfigService.ts`): `ALWAYS_READONLY` infra keys (JWT_SECRET, DATABASE_URL, SERVER_PORT, COLLECTOR_PORT, SERVER_URL, COLLECTOR_URL) are ENV-only, never DB; every other UI-editable key resolves DB > ENV > default (the DB wins — UI edits take effect immediately).
- `@ts-nocheck` is allowed in `__tests__/` files (lint config permits it there only).

## Gotchas

- `tsx watch` boots slowly (Prisma + Postgres + auto-seed + license/FTS/schedulers); the frontend Vite proxy retries ECONNREFUSED ~4s — repeated 502s after that = server actually down.
- `src/__mocks__/` mocks are wired via jest `moduleNameMapper` — if you add a heavy native/ESM dep, mock it there and add the mapping to all three jest configs (unit, integration, integration-nodb).
- `docs/` is NOT gitignored — `git add` normally (matches root `AGENTS.md` / `CONTRIBUTING.md`).

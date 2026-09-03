<!-- generated-by: gsd-doc-writer -->

# Testing Guide

Simmetric Chat uses **Jest 30** (with the `@swc/jest` transform) for unit, component, and integration tests, and **Playwright 1.62** for end-to-end browser tests. HTTP-level integration tests use **supertest 7**. This document covers how the suites are organized, how to run them, and what the CI pipeline enforces.

## Test framework and setup

### Suite layout

| Layer | Tool | Environment | Database | Location |
|---|---|---|---|---|
| Unit / component | Jest 30 + `@swc/jest` | Node / jsdom | Mocked (no DB) | `packages/*/src/__tests__/**/*.test.ts` |
| Server integration | Jest 30 + supertest 7 | Node | Real PostgreSQL (template + per-worker clone) | `packages/server/src/__tests__/**/*.integration.test.ts` |
| Collector integration | Jest 30 + `@swc/jest` | Node | Real PostgreSQL (pgvector, port 5433) | `packages/collector/src/__tests__/**/*.integration.test.ts` |
| E2E | Playwright | Chromium | Real PostgreSQL | `e2e/*.spec.ts` |

All Jest configs transform TypeScript with **`@swc/jest`**. `ts-jest` remains in devDependencies only as a documented rollback transformer — it is not used at runtime (each `jest.config.*` header notes the `git revert` path).

### The five Jest projects

The root `jest.config.cjs` is a multi-project config listing the five package suites, so a single plain-jest invocation runs everything:

1. `packages/shared/jest.config.js`
2. `packages/server/jest.config.js`
3. `packages/frontend/jest.config.cjs`
4. `packages/collector/jest.config.js`
5. `packages/widget/jest.config.js`

The root config also carries `testPathIgnorePatterns: ['check-build-freshness', 'restoreSymlinkTraversal']` — a documented safety net for suites that fail on local `/tmp` quota overflow and environment-path issues (environmental, not code regressions). The `restoreSymlinkTraversal` suite no longer exists on disk, so its pattern is a no-op guard; `check-build-freshness.test.ts` still exists and remains excluded locally. CI runners with ample `/tmp` are unaffected, and the CI `build` job runs the freshness check directly as a script (`check-build-freshness.cjs`), which is not a Jest suite and is not affected by the exclusion.

### Per-package Jest facts

- **shared** — `node` environment, `src/__tests__/**/*.test.ts`. Pure Zod schema/constant tests; no dependencies beyond `zod` are mocked. `TMPDIR` is redirected to `~/.jest-tmp` (outside the repo tree so `loadEnv.test.ts` marker-walk fixtures cannot collide with the real workspace marker).
- **server (unit)** — `node` environment; roots `src` + `scripts`; matches `**/__tests__/**/*.test.ts` and excludes `*.integration.test.ts`. Loads `packages/server/.env.test` via the `setupFiles` entry `src/__tests__/helpers/setupEnv.ts`. Maps `@simmetric-chat/shared` to `../shared/dist/index.js`.
- **frontend** — `jsdom` environment (via `jest-environment-jsdom`); matches `**/__tests__/**/*.test.{ts,tsx}`. `setupFilesAfterEnv` points at `src/__tests__/jest.setup.ts`.
- **widget** — `node` environment; `src/__tests__/**/*.test.ts`. Maps `@simmetric-chat/shared` to shared **source** (`../shared/src/index.ts`).
- **collector** — `node` environment; excludes `*.integration.test.ts` (mirrors the server pattern). Maps `@simmetric-chat/shared` to `../shared/dist/index.js`.

All five configs use per-package `cacheDirectory` subdirectories under `.jest-cache/` so the concurrently-run turbo `test` tasks never race on shared cache entries, and all run with `verbose: true` (the streaming reporter avoids a native CJS-loader abort observed with the buffered reporter).

## Running tests

All commands run from the repository root.

| Command | What it runs |
|---|---|
| `pnpm test` | Unit tests for all five packages via Turborepo (`turbo test`, depends on `^build`). **Postgres-free** — server unit tests mock the DB. |
| `pnpm test:all` | The same five suites via the root Jest multi-project config (plain jest, no turbo). |
| `pnpm --filter server test` | Server unit tests. |
| `pnpm --filter server test -- src/__tests__/auth.test.ts` | Single server test file (jest positional args pass through). |
| `pnpm --filter server test -- -t "name"` | Single server test by name. |
| `pnpm --filter server test:integration` | Server integration tests against real PostgreSQL (`jest --config jest.config.integration.js --forceExit`). |
| `pnpm --filter shared test` | Shared package tests. |
| `pnpm --filter frontend test` | Frontend component tests (`jest --config jest.config.cjs`). |
| `pnpm --filter collector test` | Collector unit tests. |
| `pnpm --filter collector test:integration` | Collector integration tests against a dedicated `pgvector_test` DB on port 5433 (`jest --config jest.config.integration.cjs`). |
| `pnpm test:e2e` | Playwright end-to-end browser tests. |

> **Turbo/stale-dist gotcha:** turbo caches `test` on `^build`. After editing `packages/shared/src/`, server and collector tests can run against a stale `shared/dist` unless you rebuild (`pnpm --filter @simmetric-chat/shared build`) or run via turbo (which rebuilds first). The frontend and widget map `@simmetric-chat/shared` to its **source** and do not need the build.

### Postgres-free requirement for `pnpm test`

`pnpm test` must never require a live database. Server unit tests load `.env.test` and mock or transform-allowlist heavy dependencies:

- **Module mocks** (`moduleNameMapper` to `src/__mocks__/`): `uuid`, `jsdom`, `@mozilla/readability`, `turndown`, `archiver`, `pdfjs-dist`, `puppeteer`, and `pg-boss` (pure-ESM v12 — the manual CJS mock unblocks suites that transitively load `src/index.ts`).
- **Transform allowlist** (`transformIgnorePatterns` scoped exception): `pdfjs-dist`, `@napi-rs/canvas`, and the transitive ESM-only `jose`, `oauth4webapi`, `openid-client` packages bypass the ignore so `@swc/jest` can process their ESM exports. This is a scoped exception (Jest bug #16266) — never convert it to a global `transformIgnorePatterns: []`.

### Server integration tests (`test:integration`)

- **Config:** `packages/server/jest.config.integration.js`, run with `--forceExit` (the mounted MCP server leaves async handles open).
- **Pattern:** `src/__tests__/**/*.integration.test.ts`.
- **Database:** `.env.test` points at `postgresql://simmetricchat:simmetricchat@localhost:5434/simmetricchat_test`. The PostgreSQL user needs the **CREATEDB** privilege.
- **Template DB lifecycle:**
  1. `jest.globalSetup.js` drops and recreates `simmetricchat_test_template`, runs `prisma migrate deploy` and `prisma db seed` against it (roles, permissions, system config).
  2. `jest.setup.integration.ts` derives a per-test-file worker DB from the SHA-256 hash of the test file path (`simmetricchat_test_<16 hex chars>`), clones the template via `CREATE DATABASE ... TEMPLATE`, and overrides `process.env.DATABASE_URL`.
  3. `jest.globalTeardown.js` drops the template database; its residual-worker sweep is a no-op due to a naming mismatch — it queries `datname LIKE 'simmetricchat_test_worker_%'`, but worker DBs are actually named `simmetricchat_test_<16 hex chars>` (SHA-256 of the test file path, per `jest.setup.integration.ts` `getDbNameForFile`), so the sweep never matches them. Interrupted runs therefore leave worker DBs behind (see Troubleshooting).
- **No-DB subset:** `npx jest --config jest.config.integration-nodb.js -- migrateGuard.integration` runs integration-pattern tests that need no database (no global setup/teardown; Prisma mocked at the test level).
- **Helpers:** `src/__tests__/helpers/integration.ts` exports `getTestApp()` (fresh app after `jest.resetModules()`), `getTestPrisma()`, and `clearTestData()` (per-table DELETE over the mutable tables).
- Run integration tests **sequentially**: suites can read the cached `getEnv()` `DATABASE_URL` instead of the per-worker URL, which weakens isolation (known open debt).

### Collector integration tests

- **Config:** `packages/collector/jest.config.integration.cjs`.
- **Database:** a dedicated `pgvector_test` DB on port **5433** — never the main DB. Start it before running:

  ```bash
  docker run -d -p 5433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=pgvector_test pgvector/pgvector:pg16
  ```

- The integration `globalSetup` probes Postgres and sets `PGVECTOR_AVAILABLE`; if Postgres is unavailable the suites skip loudly instead of false-passing. The config sets a 30s `testTimeout` and `forceExit: true` (lingering `pg.Pool` idle clients).

### Test environment (`.env.test`)

Server tests load `packages/server/.env.test` (tracked in git) via `src/__tests__/helpers/setupEnv.ts`, which must be imported **first** in any test file that touches `getEnv()`:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgresql://simmetricchat:simmetricchat@localhost:5434/simmetricchat_test` |
| `JWT_SECRET` | Required by env validation (`process.exit(1)` if missing); a test value is committed |
| `NODE_ENV` | `test` |
| `COLLECTOR_SECRET` | Required by Zod `.min(1)`; agent-service tests crash without it |
| `WIDGET_SERVICE_URL` / `WIDGET_API_KEY` | Widget cache-bust handshake defaults |
| `API_KEY_HMAC_SECRET` | Base64 32-byte HMAC key (all-zero test value) |

`setupEnv.ts` applies fallbacks for `JWT_SECRET`, `NODE_ENV`, `LICENSE_KEY` (empty = Community tier), and `COLLECTOR_SECRET`; `DATABASE_URL` has no fallback. The committed `.env.test` does **not** carry a `LICENSE_KEY` — the Enterprise JWT lives only in the gitignored root `.env`, read by the E2E `globalSetup`.

## Writing new tests

- **Naming/location:** tests live in `__tests__/` directories with a `.test.ts` / `.test.tsx` suffix (frontend tsx). Real-PostgreSQL integration tests use `.integration.test.ts`. Test files are co-located in `__tests__/` directories adjacent to the code they test.
- **Server unit test** — start with `import "./helpers/setupEnv";`, then mock Prisma (`src/__tests__/helpers/mockPrisma.ts` provides `createMockPrisma()` returning `{ prisma, resetAll }`) and heavy deps, import `createApp` from `../index`, and wrap with `supertest`. Under `@swc/jest`, a `jest.mock()` factory cannot reference outer block-scoped variables (TDZ error) — either let the factory create its own `jest.fn()` handles and retrieve them via import-cast, or reference module-level `const` objects.
- **Server integration test** — create `*.integration.test.ts`, import helpers from `./helpers/integration`, call `getTestApp()` in `beforeAll` and `clearTestData()` in `afterAll`. The worker DB is already migrated and seeded.
- **Frontend component test** — use `@testing-library/react` (16) with `renderWithProviders` / `renderHookWithProviders` from `src/__tests__/test-utils.tsx` for anything using TanStack Query (fresh `QueryClient`, `retry: false`). The frontend is ESM (`extensionsToTreatAsEsm: [".ts", ".tsx"]`, SWC `module.type: "esm"`) — use `import`/`export`, not `require`. `@simmetric-chat/shared` maps to source; CSS imports are stubbed via `styleMock.cjs`; the `@/` alias maps to `src/`. The `jest.setup.ts` setup file polyfills `TextEncoder`/`TextDecoder` (react-router-dom v7), mocks `ResizeObserver`, `matchMedia`, and `scrollIntoView` (Radix UI), and suppresses known jsdom-only console noise.
- **Widget / collector tests** — widget maps shared to source (no build needed for tests); collector maps shared to `dist` (build shared first). New heavy native/ESM deps in the server must be mocked under `src/__mocks__/` and mapped in all three server Jest configs (unit, integration, integration-nodb).
- **E2E spec** — create `e2e/{flow}.spec.ts`, use the `adminPage` fixture for authenticated flows or `widgetPage` for widget-embed flows (requires `E2E_WIDGET_ID`, seeded by globalSetup). Prefer `locator` assertions with explicit timeouts.

### E2E (Playwright)

**Config:** `playwright.config.ts` — test directory `./e2e/`, 30s per-test timeout, `retries: 2` (absorbs historically flaky rename/synthesis specs under degraded environments), base URL `http://localhost:5173`, globalSetup `./e2e/globalSetup.ts`.

Playwright boots three web servers automatically (all `reuseExistingServer: true`, so they do not conflict with an existing `pnpm dev`):

| Server | Command | Port |
|---|---|---|
| Backend | `pnpm --filter server exec tsx src/index.ts` (plain `tsx`, plus `E2E_RUN=1` so the server skips `authRateLimiter`) | 3000 |
| Frontend | `pnpm --filter frontend exec vite preview` | 5173 |
| Widget | `pnpm --filter widget exec tsx src/index.ts` (plain `tsx` — watch mode stalls on CI) | 3211 |

**Prerequisites** before `pnpm test:e2e`:

1. Local Postgres running with `prisma migrate deploy` applied (without it the server's auto-seed crashes and Playwright times out waiting for :3000).
2. `pnpm --filter @simmetric-chat/shared build` and `pnpm --filter frontend build` (the server/widget resolve shared from `dist/`; `vite preview` serves the built frontend).
3. The Enterprise license JWT in the gitignored root `.env` (`LICENSE_KEY`) — widget creation is license-gated. Without it the server falls back to Community and enterprise-gated specs self-skip.

**Seeding (`e2e/globalSetup.ts`, idempotent):**

- On a fresh DB, initializes the system through the setup wizard endpoint (`POST /api/system/initialize`) so `admin`/`admin123` exists, then logs in with those credentials.
- Ensures the hardcoded workspace `9a334821-b880-411b-affc-805664e7fd66` (the ID used across all E2E specs in `e2e/fixtures.ts`) plus project, workspace access, and chats exist.
- Creates or reuses the "E2E Test Widget" and persists its id as `E2E_WIDGET_ID`; seeds the matching `api_keys` row (HMAC-SHA256 digest keyed by `API_KEY_HMAC_SECRET`).
- Clears the admin's `mustChangePassword` flag so the force-change modal never blocks navigation.

`e2e/fixtures.ts` extends the base Playwright test with `adminPage` (auto-login as admin/admin123) and `widgetPage` (host page with the real widget loader, session seeded via `POST http://localhost:3211/api/sessions`). Existing specs cover admin flows, chat send/stream, chat edit/regenerate, upload → RAG, unified upload destinations, widget embed, synthesis runs, marketplace lifecycle, MCP pin/use, theme switching, settings navigation, and project creation.

## Coverage requirements

No coverage thresholds are configured in any Jest config, and coverage is not a blocking CI gate. You can still generate reports locally:

```bash
pnpm test:all -- --coverage                  # all packages (root multi-project)
pnpm --filter server test -- --coverage      # server only
pnpm --filter server test:integration -- --coverage  # integration
```

The closest quality gate is the CI **test-count guard**: the community suite (top-level server `*.test.ts` + frontend `*.test.tsx` declarations) is capped at **3900** declarations; exceeding the cap fails the build with a suite-bloat error. Add tests only when the behavior demands it.

## CI integration

`.github/workflows/ci.yml` runs on every push to `main` and every PR. Testing-relevant jobs:

1. **test-unit** — runs `pnpm test` (all five suites via Turborepo) after `pnpm db:generate` and a Prisma client resolvability check. Also runs the air-gap grep gate (zero outbound HTTP primitives in `licenseService.ts`), the FTS locale grep gate (no english-only tsquery literals outside `ftsService.ts`), and the test-count guard. No Postgres service is attached — the unit suite is proven DB-free.
2. **test-airgap** — re-runs the shared/server/frontend unit suites with `NETWORK_EGRESS_BLOCKED=1` (runtime air-gap proof), building shared first because it invokes package test scripts directly, bypassing turbo's `^build` edge.
3. **test-e2e** — spins up a `pgvector/pgvector:pg16` service container (`simmetricchat`/`simmetricchat`, DB `simmetricchat_test` on :5432), runs `pnpm db:generate`, applies the schema with `pnpm --filter server exec prisma migrate deploy`, builds `@simmetric-chat/shared` and the frontend, installs Playwright Chromium, then runs `pnpm test:e2e`. CI sets `LICENSE_KEY=ci-test-license` (a non-JWT literal, so the server degrades to Community and enterprise-gated specs self-skip by design) plus the throwaway `WIDGET_API_KEY` / `API_KEY_HMAC_SECRET` values that match `e2e/globalSetup.ts`.
4. **build** — runs `pnpm build` plus the build-freshness check as a direct script invocation (not the excluded Jest suite).

Common CI env for test jobs: `JWT_SECRET=ci-test-secret-key-32chars-long!!`, `DATABASE_URL=postgresql://simmetricchat:simmetricchat@127.0.0.1:5432/simmetricchat_test`, `COLLECTOR_SECRET=ci-test-collector-secret`, `NODE_ENV=test`, Node 24, pnpm 11.24.0 (via `packageManager`).

CI always runs `pnpm db:generate` before test steps because Jest module mappings and integration imports rely on the generated Prisma client existing on disk.

## Troubleshooting quick reference

- **`process.exit(1)` during env validation** — a server test file is missing `import "./helpers/setupEnv";` or `.env.test` lacks a required variable (most often `COLLECTOR_SECRET`, read at import time by agent services).
- **`Cannot find module '@simmetric-chat/shared'`** — the server/collector configs map shared to `dist`; rebuild it: `pnpm --filter @simmetric-chat/shared build`.
- **Integration "database does not exist"** — ensure Postgres is running on :5434 (per `.env.test`) and the user has CREATEDB: `psql -U postgres -c "ALTER USER simmetricchat CREATEDB;"`.
- **Playwright `ECONNREFUSED` / 429 cascade** — check ports 3000/3211/5173; a stale server started without `E2E_RUN=1` will rate-limit the suite — kill it (`lsof -ti:3000`) and re-run.
- **Worker DB accumulation** — if Jest is killed mid-run, drop leftover `simmetricchat_test_%` databases via psql.
- **Stale `dist/` vs `src/`** — `pnpm start` (and CI) refuses to run when the server build is stale; rebuild.

## See also

- [Development Guide](./DEVELOPMENT.md)
- [Configuration](./CONFIGURATION.md)
- [Architecture](./ARCHITECTURE.md)
- [README](../README.md)
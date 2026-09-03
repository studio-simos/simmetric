<!-- generated-by: gsd-doc-writer -->
# Development Guide

This guide covers local development setup, build commands, code style, testing, migrations, and the conventions enforced across the Simmetric Chat monorepo (pnpm + Turborepo, five packages under `packages/*`).

## Table of Contents

- [Local Setup](#local-setup)
- [Build Commands](#build-commands)
- [Testing Strategy](#testing-strategy)
- [Database and Migrations](#database-and-migrations)
- [Code Style](#code-style)
- [i18n Requirements](#i18n-requirements)
- [Zod Schemas and API Error Shape](#zod-schemas-and-api-error-shape)
- [RBAC and License Middleware](#rbac-and-license-middleware)
- [Monorepo Gotchas](#monorepo-gotchas)
- [Dev-Mode Quirks](#dev-mode-quirks)
- [Branch Conventions](#branch-conventions)
- [PR Process](#pr-process)

## Local Setup

Prerequisites: Node.js `>=24.0.0` (enforced by `engines.node` in root `package.json`), pnpm `11.24.0` (pinned via `packageManager`), PostgreSQL 16. For full setup from scratch — clone, root `.env`, Postgres, Prisma client, seed — see [GETTING_STARTED.md](./GETTING_STARTED.md). The short version:

```bash
git clone <repo-url> simmetric-chat
cd simmetric-chat
pnpm install
cp .env.example .env   # repo-root .env is THE single runtime config
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm dev` (`turbo dev`) boots all four services concurrently:

| Service | Port | Dev command |
|---------|------|-------------|
| Server (Express 5 API) | `3000` | `tsx watch src/index.ts` |
| Frontend (Vite + React 19 SPA) | `5173` | `vite` |
| Collector (parse/chunk/embed) | `3210` | `tsx watch src/index.ts` |
| Widget (embeddable service) | `3211` | `tsx watch src/index.ts` |

Scope any command to one package with `pnpm --filter <pkg> <script>`, e.g. `pnpm --filter server test`.

Environment notes:

- The per-package `.env` override layer was removed — `packages/{server,collector,widget}/.env` do not exist and are never read. All three Node services load the repo-root `.env` via `loadRootEnv()` in `packages/shared/src/config/loadEnv.ts`. Precedence: `process.env` > root `.env` > Zod default.
- Strictly required by the server's Zod env schema: `JWT_SECRET` and `COLLECTOR_SECRET`. `DATABASE_URL` has a code default; `LICENSE_KEY` is optional (missing key falls back to Community tier).
- Server tests read the tracked `packages/server/.env.test` (points at `localhost:5434`); it carries test secrets only and no `LICENSE_KEY`.

## Build Commands

All scripts live in the root `package.json` (Turborepo-orchestrated unless noted). `pnpm db:generate` must run before build/lint/typecheck/test — turbo's `build` task depends on it, and the server's `db:generate` also applies the Prisma 7 + pnpm symlink workaround (`scripts/fix-prisma-pnpm.cjs`).

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all services via Turborepo (server `:3000`, frontend `:5173`, collector `:3210`, widget `:3211`) |
| `pnpm build` | Production build all packages (depends on `^build` + `db:generate`, outputs `dist/**`) |
| `pnpm lint` | ESLint across all packages |
| `pnpm typecheck` | TypeScript strict-mode checking across all packages |
| `pnpm test` | Unit tests across all 5 packages via Turborepo (Postgres-free) |
| `pnpm test:all` | Same 5-project suite via the root `jest.config.cjs` aggregator (plain Jest, no Turborepo) |
| `pnpm test:e2e` | Playwright E2E browser tests |
| `pnpm db:generate` | Regenerate the Prisma client (`turbo db:generate`) |
| `pnpm db:migrate` | Apply/create migrations interactively (`prisma migrate dev`) |
| `pnpm db:seed` | Seed default roles, permissions, templates, config (`admin` / `admin123`, `mustChangePassword` set) |
| `pnpm audit:migrations` | Audit migrations for destructive ops; writes `docs/MIGRATION_AUDIT.md` |
| `pnpm db:migrate:guard` / `pnpm db:migrate:reset:guard` | Consent guards for destructive migrate/reset |
| `pnpm i18n:check` | Validate 8-locale translation parity (frontend + widget) |
| `pnpm license:check` | Verify the configured license without booting the server (exit `0` valid, `1` invalid token, `2` env error) |
| `pnpm version:check` / `pnpm version:bump` | Root `package.json` major.minor vs latest git tag sync |
| `pnpm changelog:check` | Requires a `[Unreleased]` CHANGELOG.md entry when `packages/*/src/**` changed (excluding `__tests__/` at any depth) |
| `pnpm license:check-self` | Asserts root + all 5 package `license` fields stay `AGPL-3.0-or-later` |
| `pnpm knip` | Dead-code gate (exit 1 on new unused files/deps/exports) |
| `pnpm tauri:dev` / `pnpm tauri:build` | Tauri v2 desktop shell |

## Testing Strategy

Jest 30.x with `@swc/jest` as the active TypeScript transform (`ts-jest` is retained only as a documented rollback path). The root `jest.config.cjs` aggregates 5 projects: shared, server, frontend, collector, widget.

- **Unit suites (`pnpm test`)** run Postgres-free. Server unit tests load `packages/server/.env.test` via `src/__tests__/helpers/setupEnv.ts` and mock heavy deps through jest `moduleNameMapper` (`uuid`, `jsdom`, `pdfjs-dist`, `puppeteer`, `pg-boss`, etc.). Server tests map `@simmetric-chat/shared` to `shared/dist/index.js` — see the shared-rebuild gotcha below.
- **Integration suites (`pnpm --filter server test:integration`)** hit real Postgres on `localhost:5434` (per `packages/server/.env.test`), matching `*.integration.test.ts` files. Requires a Postgres user with CREATEDB — `jest.globalSetup.js` builds a template database (`simmetricchat_test_template`), each test file gets a cloned worker DB, and `jest.globalTeardown.js` cleans up.
- **Single test:**

```bash
pnpm --filter server test -- src/__tests__/auth.test.ts   # by file (positional args pass through)
pnpm --filter server test -- -t "test name"               # by name
```

- **Exclusions:** the root `jest.config.cjs` excludes the `check-build-freshness` and `restoreSymlinkTraversal` suites from local runs (environmental `/tmp` quota + path issues, not regressions; they may pass on CI).
- **E2E (`pnpm test:e2e`)** needs local Postgres with `prisma migrate deploy` applied, plus built `@simmetric-chat/shared` and `frontend` (Playwright boots the services via plain `tsx` and `vite preview`). The Enterprise license JWT must be present in the gitignored root `.env` (read by the E2E `globalSetup`).

Full details: [TESTING.md](./TESTING.md).

## Database and Migrations

Schema lives at `packages/server/prisma/schema.prisma`. Workflow:

1. Edit the schema.
2. `pnpm db:generate` — regenerate the Prisma client (server script also runs the pnpm symlink fix).
3. `pnpm --filter server db:migrate` — create/apply the migration interactively.
4. `pnpm db:seed` — seed roles, permissions, templates, config.
5. `pnpm audit:migrations` — regenerate `docs/MIGRATION_AUDIT.md` and **commit it in the same PR** (CI's `migration-safety-check` job fails on drift).

**Additive-only policy:** migrations must not contain `DROP TABLE` / `DROP COLUMN` / `DROP INDEX`. Destructive migrations require explicit consent via the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` repo variable (accepted values: `yes`, `1`, `true`). Full policy: [MIGRATION_SAFETY.md](./MIGRATION_SAFETY.md).

Prisma rules: never call `new PrismaClient()` — import the singleton from `packages/server/src/utils/prisma.ts` (driver-adapter pool + `withSoftDelete()`). Soft deletes via `deletedAt` are the norm; hard deletes are the exception (`MCPConnection` uninstall, `ChatMCPPin` unpin).

## Code Style

**Linting: ESLint 10 flat config only** (`eslint.config.mjs` at repo root) with `typescript-eslint`. **No Prettier or Biome** — formatting is enforced through ESLint and TypeScript strict mode. Several rules are intentionally `warn` with debt documented inline in the config — do not "fix" them as drive-by changes.

Key rules (verified in `eslint.config.mjs`):

| Rule | Setting |
|------|---------|
| `@typescript-eslint/no-explicit-any` | `warn` |
| `@typescript-eslint/no-unused-vars` | `warn` (`_`-prefixed args/vars ignored) |
| `no-empty` | `error` with `allowEmptyCatch: true` |
| `no-control-regex` | `off` (deliberate control-char sanitization in `fileUtils.ts`) |
| `preserve-caught-error` | `error` |
| `react-compiler/react-compiler` | `error` in source; `off` in `__tests__/` |
| `react-hooks/rules-of-hooks` | `error` |
| `react-hooks/exhaustive-deps` | `warn` |
| `@typescript-eslint/ban-ts-comment` | `off` in `__tests__/` (`@ts-nocheck` is allowed there only) |

`projectService` is intentionally not enabled (syntax-only rules). Run with `pnpm lint` (all packages) or `pnpm --filter <pkg> lint`.

**TypeScript:** `strict: true` in all five packages; target `ES2022`; frontend additionally enables `noUnusedLocals` and `noUnusedParameters`. Run `pnpm typecheck`.

**Module formats differ per package** — root and frontend are ESM (`"type": "module"`); server, collector, shared, and widget are CommonJS. Respect each package's tsconfig `module` setting.

**Naming:** camelCase files for routes/services (`authService.ts`), PascalCase for React components (`ChatPanel.tsx`), `.schema.ts` suffix for shared schemas, `.test.ts` / `.integration.test.ts` co-located in `__tests__/`, SCREAMING_SNAKE_CASE for module constants, no `React.FC`. New source files under `packages/*/src/**` carry the AGPL-3.0-or-later SPDX header — `node scripts/add-headers.cjs` adds it idempotently.

## i18n

New UI strings must exist in **all 8 locales**: `en`, `it`, `ru`, `de`, `es`, `fr`, `zh`, `pt`. EN is the baseline; parity is strict — no locale may lag.

- `pnpm i18n:check` runs the frontend check (`packages/frontend/scripts/i18n-check.cjs` + `i18n-usage-check.cjs`) and the widget check (`packages/widget/scripts/i18n-check.cjs`). It exits 1 on any missing **or extra** key in any locale relative to `en`.
- The frontend check is scoped to the `--namespaces=` list in `packages/frontend/package.json` — **that list is the source of truth**; add new namespaces there. The usage check additionally fails on `t()` keys absent from `en` (allowlist exists for pre-existing debt — do not add entries to it).
- The widget check also fails on empty-string values.
- Shared's `widgetLocalesParity.test.ts` pins the widget locale set against the frontend `ALL_LANGUAGES` — add/remove locales in both places together.

## Zod Schemas and API Error Shape

**Schemas** are defined once in `packages/shared/src/schemas/` and re-exported from `schemas/index.ts`. Never re-declare schemas per-package. Export the inferred type alongside (`export type LoginInput = z.infer<typeof loginSchema>`). Validate with **`safeParse` (not `parse`)** in route handlers so validation failures return 400 instead of throwing 500.

**Error shape** (consistent across the API):

| Case | Response |
|------|----------|
| Generic error | `{ error: string }` |
| Validation (400) | `{ error, details }` |
| License/feature-gated (402) | `{ error, feature, tier }` (optionally `limit`, `current`) |
| Settings `PUT` | `{ updated, rejected }` — partial success is normal; refetch after save |
| Auth / RBAC / conflict | `401` / `403` / `409` with `{ error }` |

SSE chat streams emit events `token`, `status`, `citations`, `done`, `error`; errors arrive as `event: error` with `{ error }` data.

## RBAC and License Middleware

- **RBAC:** new endpoints must declare their permission requirement via `packages/server/src/middleware/rbac.ts` (`requirePermission(...)`). The 31 permissions are defined in `packages/shared/src/constants/permissions.ts`.
- **License gating:** enterprise features gate through `packages/server/src/middleware/license.ts` (`requireFeature`, `requireFeatureLimit`) and the feature flags in `packages/shared/src/constants/license.ts`. Gated failures return `402 { error, feature, tier }`.
- Typical handler stack: `authMiddleware` → `requirePermission("...")` → workspace/project access check → handler.

## Monorepo Gotchas

- **Dependency graph is strictly unidirectional:** `shared` (Zod schemas, constants, types; only dependency `zod`) is the ONLY cross-package import. Server and collector never import each other — they communicate over HTTP with the `COLLECTOR_SECRET` shared secret.
- **Turbo caching — shared rebuild:** turbo caches `build`/`lint`/`typecheck`/`test` on `^build`. After editing `packages/shared/src/`, server and collector jest runs resolve `@simmetric-chat/shared` from `shared/dist/index.js` (via each package's jest `moduleNameMapper`) and may run against a **stale `shared/dist`**. Rebuild with `pnpm --filter @simmetric-chat/shared build`, or run the task through turbo (which replays the `^build` dependency). Frontend and widget jest map shared to **source** (`shared/src/index.ts`), so their tests are unaffected; the frontend also aliases shared source in Vite.
- **No phantom dependencies:** every import must be declared in the consuming package's `package.json` (pnpm strictness enforces this).

## Dev-Mode Quirks

- **Vite proxy retry hook:** the server (`tsx watch`) boots slower than Vite (~1s) — Prisma + Postgres + auto-seed + license/FTS/schedulers. `packages/frontend/vite.config.ts` installs a proxy `onError` handler that retries `ECONNREFUSED` up to 8 times over ~4 seconds (GET/HEAD only — POST/SSE bodies are never replayed), then falls back to a single concise 502. Repeated 502s after that window mean the backend is genuinely down. **Do not remove this hook** — the default handler dumps an `AggregateError` stack on every cold start.
- **Docker template seeding:** seed templates are copied into the server image (`docker/Dockerfile.server` copies `src/templates/` to `dist/templates/`; `templateService.ts` resolves them `__dirname`-relative). A stale image silently seeds no templates — rebuild with `--no-cache` to fix.
- **`tsx watch` boot time:** the server takes several seconds to bind; this is expected, not a hang.
- **`pnpm start` freshness guard:** the server refuses to start if `dist/` is stale relative to `src/` (`check-build-freshness`); CI enforces the same.
- **Root `jest.config.cjs` exclusions:** the `check-build-freshness` and `restoreSymlinkTraversal` suites are excluded from local runs for environmental reasons (`/tmp` quota, path issues) — not code regressions.

## Branch Conventions

The default branch is `main`. Use descriptive branch names prefixed with the change type: `feat/widget-embed`, `fix/auth-token-expiry`, `docs/api-update`. Long-lived working branches may use prefixes like `docs/dev-guide`.

Commit messages follow the conventional format `type(scope): description` (`feat`, `fix`, `test`, `refactor`, `ci`, `chore`, `docs`; quick tasks use a `quick-<YYMMDD>-<id>` scope). One logical change per commit.

## PR Process

All PRs require CI to pass before merging. Per [CONTRIBUTING.md](../CONTRIBUTING.md):

1. Branch from `main` with a type-prefixed name; commit as `type(scope): description`.
2. Add or update tests for any behavioral change (co-located in `__tests__/`; `.integration.test.ts` for real-Postgres suites).
3. Touching `packages/*/src/**` (excluding `__tests__/` at any depth) requires a `[Unreleased]` bullet in `CHANGELOG.md` (`pnpm changelog:check`).
4. Schema changes require `pnpm audit:migrations` plus the regenerated `docs/MIGRATION_AUDIT.md` committed in the same PR.
5. String changes require all 8 locales (`pnpm i18n:check`).

Pre-PR checklist:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e        # if frontend/UI changed
pnpm version:check
pnpm changelog:check
pnpm audit:migrations # if schema changed
pnpm i18n:check       # if strings changed
pnpm license:check-self
```

CI (`.github/workflows/ci.yml`) runs on push to `main` and PRs targeting `main`: `lint-and-typecheck` (includes `knip` + `changelog:check`), `test-unit`, `test-airgap` (unit suite re-run with `NETWORK_EGRESS_BLOCKED=1`), `migration-safety-check`, `license-policy-check`, `test-e2e` (Playwright against `pgvector/pgvector:pg16`), `build` (with a dist-freshness check), and `security` (gitleaks scan).

## See also

- [Documentation index](./INDEX.md)
- [Getting Started](./GETTING_STARTED.md) — prerequisites, install, first run
- [Testing Guide](./TESTING.md) — test framework, integration harness, E2E
- [Architecture](./ARCHITECTURE.md) — system overview and data flow
- [Contributing Guide](../CONTRIBUTING.md) — full conventions, CLA, security/RBAC/license details
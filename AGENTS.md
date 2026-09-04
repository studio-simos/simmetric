# AGENTS.md — Simmetric Chat

Local-first, air-gap-capable AI chat workspace with RAG + RBAC + embeddable widget. pnpm + Turborepo monorepo, Node >= 24, pnpm 11.24.0 (pinned via `packageManager` in root `package.json`).

## Repo layout

Five packages, strict unidirectional deps — `@simmetric-chat/shared` is the ONLY cross-package import:

- `packages/shared` — Zod schemas, constants, types. Zero deps except `zod`. **Must be built** (`pnpm --filter @simmetric-chat/shared build`) for server/collector and their Jest runs (they map `@simmetric-chat/shared` to `shared/dist/index.js`). Frontend and widget alias shared **source** (vite + jest — widget's `jest.config.js` maps to `shared/src/index.ts`) and do not need the build.
- `packages/server` — Express 5 API (port 3000). CJS. Entry `src/index.ts`. Prisma 7 (driver adapter `@prisma/adapter-pg`). **Never `new PrismaClient()`** — import the singleton from `packages/server/src/utils/prisma.ts` (adds `withSoftDelete()`); soft deletes via `deletedAt` are the norm. Server↔collector communicate over HTTP only (shared secret `COLLECTOR_SECRET`), never imports.
- `packages/collector` — parse/chunk/embed pipeline (port 3210). CJS. No ORM/Prisma access, but the pgvector provider (`src/services/pgVectorProvider.ts`) creates a `pg.Pool` and queries Postgres directly; receives jobs via HTTP.
- `packages/frontend` — Vite + React 19 SPA (port 5173). ESM. **No Next.js.** Detailed frontend conventions live in `packages/frontend/AGENTS.md` (state golden rule: REST → TanStack Query, SSE → `fetchEventSource` + `useRef`, UI state → Context; Zustand was removed — `src/stores/` no longer exists).
- `packages/widget` — embeddable widget service (port 3211). **CJS**; preact bundle via `build:widget` → `dist-widget/` (gitignored). Detailed conventions in `packages/widget/AGENTS.md`; likewise `packages/server/AGENTS.md`, `packages/collector/AGENTS.md`, `packages/shared/AGENTS.md` — read the package file before working in a package.
- `src-tauri/` — Tauri v2 desktop shell; `beforeDevCommand` boots server+collector and serves the frontend build (`frontendDist: ../packages/frontend/dist`), in release mode the server runs as a `node` sidecar.

Module formats differ per package: root + frontend are ESM; server, collector, shared, widget are CJS. Respect each package's tsconfig `module`.

## Enterprise plugin

The enterprise package (`simmetric-enterprise/`) is a SEPARATE private repo (IP isolation + air-gap + single-package contract). It is NOT a community dependency. Four subsections below.

### Package boundary

- The enterprise package imports ONLY `@simmetric-chat/shared` (Zod schemas, constants, types) — never server/frontend/collector/widget.
- The community repo imports NOTHING from enterprise. The loader's `require.resolve("@simmetric-chat/enterprise")` (in `packages/server/src/services/enterpriseLoader.ts`) is the ONLY seam.
- If absent, the server runs in community mode (graceful degradation — `MODULE_NOT_FOUND` is caught and logged at info level, "Community build — no enterprise package found"). A broken install (load throws) is fail-LOUD (`process.exit(1)` — never silently degrade a paying customer).
- The enterprise package provides SSO (Phase 143), audit log (Phase 144), white-label branding (Phase 145), and backup (Phase 146). Phase 147 added the license-limit override resolver.

### PluginContext contract

The `ctx` object passed to `register(ctx)` (type at `packages/shared/src/schemas/plugin.schema.ts`):

| Property / method | Purpose |
|-------------------|---------|
| `app` | Express app — mount routers via `mountProtected`/`mountPublic`. |
| `prisma` | Prisma singleton (never `new PrismaClient()` — cast through `unknown` for the index signature). |
| `logger` | Server winston logger (info/warn/error/debug). |
| `env` | Parsed + validated env config (`getEnv()`). |
| `licenseInfo` | Resolved license info (Community or Enterprise) — read at boot, reflects the current tier. |
| `mountProtected(path?, router)` | Mount router at `/api/enterprise` (default) or explicit `path`. Applies `authMiddleware` BEFORE the router — core owns auth, plugin owns the handler. Missing `Authorization` → 401. |
| `mountPublic(path?, router)` | Mount router WITHOUT `authMiddleware` — for IdP-initiated callbacks (SAML/OIDC `/api/auth`) + SCIM (`/scim/v2`, applies its own Bearer token). |
| `registerScheduler(name, {start, stop})` | `start()` called immediately at boot; `stop()` called during graceful shutdown (5s per-teardown cap). |
| `onShutdown(fn)` | Teardown callback invoked before `prisma.$disconnect()` (5s per-callback cap). |
| `registerAuditLogWriter(fn)` | Injects the enterprise audit writer into the community `logEvent()` shim (IoC — the shim never imports enterprise). |
| `registerConfigKeyValidator(fn)` | Injects a config-key validator into `updateSettings()` (e.g. the branding validator rejects non-Enterprise `BRANDING_*` keys). |
| `auditLog` | Typed `AuditLog` contract for enterprise-internal routes (set by `register(ctx)`; placeholder until then). |
| `overrideFeatureLimit(flag, value)` | Raise a numeric limit (e.g. `max_workspaces` to `Infinity`). Reactive revocation: `clearLimitOverrides()` runs at the start of `initLicense()`. |
| `generateToken(userId)` | Issue a JWT for a user (core-owned auth delegated — SSO callback routes need this). |
| `encrypt(plaintext)` / `decrypt(ciphertext)` | AES-256-GCM crypto (core-owned, delegated — enterprise SSO needs to encrypt/decrypt `SsoConfig.clientSecretEncrypted`). |

### Air-gap install runbook

1. Build the enterprise package: `cd simmetric-enterprise && pnpm build` (produces `dist/`).
2. Tarball: `tar czf enterprise.tgz -C dist .`.
3. On the customer server, extract to `packages/server/node_modules/@simmetric-chat/enterprise/`.
4. Set `LICENSE_KEY` in the root `.env` (the RS256 JWT — see "License JWT shape" in `docs/ENTERPRISE_PLUGIN.md`).
5. Restart the server — the loader finds the package via `require.resolve()` and the license service validates the JWT.
6. Verify: `curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/enterprise/modules` → 200 with the module manifest.

No npm install, no phone-home, no telemetry. The license service is read-only + local-validation only (verified by the airgap-grep CI gate).

### Boot order

`prisma.$connect()` → `initLicense()` (validates JWT, builds `tierFeatures`) → `loadEnterprisePlugin(app)` (calls `register(ctx)` which mounts routes, registers schedulers, calls `overrideFeatureLimit`) → routes live.

The enterprise plugin loads AFTER the license is validated so `ctx.licenseInfo` reflects the current tier. Enforced by `packages/server/src/__tests__/bootOrder.test.ts`. See `packages/server/src/index.ts` for the boot sequence.

## Commands

```bash
pnpm install                 # onlyBuiltDependencies + patches handled by pnpm-workspace.yaml
pnpm db:generate             # required before build/lint/typecheck/test (turbo `build` depends on it; server also runs scripts/fix-prisma-pnpm.cjs)
pnpm dev                     # all 4 services: server :3000 · frontend :5173 · collector :3210 · widget :3211
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e                # Playwright — see below
```

- `pnpm test` (turbo) runs all 5 package suites (shared, server, frontend, collector, widget — root `jest.config.cjs` has 5 projects); `pnpm test:all` is the same list via plain jest. `pnpm test` requires a Postgres-free environment — server unit tests mock the DB; only `test:integration` suites hit real Postgres.
- Single test: `pnpm --filter server test -- src/__tests__/auth.test.ts` (jest positional args pass through).
- Server integration tests (real Postgres, `.integration.test.ts`): `pnpm --filter server test:integration`. Needs a Postgres user with CREATEDB (jest globalSetup creates a template DB); uses `packages/server/.env.test` which points at `localhost:5434`.
- Server unit tests load `packages/server/.env.test` (via `setupEnv.ts`) and mock or transform-allowlist heavy deps (uuid, jsdom, pdfjs-dist, puppeteer, pg-boss, openid-client — see `jest.config.js` `moduleNameMapper`/`transformIgnorePatterns`) — they must not require a live DB.
- E2E needs local Postgres running with `prisma migrate deploy` applied, plus `pnpm --filter @simmetric-chat/shared build` and `pnpm --filter frontend build` (playwright.config.ts boots server/widget with plain `tsx`, not `tsx watch`, and frontend via `vite preview`). globalSetup seeds admin/admin123 session, the hardcoded workspace, widget API key, and clears `mustChangePassword`. Requires the Enterprise license JWT in the root `.env` (widget gating).

## Environment (biggest gotcha)

- **ROOT `.env` is THE single runtime config.** Bootstrap + shared secrets (`DATABASE_URL`, `JWT_SECRET`, `COLLECTOR_SECRET`, `WIDGET_API_KEY`, `API_KEY_HMAC_SECRET`, optional `ENCRYPTION_KEY`/`REDIS_URL`/`LICENSE_KEY`) live in the repo-root `.env` (gitignored); template: root `.env.example` — the single exhaustive file documenting EVERY schema key of every package, organized in per-package sections with `[server]`/`[collector]`/`[widget]` applicability markers (guarded by the three `envExampleParity` tripwires, which all point at the root file). The per-package `.env` override layer was REMOVED (Phase 177 cleanup): `packages/{server,collector,widget}/.env` no longer exist and are never read. Loader resolution: `process.env > root .env > Zod default` (root-only `loadRootEnv()` in `packages/shared/src/config/loadEnv.ts`, marker-walk to the repo root; containers get env via compose `env_file`, Tauri packaged layout falls back gracefully). `packages/server/.env.test` stays tracked for tests.
- Strictly required (Zod `.min(1)` in `packages/server/src/config/env.ts`): `JWT_SECRET` and `COLLECTOR_SECRET`. `DATABASE_URL` has a code default, and `LICENSE_KEY` is optional — `licenseService.initLicense()` falls back to Community when missing (a working Enterprise JWT enables widget/SSO/webhooks/etc. — the committed `.env.test` does NOT carry the JWT; the gitignored `.env` does, read by E2E `globalSetup`).
- Default DB (code default in `packages/server/src/config/env.ts`): `postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat` (the tracked root `.env.example` uses `host.docker.internal:5432` with a comment listing the `localhost:5432` host-native alternative; `docs/GETTING_STARTED.md` / `docs/DEPLOYMENT.md` document both variants). Vector DB defaults to LanceDB (local); LLM defaults to Ollama.
- The server loads env on boot. **Precedence (code-verified, `systemConfigService.ts`):** `ALWAYS_READONLY` infra keys (JWT_SECRET, DATABASE_URL, SERVER_PORT, COLLECTOR_PORT, SERVER_URL, COLLECTOR_URL) are ENV-only, never DB; every other UI-editable key resolves DB > ENV > default (the DB wins — UI edits take effect immediately). Versioning is pre-1.0 beta: root `package.json` tracks the latest 0.x tag (v0.21 = debt sweep line, rebased from the never-published 1.x numbering).

## Migrations

- Workflow: edit `packages/server/prisma/schema.prisma` → `pnpm db:generate` → `pnpm --filter server db:migrate` → `pnpm db:seed`.
- **Additive-only policy.** After any schema change run `pnpm audit:migrations` and commit the regenerated `docs/MIGRATION_AUDIT.md` in the same PR — CI fails if it drifts. Destructive migrations need consent via the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` repo variable. See `docs/MIGRATION_SAFETY.md`.
- `docs/` is **not** gitignored (no `docs` entry in `.gitignore`); files under `docs/` are tracked normally with plain `git add`.

## Conventions

- **Lint**: ESLint 10 flat config only; no Prettier/Biome. Several rules are intentionally `warn` with debt documented inline in `eslint.config.mjs` — don't "fix" them as drive-by. `@ts-nocheck` is allowed in `__tests__/` files.
- **i18n**: new UI strings must exist in all 8 locales — `pnpm i18n:check` (frontend `scripts/i18n-check.cjs` + `i18n-usage-check.cjs`, mirrored in the widget) iterates `LOCALES = [en, it, ru, de, es, fr, zh, pt]` and exits 1 on any missing/extra key in ANY locale relative to `en`; de/fr/es/zh/pt cannot lag (widget script also fails on empty values). The frontend check is scoped to the `--namespaces=` list in `packages/frontend/package.json` — that list is the source of truth; add new namespaces there. `i18n-usage-check.cjs` additionally fails on `t()` keys absent from `en` (allowlist for pre-existing debt). Shared's `widgetLocalesParity.test.ts` pins widget ↔ frontend locale sets.
- **Schemas**: define in `packages/shared/src/schemas/`, export inferred types, validate with `safeParse` (not `parse`) in handlers. Never re-declare schemas per-package.
- **API shape**: errors are `{ error: string }` (400 adds `details`); settings PUT returns `{ updated, rejected }` (partial success is normal — refetch after save); license-gated failures return 402 `{ error, feature, tier }`.
- **RBAC/license**: new endpoints must declare permissions via `packages/server/src/middleware/rbac.ts`; enterprise features gate through `packages/server/src/middleware/license.ts` and `packages/shared/src/constants/license.ts`.
- **GSD workflow**: per `CONTRIBUTING.md`, route work through `/gsd:quick`, `/gsd:debug`, or `/gsd:execute-phase`; GSD handles commits — do not commit manually inside a workflow. Planning artifacts live in `.planning/` (gitignored).

## Dev-mode quirks

- Root `jest.config.cjs` excludes `check-build-freshness` and `restoreSymlinkTraversal` suites from all local runs (Phase 137 D-03: /tmp quota + local-env path issues — environmental, not regressions; they may pass on CI).
- Vite proxies `/api` → `:3000` with a retry hook for the server's slow boot (GET/HEAD only, ~4s). Repeated 502s after that window = backend actually down; don't remove the hook.
- Turbo caches `build`/`lint`/`typecheck`/`test` on `^build`, so after editing `packages/shared/src/`, server tests may run against a stale `shared/dist` unless you rebuild shared (`pnpm --filter @simmetric-chat/shared build`) or run via turbo.
- Docker seed requires template files copied into the image (`packages/server/src/templates/` — `Dockerfile.server` copies them to `dist/templates/`; `templateService.ts` resolves them `__dirname`-relative, so a stale image silently seeds no templates). Stale-image seed failures are fixed by rebuilding with `--no-cache`.

## High-value sources

- `packages/frontend/AGENTS.md` — frontend architecture, components, i18n, chat/SSE internals
- `CONTRIBUTING.md` — full conventions, PR checklist, security/RBAC/license details
- `docs/DEVELOPMENT.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`
- `.planning/codebase/*` — STRUCTURE.md, STACK.md, CONVENTIONS.md, TESTING.md (up-to-date codebase maps)

# Contributing to Simmetric Chat

Thank you for your interest in contributing to Simmetric Chat — an enterprise-grade, local-first, privacy-first AI chat workspace with RAG, RBAC, and full air-gap capability. This document outlines the conventions and process for contributing to the project.

## Contributor License Agreement

By submitting a pull request, you agree to the [Contributor License Agreement](CLA.md) (v1.0). Include this line in your PR description:

```
I have read and agree to the Simmetric Chat Contributor License Agreement (v1.0).
```

This CLA protects the project's dual-license model (AGPL-3.0 community + proprietary commercial enterprise) by ensuring the maintainer has the rights to distribute contributions under both licenses.

## Development Setup

See [GETTING_STARTED.md](docs/GETTING_STARTED.md) for prerequisites and first-run instructions, and [DEVELOPMENT.md](docs/DEVELOPMENT.md) for local development setup including build commands, environment configuration, and code style details.

Quick reference:

- **Prerequisites**: Node.js `>=24.0.0`, pnpm `11.24.0` (pinned via `packageManager` in root `package.json`), PostgreSQL 16.
- **Install**: `pnpm install` (root). pnpm strictness enforces no phantom dependencies — every import must be declared in the consuming package's `package.json`. pg-boss (v12, server dependency) is pulled by `pnpm install` — no manual setup; it auto-creates its `pgboss` schema in Postgres on server boot (not a Prisma migration).
- **Root `.env` (single runtime config)**: Server, collector, and widget all load the repo-root `.env` via the shared `loadRootEnv()` marker-walk in `@simmetric-chat/shared` (finds `pnpm-workspace.yaml` walking up from `src/config/env.ts` — independent of the operator's working directory; packaged layouts without the marker fall back to a cwd-adjacent path and gracefully skip). The per-package `.env` override layer was REMOVED — do NOT create `packages/server/.env` / `packages/collector/.env` / `packages/widget/.env`, they are never read. Copy the root `.env.example` (the single exhaustive template, per-package sections) to `.env`. Server tests use `packages/server/.env.test` (tracked in git — must include `DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=test`, `COLLECTOR_SECRET`, `WIDGET_API_KEY`, `API_KEY_HMAC_SECRET`; it does NOT carry `LICENSE_KEY`). The Enterprise license JWT lives in the gitignored root `.env` (read by the E2E `globalSetup`), not in `.env.test`. `.env` is gitignored — do not commit it.
- **Local API-key auth**: API-key verification uses HMAC-SHA256 keyed by `API_KEY_HMAC_SECRET` (base64 32-byte, `openssl rand -base64 32`). It is optional in the Zod env schema, but `getHmacSecret()` throws fail-loud when an API key is actually used without it (middleware returns 500, not 401, so misconfiguration is not hidden as "invalid key"). Set it in the root `.env` for local API-key auth; `.env.test` carries a test value (32 zero bytes).
- **Encryption key**: `ENCRYPTION_KEY` (base64 32-byte) is optional in dev/test — when unset, `encryptionService` falls back to the legacy `scryptSync(JWT_SECRET)` derivation so local dev needs no extra config. In production (`NODE_ENV=production`) it is REQUIRED: the boot gate in `packages/server/src/index.ts` refuses to start without it. Generate with `openssl rand -base64 32`. See `docs/ENCRYPTION_KEY_ROTATION.md` for rotation.
- **Database**: `pnpm db:generate` (regenerate Prisma client), `pnpm db:migrate` (apply migrations interactively), `pnpm db:seed` (seed default roles, permissions, templates, config; admin/admin123 is auto-seeded on a fresh DB with `mustChangePassword`).
- **Run**: `pnpm dev` starts all services (server `:3000`, frontend `:5173`, collector `:3210`, widget `:3211`). Use `pnpm --filter <pkg> <script>` to scope a command to one package (e.g., `pnpm --filter server test`).

## Coding Standards

- **Linting**: ESLint 10 with flat config (`eslint.config.mjs`) and `typescript-eslint`. Run `pnpm lint` to check all packages. Key rules: `no-explicit-any` is `warn` (discourages `any` annotations and casts), `no-unused-vars` is `warn` (arguments prefixed with `_` are ignored), `react-compiler/react-compiler` and `react-hooks/rules-of-hooks` are `error`; only `react-hooks/exhaustive-deps` is `warn`. Test files (`packages/*/src/**/__tests__/**`) down-select `@typescript-eslint/ban-ts-comment` to allow `@ts-nocheck` in mock-heavy tests.
- **Type checking**: TypeScript strict mode (`"strict": true`) is enabled in **all five packages** (server, collector, frontend, shared, widget). Frontend additionally enables `noUnusedLocals` and `noUnusedParameters`. Target is `ES2022` everywhere. Run `pnpm typecheck` to validate all packages.
- **Module format**: Frontend and root are ESM (`"type": "module"`); server, collector, shared, and widget are CommonJS. Respect the existing `module` setting in each package's `tsconfig.json`.
- **Formatting**: No Prettier or Biome configuration is present. ESLint and TypeScript strict mode enforce code style.
- **License headers**: Source files under `packages/*/src/**` (`.ts` / `.tsx`) carry the AGPL-3.0-or-later SPDX header. When you create new files, run `node scripts/add-headers.cjs` — it is idempotent (it skips files that already start with the header and empty files), so it is safe to re-run any time. Never remove or rewrite existing headers.
- **CI enforcement**: `.github/workflows/ci.yml` runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm audit:migrations`, `pnpm changelog:check`, `pnpm test:e2e` (Playwright), and `pnpm build` on every push and pull request. All checks must pass before a PR can be merged. The `lint-and-typecheck` job runs `pnpm changelog:check` right after `version:check` — a PR touching `packages/*/src/**` (excluding `__tests__/` at any depth) without a `[Unreleased]` entry in `CHANGELOG.md` fails CI.

## Monorepo Conventions

Simmetric Chat is a pnpm + Turborepo monorepo. Workspaces live under `packages/*` (server, collector, frontend, shared, widget). Cross-package rules are strict:

- **AGENTS.md first**: Each package has its own `AGENTS.md` (`packages/server/AGENTS.md`, `packages/frontend/AGENTS.md`, `packages/collector/AGENTS.md`, `packages/widget/AGENTS.md`, `packages/shared/AGENTS.md`) — read the package file before working in that package. The root `AGENTS.md` covers repo-wide rules (dev-mode quirks, env precedence, boot order).
- **Unidirectional dependency graph**: `shared ← server`, `shared ← collector`, `shared ← frontend`, `shared ← widget`. `shared` (zero-dependency types, Zod schemas, constants — only dependency is `zod`) is the ONLY cross-package import. Server and collector must never import from each other — they communicate via HTTP APIs only, authenticated by `COLLECTOR_SECRET`.
- **Collector has no Prisma ORM access**: `packages/collector` uses no Prisma ORM, but the pgvector provider (`src/services/pgVectorProvider.ts`) creates a `pg.Pool` and queries Postgres directly for vector storage. It receives ingest jobs from the server via HTTP POST to `/api/ingest` and `/api/ingest/query`, and notifies the server of processing outcome via `PUT /api/documents/:id/status`.
- **Schedulers are pg-boss cron jobs**: The 8 background schedulers (MCP health check `*/30 * * * *`, MCP reaper `*/5 * * * *`, synthesis reaper `*/15 * * * *`, vector cleanup `*/5 * * * *`, upload-draft reaper `0 3 * * *`, chat-message reaper `0 3 * * *`, fidelity sampling `0 3 * * 0`, wiki consistency `0 * * * *`) run as pg-boss cron jobs registered at boot via `createQueue` + `schedule` + `boss.work` (see `packages/server/src/services/*Job.ts`, `archiveConsistencyService.ts`, and the fidelity scheduler in `packages/server/src/index.ts`). pg-boss's native SKIP LOCKED dedup supersedes the old overlap guards/distributed locks, and `stopJobQueue()` drains all workers on shutdown. When Postgres is unreachable, `startJobQueue()` degrades gracefully (`getBoss() === null`, schedulers log offline — no fallback timers). The OCR and synthesis pipeline pollers (10s `setInterval`) remain inline in `packages/server/src/index.ts`. See [SCALING.md](docs/SCALING.md) for the multi-instance operator view.
- **No phantom dependencies**: If a package uses a dependency, it must be declared in that package's `package.json`. pnpm strictness enforces this; undeclared imports will fail to resolve.
- **Validation**: Define request/response schemas in `packages/shared/src/schemas/` using Zod (`auth.schema.ts`, `chat.schema.ts`, `widget.schema.ts`, `mcpConnection.schema.ts`, etc.). Export both the schema and the inferred type (`export type LoginInput = z.infer<typeof loginSchema>`). Validate in BOTH server and collector — never re-declare schemas in a package. Use `safeParse` (not `parse`) in route handlers so validation errors return 400 instead of throwing 500.
- **Soft deletes**: Projects, workspaces, documents, widgets, archives, and chats use `deletedAt: DateTime?` for soft deletes, never hard deletes (exception: `MCPConnection` uninstall and `ChatMCPPin` unpin are hard-deleted by design). Always import Prisma from `packages/server/src/utils/prisma.ts` (the driver-adapter pool singleton that also exports `withSoftDelete()`). Note that `withSoftDelete` is a type-preserving no-op (`return where;`) — it does NOT add any filter; call sites must include the `deletedAt: null` filter themselves. Never call `new PrismaClient()` directly.
- **SSE protocol**: All chat streams use `text/event-stream` with events `token`, `status`, `citations`, `done`, `error`. The widget reuses the same format for compatibility. SSE errors are emitted as `event: error\ndata: {"error": "..."}` so the frontend can display them inline. Do NOT use TanStack Query for SSE chat state — use `useState`/`useRef` (see `packages/frontend/src/hooks/useChat.ts`).
- **API response format**: Success `GET` → `res.json(data)` (200); `POST` create → `201`; `POST` action → `200 { message }`; `DELETE` → `200 { message }`; settings `PUT` → `200 { updated, rejected }` (partial success is the norm). Errors: `{ error: string }` minimum; validation `400 { error, details }`; auth `401`; RBAC `403`; conflict `409`; license/feature flag `402 { error, feature, tier }` plus optional `limit`/`current`. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow.

### RBAC, License, and Security (Cross-Cutting)

- **RBAC**: 31 permissions grouped by resource (Workspace, Project, Chat, Document, Admin, Creation, Provider, Archive, Backup, Memory, Filters) are defined in `packages/shared/src/constants/permissions.ts`. 13 menu sections control sidebar visibility and are gated per-role via the `RoleMenuSection` model. Two roles are seeded by default — Admin (all 31 permissions + all 13 menu sections; the de-facto superuser) and User (limited permissions + a subset of menu sections). New endpoints must declare their permission requirement via the `rbac` middleware in `packages/server/src/middleware/rbac.ts`.
- **License-gated features**: 11 feature flags in `packages/shared/src/constants/license.ts` are gated by `LICENSE_KEY` (RS256 JWT) via `packages/server/src/middleware/license.ts`. The public key used to verify licenses is embedded in `packages/server/src/services/license-public-key.ts` (no secret env config needed to verify). Enterprise-gated flags: SSO (`sso_enabled`), immutable audit logs (`audit_log_immutable`), white-label branding (`white_label`, enforced at settings level by rejecting `BRANDING_*` keys), widget system (`widget_enabled`), backup system (`backup_enabled`), and widget credits editing (`widget_credits_editing`). Numeric limits (`max_workspaces`, `max_projects`, `max_widgets`, `max_backup_destinations`, `custom_agents`) are enforced on creation routes via `requireFeatureLimit` (Community defaults: 3/3/1/1/3; Enterprise: unlimited). The 8 commodity features (web search, webhooks, push notifications, memory, lead export, widget analytics, auto title generation, synthesis rate limit) are always-ON in Community builds; `priority_support` moved to a commercial/SLA contract. Graceful degradation: expired Enterprise licenses automatically revert to Community at runtime. New enterprise features must be wired through the license middleware and added to `packages/shared/src/constants/license.ts`.
- **Registration gating**: `ALLOW_REGISTRATION` env var — `true` for open signup, `false` (default) for admin-only creation.
- **Local-first / air-gap**: All data stays on-prem and is air-gap compatible — no external CDN for core functionality. Default embeddings (Xenova/all-MiniLM-L6-v2) and vector store (LanceDB) run locally; Ollama is the default LLM provider. Privacy-first: sensitive data (API keys, tokens, passwords) is redacted in API responses (`redactSecret` in `license.ts`, `maskApiKey` in `providers.ts`/`encryptionService.ts`, backup/SSO redaction helpers live in the enterprise package; community SSO config handling is inlined in `packages/server/src/routes/auth.ts`, which never exposes the client secret — only a `clientSecretConfigured` boolean) — note that loggers dump metadata as-is with no redaction.

#### Committed Test Enterprise License JWT

The gitignored root `.env` (NOT the tracked `.env.test`) carries an Enterprise license JWT (`LICENSE_KEY`) that the E2E `globalSetup` reads to enable widget gating and other Enterprise-gated features during Playwright runs. The tracked `packages/server/.env.test` carries only test secrets — `JWT_SECRET`, `DATABASE_URL`, `COLLECTOR_SECRET`, `WIDGET_SERVICE_URL`, `WIDGET_API_KEY`, `API_KEY_HMAC_SECRET`, `NODE_ENV` — and no `LICENSE_KEY`.

The license JWT is an RS256 token whose payload conforms to `licensePayloadSchema` (`packages/shared/src/schemas/license.schema.ts`): `tier` (`"community"` | `"enterprise"`), `iss` (issuer), `sub` (licensee — org name or domain), `iat` (issued at), `exp` (expiry, unix epoch — checked on every read by `getLicenseInfo()`), and an optional `features` record mapping feature-flag names to boolean or numeric values. The `features` values override the Enterprise defaults in `packages/shared/src/constants/license.ts` when the key exists in `tierFeatures`; unknown keys are silently dropped by the `licenseService` override loop (additive-only invariant, EPA-10), so old JWTs keep working on newer servers. The flags that actually gate behavior are the 11 in `FEATURE_FLAGS` (see the RBAC/License section above).

The JWT body itself is not committed to this repo — `LICENSE_KEY` lives in the gitignored root `.env` (also read by the E2E `globalSetup`), so the concrete entitlements of the test license and its `exp` value cannot be verified from tracked files. Operators can decode their own token with `pnpm license:check` (exit 0 = valid/entitled, 1 = invalid token, 2 = env error) and any JWT decoder (note: the server never logs the payload or the token itself — `licenseService` logs only `tier` and `sub`); new test/production JWTs are minted via the separate `simmetric-license-tool` repo.

These are scoped to test/dev — the JWT is validated against the embedded RSA public key (`packages/server/src/services/license-public-key.ts`); only the private key in the separate `simmetric-license-tool` repo can mint licenses, so the committed JWT cannot be used to forge new ones.

**Rotation invalidation:** rotating the license signing keypair (in `simmetric-license-tool`) invalidates this committed JWT — `licenseService.initLicense()` fails RS256 verification against the new public key and the server falls back to Community tier, which disables widget/SSO/audit-log/backup/white-label features. The same applies to any customer JWT that has not been re-issued after a rotation. See [docs/LICENSE_KEY_ROTATION.md](docs/LICENSE_KEY_ROTATION.md) for the full rotation procedure.

**Expiry:** the JWT's `exp` claim (unix epoch seconds) is checked on every read — after expiry the server auto-reverts to Community (graceful degradation, no crash; `clearLimitOverrides()` also revokes any `Infinity` limit overrides from the expired Enterprise tier). Re-issue the test JWT via `simmetric-license-tool` before it lapses to keep the E2E suite green.

### Naming Conventions

- **Files**: camelCase for routes/services/middleware (`auth.ts`, `authService.ts`, `rateLimit.ts`); PascalCase for frontend components (`ChatPanel.tsx`); `.schema.ts` suffix for shared schemas; `.test.ts` / `.test.tsx` suffix for tests co-located in `__tests__/` (`.integration.test.ts` for real-PostgreSQL integration tests).
- **Functions/variables**: camelCase (`createWorkspaceSchema`, `getEnv`, `findUnique`).
- **Module constants**: SCREAMING_SNAKE_CASE (`PERMISSION_NAMES`, `FEATURE_FLAGS`, `MENU_SECTIONS`, `SALT_ROUNDS`).
- **Types/interfaces**: PascalCase (`LoginInput`, `AuthUser`, `ChatMessage`).
- **Booleans**: `is`/`has`/`should` prefixes (`isAuthenticated`, `hasMatch`).
- **Prisma models**: PascalCase model names with camelCase fields and `@@map("snake_case")` for table names (`@@map("users")`, `@@map("user_roles")`).
- **React components**: `function ComponentName(props: Props)` — `React.FC` is NOT used.

## i18n

Frontend strings are managed with `react-i18next` and JSON files in `packages/frontend/src/i18n/{en,it,ru,de,es,fr,zh,pt}/translation.json` (8 locales; `pt` was added last). EN is the source baseline. **Strict parity**: `pnpm i18n:check` (via `packages/frontend/scripts/i18n-check.cjs`) iterates ALL 8 locales and exits 1 on any missing OR extra key in ANY locale relative to `en` — no locale is drift-tolerant (de/fr/es/zh/pt cannot lag). The only scoping is namespace-based: the check is limited to the `--namespaces=` list in `packages/frontend/package.json` (currently: `chat.palette, chat.comparison, chat.fallback, chat.modelSelector, chat.modelCommand, chat.capabilities, wiki, config, archives, uploads, chat.archive, mcpHelp, documents, synthesis.rename, settings.webSearch, widgets, setup.wizard, workspace, synthesis, ocr`) — that list is the source of truth; add new namespaces there. `i18n-usage-check.cjs` additionally fails on `t()` keys absent from `en` (allowlist for pre-existing debt — do NOT add new entries without verifying the key genuinely does not exist in `en`). The widget mirrors the same 8-locale set (`packages/widget/src/widget/i18n/{en,it,ru,de,es,fr,zh,pt}.json`) via its own `i18n-check.cjs`, which also fails on empty-string values; shared's `widgetLocalesParity.test.ts` pins the widget ↔ frontend locale sets. Run `pnpm i18n:check` (root) to validate both.

- **License policy**: The community repo is AGPL-3.0-or-later (all five packages declare it; `pnpm license:check-self` asserts the fields). The enterprise plugin (`@simmetric-chat/enterprise`, from the separate private `simmetric-enterprise` repo) is proprietary commercial — the community repo imports nothing from it; the only seam is the server's `require.resolve("@simmetric-chat/enterprise")` in `packages/server/src/services/enterpriseLoader.ts` (graceful Community-mode fallback when absent). The CLA above is what makes this dual-license model possible. CI's `license-policy-check` job enforces per-package dependency license allowlists, regenerates `THIRD_PARTY_NOTICES.md` / `docs/LICENSE_AUDIT.md` (fails on drift), and fails on stale references to the pre-AGPL permissive license in user-facing docs. New `packages/*/src/**` source files must keep the AGPL-3.0-or-later SPDX header (`node scripts/add-headers.cjs` is idempotent).

## PR Guidelines

- **Branch naming**: Use descriptive branch names prefixed with the change type. Examples: `feat/widget-embed`, `fix/auth-token-expiry`, `docs/api-update`. The current default branch is `main`; long-lived working branches may use prefixes like `docs/dev-guide`.
- **Commit messages**: Follow the conventional format `type(scope): description`. Common types: `feat`, `fix`, `test`, `refactor`, `ci`, `chore`, `docs`. Keep descriptions concise and in the imperative mood ("add" not "added"). Quick tasks use a `quick-<YYMMDD>-<id>` scope prefix.
- **Atomic commits**: One logical change per commit. Avoid mixing unrelated refactors with feature work.
- **Tests**: Add or update tests for any behavioral changes. Co-locate tests in `__tests__/` directories with `.test.ts` / `.test.tsx` suffix. Integration tests (real PostgreSQL) use `.integration.test.ts` and run via `pnpm --filter server test:integration`. CI (`ci.yml` `test-unit`) caps the community suite at 3404 top-level `__tests__/` declarations (15% over the v1.0 baseline of 2960) — keep it green and only add tests when the behavior demands it.
- **Version discipline**: `pnpm version:check` (run in CI's `lint-and-typecheck` job) fails if the root `package.json` major.minor drifts from the latest git tag (`vX.Y` scheme; patch differences are ignored by design). Root `package.json` tracks the latest 0.x tag — if `version:check` flags a mismatch, run `pnpm version:bump <tag-version>` to resync. Tags are minted by `.github/workflows/release.yml` on tag push.
- **Type safety**: All five packages enforce `strict: true`. Avoid `any` where possible (linted as `warn`); narrow with `err instanceof Error ? err.message : String(err)` in catch blocks. `as any` is used sparingly and only for third-party SDK interop (passport/SAML/SCIM strategies, backup providers, OCR SDKs) — avoid it in new code; prefer type-preserving helpers (e.g., `withSoftDelete(where)` from `packages/server/src/utils/prisma.ts`).
- **Migration safety**: If your PR includes Prisma schema changes, run `pnpm audit:migrations` and commit the updated `docs/MIGRATION_AUDIT.md` alongside your migration. Migrations MUST be additive-only (no `DROP TABLE` / `DROP COLUMN` / `DROP INDEX`); destructive migrations require explicit consent via the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` CI variable. See [MIGRATION_SAFETY.md](docs/MIGRATION_SAFETY.md) for the full policy.
- **i18n**: If you add user-facing strings, add keys for all 8 locales (`en`, `it`, `ru`, `de`, `es`, `fr`, `zh`, `pt`) — parity is strict, no locale may lag. Run `pnpm i18n:check` to validate key completeness (frontend + widget).
- **Don't commit secrets**: `.env`, `.env.local`, and `.env.*.local` are gitignored. Never stage env files, API keys, JWT secrets, or `LICENSE_KEY` values. (The license public key is NOT a secret — it ships in the source by design.)
- **Docs directory**: `docs/` is NOT gitignored (verified via `git check-ignore -v docs/` — no `docs` entry exists in `.gitignore`). New files under `docs/` use a normal `git add`; no `-f` flag is required.
- **Review process**: All PRs require CI to pass before merging. Request review from a maintainer for significant changes.

### Pre-PR Checklist

Run the following locally before opening a PR:

```bash
pnpm lint               # ESLint across all packages
pnpm typecheck          # TypeScript strict-mode checking across all packages
pnpm test               # Jest unit tests (all packages via Turborepo)
pnpm test:e2e           # Playwright E2E browser tests (if frontend/UI changed)
pnpm version:check      # Root package.json major.minor must match latest git tag (patch differences ignored)
pnpm changelog:check    # Add a CHANGELOG.md [Unreleased] entry if packages/*/src/** changed (excluding __tests__/ at any depth)
pnpm audit:migrations   # Audit Prisma migrations for destructive ops (if schema changed) — commit regenerated docs/MIGRATION_AUDIT.md in the same PR
pnpm i18n:check         # Validate i18n key completeness across all 8 locales (frontend + widget) (if strings changed)
pnpm license:check-self # Assert root + all 5 package license fields stay AGPL-3.0-or-later (CI license-policy-check also regenerates THIRD_PARTY_NOTICES.md / docs/LICENSE_AUDIT.md)
```

CI (`.github/workflows/ci.yml`) runs a job pipeline on every push to `main` and every PR: `lint-and-typecheck` (includes `version:check` and `changelog:check`), then `test-unit` (with an air-gap grep gate on `licenseService.ts`, an FTS locale grep gate, and a test-count cap of 3900), `test-airgap` (the unit suite re-run with `NETWORK_EGRESS_BLOCKED=1`), `migration-safety-check` (regenerates `docs/MIGRATION_AUDIT.md`, fails on drift, gates destructive migrations behind the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` repo variable — accepted values: `yes`, `1`, `true`), `license-policy-check` (per-package license allowlist via `scripts/license-policy-check.cjs` + regenerates `THIRD_PARTY_NOTICES.md` / `docs/LICENSE_AUDIT.md`, fails on drift, plus `pnpm license:check-self` and an old-license-reference gate on user-facing docs), `test-e2e` (Playwright against a `pgvector/pgvector:pg16` service), `build` (with a dist-freshness check), and `security` (gitleaks scan). `build` depends only on `lint-and-typecheck`, `test-unit`, `test-airgap`, `migration-safety-check`, and `license-policy-check` — `test-e2e` and `security` are not `build` dependencies.

## Documentation Guidelines

- **Screenshots in docs must use synthetic data only** — never real user data, real API keys, or real database contents. The 9 canonical docs currently contain no embedded screenshots; this is a forward-looking guideline for any screenshots added later.
- **Cross-links use relative paths** (`./DEVELOPMENT.md`, `../docs/DEVELOPMENT.md`), not absolute URLs, so the docs stay portable. See `docs/INDEX.md` for the hub-and-spoke cross-link model.
- **Command verification:** every shell command in fenced `bash`/`sh` blocks across the canonical docs is verified by `scripts/verify-doc-commands.cjs` (runnable in CI). Server/DB/Docker-dependent commands are skipped with a logged note; a denylist blocks `sudo`, `rm -rf`, `curl|sh`, etc. If you add a new command to a doc, ensure the verification script either runs it green or skips it with a documented note.

## Issue Reporting

Report bugs or request features via [GitHub Issues](https://github.com/simmetric-chat/simmetric-chat/issues).

For bug reports, include:

- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Environment details: Node.js version (`node --version`), pnpm version (`pnpm --version`), PostgreSQL version, browser (if frontend), and any relevant configuration

For feature requests, include:

- A clear description of the feature and the problem it solves
- Any relevant use cases or examples
- Whether the feature should be gated behind the Enterprise license (see [CONFIGURATION.md](docs/CONFIGURATION.md) for the full feature-flag list)

## Post-Publication Setup (maintainer)

These settings live on GitHub (repo/org settings), not in repo files. Run them once after `gh repo create simmetric-chat/simmetric-chat --public`. The repo's `.github/workflows/ci.yml` (gitleaks job) is the in-pipeline secret-scanning net; the settings below are the platform-level net.

### Secret scanning + push protection

Enabled by default on new public repos, but the command confirms/forces the state:

```bash
gh api -X PATCH repos/simmetric-chat/simmetric-chat \
  -F security_and_analysis[secret_scanning][status]=enabled \
  -F security_and_analysis[push_protection][status]=enabled
```

### Branch protection on `main`

Require PR reviews + the CI status checks:

```bash
gh api -X PUT repos/simmetric-chat/simmetric-chat/branches/main/protection \
  -f required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=lint-and-typecheck \
  -f required_status_checks[contexts][]=test-unit \
  -f required_status_checks[contexts][]=test-airgap \
  -f required_status_checks[contexts][]=migration-safety-check \
  -f required_status_checks[contexts][]=license-policy-check \
  -f required_status_checks[contexts][]=test-e2e \
  -f required_status_checks[contexts][]=build \
  -f required_status_checks[contexts][]=license-keygen \
  -f required_status_checks[contexts][]=security \
  -f enforce_admins=true \
  -f required_pull_request_reviews[required_approving_review_count]=1 \
  -f required_pull_request_reviews[dismiss_stale_reviews]=true
```

No additional contexts need adding — `license-policy-check`, `license-keygen`, and `migration-safety-check` are already in the list above (they are CI job names, not separate gates).

## License

By contributing, you agree that your contributions will be licensed under the project's license — **AGPL-3.0-or-later** for the community repo (see the [LICENSE](LICENSE) file) — with the dual-license grant described in the [CLA](CLA.md) covering the proprietary enterprise plugin. The enterprise plugin itself is NOT part of this repo and is never imported by community code.

---

## See also

- [Documentation index](docs/INDEX.md) — hub for all canonical dev docs
- [Getting Started](docs/GETTING_STARTED.md) — install, configure, first run
- [Development Guide](docs/DEVELOPMENT.md) — local development setup and build commands
- [Testing Guide](docs/TESTING.md) — test framework, commands, integration harness, E2E
- [Scaling Guide](docs/SCALING.md) — multi-instance deployment, Redis layer, pg-boss schedulers

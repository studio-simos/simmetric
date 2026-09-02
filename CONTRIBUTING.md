<!-- generated-by: gsd-doc-writer -->
# Contributing to Simmetric Chat

Thank you for contributing to Simmetric Chat — a local-first, privacy-first AI chat workspace with RAG, RBAC, and full air-gap capability. This document covers the conventions and process for contributing to the community repository.

## Contributor License Agreement

By submitting a pull request, you agree to the [Contributor License Agreement](CLA.md) (v1.0). The CLA protects the project's dual-license model (AGPL-3.0-or-later community + proprietary commercial enterprise plugin) by ensuring the maintainer has the rights to distribute contributions under both licenses.

Include this line in your first PR description:

```
I have read and agree to the Simmetric Chat Contributor License Agreement (v1.0).
```

## Development Setup

See [GETTING_STARTED.md](docs/GETTING_STARTED.md) for prerequisites and first-run instructions, and [DEVELOPMENT.md](docs/DEVELOPMENT.md) for local development setup (build commands, environment configuration, code style).

Quick reference:

- **Prerequisites**: Node.js `>=24.0.0`, pnpm `11.24.0` (pinned via `packageManager` in the root `package.json`), PostgreSQL 16.
- **Install**: `pnpm install` from the repo root. pnpm strictness enforces no phantom dependencies — every import must be declared in the consuming package's `package.json`.
- **Environment**: copy the root `.env.example` to `.env` (gitignored, never commit it). The root `.env` is the single runtime config — per-package `.env` files are not read.
- **Database**: `pnpm db:generate`, then `pnpm db:migrate` and `pnpm db:seed` for a fresh local DB.
- **Run**: `pnpm dev` starts all services (server `:3000`, frontend `:5173`, collector `:3210`, widget `:3211`).
- **Scoped commands**: use `pnpm --filter <pkg> <script>` to run a command in one package (e.g., `pnpm --filter server test`).
- **Read the package AGENTS.md first**: each package has its own `AGENTS.md` (root, `packages/server`, `packages/frontend`, `packages/collector`, `packages/widget`, `packages/shared`) with package-specific conventions.

## Coding Standards

- **Linting**: ESLint 10 with flat config (`eslint.config.mjs`) and `typescript-eslint`. Run `pnpm lint` across all packages. Several rules are intentionally `warn` with debt documented inline in the config — do not "fix" them as drive-by changes.
- **Type checking**: TypeScript strict mode in all five packages; run `pnpm typecheck`. Avoid `any` where possible; narrow errors with `err instanceof Error ? err.message : String(err)` in catch blocks.
- **Formatting**: No Prettier or Biome — ESLint and TypeScript strict mode enforce style. Respect each package's `tsconfig.json` `module` setting (frontend and root are ESM; server, collector, shared, widget are CommonJS).
- **License headers**: source files under `packages/*/src/**` carry the AGPL-3.0-or-later SPDX header. When you create new files, run `node scripts/add-headers.cjs` (idempotent). Never remove or rewrite existing headers.
- **CI enforcement**: `.github/workflows/ci.yml` runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the rest of the pipeline on every push and pull request. All checks must pass before a PR can be merged.

## Branch and Commit Conventions

- **Default branch**: `main`.
- **Branch naming**: descriptive names prefixed with the change type — e.g., `feat/widget-embed`, `fix/auth-token-expiry`, `docs/api-update`.
- **Commit messages**: conventional format `type(scope): description`. Common types: `feat`, `fix`, `test`, `refactor`, `ci`, `chore`, `docs`. Keep descriptions concise and in the imperative mood ("add" not "added").
- **Atomic commits**: one logical change per commit; avoid mixing unrelated refactors with feature work.

## PR Guidelines

- **Fork/branch** from `main` using the branch naming above; keep PRs focused on a single change.
- **Tests**: add or update tests for any behavioral change. Unit tests are co-located in `__tests__/` with `.test.ts` / `.test.tsx` suffixes; real-PostgreSQL integration tests use `.integration.test.ts` (`pnpm --filter server test:integration`).
- **Migration safety**: if your PR includes Prisma schema changes, migrations MUST be additive-only (no `DROP TABLE` / `DROP COLUMN` / `DROP INDEX`). Run `pnpm audit:migrations` and commit the regenerated `docs/MIGRATION_AUDIT.md` in the same PR — CI fails on drift. Destructive migrations require explicit consent via the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` CI variable. See [MIGRATION_SAFETY.md](docs/MIGRATION_SAFETY.md).
- **i18n**: if you add user-facing strings, add keys for all 8 locales (`en`, `it`, `ru`, `de`, `es`, `fr`, `zh`, `pt`) — parity is strict, no locale may lag. Run `pnpm i18n:check` to validate key completeness across the frontend and widget.
- **Version discipline**: `pnpm version:check` fails if the root `package.json` major.minor drifts from the latest git tag; resync with `pnpm version:bump <tag-version>` if flagged.
- **Changelog**: if your PR touches `packages/*/src/**` (excluding `__tests__/` at any depth), add a `[Unreleased]` entry to `CHANGELOG.md` — `pnpm changelog:check` fails otherwise.
- **No secrets**: never stage `.env` files, API keys, JWT secrets, or `LICENSE_KEY` values. (The license public key is not a secret — it ships in source by design.)
- **Docs**: files under `docs/` are tracked normally (`git add docs/...`; no `-f` flag needed). Screenshots in docs must use synthetic data only.
- **Enterprise IP boundary**: the enterprise package (`simmetric-enterprise/`) is a SEPARATE private repository. The community repo imports NOTHING from it — the only seam is the server's `require.resolve("@simmetric-chat/enterprise")` in `packages/server/src/services/enterpriseLoader.ts` (graceful Community-mode fallback when absent). Never add a direct import from community code to enterprise code.
- **Review**: all PRs require CI to pass; request review from a maintainer for significant changes.

### Pre-PR Checklist

Run locally before opening a PR:

```bash
pnpm lint               # ESLint across all packages
pnpm typecheck          # TypeScript strict-mode checking across all packages
pnpm test               # Jest unit tests (all packages via Turborepo)
pnpm test:e2e           # Playwright E2E browser tests (if frontend/UI changed)
pnpm version:check      # Root package.json major.minor matches latest git tag
pnpm changelog:check    # CHANGELOG.md [Unreleased] entry present (if packages/*/src/** changed)
pnpm audit:migrations   # Migration audit (if schema changed) — commit docs/MIGRATION_AUDIT.md in the same PR
pnpm i18n:check         # i18n key parity across all 8 locales (if strings changed)
pnpm license:check-self # Assert root + all 5 package license fields stay AGPL-3.0-or-later
```

CI (`.github/workflows/ci.yml`) runs the following jobs on every push to `main` and every PR: `lint-and-typecheck` (includes `version:check` and `changelog:check`), `test-unit`, `test-airgap` (the unit suite re-run with `NETWORK_EGRESS_BLOCKED=1`), `migration-safety-check`, `license-policy-check` (per-package license allowlists; regenerates `THIRD_PARTY_NOTICES.md` / `docs/LICENSE_AUDIT.md` and fails on drift), `test-e2e` (Playwright against a `pgvector/pgvector:pg16` service), `build`, and `security` (gitleaks scan).

## Issue Reporting

Report bugs and request features via [GitHub Issues](https://github.com/simmetric-chat/simmetric-chat/issues).

For bug reports, include:

- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Environment details: Node.js version (`node --version`), pnpm version (`pnpm --version`), PostgreSQL version, browser (if frontend), and any relevant configuration

For feature requests, include:

- A clear description of the feature and the problem it solves
- Any relevant use cases or examples
- Whether the feature should be gated behind the Enterprise license (see [CONFIGURATION.md](docs/CONFIGURATION.md) for the feature-flag list)

## Security Issues

**Do NOT open a public GitHub issue for security vulnerabilities.** Report vulnerabilities privately via GitHub Security Advisories (the **Security** tab of this repository → **Report a vulnerability**). See [SECURITY.md](SECURITY.md) for the full policy, response timelines, and scope.

## License

By contributing, you agree that your contributions will be licensed under **AGPL-3.0-or-later** (see the [LICENSE](LICENSE) file), with the dual-license grant described in the [CLA](CLA.md) covering the proprietary enterprise plugin. The enterprise plugin itself is not part of this repo and is never imported by community code.

---

## See also

- [Documentation index](docs/INDEX.md) — hub for all canonical dev docs
- [Getting Started](docs/GETTING_STARTED.md) — install, configure, first run
- [Development Guide](docs/DEVELOPMENT.md) — local development setup and build commands
- [Testing Guide](docs/TESTING.md) — test framework, commands, integration harness, E2E
- [Scaling Guide](docs/SCALING.md) — multi-instance deployment, Redis layer, pg-boss schedulers
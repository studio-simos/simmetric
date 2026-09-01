# Enterprise Plugin

This document describes the Simmetric Chat enterprise plugin architecture: the plugin model, the `PluginContext` contract, the extraction history (Phases 140–147), the air-gap install runbook, the tarball delivery model, and the license JWT shape.

The enterprise package is a **separate private repo** (`simmetric-enterprise/`) — it is NOT a community dependency. The community repo loads it at boot via `require.resolve("@simmetric-chat/enterprise")` (the only seam). When the package is absent, the server runs in community mode (graceful degradation). When present but broken, the server fails LOUD (`process.exit(1)` — never silently degrade a paying customer).

## 1. The plugin model

The enterprise package (`@simmetric-chat/enterprise`) is shipped as a private, source-isolated package separate from the community monorepo for three reasons:

- **IP isolation** — enterprise source code lives in a private repo; the community repo never imports it. The community repo's only reference to the enterprise package is `require.resolve("@simmetric-chat/enterprise")` in `packages/server/src/services/enterpriseLoader.ts`. This keeps enterprise IP out of the public/community distribution.
- **Air-gap compatibility** — the enterprise package is delivered as a tarball (no `npm install`, no phone-home). The customer extracts it into the server's `node_modules`. See § Air-gap install runbook below.
- **Single-package contract** — exactly one enterprise package is supported. There is no plugin marketplace, no competing enterprise plugins, and no third-party plugin loading (all deferred per `REQUIREMENTS.md`). The `PluginContext` contract (`packages/shared/src/schemas/plugin.schema.ts`) is the single integration surface.

The enterprise package provides four feature areas, each extracted from community code in its own phase:

- **SSO** (SAML + OIDC + SCIM 2.0) — 
- **Audit log** (immutable `event_logs` table + insert-only DB role) — 
- **White-label branding** (config-key validator pattern) — 
- **Backup** (destinations + scheduler + local/S3 providers) — 

The enterprise package imports ONLY `@simmetric-chat/shared` (Zod schemas, constants, types). It never imports from `packages/server`, `packages/frontend`, `packages/collector`, or `packages/widget`. Core-owned capabilities (auth, crypto) are delegated to the plugin via `ctx.generateToken`, `ctx.encrypt`, and `ctx.decrypt` (see § PluginContext contract).

## 2. The PluginContext contract

The `PluginContext` interface is defined in `packages/shared/src/schemas/plugin.schema.ts` (a shared-kernel file — zero runtime deps beyond `zod`). The loader (`packages/server/src/services/enterpriseLoader.ts`) constructs a `ctx` object implementing this interface and passes it to `plugin.register(ctx)` at boot.

| Property / method | Signature | Purpose |
|-------------------|-----------|---------|
| `app` | `MinimalExpressApp` | Structural subset of `express.Express` — mount routers via `mountProtected`/`mountPublic`. The enterprise package casts to the full `Express` type at its own boundary. |
| `prisma` | `MinimalPrismaClient` | Structural subset of `@prisma/client`'s `PrismaClient` — avoids importing Prisma into the shared kernel. The real singleton (from `packages/server/src/utils/prisma.ts`) is cast through `unknown` to satisfy the index signature. Never `new PrismaClient()`. |
| `logger` | `MinimalLogger` | Server winston logger shape — `info`, `warn`, `error`, `debug` with optional meta object. Mirrors `packages/server/src/utils/logger.ts`. |
| `env` | `Record<string, unknown>` | Parsed + validated env config from `getEnv()` (Zod-validated in `packages/server/src/config/env.ts`). Env vars override DB settings on boot. |
| `licenseInfo` | `LicenseInfo` | Resolved license info (Community or Enterprise) — read at boot, reflects the current tier. The enterprise plugin loads AFTER `initLicense()` so this reflects the validated JWT. |
| `mountProtected` | `(router) => void` \| `(path, router) => void` | Mount router at `/api/enterprise` (default, backward-compatible with health route) or explicit `path`. The loader applies the community `authMiddleware` BEFORE the plugin's router — core owns auth, plugin owns the handler. Missing `Authorization` → 401. |
| `mountPublic` | `(router) => void` \| `(path, router) => void` | Mount router WITHOUT `authMiddleware` — for IdP-initiated callbacks (`/api/auth` SAML/OIDC) + SCIM (`/scim/v2`, applies its own `scimAuth` Bearer token). Default path standardized to `/api/enterprise` ( Finding 1 fix). |
| `registerScheduler` | `(name, {start, stop}) => void` | `start()` called immediately at boot (after `prisma.$connect`); `stop()` called during graceful shutdown (5s per-teardown cap via `Promise.race`). |
| `onShutdown` | `(fn) => void` | Teardown callback invoked during graceful shutdown BEFORE `prisma.$disconnect()` (5s per-callback cap). |
| `registerAuditLogWriter` | `(fn: (event) => Promise<void>) => void` | : injects the enterprise audit writer into the community `logEvent()` shim. The shim holds a module-level delegate set by this hook — it never imports the enterprise package. Same IoC shape as `mountProtected`. |
| `registerConfigKeyValidator` | `(fn: ConfigKeyValidator) => void` | : injects a config-key validator into the community `updateSettings()` loop (e.g. the branding validator rejects non-Enterprise `BRANDING_*` keys). Same IoC pattern as `registerAuditLogWriter`. |
| `auditLog` | `AuditLog` | : typed `AuditLog` contract for enterprise-internal routes (the `eventLogs.ts` reader). Set by `register(ctx)`; placeholder (`undefined as unknown as AuditLog`) until then. The community `logEvent()` shim does NOT use this — it delegates via `registerAuditLogWriter`. |
| `overrideFeatureLimit` | `(flag: string, value: number) => void` | : real resolver — raises a numeric limit (e.g. `max_workspaces` to `Infinity`). Forwards to `licenseService.setLimitOverride`. Reactive revocation: `clearLimitOverrides()` runs at the START of `initLicense()` and in `getLicenseInfo()`'s runtime-expiry branch, so a Community JWT loaded after an Enterprise one cannot inherit `Infinity` overrides. |
| `generateToken` | `(userId: string) => string` | : core-owned auth delegated — issue a JWT for a user. SSO callback routes need this after a successful IdP callback (the enterprise package cannot import the community `authService`). Uses `require()` to avoid circular-import risk. |
| `encrypt` | `(plaintext: string) => string` | : AES-256-GCM encryption (core-owned crypto delegated). The enterprise `saveSsoConfig` encrypts the client secret before storage via `ctx.encrypt` — same crypto as the community (`packages/server/src/services/encryptionService.ts`, T-113-01-01). |
| `decrypt` | `(ciphertext: string) => string` | : AES-256-GCM decryption (core-owned crypto delegated). Enterprise SSO routes/services decrypt `SsoConfig.clientSecretEncrypted` before sending it to the IdP via `ctx.decrypt`. |

The contract also defines `EnterprisePlugin` (the default export shape the enterprise package must export): `apiVersion: 1` (literal — the loader rejects mismatches with `process.exit(1)`, D-03), optional `name`/`version`, and `register(ctx): void | Promise<void>`.

## 3. Extraction history

The enterprise plugin architecture was built across 8 phases (the v1.1 milestone). One paragraph per phase:

- ** (EPA-01)** — Established the plugin architecture: the `PluginContext` contract , the `EnterprisePlugin` interface, the `API_VERSION = 1` runtime check , the two-step `require.resolve` → `require` loader (D-05 — never collapse, that's fail-open), the community no-op path (D-06 — info-level "Community build"), and the fail-loud register-throws policy (D-07 — `process.exit(1)`, never silently degrade). `overrideFeatureLimit` shipped as a throwing stub ("not wired until ").
- **** — The migration verdict: the community repo is the canonical migration record. The enterprise migrations are tracked as rows in `docs/MIGRATION_AUDIT.md`'s flat per-migration table (the audit report was aligned in SC-4 per this verdict; the file has no section headers — enterprise migrations are listed alongside community ones, identifiable by their `enterprise_` name prefix).
- **** — Added the `/api/enterprise` health route. The `mountProtected`/`mountPublic` shims hardcoded `/api/enterprise` as the single prefix (this became the Finding 1 bug in — SSO routes needed their original paths).
- ** (EPA-03 — SSO extraction)** — Extracted SAML + OIDC + SCIM into the enterprise package. Finding 1: the hardcoded `/api/enterprise` prefix broke SSO callback URLs (`/api/sso/*`, `/api/auth/*`, `/scim/v2/*`) — fixed by adding the path-arg overload to `mountProtected`/`mountPublic`. Added `ctx.generateToken`, `ctx.encrypt`, `ctx.decrypt` (core-owned auth/crypto delegated — the enterprise package can only import `@simmetric-chat/shared`).
- ** (EPA-04 — audit log extraction)** — Extracted the audit log into the enterprise package. Replaced the `auditLog(event: unknown)` throwing stub with the typed `AuditLog` contract + the `registerAuditLogWriter(fn)` IoC hook — the community `logEvent()` shim holds a module-level delegate set by this hook and never imports the enterprise package. The enterprise audit writer uses the `simmetric_audit_writer` DB role with INSERT-only grants.
- ** (EPA-05 — white-label extraction)** — Extracted white-label branding config. Added `registerConfigKeyValidator(fn)` — the branding validator rejects non-Enterprise `BRANDING_*` keys via the community `updateSettings()` loop. Same IoC pattern as `registerAuditLogWriter` ( D-11). Pitfall 1: alias import (`addConfigKeyValidator`) to avoid the name collision between the `ctx.registerConfigKeyValidator` method and the community `registerConfigKeyValidator` export.
- ** (EPA-06 — backup extraction)** — Extracted backup destinations + scheduler + local/S3 providers. Added the 5s per-teardown `Promise.race` cap in `shutdownEnterprisePlugin` (D-03 — SC-2) so one hanging teardown cannot consume the whole 5s outer shutdown budget. Originally added the `GSD_TEST_MOCK_PLUGIN` env var for subprocess-aware test mocking (Open Question 4); that production-code seam was removed in the dead-code sweep (PUB-02) in favor of a `tsx -r` bootstrap fixture that overrides `__pluginResolver` in the child process.
- ** (EPA-07 — license override + frontend conditional loading)** — Replaced the `overrideFeatureLimit` throwing stub with the real resolver — forwards to `licenseService.setLimitOverride`. Reactive revocation: `clearLimitOverrides()` runs at the START of `initLicense()` (D-02 — Pitfall 3) and in `getLicenseInfo()`'s runtime-expiry branch (SC-1), so a Community JWT loaded after an Enterprise one cannot inherit `Infinity` overrides. Frontend conditional loading: the frontend reads `licenseInfo.tier` and hides enterprise-only UI when Community. Signature byte-identical to D-02 — no shared version bump .
- ** (EPA-12 — tests/docs/env alignment)** — The v1.1 ship gate: plugin auth boundary test (SC-1 — every `mountProtected` route returns 401 without `Authorization`), air-gap CI profile (SC-2 — grep gate on `packages/server/src/services/licenseService.ts` for HTTP-call primitives), plugin absent/present test matrix (SC-3 — community suite green with plugin absent, ≤15% test-count growth cap), this docs/env alignment (SC-4), and the `custom_agents` verdict (SC-5 — numeric limit, config-only).

## 4. Air-gap install runbook

The enterprise package is delivered as a tarball — no npm install, no phone-home, no telemetry. Step-by-step:

1. **Build the enterprise package** (on the vendor side or a build host):
```bash
cd simmetric-enterprise
pnpm build # produces dist/
```

2. **Create the tarball**:
```bash
tar czf enterprise.tgz -C dist .
```
This captures the compiled JS + any assets in `dist/` (the enterprise Prisma schema is not in the tarball — it lives in the community repo at `packages/server/prisma/schema-enterprise.prisma`).

3. **Transfer the tarball to the customer server** (USB, scp, signed artifact — air-gap means no `npm install`).

4. **Extract into the server's `node_modules`**:
```bash
mkdir -p packages/server/node_modules/@simmetric-chat/enterprise/
tar xzf enterprise.tgz -C packages/server/node_modules/@simmetric-chat/enterprise/
```
The loader's `require.resolve("@simmetric-chat/enterprise")` finds the package here. No `npm install` needed — the `require.resolve` walks `node_modules` and resolves the `package.json` `main`/`exports` field.

5. **Set `LICENSE_KEY` in the root `.env`**:
```bash
LICENSE_KEY=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.... # the RS256 JWT
```
The license service validates the JWT against the public key embedded in `packages/server/src/services/license-public-key.ts`. No outbound HTTP — the public key is in the server source, the JWT carries all feature flags.

6. **Restart the server**:
```bash
pnpm --filter server start
# or, in Docker: docker compose restart server
```
On boot: `prisma.$connect()` → `initLicense()` (validates the JWT, builds `tierFeatures`) → `loadEnterprisePlugin(app)` (calls `register(ctx)` which mounts routes, registers schedulers, calls `overrideFeatureLimit`) → routes live.

7. **Verify**:
```bash
curl -H "Authorization: Bearer <admin-jwt>" \
http://localhost:3000/api/enterprise/modules
```
Expected: `200 OK` with a JSON manifest of the enterprise modules (SSO, audit log, branding, backup). A `404` means the plugin didn't load (check `packages/server/node_modules/@simmetric-chat/enterprise/`); a `402` means the license JWT is missing/invalid/expired.

### Boot error: Cannot find module './env.schema'

**Symptom** — the server crash-loops at boot right after license init: the loader's fail-loud policy (§1, `process.exit(1)` on register failure) turns one plugin error into a restart loop. The Docker log shows:

```
[enterprise] Plugin registration failed
{"error":"Cannot find module './env.schema'" ...
"requireStack":[…/@simmetric-chat/shared/dist/schemas/index.js]}
```

The throw originates in shared's `schemas/index.js` re-export, invoked inside the enterprise plugin's `register(ctx)`.

**Cause** — the enterprise repo installs `@simmetric-chat/shared` via `file:../simmetric-chat/packages/shared`; pnpm snapshots `file:` packages into `node_modules/.pnpm` and hardlinks only files that already exist, so files **created** in shared after the last `pnpm install` never reach the snapshot. When a community phase adds a new schema file (e.g. the `env.schema.ts` + its `schemas/index` re-export added in ), the snapshot's (hardlinked, updated) `index.js` now requires a module that does not exist on the enterprise side.

**Fix** — refresh the stale snapshot, then rebuild against it:

```bash
cd simmetric-enterprise && pnpm install && pnpm build
```

`pnpm install` re-snapshots the `file:` package (picking up new dist files); `pnpm build` then rebuilds enterprise against the refreshed snapshot. See the enterprise repo's `README.md` ("### 1. Rebuild `@simmetric-chat/shared`") for the full runbook note.

**Check** — the one-liner below must succeed before restarting the server container:

```bash
node -e "require('./node_modules/@simmetric-chat/shared/dist/schemas/index.js')"
```

### Docker volume mount (optional sidecar pattern)

For Docker deployments, the enterprise tarball can be mounted as a read-only volume instead of baked into the image. In `docker/docker-compose.yml`, the `server` service has an active read-only volume mount of the sibling repo:

```yaml
# ─── Enterprise plugin (optional — air-gap tarball delivery) ───
# Extract the enterprise tarball to ./simmetric-enterprise/dist/ on the host,
# then uncomment to mount it into the server container. The loader's
# require.resolve("@simmetric-chat/enterprise") finds it here at boot.
- ../../simmetric-enterprise:/simmetric-enterprise:ro
```

The mount is already active — restart the server container to pick up changes to the enterprise package. The `:ro` flag ensures the container cannot modify the enterprise package (defense in depth).

## 5. Tarball delivery model

The enterprise package is shipped as a tarball — NOT via `npm install`. The customer extracts it directly into the server's `node_modules`:

```
packages/server/node_modules/@simmetric-chat/enterprise/
├── package.json # name: @simmetric-chat/enterprise, main: dist/index.js
├── dist/
│ ├── index.js # the register(ctx) entry
│ ├── services/
│ ├── routes/
│ └── middleware/
└── ...
```

Why tarball (not npm):

- **Air-gap** — customer environments may have no outbound network. `npm install` would fail; the tarball is carried in via USB/scp/signed artifact.
- **IP isolation** — the enterprise package is private. It is NOT published to the public npm registry. The tarball is delivered directly to paying customers.
- **No phone-home** — the license service is read-only + local-validation only. The JWT carries all feature flags; the public key is embedded in `packages/server/src/services/license-public-key.ts`. There is NO outbound HTTP from the license subsystem (verified by the `airgap-grep` CI gate, SC-2 — `rg 'fetch\(|axios|got\(|request\(|http\.get|http\.request|https\.get|https\.request|undici' packages/server/src/services/licenseService.ts` returns zero matches).
- **No telemetry** — the enterprise package does not emit usage data. `DISABLE_TELEMETRY=true` is the default in `.env.example`.

## 6. License JWT shape

The `LICENSE_KEY` env var carries an **RS256 JWT** issued by the vendor's private key. The customer's server validates it against the public key embedded in `packages/server/src/services/license-public-key.ts` — no secret env config needed on the customer side.

### Properties

- **Algorithm:** RS256 (RSA signature with SHA-256). The vendor signs with the private key; the customer's server verifies with the embedded public key.
- **Additive-only flags:** new feature flags can be added to the JWT payload without breaking old JWTs. The `tierFeatures` check uses `key in tierFeatures` — unknown flags are ignored, so an old JWT loaded against a newer server simply lacks the new flags (the server falls back to the community default for unknown flags). This means a customer does NOT need a new JWT when the vendor adds a flag the customer's tier doesn't entitle.
- **No outbound HTTP:** the license service is read-only + local-validation only. The JWT is verified entirely in-process against the embedded public key. There is no license-server phone-home, no revocation API, no telemetry. This is verified by the `airgap-grep` CI gate ( SC-2).
- **Runtime expiry:** `getLicenseInfo()` checks `exp` on every read. If the JWT has expired at runtime, `clearLimitOverrides()` runs (so `Infinity` overrides from the expired Enterprise tier are revoked) and the server falls back to Community tier. A restart with a fresh JWT restores Enterprise.
- **Reactive revocation:** `clearLimitOverrides()` runs at the START of `initLicense()` ( D-02 — Pitfall 3) and in `getLicenseInfo()`'s runtime-expiry branch ( SC-1). This prevents a Community JWT loaded after an Enterprise one from inheriting `Infinity` overrides (e.g. a downgrade from Enterprise to Community must not leave `max_workspaces = Infinity` in effect).

### Verifying the license

```bash
pnpm license:check
# exit 0 = entitled (Enterprise) or Community (no JWT)
# exit 1 = token invalid (bad signature, wrong alg, malformed)
# exit 2 = env error (LICENSE_KEY set but unparseable)
```

The `licenseService.initLicense()` runs at boot (before `loadEnterprisePlugin`) and builds the `tierFeatures` map from the JWT payload. If `LICENSE_KEY` is unset or the JWT is invalid/expired, the server runs in Community tier (graceful degradation — the enterprise plugin still loads if present, but `overrideFeatureLimit` is a no-op against Community defaults and enterprise routes return 402 for tier-gated features).

## See also

- [INDEX.md](INDEX.md) — documentation hub
- [CONFIGURATION.md](CONFIGURATION.md) — full environment variable reference (including `LICENSE_KEY`)
- [DEPLOYMENT.md](DEPLOYMENT.md) — Docker deployment + air-gap notes
- [MIGRATION_AUDIT.md](MIGRATION_AUDIT.md) — the 4 additive enterprise migrations, listed as rows in the flat per-migration table (no section headers; identifiable by the `enterprise_` name prefix)
- `packages/shared/src/schemas/plugin.schema.ts` — the `PluginContext` type (canonical contract)
- `packages/server/src/services/enterpriseLoader.ts` — the loader + `ctx` implementation
- `packages/server/src/services/licenseService.ts` — `initLicense()`, `getFeatureLimit()`, `getLicenseInfo()`, `setLimitOverride()`, `clearLimitOverrides()`
- `AGENTS.md` § Enterprise plugin — the short-form developer reference
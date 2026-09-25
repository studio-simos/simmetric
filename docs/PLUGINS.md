# Plugins

Simmetric Chat supports two plugin kinds with two install paths:

- **Native plugins** (enterprise + SaaS): resolved from the node module graph at boot — see [docs/ENTERPRISE_PLUGIN.md](ENTERPRISE_PLUGIN.md) for the air-gap install runbook. This file's "Plugin manager path" section is the managed alternative.
- **Managed plugins** (any third-party CJS package): uploaded as a `.zip` through the **Plugin manager** admin UI (`/plugins`, `plugins:manage` permission), stored under `storage/plugins/<slug>`, and loaded fail-soft at boot by the managed loader.

## 1. The plugin contract

A managed plugin is a CommonJS package whose entry module exports the plugin as the default export:

```js
// index.js
module.exports.default = {
  apiVersion: 1,              // or 2
  register(ctx) { /* mount routes, schedulers, hooks */ },
  licenseMode: "none",        // "none" | "platform" | "self" (see §3)
};
```

- **`apiVersion`** — `1` or `2` (the managed loader accepts both). A mismatched version is rejected at install (probe) and at load.
- **`register(ctx)`** — the same `PluginContext` the native plugins receive (see [docs/ENTERPRISE_PLUGIN.md §2](ENTERPRISE_PLUGIN.md)): `mountProtected` / `mountPublic` (Express routers), `registerScheduler` (pg-boss/interval jobs with a 5s-per-teardown shutdown cap), `onShutdown` callbacks, `overrideFeatureLimit` (enterprise numeric limits). The context is built by the shared `buildPluginContext` factory — managed and native plugins see the same surface.
- **Install probe** — the installer requires the entry module **without calling `register`** (capture `apiVersion` / register-presence / `licenseMode` only). Trust boundary (explicit): the probe DOES execute the module's top-level code — the admin upload is the trust boundary, there is no sandbox in v1. Only upload plugins you control.

## 2. Packaging

Zip layout:

```
package.json     { "name": "@scope/pkg", "main": "index.js", "version": "1.0.0" }
index.js         the CJS entry exporting { default: { apiVersion, register, licenseMode } }
node_modules/…   ALL dependencies, bundled
```

- **Deps are bundled** — there is NO `npm install` at install time (spec §3.3). Everything the plugin requires must be inside the archive, **including `@simmetric-chat/shared`** if the plugin imports shared schemas/types (the plugin's `createRequire` resolves against its own package root, so shared must ship in its own `node_modules`).
- `package.json` `name` must be a valid npm name (lowercase, optional `@scope/`) — it IS the security input: the npm-name validation runs BEFORE slug derivation, and the derived slug (`/` → `+`) is containment-checked against `storage/plugins`.
- Max upload size: **100 MB** (enforced client-side and by the server's multer cap).
- Entry name guard: raw archive entry names are checked for traversal (`../`), absolute paths, NUL bytes, symlinks and duplicates BEFORE extraction — malformed archives are rejected with no filesystem or database residue.
- Re-installing the same slug (different version) is a **replace-swap**: the old directory is swapped out atomically and removed only after the new row is durable; a failed upgrade restores the previous version.

## 3. License modes (D6)

| `licenseMode` | Meaning |
|---------------|---------|
| `none` (default) | **Zero license UI, zero license gate.** Third-party plugins install and run without any JWT. The UI renders no license affordance; the loader never consults the license service. |
| `platform` | The plugin is gated on a Simmetric **platform license**. Paste an RS256 license JWT (issued for the plugin's exact package name) in the PluginPage license modal; it is RS256-verified (alg-restricted, expiry-checked, package-claim match), stored **AES-256-GCM encrypted at rest**, and re-checked at every load. An unlicensed platform row stays `installed` — it never loads. |
| `self` | The plugin carries its own licensing internally. The UI shows only an informational "Self-licensed" badge; the platform verifies nothing. |

License keys are issued by the Simmetric license tooling (see [docs/ENTERPRISE_PLUGIN.md §6](ENTERPRISE_PLUGIN.md) for the JWT shape — the per-plugin variant adds a `plugin` claim bound to the package name).

## 4. Both install paths

### Native path (unchanged)

Enterprise/SaaS plugins built into the deployment resolve through `require.resolve` at boot — the native loaders keep the historical fail-loud behavior (`process.exit(1)` on a broken install; a paying customer's missing features must never fail silently). Install via the air-gap tarball runbook in [docs/ENTERPRISE_PLUGIN.md §4](ENTERPRISE_PLUGIN.md).

### Plugin manager path (managed)

1. Open **Plugins** (`/plugins`) as an admin with the `plugins:manage` permission (the 40th permission; admins auto-gain it).
2. Drop a `.zip` on the dropzone (or click to browse). The install runs the six-step pipeline: parse → entry-guard matrix → staged extraction → package-name validation → probe (no register) → atomic install + DB row.
3. For `licenseMode: "platform"` plugins, open the card menu → **Manage license** → paste the JWT → **Verify** (probe-only) → **Save**.
4. **Enable** the plugin with the card switch. The toggle takes effect only after a restart (the amber "Restart required" chip and the toast copy both say so).
5. **Disable** before **Uninstall** (the route contract: enabled rows are refused with 409).
6. Restart the server (§4 runbook below) — the managed loader loads enabled rows fail-soft: a register throw records `status=failed` + `lastError` and **boot continues** (a broken third-party plugin can never kill the server; the native loaders above keep `process.exit(1)`).

Native-wins rule: a plugin installed natively (resolvable through `require.resolve`) shadows a managed install of the same slug — the managed row is stored but ignored for loading.

## 4. Restart / supervisor runbook

Plugin loads happen at boot, so the effect of install/enable/disable/uninstall lands on the next server restart.

- **Docker** (`restart: unless-stopped`): `docker compose restart server` — the container restarts itself.
- **Coolify**: the platform respawns the service automatically after a graceful shutdown.
- **Tauri desktop app**: ⚠ **the Tauri release build does NOT respawn the server sidecar** (single spawn, no restart policy in `src-tauri/src/lib.rs`). After plugin changes, **restart the desktop application itself**. The UI's restart button derives its mode from the server (`restartMode: supervisor` in production, `manual` otherwise) — on a Tauri deployment the server reports `supervisor` but the sidecar stays dead until the app relaunches; plan for the app restart.
- **Dev mode** (`tsx watch`): the UI shows the dev-mode warning and never calls the restart route — restart the dev process yourself.

## 5. Operations notes

- Managed plugin directories live under `storage/plugins/` — include the server-storage volume in your backup/restore strategy (the same volume holds branding, uploads, and encryption keys; see [docs/DEPLOYMENT.md](DEPLOYMENT.md)).
- The server sweeps orphan `.tmp-*` staging dirs (>10 min old) at boot — an interrupted install self-heals.
- The plugin list (`GET /api/plugins`) merges managed rows with a read-only probe of the native plugins (enterprise/SaaS presence detection — probe-only, never loads).
- Plugin lifecycle events are logged with closed-enum license reasons (`verified | invalid | expired | missing | plugin_mismatch`) — license key material never appears in logs or API responses.
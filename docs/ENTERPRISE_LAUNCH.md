# Launching Simmetric Chat with the Enterprise Plugin

Two ways to run with Enterprise enabled: **pnpm (local/dev)** and **Docker (compose)**.
Both need (1) the enterprise package built and reachable, and (2) a valid RS256 `LICENSE_KEY`.

## Prerequisites

| Item | Where | Notes |
|------|-------|-------|
| Enterprise repo | `../simmetric-enterprise/` (sibling of this repo) | Private repo, IP-isolated |
| License tool | `../simmetric-license-tool/` | Mints RS256 JWTs with the private key |
| Private key | `../simmetric-license-tool/keys/license-private.pem` | The ONLY key that verifies against the embedded public key (`packages/server/src/services/license-public-key.ts`) |
| Workspace link | `pnpm-workspace.yaml` → `'@simmetric-chat/enterprise': link:../simmetric-enterprise` | Already in place |

> **License gotcha:** the server verifies with `algorithms: ["RS256"]` against the embedded public key.
> A JWT signed with any other key (or the old HS256 scheme) fails with `bad-signature` and the server
> silently falls back to Community. Always mint with `keys/license-private.pem`.

## 1. Build the enterprise package (both paths)

```bash
cd ../simmetric-enterprise
pnpm build          # produces dist/ (index.js + routes/services/middleware)
cd ../simmetric-chat
```

## 2. Mint a license (both paths)

```bash
cd ../simmetric-license-tool
npx tsx src/generate-license.ts \
  --org "Your Org" \
  --duration 365 \
  --private-key ./keys/license-private.pem \
  --output env-file        # writes .env.license with LICENSE_KEY=<JWT>
cd ../simmetric-chat
```

Verify it locally before launching:

```bash
cd ../simmetric-license-tool
npx tsx src/verify-license.ts --token "$(grep -o 'LICENSE_KEY=.*' .env.license | cut -d= -f2)" \
  --public-key ./keys/license-public.pem
# → VALID
```

---

## Option A — pnpm (local dev)

### 3A. Set the license

Append the minted key to the server env (gitignored):

```bash
grep '^LICENSE_KEY=' ../simmetric-license-tool/.env.license >> packages/server/.env
```

### 4A. Install and launch

```bash
pnpm install                 # refreshes the enterprise workspace link
pnpm dev                     # server :3000 · frontend :5173 · collector :3210 · widget :3211
```

### 5A. Verify

```bash
pnpm license:check
# [license:check] OK: enterprise license (Your Org) — expires ...

curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/license/info
# → { "tier": "enterprise", ... }

curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/enterprise/modules
# → 200 with the module manifest (SSO, audit log, branding, backup)
```

---

## Option B — Docker (compose)

### 3B. Create the repo-root `.env`

`docker/docker-compose.yml` reads `../.env` (repo root) via `env_file` and passes
`LICENSE_KEY=${LICENSE_KEY:-}` to the server container:

```bash
grep '^LICENSE_KEY=' ../simmetric-license-tool/.env.license > .env
```

### 4B. Mount the enterprise package into the server container

In `docker/docker-compose.yml`, uncomment and fix the volume mount on the `server` service
(the commented line says `./simmetric-enterprise/dist` — compose paths are relative to the
compose file in `docker/`, so it must be `../simmetric-enterprise/dist`):

```yaml
    volumes:
      # ─── Enterprise plugin (optional — air-gap tarball delivery) ───
      - ../simmetric-enterprise/dist:/app/packages/server/node_modules/@simmetric-chat/enterprise:ro
```

This is required: the image's `packages/server/node_modules/@simmetric-chat/enterprise` is a
symlink to `/app/simmetric-enterprise`, which does not exist inside the image. The read-only
mount replaces it with the real built package.

### 5B. Build and start

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

### 6B. Verify

```bash
docker compose -f docker/docker-compose.yml logs server | grep -i license
# [license] loaded { tier: 'enterprise', licensee: 'Your Org', ... }

curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/enterprise/modules
# → 200 with the module manifest
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[license:check] FAILED: bad-signature` | JWT signed with wrong key (or old HS256 token) | Re-mint with `keys/license-private.pem` (Step 2) |
| `[license] fallback to Community` in logs | `LICENSE_KEY` missing/invalid/expired | Check `.env` / root `.env`; restart server (license is read once at boot) |
| `/api/enterprise/modules` → 404 | Plugin not loaded | Docker: volume mount missing or wrong path (Step 4B); pnpm: run `pnpm install` to refresh the link |
| `/api/enterprise/modules` → 402 | License valid but tier-gated feature | Check `tier` in `/api/license/info` |
| `ERR_PNPM_IGNORED_BUILDS` on `pnpm build` | `allowBuilds` placeholder strings in `../simmetric-enterprise/pnpm-workspace.yaml` | Set `cpu-features: true` / `ssh2: true` (booleans, not `set this to true or false`) |

## Reference

- `docs/ENTERPRISE_PLUGIN.md` — plugin architecture, PluginContext contract, air-gap runbook, license JWT shape
- `docs/DEPLOYMENT.md` — full deployment reference
- `../simmetric-license-tool/README.md` — keypair generation, license minting, rotation

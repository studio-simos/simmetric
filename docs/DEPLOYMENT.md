<!-- generated-by: gsd-doc-writer -->
# Deployment

Simmetric Chat deploys as a Docker Compose stack (recommended for production), a single all-in-one container for air-gapped environments, a Coolify-managed stack, or a Tauri desktop bundle. All deployment artifacts live in the `docker/` directory; the desktop shell lives in `src-tauri/`.

## Deployment targets

| Mode | Use case | File(s) |
|------|----------|---------|
| **Multi-container Compose** | Production with per-service isolation and healthchecks | `docker/docker-compose.yml` + `docker/Dockerfile.{server,collector,widget,frontend}` |
| **Single-container all-in-one** | Air-gapped / offline / demo — one container runs everything | `docker/Dockerfile` + `docker/supervisord.conf` + `docker/entrypoint.sh` |
| **Coolify** | Self-hosted PaaS deployment with Traefik TLS termination | `docker/docker-compose.coolify.yml` + `docker/nginx.coolify.conf` (runbook: [docs/COOLIFY.md](COOLIFY.md)) |
| **Dev overrides (pure Docker)** | Hot-reload with source mounts on top of the production compose | `docker/docker-compose.dev.yml` |
| **Dev infra only** | Dev-container workflow: only Postgres/Qdrant in Docker, app runs on host | `docker/docker-compose.infra.yml` |
| **Tauri desktop** | Standalone desktop application (deb/dmg/msi/appimage) | `src-tauri/` |

### Services in the production compose

`docker/docker-compose.yml` defines six active services:

| Service | Image / Dockerfile | Ports | Purpose |
|---------|--------------------|-------|---------|
| `frontend` | `docker/Dockerfile.frontend` (node:24-alpine builder + nginx:alpine runtime) | `${FRONTEND_PORT:-80}:80` and `443:443` | Nginx: TLS with self-signed certs generated at image build, SPA serving, `/api` + `/widget` proxying |
| `server` | `docker/Dockerfile.server` (node:24-alpine) | `${SERVER_PORT:-3000}:3000` | Express API — auth, RBAC, chat orchestration |
| `collector` | `docker/Dockerfile.collector` (node:24-**slim**, glibc needed by LanceDB/Xenova/canvas) | `3210` (expose only) | Document parse/chunk/embed pipeline |
| `widget` | `docker/Dockerfile.widget` (node:24-alpine) | `3211` (expose only) | Embeddable widget service |
| `postgres` | `pgvector/pgvector:pg16` | `${POSTGRES_PORT:-5432}:5432` | Relational DB with the pgvector extension bundled |
| `redis` | `redis:7-alpine` | `6379` (expose only) | Optional scaling cache (`--appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru`); every consumer degrades gracefully in-memory |

**Ollama and Qdrant are currently DISABLED in the production compose** — their service blocks are commented out (`ollama:` around lines 199-219, `qdrant:` around lines 238-260, and a `chroma:` block below them). A commented `chroma` block also exists. To use them:

- Uncomment the `ollama` block and set `OLLAMA_BASE_URL=http://ollama:11434` (the server/collector environment entries already default to that hostname).
- Uncomment the `qdrant` block only if you run `VECTOR_DB_PROVIDER=qdrant`; the default provider is `lancedb` (file-based, stored under `/app/storage`).
- The Coolify compose (`docker-compose.coolify.yml`) keeps `ollama` and `qdrant` **active** — there the Qdrant container runs idle unless `VECTOR_DB_PROVIDER=qdrant`.

All healthchecks use `wget --spider`: server `GET /api/health`, collector `GET /api/health` on 3210, widget `GET /health` on 3211, Postgres `pg_isready`, Redis `redis-cli ping`. The frontend waits for the server healthcheck before starting.

### Single-container all-in-one

`docker/Dockerfile` builds one image supervised by `supervisord` running PostgreSQL 16 (pgvector 0.8.1 compiled from source at image build, installed offline for air-gap), the server, the collector, and the widget. It exposes `3000 3210 3211`, uses `DATABASE_URL=postgresql://...@localhost:5432/...`, and healthchecks `http://localhost:3000/api/health`. Environment defaults are scaffolding placeholders (`JWT_SECRET=change-me-in-production`, etc.) — operators must override via `.env` or `-e`.

### Enterprise plugin is never in images

No published image contains the enterprise plugin (IP isolation + air-gap contract). It is delivered as a tarball or bind-mounted at runtime — see [Air-gap enterprise install](#air-gap-enterprise-install).

## Build pipeline

### Dockerfiles

Four service Dockerfiles plus the all-in-one image, all multi-stage:

| Dockerfile | Builder base | Runtime base | BuildKit cache mount |
|------------|--------------|--------------|----------------------|
| `docker/Dockerfile.server` | `node:24-alpine` | `node:24-alpine` (adds chromium, poppler-utils, docker-cli) | `id=pnpm-store-server` |
| `docker/Dockerfile.collector` | `node:24-slim` | `node:24-slim` (adds wget for the healthcheck) | `id=pnpm-store-collector` |
| `docker/Dockerfile.widget` | `node:24-alpine` | `node:24-alpine` | `id=pnpm-store-widget` |
| `docker/Dockerfile.frontend` | `node:24-alpine` | `nginx:alpine` | `id=pnpm-store-frontend` |
| `docker/Dockerfile` (all-in-one) | `node:24-alpine` | `node:24-alpine` + PostgreSQL 16 + supervisord | none |

The service Dockerfiles persist the pnpm store across builds with a BuildKit cache mount:

```dockerfile
RUN --mount=type=cache,id=pnpm-store-server,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
```

This avoids re-downloading the whole lockfile on every build and caps peak disk usage. Each image uses a distinct cache id so concurrent builds do not thrash each other's store. Each builder compiles `@simmetric-chat/shared` first, then its own package; the server builder also runs `pnpm --filter server db:generate` (Prisma client). The server image copies `prisma/`, `prisma.config.ts`, `scripts/`, and `src/templates/` into `dist/templates/` (the template seeder resolves them `__dirname`-relative — a stale image silently seeds no templates; rebuild with `--no-cache` to fix).

### CI/CD release pipeline

`.github/workflows/release.yml` triggers on a `v*` tag push:

1. **`github-release` job** — verifies `package.json` version matches the tag (major.minor comparison), extracts release notes from `CHANGELOG.md`, creates the GitHub Release.
2. **`docker-images` job** — matrix of 5 images (`simmetric-chat-server`, `-frontend`, `-collector`, `-widget`, `-all-in-one`), built with Buildx and pushed to GHCR tagged `latest` + version. All images are **amd64-only** (`platforms: linux/amd64`) — QEMU-emulated arm64 builds hung and exhausted runner disk; arm64 users self-build locally on native hardware. `cache-from`/`cache-to` use the GitHub Actions cache. The matrix frees ~30 GB of runner disk before building.

<!-- VERIFY: GHCR image paths are ghcr.io/<repository-owner>/simmetric-chat-*; the owner is derived from the release repository. Confirm the actual registry location before pulling. -->

3. **`verify-release` job** — pulls the server image at the released version and confirms the Release is live.

Local build (any host, including arm64):

```bash
docker build -f docker/Dockerfile.server -t simmetric-chat-server .
docker compose -f docker/docker-compose.yml up -d   # uses locally built or pulled images
```

### Server container entrypoint

`docker/entrypoint-server.sh` runs on every server boot (production only):

1. Sources `docker/provision-encryption-key.sh` — provisions `ENCRYPTION_KEY` and `API_KEY_HMAC_SECRET` with precedence: operator-supplied value (env / `env_file`) > persisted value in the `server-storage` volume (`/app/storage/.encryption-key`, `.api-key-hmac-secret`) > generated once and persisted. A placeholder from the `.env.example` template (`<sostituire-con-valore-generato>`) is treated as unset. Provisioning never regenerates over existing key material and fails loudly before any Prisma step.
2. `npx prisma generate` + `node scripts/fix-prisma-pnpm.cjs` (pnpm/Prisma client resolution fix).
3. `npx prisma migrate deploy`, then `npx prisma db seed` (seed failure logs a warning and continues boot).
4. `exec node packages/server/dist/index.js`.

Dev mode (`docker-compose.dev.yml` sets `NODE_ENV=development`) skips provisioning entirely — dev keeps the scrypt fallback.

## Environment setup

Containers receive configuration **via compose `env_file`** — there are no per-package `.env` files; the repo-root `.env` is the single runtime config (template: `.env.example`). The `server`, `collector`, and `widget` services all mount it:

```yaml
env_file:
  - path: ../.env
    required: false
```

`required: false` means the stack boots with only the compose-level `environment` defaults (fine for a first smoke test, not for production). Resolution inside the container: compose `environment` > root `.env` (via `env_file`) > image `ENV` defaults.

Required strict secrets (the server exits without them): `JWT_SECRET` and `COLLECTOR_SECRET`. `DATABASE_URL` has a code default; `LICENSE_KEY` is optional (missing falls back to Community tier).

### The `env_file` vs. `${VAR:-}` interpolation trap

`docker-compose.yml` (lines ~67-81) documents the trap: do **not** add a passthrough like

```yaml
- LICENSE_KEY=${LICENSE_KEY:-}
- ENCRYPTION_KEY=${ENCRYPTION_KEY:-}
```

Shell interpolation resolves an unset variable to the empty string, and an explicit empty `environment` entry **overrides** the value coming from `env_file`. Two consequences:

- `LICENSE_KEY` — an interpolated empty value silently downgrades the deployment to Community tier even though the root `.env` carries a valid JWT.
- `ENCRYPTION_KEY` (and `API_KEY_HMAC_SECRET`) — an interpolated empty value overrides the entrypoint's auto-provisioning, and provisioning never regenerates over existing key material, so the server fails its validation gate.

Leave both to `env_file` (production compose) or explicit interpolation (Coolify compose, where `LICENSE_KEY=${LICENSE_KEY:-}` is intentional because there is no `env_file` there and absent means Community).

### DATABASE_URL variants

| Variant | When |
|---------|------|
| `postgresql://simmetricchat:simmetricchat@postgres:5432/simmetricchat` | Inside the compose network — hardcoded in the compose `environment` (compose wins over `env_file`) |
| `postgresql://...@host.docker.internal:5432/simmetricchat` | Root `.env` default — server on the host (or in a container), Postgres in Docker |
| `postgresql://...@localhost:5432/simmetricchat` | Everything running host-native (also the all-in-one image default, where Postgres runs in the same container) |

<!-- VERIFY: host.docker.internal resolves on Docker Desktop (macOS/Windows) and recent Linux Docker Engines; on older Linux hosts add extra_hosts: "host.docker.internal:host-gateway" to the compose service. -->

### Other environment notes

- `WIDGET_API_KEY` must be identical for `server` and `widget` — the server auto-seeds the `api_keys` row the widget service needs and pushes cache-busts to it.
- `OLLAMA_CONTAINER_NAME` (default `simmetric-chat-ollama`) is used by the server's Ollama Cloud login flow, which runs `docker exec` against the host daemon — that is why `/var/run/docker.sock` is mounted into the server container (root-equivalent access; the Coolify variant does not mount it by default, with a hardening note pointing at a restricted Docker socket proxy alternative).
- The full variable list lives in `.env.example` (per-package sections with applicability markers) — see [CONFIGURATION.md](CONFIGURATION.md).
- Scaling caveat: secret auto-provisioning must complete once before scaling the server beyond one replica (concurrent first-boot replicas could generate divergent keys). Single-instance is the documented default — see [SCALING.md](SCALING.md).

## Coolify deployment

`docker/docker-compose.coolify.yml` automates the image builds (`build.context: ..` works because Coolify clones the whole repo), internal networking, volumes, healthchecks, the enterprise plugin mount (absolute host path `${ENTERPRISE_PLUGIN_PATH:-/opt/simmetric-enterprise}`), and enforces required secrets with `:?` syntax — Coolify refuses to deploy when they are missing: `JWT_SECRET`, `COLLECTOR_SECRET`, `WIDGET_API_KEY`, `POSTGRES_PASSWORD`, `APP_URL`, `ALLOWED_ORIGINS`. Differences from the stock compose:

- No `container_name`, no host ports on app services — Coolify owns naming and its Traefik proxy owns ingress (assign your domain to the `frontend` service, port 80).
- `nginx.coolify.conf` replaces `nginx.conf`: HTTP-only, because Traefik terminates TLS and the stock 80-to-443 redirect would bounce users to a dead port.
- `docker.sock` is **not** mounted by default (root-equivalent); uncomment only for the Ollama Cloud login flow.
- `ENCRYPTION_KEY`/`API_KEY_HMAC_SECRET` are deliberately **not** interpolated — the entrypoint auto-provisions them into the `server-storage` volume.

Manual steps (rsync the enterprise tree, fill secrets, paste `LICENSE_KEY`, assign the domain, optional `ollama pull`) are in the step-by-step runbook: [docs/COOLIFY.md](COOLIFY.md).

## Tauri desktop shell

`src-tauri/` wraps the web app in a Tauri v2 desktop bundle (`com.simmetric-chat.desktop`, targets `deb`, `dmg`, `msi`, `appimage`).

- **Dev mode** (`pnpm tauri:dev`): `beforeDevCommand` boots the server and collector dev processes (`pnpm --filter server dev & pnpm --filter collector dev & sleep 3`), the window loads `devUrl` `http://localhost:5173` (the Vite frontend). The Node sidecar is only spawned in release builds (`#[cfg(not(debug_assertions))]`).
- **Release build** (`pnpm tauri:build`): `beforeBuild` runs `pnpm build` for all packages, the window loads the built assets from `frontendDist: ../packages/frontend/dist`, and `src-tauri/src/lib.rs` spawns a **Node sidecar** (`app.shell().sidecar("node")` with `../packages/server/dist/index.js`) so the API server runs alongside the UI. Bundled resources include the server/collector/shared `dist/` trees, `prisma/`, and `.prisma` client artifacts.

```bash
pnpm tauri:dev     # desktop app in dev mode
pnpm tauri:build   # production installer bundle
```

<!-- VERIFY: Tauri installer output location and code-signing requirements depend on the target OS and your signing certificates. -->

## Air-gap enterprise install

The enterprise package (`@simmetric-chat/enterprise`) is a separate private repo, delivered as a tarball — no `npm install`, no phone-home, no telemetry. The license service validates the `LICENSE_KEY` RS256 JWT locally against an embedded public key; there is no outbound HTTP from the license subsystem (enforced by a CI grep gate).

### Bare-metal / node install (tarball into node_modules)

1. Build the enterprise package on the vendor side: `cd simmetric-enterprise && pnpm build` (produces `dist/`).
2. Tarball it: `tar czf enterprise.tgz -C dist .`
3. Transfer to the customer server (USB, scp, signed artifact).
4. Extract into the server's `node_modules`:

```bash
mkdir -p packages/server/node_modules/@simmetric-chat/enterprise/
tar xzf enterprise.tgz -C packages/server/node_modules/@simmetric-chat/enterprise/
```

The loader's `require.resolve("@simmetric-chat/enterprise")` walks `node_modules` and resolves the package's `main`/`exports` — no npm install needed. (In a dev checkout of this repo, `packages/server/node_modules/@simmetric-chat/enterprise` is a symlink to the sibling repo, so local builds resolve directly.)

5. Set `LICENSE_KEY` in the root `.env` (the RS256 JWT — shape documented in [docs/ENTERPRISE_PLUGIN.md](ENTERPRISE_PLUGIN.md)).
6. Restart the server. Boot order: `prisma.$connect()` -> `initLicense()` (validates the JWT) -> `loadEnterprisePlugin(app)` (mounts routes, registers schedulers) -> routes live.
7. Verify:

```bash
curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/enterprise/modules
```

Expected: `200` with the module manifest (SSO, audit log, branding, backup). `404` = plugin did not load (check the extracted path); `402` = license missing/invalid/expired.

Loader failure policy: plugin absent (`MODULE_NOT_FOUND`) is graceful — the server logs "Community build — no enterprise package found" at info level and continues. A broken install (the package resolves but `register(ctx)` throws) is fail-loud — `process.exit(1)`, never a silent downgrade for a paying customer.

### Docker deployments (bind mount)

The production compose already mounts the **whole sibling repo** read-only into the server container:

```yaml
- ../../simmetric-enterprise:/simmetric-enterprise:ro
```

The path is relative to the `docker/` directory, hence `../../` — the sibling repo sits next to `simmetric-chat`, not inside it. Mount the whole tree (not just `dist/`): the plugin's own dependencies (`passport`, `openid-client`, `node-saml`, ...) are not installed in the server image and resolve from `/simmetric-enterprise/node_modules`, while `express`/`shared` resolve from the server's `node_modules` via:

```yaml
- NODE_PATH=/app/packages/server/node_modules:/simmetric-enterprise/node_modules
```

The image also carries a symlink so `require.resolve("@simmetric-chat/enterprise")` follows the mount. Restart the server container after updating the mounted tree.

For Coolify the same mount uses an absolute host path (`${ENTERPRISE_PLUGIN_PATH:-/opt/simmetric-enterprise}`) because the Coolify clone has no sibling repo — rsync the full tree there (see [docs/COOLIFY.md](COOLIFY.md), step A).

## Rollback procedure

No automated rollback exists in CI — roll back by redeploying a known-good artifact:

1. Compose/GHCR deployments: pin the previous image tag in your compose override or pull it explicitly, e.g. `docker pull ghcr.io/<owner>/simmetric-chat-server:<previous-version>`, then `docker compose up -d`.
2. Self-built deployments: rebuild from the previous git tag (`git checkout v0.20.0 && docker compose -f docker/docker-compose.yml build && docker compose up -d`).
3. Coolify: redeploy the previous successful deployment from the Coolify UI (it keeps deployment history per resource).
4. Database migrations are additive-only by policy (see [docs/MIGRATION_SAFETY.md](MIGRATION_SAFETY.md)); a rollback that reverts code does not revert applied migrations — verify schema compatibility of the older image before redeploying.

<!-- VERIFY: GHCR image owner path — substitute your actual registry owner in rollback commands. -->

## Monitoring

No external monitoring/telemetry service is integrated (`DISABLE_TELEMETRY=true` is the default in `.env.example`; there is no Sentry/Datadog dependency). Health signals available out of the box:

- **Container healthchecks** (wget probes): server `http://localhost:3000/api/health` (30s interval, 40s start period), collector `:3210/api/health`, widget `:3211/health`, Postgres `pg_isready`, Redis `redis-cli ping`. Compose `depends_on: condition: service_healthy` gates startup order.
- **`/api/health` endpoint** returns `{"status":"ok","checks":{"database":true,...}}` — suitable for external uptime probes and load-balancer checks.
- **Structured logs**: the server logs JSON via winston (`LOG_LEVEL` env); all services log to stdout for `docker compose logs -f <service>`.
- **Teardown signals**: graceful shutdown stops plugin schedulers and shutdown callbacks before `prisma.$disconnect()`.

<!-- VERIFY: If you front the stack with an external uptime checker, target the /api/health endpoint through your reverse proxy; no built-in metrics endpoint (Prometheus/OpenTelemetry) exists. -->
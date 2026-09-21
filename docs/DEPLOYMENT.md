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
| **Dev infra only** | Dev-container workflow: only Postgres/Qdrant in Docker, app runs on the host (Ollama intentionally host-native) | `docker/docker-compose.infra.yml` |
| **Tauri desktop** | Standalone desktop application (deb/dmg/msi/appimage) | `src-tauri/` |

### Services in the production compose

`docker/docker-compose.yml` defines ten active services (`minio-init` is a one-shot bucket initializer):

| Service | Image / Dockerfile | Ports | Purpose |
|---------|--------------------|-------|---------|
| `frontend` | `docker/Dockerfile.frontend` (node:24-alpine builder + nginx:alpine runtime) | `${FRONTEND_PORT:-80}:80` and `443:443` | Nginx: TLS with self-signed certs generated at image build, SPA serving, `/api` + `/widget` proxying |
| `server` | `docker/Dockerfile.server` (node:24-alpine) | `${SERVER_PORT:-3000}:3000` | Express API — auth, RBAC, chat orchestration |
| `collector` | `docker/Dockerfile.collector` (node:24-**slim**, glibc needed by LanceDB/Xenova/canvas) | `3210` (expose only) | Document parse/chunk/embed pipeline |
| `widget` | `docker/Dockerfile.widget` (node:24-alpine) | `3211` (expose only) | Embeddable widget service |
| `postgres` | `pgvector/pgvector:pg16` | `${POSTGRES_PORT:-5432}:5432` | Relational DB with the pgvector extension bundled |
| `minio` | `minio/minio:RELEASE.2025-09-07T16-13-09Z` (pinned tag) | `${MINIO_PORT:-9000}:9000`, `${MINIO_CONSOLE_PORT:-9001}:9001` | S3-compatible storage for the `STORAGE_PROVIDER=s3` arm of the StorageProvider strategy (Phase 184; CI runs its S3 conformance tests against it). Default storage stays `localfs`. |
| `minio-init` | same pinned MinIO image | — | One-shot: creates the `${S3_BUCKET:-simmetricchat}` bucket so dev/CI conformance runs find it ready |
| `ollama` | `ollama/ollama:latest` | `11434` (expose only) | Local LLM — **active since 2026-09-08**: the provider fetch and the Ollama Cloud `docker exec` login both require a real Ollama container on the compose network (the host daemon binds 127.0.0.1, unreachable from containers) |
| `redis` | `redis:7-alpine` | `6379` (expose only) | Optional scaling cache (`--appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru`); every consumer degrades gracefully in-memory |
| `searxng` | `searxng/searxng:2026.9.8-3fdc6d753` (pinned tag) | `8080` (expose only) | Optional self-hosted metasearch for the web-search backend — pure optional infrastructure: nothing depends on it and it depends on nothing |

**Qdrant and Chroma remain commented out** in the production compose (their service blocks sit at the bottom of the file). To use them:

- Uncomment the `qdrant` block only if you run `VECTOR_DB_PROVIDER=qdrant`; the default provider is `lancedb` (file-based, stored under `/app/storage`).
- The Coolify compose (`docker-compose.coolify.yml`) keeps `ollama` **and** `qdrant` active — there the Qdrant container runs idle unless `VECTOR_DB_PROVIDER=qdrant`.

Ollama notes: the container has its own model volume (`ollama-data`) — host-downloaded models do NOT appear in it; pull models via the app UI or `docker exec simmetric-chat-ollama ollama pull <model>`.

searXNG notes: the image entrypoint auto-provisions `/etc/searxng/settings.yml` (random secret key) on first boot when absent; the JSON API (`/search?format=json`) returns 403 until the operator places their own `settings.yml` with `formats: [html, json]` in the `searxng-config` volume (the entrypoint never overwrites an existing file).

All healthchecks: server `GET /api/health`, collector `GET /api/health` on 3210, widget `GET /health` on 3211 (all `wget --spider`), Postgres `pg_isready`, Redis `redis-cli ping`, MinIO `mc ready local`, Ollama `ollama ls` (the ollama image ships no curl/wget — `ollama ls` talks to the daemon its own binary serves), searXNG `wget --spider http://localhost:8080/healthz`. The frontend and the widget both wait for the server healthcheck before starting.

### Single-container all-in-one

`docker/Dockerfile` builds one image supervised by `supervisord` running PostgreSQL 16 (pgvector 0.8.1 compiled from source at image build against postgresql16-dev, installed offline for air-gap), the server, the collector, and the widget. It exposes `3000 3210 3211`, uses `DATABASE_URL=postgresql://...@localhost:5432/...`, and healthchecks `http://localhost:3000/api/health`. Environment defaults are scaffolding placeholders (`JWT_SECRET=change-me-in-production`, etc.) — operators must override via `.env` or `-e`.

Its `docker/entrypoint.sh` mirrors the split image's boot: in production it sources the same `provision-encryption-key.sh` helper (fail-loud when `ENCRYPTION_KEY`/`API_KEY_HMAC_SECRET` cannot be provisioned), initializes the Postgres data directory and password, runs `prisma generate` + `prisma migrate deploy`, then hands all four processes to `supervisord`.

### Enterprise plugin is never in images

No published image contains the enterprise plugin (IP isolation + air-gap contract). It is delivered as a tarball or bind-mounted at runtime — see [Air-gap enterprise install](#air-gap-enterprise-install). The optional SaaS plugin (`@simmetric-chat/saas`, Phase 186) follows the same contract: never in images, sibling-repo bind mount, community no-op when absent.

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

The collector image bakes an air-gap reranker cache: run `pnpm --filter collector seed:reranker` on a networked host **before** `docker build` to populate `packages/collector/.cache/huggingface/` (~544MB `bge-reranker-v2-m3` int8 ONNX); the image sets `HF_ALLOW_REMOTE_MODELS=false`, so a cache miss throws fail-loud at load time (the compose service overrides it with `HF_ALLOW_REMOTE_MODELS=${HF_ALLOW_REMOTE_MODELS:-true}` for networked setups).

### CI/CD release pipeline

`.github/workflows/release.yml` triggers on a `v*` tag push:

1. **`github-release` job** — verifies `package.json` version matches the tag (major.minor comparison), extracts release notes from `CHANGELOG.md`, creates the GitHub Release.
2. **`docker-images` job** — matrix of 5 images (`simmetric-chat-server`, `-frontend`, `-collector`, `-widget`, `-all-in-one`), built with Buildx and pushed to GHCR tagged `latest` + version. All images are **amd64-only** (`platforms: linux/amd64`) — QEMU-emulated arm64 builds hung and exhausted runner disk; arm64 users self-build locally on native hardware (the Dockerfiles are cross-build-safe). Two builds run concurrently (`max-parallel: 2`). `cache-from`/`cache-to` use the GitHub Actions cache. The job frees ~30 GB of runner disk before building.

<!-- VERIFY: GHCR image paths are ghcr.io/<repository-owner>/simmetric-chat-*, with the owner lowercased from github.repository_owner of the repo the tag is pushed to (code-verified in release.yml). This repo has two remotes (public: studio-simos/simmetric, dev: simooooone/simoschat-improved) — confirm which one hosts the release before pulling. -->

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

`docker-compose.yml` documents the trap in the server `environment` block: do **not** add a passthrough like

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
- `OLLAMA_CONTAINER_NAME` (default `simmetric-chat-ollama`) is used by the server's Ollama Cloud login flow, which runs `docker exec` against the host daemon — that is why `/var/run/docker.sock` is mounted into the server container. This is root-equivalent access on the host; the compose comment cites a restricted Docker socket proxy as the hardening alternative. The Coolify variant does **not** mount the socket by default (uncomment only for the Ollama Cloud login flow).
- The stock compose also bind-mounts the sibling `simmetric-saas` repo (`../../simmetric-saas:/simmetric-saas:ro`) for the optional SaaS plugin — same whole-tree + `NODE_PATH` pattern as enterprise (the Coolify compose does not include it).
- The full variable list lives in `.env.example` (per-package sections with applicability markers) — see [CONFIGURATION.md](CONFIGURATION.md).
- Scaling caveat: secret auto-provisioning must complete once before scaling the server beyond one replica (concurrent first-boot replicas could generate divergent keys). Single-instance is the documented default — see [SCALING.md](SCALING.md).

## Coolify deployment

`docker/docker-compose.coolify.yml` automates the image builds (`build.context: .` works because Coolify runs compose with `--project-directory` set to the clone root), internal networking, volumes, healthchecks, the enterprise plugin mount (host path hardcoded to `/opt/simmetric-enterprise` — the `ENTERPRISE_PLUGIN_PATH` variable was removed because Coolify rejects `${...}` in volume sources; edit the file to change it), and enforces required secrets with `:?` syntax — Coolify refuses to deploy when they are missing: `JWT_SECRET`, `COLLECTOR_SECRET`, `WIDGET_API_KEY`, `POSTGRES_PASSWORD`, `APP_URL`, `ALLOWED_ORIGINS`. Differences from the stock compose:

- No `container_name`, no host ports on app services — Coolify owns naming and its Traefik proxy owns ingress (assign your domain to the `frontend` service, port 80).
- `nginx.coolify.conf` replaces `nginx.conf`: HTTP-only, because Traefik terminates TLS and the stock 80-to-443 redirect would bounce users to a dead port.
- `docker.sock` is **not** mounted by default (root-equivalent); uncomment only for the Ollama Cloud login flow.
- `ENCRYPTION_KEY`/`API_KEY_HMAC_SECRET` are deliberately **not** interpolated — the entrypoint auto-provisions them into the `server-storage` volume.
- No MinIO, searXNG, or SaaS-plugin mount — the Coolify compose carries only frontend, server, collector, widget, postgres, ollama, redis, and qdrant.

Manual steps (rsync the enterprise tree to `/opt/simmetric-enterprise`, fill secrets, paste `LICENSE_KEY`, assign the domain, optional `ollama pull`) are in the step-by-step runbook: [docs/COOLIFY.md](COOLIFY.md).

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

The loader's `require.resolve("@simmetric-chat/enterprise")` walks `node_modules` and resolves the package's `main`/`exports` — no npm install needed. (In a dev checkout of this repo, `packages/server/node_modules/@simmetric-chat/enterprise` is a pnpm symlink to the sibling repo — created by the `link:../simmetric-enterprise` override in `pnpm-workspace.yaml` — so local builds resolve directly.)

5. Set `LICENSE_KEY` in the root `.env` (the RS256 JWT — shape documented in [docs/ENTERPRISE_PLUGIN.md](ENTERPRISE_PLUGIN.md)).
6. Restart the server. Boot order: `prisma.$connect()` -> `initLicense()` (validates the JWT) -> `loadEnterprisePlugin(app)` (mounts routes, registers schedulers) -> `loadSaaSPlugin(app)` (if installed) -> routes live.
7. Verify:

```bash
curl -H "Authorization: Bearer <admin-jwt>" http://localhost:3000/api/enterprise/modules
```

Expected: `200` with the module manifest (SSO, audit log, branding, backup). `404` = plugin did not load (check the extracted path); `401` = bad/missing admin token (the route mounts via `mountProtected`, which applies only `authMiddleware` — 402 appears only on license-gated feature routes via `middleware/license.ts`, not on this check).

Loader failure policy: plugin absent (`MODULE_NOT_FOUND`) is graceful — the server logs "Community build — no enterprise package found" at info level and continues. A broken install (the package resolves but `register(ctx)` throws) is fail-loud — `process.exit(1)`, never a silent downgrade for a paying customer. The SaaS loader (Phase 186) copies these semantics byte-for-byte, with its own apiVersion acceptance (`[2]`).

### Docker deployments (bind mount)

The production compose already mounts the **whole sibling repos** read-only into the server container:

```yaml
- ../../simmetric-enterprise:/simmetric-enterprise:ro
- ../../simmetric-saas:/simmetric-saas:ro
```

The paths are relative to the `docker/` directory, hence `../../` — the sibling repos sit next to `simmetric-chat`, not inside it. Mount the whole tree (not just `dist/`): the plugin's own dependencies (`passport`, `openid-client`, `node-saml`, ...) are not installed in the server image and resolve from `/simmetric-enterprise/node_modules`, while `express`/`shared` resolve from the server's `node_modules` via:

```yaml
- NODE_PATH=/app/packages/server/node_modules:/simmetric-enterprise/node_modules:/simmetric-saas/node_modules
```

The image also carries a symlink: the root `package.json` declares `@simmetric-chat/enterprise` as a `link:` dependency, so pnpm creates `node_modules/@simmetric-chat/enterprise -> ../../../simmetric-enterprise`, which resolves to `/simmetric-enterprise` inside the container — exactly where the bind mount lands. Restart the server container after updating the mounted tree.

For Coolify the same enterprise mount uses a hardcoded absolute host path (`/opt/simmetric-enterprise`) because the Coolify clone has no sibling repo — rsync the full tree there (see [docs/COOLIFY.md](COOLIFY.md), step A). The `ENTERPRISE_PLUGIN_PATH` env var was removed from the compose (Coolify rejects `${...}` in volume sources).

## Rollback procedure

No automated rollback exists in CI — roll back by redeploying a known-good artifact:

1. Compose/GHCR deployments: pin the previous image tag in your compose override or pull it explicitly, e.g. `docker pull ghcr.io/<owner>/simmetric-chat-server:<previous-version>`, then `docker compose up -d`.
2. Self-built deployments: rebuild from the previous git tag (`git checkout v0.21 && docker compose -f docker/docker-compose.yml build && docker compose up -d`).
3. Coolify: redeploy the previous successful deployment from the Coolify UI (it keeps deployment history per resource).
4. Database migrations are additive-only by policy (see [docs/MIGRATION_SAFETY.md](MIGRATION_SAFETY.md)); a rollback that reverts code does not revert applied migrations — verify schema compatibility of the older image before redeploying.

<!-- VERIFY: GHCR image owner path — substitute your actual registry owner in rollback commands. -->

## Monitoring

No external monitoring/telemetry service is integrated (`DISABLE_TELEMETRY=true` is the default in `.env.example`; there is no Sentry/Datadog dependency). Health signals available out of the box:

- **Container healthchecks** (wget probes): server `http://localhost:3000/api/health` (30s interval, 40s start period), collector `:3210/api/health`, widget `:3211/health`, Postgres `pg_isready`, Redis `redis-cli ping`, MinIO `mc ready local`, Ollama `ollama ls`, searXNG `wget --spider :8080/healthz`. Compose `depends_on: condition: service_healthy` gates startup order.
- **`/api/health` endpoint** returns `{"status":"ok"|"degraded","checks":{"database":true,"collector":true,"disk":{...}}}` — DB (`SELECT 1`), collector reachability, and disk free space — suitable for external uptime probes and load-balancer checks (`/api/health/rag` exists as a backward-compatible RAG-only variant).
- **Structured logs**: the server logs via winston in a text format (`2026-01-01 12:00:00 [info]: message {"meta":"json"}` — only the metadata object is JSON) with `LOG_LEVEL` env; all services log to stdout for `docker compose logs -f <service>`.
- **Teardown signals**: graceful shutdown on SIGTERM/SIGINT drains pg-boss in-flight jobs, closes MCP connections, runs plugin teardown (SaaS before enterprise) and `onShutdown` callbacks before `prisma.$disconnect()`, raced against a 5s hard timeout.

No built-in metrics endpoint (Prometheus/OpenTelemetry) exists — if you front the stack with an external uptime checker, target the `/api/health` endpoint through your reverse proxy.
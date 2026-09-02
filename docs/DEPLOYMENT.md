
# Deployment

Simmetric Chat supports multiple deployment modes: multi-container Docker Compose (recommended for production), single-container all-in-one (ideal for air-gapped environments), and development overrides with hot reload. All deployment artifacts live in the `docker/` directory at the repository root.

## Deployment Overview

| Mode | Use Case | File(s) |
|------|----------|---------|
| **Multi-container** | Production deployments with independent scaling and service isolation | `docker/docker-compose.yml` + per-service Dockerfiles |
| **Single-container** | Air-gapped, offline, or demo deployments where one container runs everything | `docker/Dockerfile` + `docker/supervisord.conf` |
| **Development (pure Docker)** | Local hot-reload with source code mounts | `docker/docker-compose.dev.yml` |
| **Development (dev container + infra)** | Local hot-reload with app on host, only infra in containers | `docker/docker-compose.infra.yml` |
| **Tauri desktop** | Standalone desktop application bundle | `pnpm tauri:build` → `src-tauri/` |

The multi-container mode is the recommended production target. It separates PostgreSQL, Redis, the server, the collector, the widget service, the frontend (Nginx), and Ollama into isolated containers with dedicated health checks and restart policies.

The single-container mode bundles PostgreSQL (with the pgvector extension), the server, the collector, and the widget service into one image supervised by `supervisord`. This trades operational flexibility for simplicity and is designed for environments where running a single Docker image is preferable to orchestrating a Compose stack.

## Production Build

The production build is orchestrated by Turborepo at the monorepo root:

```bash
pnpm build # Builds all packages via turbo (shared → server/collector/frontend/widget)
```

The server package compiles with a dedicated build config that emits to a root `dist/` directory (not a nested `dist/src/`):

```bash
# packages/server/package.json "build" script:
tsc -p tsconfig.build.json && mkdir -p dist/templates && cp src/templates/*.json dist/templates/
```

`tsconfig.build.json` extends `tsconfig.json` and excludes `__tests__/`, `__mocks__/`, and `*.test.ts`/`*.spec.ts` files so the runtime image does not carry test artifacts. The compiled entry point is `packages/server/dist/index.js`, which is what `docker/entrypoint-server.sh` executes.

### Tauri Desktop Build

```bash
pnpm tauri:build # Production desktop bundle (installer) in src-tauri/
pnpm tauri:dev # Desktop app in dev mode
```

<!-- VERIFY: Tauri installer output location and code-signing requirements depend on the target OS and your signing certificates. -->

## Deployment Targets and CI/CD

- **Docker Compose** — `docker/docker-compose.yml` (production), `docker-compose.dev.yml` (hot-reload override), `docker-compose.infra.yml` (infra-only for host-native dev).
- **Release pipeline** — `.github/workflows/release.yml` triggers on a `v*` tag push. It verifies `package.json` version matches the tag (major.minor), extracts release notes from `CHANGELOG.md`, creates the GitHub Release, then builds and pushes 5 **amd64-only** (`linux/amd64`) images to GHCR: `simmetric-chat-server`, `simmetric-chat-frontend`, `simmetric-chat-collector`, `simmetric-chat-widget`, `simmetric-chat-all-in-one` (tagged `latest` + version). A `verify-release` job pulls the server image and checks the Release is live.

> **arm64 note:** CI images are amd64-only — QEMU-emulated arm64 builds hung up to ~5h and exhausted runner disk (Phase 181). On arm64 hardware, self-build locally: `docker build -f docker/Dockerfile.server -t simmetric-chat-server .` (all Dockerfiles are cross-build-safe; build on the target arch natively). Alternatively, point a self-hosted arm64 runner at the release matrix and re-add `linux/arm64` to `platforms:`.
- **Enterprise plugin** — never baked into any published image. Delivered as a private tarball (air-gap compatible); mounted into the server container at runtime (see [Enterprise Plugin Deployment (Docker)](#enterprise-plugin-deployment-docker)).

<!-- VERIFY: GHCR image paths are ghcr.io/<repository-owner>/simmetric-chat-*; the owner is derived from the release repository. Confirm your registry location before pulling. -->

## Docker Compose Configuration

The production Compose file (`docker/docker-compose.yml`) defines the following services:

| Service | Image | Port(s) | Purpose |
|---------|-------|---------|---------|
| `frontend` | Custom (`docker/Dockerfile.frontend`, `node:24-alpine` builder + `nginx:alpine` runtime) | `${FRONTEND_PORT:-80}:80` + `443:443` | Nginx reverse proxy: TLS termination (self-signed certs), SPA serving, API/widget proxying |
| `server` | Custom (`docker/Dockerfile.server`, `node:24-alpine`) | `${SERVER_PORT:-3000}:3000` | Express API, auth, RBAC, agent orchestration |
| `collector` | Custom (`docker/Dockerfile.collector`, `node:24-slim` for glibc-native deps) | `3210` (expose only) | Document ingestion: parse, chunk, embed, store |
| `widget` | Custom (`docker/Dockerfile.widget`, `node:24-alpine`) | `3211` (expose only) | Embeddable chat widget service |
| `postgres` | `pgvector/pgvector:pg16` | `${POSTGRES_PORT:-5432}:5432` | Primary relational database with pgvector extension |
| `redis` | `redis:7-alpine` | `6379` (expose only) | Optional horizontal-scaling layer (auth/JWT cache, SSE fan-out, widget config cache); `--appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru`. Wired into `server` and `widget` via `REDIS_URL=redis://redis:6379`; every consumer degrades gracefully in-memory when Redis is absent. |
| `ollama` | `ollama/ollama:latest` | `11434` (expose only) | Local LLM inference (optional) |
| `qdrant` | `qdrant/qdrant:latest` | `6333` (HTTP), `6334` (gRPC) (expose only) | Vector database (runs by default; only consumed when `VECTOR_DB_PROVIDER=qdrant`) |

**PostgreSQL image:** As of D-08 (-01), the production `postgres` service uses the `pgvector/pgvector:pg16` image. This bundles the `pgvector` extension offline so air-gapped deployments can enable it without reaching an external package mirror. Pin by digest in production.

**PostgreSQL host port:** The `postgres` service maps port `${POSTGRES_PORT:-5432}:5432` to the host (needed for `prisma migrate dev` against the container). Inside the Compose network, services reach it as `postgres:5432`. Set `POSTGRES_PORT` in your environment if host port 5432 conflicts with a locally installed PostgreSQL.

**Qdrant:** The `qdrant` service has no Compose profile and starts by default in `docker compose up`. It is only consumed when `VECTOR_DB_PROVIDER=qdrant` (and `VECTOR_DB_URL`/`VECTOR_DB_API_KEY` are set). With the default `VECTOR_DB_PROVIDER=lancedb`, the Qdrant container runs idle; stop it explicitly with `docker compose stop qdrant` if you want to save resources. (A `chroma` service block is commented out in the Compose file — uncomment it with its `chroma-data` volume if you use `VECTOR_DB_PROVIDER=chroma`.)

**Profiles:** No profiles are defined in the production Compose file — every service above starts with a plain `docker compose up`. (The dev infra file `docker-compose.infra.yml` gates Qdrant behind a `qdrant` profile, and Ollama is intentionally absent there — host-native Ollama is the dev default.)

### Server Volume Mounts

The `server` service mounts, on top of `server-storage:/app/storage`:

- `${LOCAL_BACKUP_PATH:-/var/backups}:${LOCAL_BACKUP_PATH:-/var/backups}:rw` — host bind mount for local backup destinations (same path inside and outside the container). Set `LOCAL_BACKUP_PATH` in the root `.env` to control where local backups land.
- `/var/run/docker.sock:/var/run/docker.sock` — the host Docker socket, used by the **Ollama Cloud login** flow: the server runs `docker exec <OLLAMA_CONTAINER_NAME> ollama login` against the host daemon (SSH-key-based cloud auth). This is root-equivalent access — see `.env.example` for the restricted Docker socket proxy hardening alternative. `OLLAMA_CONTAINER_NAME` must match the `ollama` service's `container_name` (default `simmetric-chat-ollama`).
- `../../simmetric-enterprise:/simmetric-enterprise:ro` — the **whole sibling enterprise repo** (dist AND node_modules), read-only. See [Enterprise Plugin Deployment (Docker)](#enterprise-plugin-deployment-docker).

### Volumes

| Volume | Service(s) | Purpose |
|--------|------------|---------|
| `pgdata` | `postgres` | Persistent PostgreSQL data |
| `redis-data` | `redis` | Redis AOF persistence |
| `server-storage` | `server` (rw), `collector` (read-only at `/app/server-storage`) | Uploads, backups, logs, auto-provisioned secrets (`/app/storage`) |
| `collector-storage` | `collector` | Documents and vector files |
| `xenova-cache` | `collector` | Local embedding model cache (`/app/.cache/xenova`) |
| `widget-storage` | `widget` | Widget runtime storage |
| `ollama-data` | `ollama` | Downloaded models |
| `qdrant-storage` | `qdrant` | Vector collections |

### Environment Variable Mapping

The Compose file reads from two sources:

1. **Inline environment variables** inside each `services.*.environment` block, with fallback defaults (e.g., `JWT_SECRET: ${JWT_SECRET:-change-me-in-production}`).
2. **Optional root `.env` file** referenced by `env_file: ../.env` (relative to the `docker/` directory) with `required: false` — all three application services (`server`, `collector`, `widget`) read it. If present, values from this file are injected into the containers.

The root `.env` is the single runtime config. **Do NOT add an inline `- KEY=${KEY:-}` passthrough for `ENCRYPTION_KEY` or `LICENSE_KEY`** (or any env_file-delivered secret): Compose shell interpolation resolves an unset variable to the empty string, and that empty value **overrides** the value `env_file` injected — silently downgrading you to Community tier or breaking encryption-key provisioning. This trap is documented in the Compose file comments; `ENCRYPTION_KEY` and `LICENSE_KEY` must flow through `env_file` only.

Critical secrets such as `JWT_SECRET`, `LICENSE_KEY`, and `COLLECTOR_SECRET` are injected via the `.env` file or exported in the shell before running `docker compose up`. The license public key is embedded in the source — no secret is needed for verification. The default values in the Compose file are **not secure for production**.

## Production Deployment Steps

### Prerequisites

- Docker Engine >= 24.0.0
- Docker Compose >= 2.20.0
- Node.js >= 24.0.0 and pnpm 11.24.0 (pinned via `packageManager` in the root `package.json` — only needed if building images locally instead of pulling from a registry)
- At least 4 GB RAM (8 GB recommended when running Ollama)
- At least 20 GB disk space for images, models, and document storage

### Step-by-Step Multi-Container Deployment

1. **Clone the repository:**

```bash
git clone https://github.com/simmetric-chat/simmetric-chat simmetric-chat
cd simmetric-chat
```

<!-- VERIFY: The canonical clone URL depends on where the repository is hosted for your organization. -->

2. **Create the root environment file:**

```bash
cp .env.example .env
```

Edit it with production values. The root `.env` is the single runtime config
(docker compose injects it into every application container via `env_file`
with `required: false`). The per-package `.env` override layer was removed —
there is no other runtime env file.
See [Environment Variable Configuration for Production](#environment-variable-configuration-for-production).

3. **Build and start the stack:**

```bash
cd docker
docker compose -f docker-compose.yml up --build -d
```

4. **Pull the first Ollama model (if using local LLMs):**

```bash
docker exec simmetric-chat-ollama ollama pull gemma4:latest
```

5. **Verify services:**

```bash
docker compose ps
```

Every service except `frontend` (which has no healthcheck) configures a healthcheck; all should report `healthy` Ollama included — its probe is `ollama ls` against the local daemon.

6. **Access the application:**

- Frontend: `https://localhost` (port 80 redirects to HTTPS 443 with the bundled self-signed certificate — see [SSL/TLS Considerations](#ssltls-considerations))
- API: `https://localhost/api`
- Swagger UI: the Nginx proxy only forwards `/api/` and widget routes, so reach Swagger directly on the server port: `http://localhost:3000/api-docs`

### Single-Container Deployment

For air-gapped or demo environments:

```bash
cd docker
docker build -f Dockerfile -t simmetric-chat:airgap ..
docker run -d \
-p 3000:3000 \
-p 3210:3210 \
-p 3211:3211 \
-v simmetric-storage:/app/storage \
-e JWT_SECRET=<strong-secret> \
simmetric-chat:airgap
```

Do not override `DATABASE_URL` for the single-container image: its default (`postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat`) targets the embedded PostgreSQL instance.

The single-container image (`docker/Dockerfile`) bundles PostgreSQL 16 with the `postgresql16-pgvector` extension installed offline via `apk` (D-08 -01), plus supervisord, git, poppler-utils, and Chromium for archive PDF export. On first start (`docker/entrypoint.sh`) it provisions the production secrets (same helper as the split image — see below), initializes the database directory, generates the Prisma client, applies migrations, stops the temporary PostgreSQL, and launches all services via supervisord (postgres → server → collector → widget, by priority order). The image carries a HEALTHCHECK (`wget --spider` on `/api/health`, 30s interval, 30s start period).

## Database Migrations in Production

Migrations are applied automatically on container startup by `docker/entrypoint-server.sh`. **Secret provisioning runs first**, before any Prisma step so a missing or corrupt key fails fast instead of crash-looping through generate/migrate/seed on every restart:

```bash
# entrypoint-server.sh (server container)
if [ production ]; then
. /app/provision-encryption-key.sh /app/storage # ENCRYPTION_KEY + API_KEY_HMAC_SECRET
fi # (refuses to boot if either can't be provisioned)
cd /app/packages/server
npx prisma generate
node scripts/fix-prisma-pnpm.cjs
npx prisma migrate deploy
npx prisma db seed || echo "WARNING: Seed failed, continuing boot. The app may work with existing data."
cd /app
exec node packages/server/dist/index.js
```

A seed failure is treated as non-fatal so an upgrade over existing data can boot without re-seeding.

This means **no manual migration step is required** when deploying new versions, provided the container restarts after the image update. If you need to run migrations manually (for example, during a zero-downtime blue/green deployment), exec into the running server container:

```bash
docker exec -it simmetric-chat-server sh
cd /app/packages/server
npx prisma migrate deploy
```

### Prisma 7 + pnpm Client Fix (Docker)

Prisma 7's `prisma-client-js` generator writes the client into `node_modules/.prisma/client` and `@prisma/client` resolves it via a `.prisma` symlink. Under pnpm's symlinked `node_modules` layout, this relative resolution fails at both runtime (Node `require`) and type-check time (TypeScript `export *`). The repository ships `packages/server/scripts/fix-prisma-pnpm.cjs`, which the entrypoint runs immediately after `prisma generate`. It:

1. Creates a `node_modules/@prisma/client/.prisma` symlink pointing at `node_modules/.prisma`.
2. Rewrites `@prisma/client`'s `index.js`, `default.js`, `index.d.ts`, and `default.d.ts` to use a `__dirname`-relative path to the generated client (overridable via `PRISMA_GENERATED_DIR`).

This is invoked in both the multi-container entrypoint (`docker/entrypoint-server.sh`) and the single-container entrypoint (`docker/entrypoint.sh`). The same script runs locally via `pnpm --filter server db:generate`.

**Important:** Always back up the database before applying migrations in production. See [Backup and Restore Procedures](#backup-and-restore-procedures).

**Database seeding** (`pnpm db:seed`) creates default roles, permissions, system config, and templates on first launch when the database is empty. In Docker, this happens automatically when the server starts with an empty database. Seed templates are copied into the image (`Dockerfile.server` copies `src/templates/` to `dist/templates/`, resolved `__dirname`-relative) — a stale image silently seeds no templates; rebuild with `--no-cache` if you see that.

## Enterprise Plugin Deployment (Docker)

The enterprise package (`@simmetric-chat/enterprise`) is a **separate private repo** (`simmetric-enterprise/` sibling to this repo). It is never published and never baked into community images — it is delivered as a tarball and mounted into the server container (no `npm install`, no phone-home, no telemetry; the license service is read-only + local-validation only, verified by the `airgap-grep` CI gate).

### Compose mount + module resolution

`docker/docker-compose.yml` mounts the **whole sibling repo** at `/simmetric-enterprise:ro`:

```yaml
- ../../simmetric-enterprise:/simmetric-enterprise:ro
- NODE_PATH=/app/packages/server/node_modules:/simmetric-enterprise/node_modules
```

Mount the whole repo, not only `dist/`: the plugin's own dependencies (passport, openid-client, node-saml, bree, yauzl, …) are **not** installed in the server image, so they must resolve from the mounted `/simmetric-enterprise/node_modules`, while the plugin's `express`/`@simmetric-chat/shared` imports resolve from the server's own `node_modules`. This is what the `NODE_PATH` pair supports. A dist-only mount breaks dependency resolution, and nested mounts get shadowed by the parent.

The loader (`packages/server/src/services/enterpriseLoader.ts`) finds the package at boot via `require.resolve("@simmetric-chat/enterprise")` — that resolve seam is the ONLY coupling between the community repo and the enterprise package. Set `LICENSE_KEY` (RS256 JWT) in the root `.env`; absence = Community tier.

### Boot failure modes

The loader distinguishes three outcomes (never fail-open):

| Situation | Behavior |
|-----------|----------|
| Package not present (`MODULE_NOT_FOUND`) | **Community mode** — info-level log `[enterprise] Community build — no enterprise package found (no-op)`, boot continues |
| Broken install (load throws: SyntaxError, `ERR_REQUIRE_ESM`, stale snapshot, …) | **Fail-loud** — `process.exit(1)`; a broken enterprise install must never silently degrade to Community |
| `register(ctx)` throws, or runtime `apiVersion` mismatch | **Fail-loud** — `process.exit(1)` (the single-package contract is version-pinned via `API_VERSION`) |

### The `file:`-snapshot pitfall (crash loop: `Cannot find module './env.schema'`)

The enterprise repo installs `@simmetric-chat/shared` via `file:../simmetric-chat/packages/shared`. pnpm snapshots `file:` packages and hardlinks only files that **already exist**, so new files created in shared after the last enterprise `pnpm install` never reach the snapshot. When a community release adds a new schema file, the snapshot's (hardlinked, updated) `schemas/index.js` requires a module that does not exist on the enterprise side — and the fail-loud policy turns that into a boot crash loop:

```
[enterprise] Plugin registration failed
{"error":"Cannot find module './env.schema'" ...}
```

**Runbook:** on the machine holding the enterprise repo, refresh the snapshot and rebuild:

```bash
cd simmetric-enterprise && pnpm install && pnpm build
```

`pnpm install` re-snapshots the `file:` package (picking up new dist files); `pnpm build` rebuilds enterprise against it. Reinstall is not rebuild — you need both. Verify before restarting the container:

```bash
node -e "require('./node_modules/@simmetric-chat/shared/dist/schemas/index.js')"
```

Details and the full contract: [ENTERPRISE_PLUGIN.md](ENTERPRISE_PLUGIN.md) (air-gap install runbook, tarball model, license JWT shape).

## Environment Variable Configuration for Production

The following table lists the variables that must be configured for a secure production deployment. For the full list of supported variables, see `.env.example` and [CONFIGURATION.md](CONFIGURATION.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | **Yes** | `postgresql://simmetricchat:simmetricchat@postgres:5432/simmetricchat` (set inline in the Compose file) | PostgreSQL connection string. Inside Compose, point at the `postgres` service hostname — not `localhost`. |
| `JWT_SECRET` | **Yes** | `change-me-in-production` | Symmetric signing key for JWT tokens. **Not the production data-at-rest key** since the hard default (it remains the dev/test fallback and the decrypt-chain tail for pre-override blobs). Must be a strong random string. |
| `COLLECTOR_SECRET` | **Yes** | `change-me-in-production` | Shared secret for server↔collector HTTP calls. Validated by Zod (min 1 char). Must match between `.env` and `.env.test`. |
| `ENCRYPTION_KEY` | **Yes (in production)** | *(Docker: auto-provisioned to `/app/storage/.encryption-key`)* | Base64 32-byte data-at-rest key (generate with `openssl rand -base64 32`). **Required since the hard default — the server refuses to boot in production without it.** In Docker deployments the entrypoint auto-provisions one to `/app/storage/.encryption-key` (server-storage volume) when unset — restore it or delete it deliberately if corrupted, and back it up (see [Production secret provisioning (Docker)](#production-secret-provisioning-docker)). See [ENCRYPTION_KEY_ROTATION.md](ENCRYPTION_KEY_ROTATION.md). |
| `API_KEY_HMAC_SECRET` | **Yes (in production)** | *(Docker: auto-provisioned to `/app/storage/.api-key-hmac-secret`)* | Base64 32-byte HMAC-SHA256 signing secret for API keys (widget API key auto-seed + key issuance/verification). The entrypoint provisions it alongside `ENCRYPTION_KEY` before any Prisma step; the entrypoint refuses to boot when it is unset or invalid. |
| `SERVER_PORT` | No | `3000` | Express server port inside the container |
| `COLLECTOR_URL` | No | `http://collector:3210` | Internal URL the server uses to reach the collector |
| `SERVER_URL` | No | `http://server:3000` (Compose) | Public base URL of the server |
| `LLM_PROVIDER` | No | `ollama` | Primary LLM provider: `ollama`, `openai`, `anthropic`, or `openrouter` |
| `LLM_MODEL` | No | `gemma4:latest` | Default model name for the selected provider |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434` | Ollama API base URL. In Docker Compose the server auto-detects `http://ollama:11434` when unset. In `pnpm dev` on the host, use `http://localhost:11434` (see [Host-Native Dev Networking](#host-native-dev-networking)). |
| `OLLAMA_CONTAINER_NAME` | No | `simmetric-chat-ollama` | Container name passed to `docker exec <name> ollama login` for the Ollama Cloud login flow (see [Server Volume Mounts](#server-volume-mounts)) |
| `EMBEDDING_PROVIDER` | No | `local` | `local` (Xenova/transformers), `hf-local` (`@huggingface/transformers` v3, air-gap), or `openai` |
| `HF_CACHE_DIR` | No | *(inside `node_modules`)* | HuggingFace cache directory. **In air-gap production, set this to a path OUTSIDE `node_modules`** — the default cache lives under `node_modules/.pnpm/.../.cache/` and is wiped on every `pnpm install`. In the collector image the reranker cache is baked at `RERANKER_CACHE_DIR=/app/.cache/huggingface`. |
| `HF_ALLOW_REMOTE_MODELS` | No | `true` (Compose default) | Allow first-use model downloads from the HF hub for `local`/`hf-local` embeddings and the reranker. The collector image's Dockerfile default is `false`, but the Compose environment block overrides it with `true` — set `HF_ALLOW_REMOTE_MODELS=false` in the root `.env` for strict air-gap operation. |
| `VECTOR_DB_PROVIDER` | No | `lancedb` | `lancedb` (local, air-gap), `qdrant` (remote), `pgvector` (reuses PostgreSQL), or `chroma` (embedded) |
| `LICENSE_KEY` | No | *(none)* | RS256 JWT Enterprise license key (issued by the vendor's private key). Absence enables Community tier. The verifying public key is embedded in the source — no env secret needed. **Flows through `env_file` only — never redeclare it as an inline Compose variable** (see [Environment Variable Mapping](#environment-variable-mapping)). |
| `LOCAL_BACKUP_PATH` | No | `/var/backups` | Host path bind-mounted into the server container for local backup destinations |
| `ALLOW_REGISTRATION` | No | `true` | Set to `false` to restrict user creation to admins only |
| `VAPID_PUBLIC_KEY` | No | *(auto-generated)* | VAPID public key for Web Push (Enterprise feature) |
| `VAPID_PRIVATE_KEY` | No | *(auto-generated)* | VAPID private key for Web Push |
| `SMTP_HOST` | No | *(none)* | SMTP server for password reset emails |
| `LOG_LEVEL` | No | `info` | Winston log level: `error`, `warn`, `info`, `debug` |
| `WIDGET_API_KEY` | No | `sk-default-widget-key` (compose) | Shared secret between server and widget service. The server uses it to auto-seed the api_keys row required by the widget service's outbound calls and to push cache-busts to the widget. Override in production. |
| `PUPPETEER_EXECUTABLE_PATH` | No | *(auto-detected)* | Chromium path for archive PDF export. Server Dockerfiles install `chromium`; set this only if you use a custom Chromium. |

**Security notes:**

- Never commit `.env` files to version control.
- `JWT_SECRET` must be at least 32 characters of cryptographically random data. **Changing `JWT_SECRET` after initial deployment invalidates all existing JWTs AND makes previously encrypted backup-destination configs undecryptable** (see [Backup and Restore Procedures](#backup-and-restore-procedures)).
- In a Compose deployment, `DATABASE_URL` should point to the `postgres` service hostname, not `localhost`.
- `.env` loading walks up to the repo-root marker (`pnpm-workspace.yaml`) from each loader's `__dirname`: the loader resolves the root `.env`, independent of the process working directory. The ROOT `.env` is the single runtime config (docker compose `env_file` injects it into every application container); the per-package `.env` override layer that existed during the transition was removed.

### Production secret provisioning (Docker)

`docker/provision-encryption-key.sh` provisions **two** production-required secrets with identical precedence rules, sourced by both entrypoints (`entrypoint-server.sh` and `entrypoint.sh`) **before any Prisma step**:

- `ENCRYPTION_KEY` — data-at-rest key (provider API keys, backup destination configs). The server refuses to boot in production without it.
- `API_KEY_HMAC_SECRET` — HMAC-SHA256 signing secret for API keys (widget API key auto-seed runs during boot). Provisioned early because an unset secret surfaces as a misleading "Database connection failed" *after* listen.

Precedence for both:

1. **Operator-supplied value wins** (root `.env` via `env_file`, or exported in the environment) — validated early: must base64-decode to exactly 32 bytes, else the entrypoint fails loud.
2. **Restore path** — the persisted value inside the server-storage volume is restored: `/app/storage/.encryption-key` (ENCRYPTION_KEY) and `/app/storage/.api-key-hmac-secret` (API_KEY_HMAC_SECRET).
3. **Generate path** — generated once (via `node crypto`, not the `openssl` CLI, which is not guaranteed on `node:24-alpine`), validated, and persisted atomically (tmp write → `chmod 600` → rename) with a loud backup warning on first boot. Key values are **never** logged — only file paths.

**Template placeholders:** an operator value equal to the unfilled `.env.example` placeholder (`<sostituire-con-valore-generato>`) is **not** treated as an operator-supplied secret — the entrypoint warns and falls through to the restore/generate paths as if the variable were unset. An unfilled template copied to `.env` therefore never crash-loops the validation gate (any other invalid non-empty value still fails loud). When filling the `.env` for real, generate each secret with `openssl rand -base64 32`.

Failure handling: an empty or **corrupt** persisted key file is fail-loud (the operator must restore it from backup or delete it deliberately after confirming rotation consequences — regeneration of *different* key material is never automatic, because it would brick stored provider API keys, backup configs, and issued API-key digests).

Operational notes:

- **Back the key up now:** `docker cp simmetric-chat-server:/app/storage/.encryption-key .` (and `.api-key-hmac-secret`). Losing a file while the database volume survives makes the corresponding key material unrecoverable.
- **Scale-out caveat:** provisioning must complete once before scaling the `server` service beyond one replica (concurrent first-boot replicas could each generate a divergent key); single-instance is the documented default.
- Dev (`docker-compose.dev.yml` sets `NODE_ENV=development`) skips provisioning entirely — dev keeps the scrypt fallback.
- Rotation procedure and corrupt-key recovery steps: [ENCRYPTION_KEY_ROTATION.md](ENCRYPTION_KEY_ROTATION.md).

### Existing Installs

The app-level default `DATABASE_URL` in the Zod env schema (`postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat`) is for **fresh local installs only**. In Docker Compose, `DATABASE_URL` is set inline to `postgresql://simmetricchat:simmetricchat@postgres:5432/simmetricchat`. If you are upgrading an existing deployment against a different database, set `DATABASE_URL` explicitly via the root `.env` — do not rely on defaults.

### License Gating

Several deployment-relevant features are gated behind `LICENSE_KEY` (an RS256 JWT verified with the embedded public key) and enforced by the `license.ts` middleware. Without a valid Enterprise license these fall back to Community behavior:

- `backup_enabled` — Backup destination creation and the Bree scheduler. Community tier disables backup destinations beyond the limit.
- `widget_enabled` — Widget system. `max_widgets` (default 1) caps widget creation.
- `max_backup_destinations` (default 1) — Enforced on creation routes via `requireFeatureLimit`.
- SSO, webhooks, push notifications, immutable audit logs, custom agent config, white-label branding.

An expired Enterprise license automatically reverts to Community at runtime — no redeploy is required, but the gated endpoints will start returning `402 { error, feature, tier: "community" }`.

## Reverse Proxy Setup (Nginx)

The production frontend container is an Nginx reverse proxy **and TLS terminator**. Its configuration (`docker/nginx.conf`) handles:

- **HTTP→HTTPS redirect** — Port 80 redirects all traffic to `https://$host:443`
- **TLS termination** — Port 443 with TLS 1.2/1.3 using the self-signed certificate pair from `docker/certs/` (baked in via `COPY docker/certs/ /etc/nginx/certs/`) — see [SSL/TLS Considerations](#ssltls-considerations)
- **Static asset serving** — Built React SPA from `packages/frontend/dist/`
- **API proxy** — `/api/` routes forwarded to the `server` container on port `3000`
- **Widget static proxy** — `/widget/` forwarded to the `widget` container on port `3211` (same-origin widget loader/bundle, so embedding requires no widget-code changes)
- **Widget API proxy** — `/api/(sessions|config|chat|lead)` regex location forwarded to the `widget` container (regex wins over the plain `/api/` prefix for exactly these widget path prefixes)
- **Avatar proxy** — `/avatars/` forwarded to the `server` container
- **Branding proxy** — `/branding/` forwarded to the `server` container (served by `express.static("storage/branding")`)
- **SSE support** — `proxy_buffering off` and long timeouts (`proxy_read_timeout 86400s`) for streaming endpoints (`/api/`, `/api/mcp/`, `/widget/`)
- **SPA fallback** — All unmatched routes return `index.html` for React Router; `X-Frame-Options: SAMEORIGIN` is applied to the SPA only (the widget iframe page under `/widget/` must stay embeddable in third-party sites)
- **Service worker** — `/sw.js` served with `no-cache` headers and `Service-Worker-Allowed: /`
- **Security headers** — `X-Frame-Options` (SPA), `X-Content-Type-Options`, `X-XSS-Protection`, `Referrer-Policy`
- **Gzip compression** — Enabled for text assets and JSON payloads
- **Asset caching** — `/assets/` cached for 1 year with immutable headers
- **Upload size** — `client_max_body_size 100m` (DOC-04), aligned with multer (100MB) and `express.json` (100mb) so large document uploads are not rejected at the edge
- **Docker DNS resolver** — Uses `resolver 127.0.0.11 valid=5s` with variable upstreams so container IP changes after a restart do not cause 502s (and so `nginx -t` does not fail when a container name has no DNS entry at config load)

If you are running your own Nginx instance in front of the Compose stack (for example, to terminate TLS at the edge instead), use this configuration as a template and proxy `location /api/` to `http://<server-host>:3000` and static traffic to `http://<frontend-host>:80`.

### Custom Nginx Config

Mount a custom config over the built-in one:

```yaml
services:
frontend:
volumes:
- ./my-nginx.conf:/etc/nginx/conf.d/default.conf:ro
```

## SSL/TLS Considerations

The built-in frontend container **does terminate TLS** — with a **self-signed certificate pair** shipped in `docker/certs/` (`selfsigned.crt` / `selfsigned.key`), baked into the image by `Dockerfile.frontend`. HTTPS is required because the SPA's push-notification feature requires a secure context.

For production:

1. **Replace the certificates** — bind-mount your real cert/key over the baked-in pair:

```yaml
services:
frontend:
volumes:
- ./certs/fullchain.pem:/etc/nginx/certs/selfsigned.crt:ro
- ./certs/privkey.pem:/etc/nginx/certs/selfsigned.key:ro
```

2. **Or terminate TLS upstream** — at a cloud load balancer (AWS ALB, GCP HTTPS LB, Azure Application Gateway), an edge reverse proxy (Traefik, Caddy, Nginx with real certificates), or a CDN — and point it at the frontend container.

<!-- VERIFY: Certificate paths and acquisition (Let's Encrypt, corporate CA, cloud-managed certs) depend on your certificate provider and deployment platform. -->

**Important for SSE:** Ensure your TLS-terminating proxy does not buffer responses, or streaming chat events will be delayed. Set `proxy_buffering off` for `/api/`, `/api/mcp/`, and `/widget/` locations.

## Backup and Restore Procedures

The backup system is a Bree-based multi-job scheduler (`@mintplex-labs/bree`) that manages scheduled `BackupJob` records targeting configured `BackupDestination` records. It replaces the legacy single-interval daily backup. **The backup module lives in the enterprise plugin** (`simmetric-enterprise/`) — it registers its Bree scheduler through the plugin's `registerScheduler` contract, so backup stop/teardown runs through `shutdownEnterprisePlugin()` during graceful shutdown. It is gated by the `backup_enabled` license feature (see [License Gating](#license-gating)).

### Components

- `backupSchedulerService.ts` — Singleton `Bree` instance (enterprise plugin). Jobs are added/removed dynamically via `addScheduledJob(jobId, cronExpression)` with a standard cron expression (e.g. `0 2 * * *`). Jobs with `cronExpression: null` are manual-only and tracked but not scheduled.
- `backupJobWorker.ts` — Runs inside the Bree worker thread per job. Performs the backup, then triggers retention cleanup on success.
- `backupRetentionService.ts` — Loads the job's `retentionDays` from the DB, filters logs/remote files older than the cutoff, and deletes them.
- `backupService.ts` — Orchestration: decrypts the destination's encrypted config in-memory (never logged), runs `pg_dump`, zips document/vector storage, and uploads the final archive.
- `restoreService.ts` — Decrypts destination config and restores from a backup log, taking a pre-restore safety snapshot first.
- `encryptionService.ts` — AES-256-GCM encrypt/decrypt for destination credentials. **In production the key is the explicit `ENCRYPTION_KEY` (required since the hard default) or, in Docker deployments, the key the entrypoint auto-provisioned to `/app/storage/.encryption-key`** — see [Production secret provisioning (Docker)](#production-secret-provisioning-docker) and [ENCRYPTION_KEY_ROTATION.md](ENCRYPTION_KEY_ROTATION.md). There is no separate `BACKUP_ENCRYPTION_KEY` env var; backup encryption reuses `ENCRYPTION_KEY`. In dev/test the legacy `scryptSync(JWT_SECRET)` derivation remains available as the fallback and as the decrypt-chain tail for pre-override blobs.

### Backup Output

Backups land in `storage/backups/final/backup-{jobName}-{timestamp}.zip`. Intermediate staging uses `storage/backups/tmp/{jobId}/`. A pre-restore safety snapshot is written to `storage/backups/pre-restore-safety/{safetyId}.zip` before any restore overwrites live data.

The final archive contains:

- `dbdump.sql` — PostgreSQL dump via `pg_dump`
- `documents/` — Zipped document storage from the collector
- `vectors/` — Zipped vector storage from the collector

Local backup destinations write into the host bind mount configured by `LOCAL_BACKUP_PATH` (default `/var/backups`) — see [Server Volume Mounts](#server-volume-mounts).

### Retention

Retention is **per-job**, driven by the `BackupJob.retentionDays` database field (default `30` if unset). After each successful backup, `backupRetentionService.cleanupRetention(jobId)` deletes expired backup logs and their remote files for that job. There is no global `BACKUP_RETENTION_DAYS` env var; configure retention per destination/job in the admin UI.

### Manual / On-Demand Backups

Administrators can trigger an on-demand backup run via the API (requires admin auth and the `backup_enabled` license feature):

```bash
curl -H "Authorization: Bearer <admin-jwt>" \
-X POST \
http://localhost/api/system/backups
```

Response:

```json
{ "name": "backup-2026-05-19T10-30-00-000Z", "message": "Backup created successfully" }
```

### Listing and Downloading Backups

- `GET /api/system/backups` — List all backups with size and creation time
- `GET /api/system/backups/:name/download/db` — Download the database dump
- `GET /api/system/backups/:name/download/documents` — Download documents archive
- `GET /api/system/backups/:name/download/vectors` — Download vectors archive

All backup endpoints require admin authentication.

### Restore Procedure

Restoration is initiated via `restoreService` and requires taking services offline:

1. **Stop the server and collector:**

```bash
docker compose stop server collector widget
```

2. **Restore the database:**

```bash
docker exec -i simmetric-chat-db psql -U simmetricchat -d simmetricchat < backup-*/dbdump.sql
```

3. **Restore documents and vectors:**

```bash
cd /var/lib/docker/volumes/simmetric-chat_collector-storage/_data
unzip /path/to/backup-*/documents.zip
unzip /path/to/backup-*/vectors.zip
```

4. **Restart services:**

```bash
docker compose start server collector widget
```

<!-- VERIFY: Volume host paths vary by Docker storage driver and installation method. Adjust paths for your environment. -->

**Critical:** Do **not** rotate `JWT_SECRET` (or `ENCRYPTION_KEY`) without first re-encrypting backup-destination configs or you will lose the ability to decrypt stored destination credentials. If you must rotate `JWT_SECRET`, decrypt all `BackupDestination.config` values with the old secret, rotate, then re-encrypt with the new secret. See [ENCRYPTION_KEY_ROTATION.md](ENCRYPTION_KEY_ROTATION.md) for the rotation procedure.

## Monitoring and Health Checks

### Service Health Endpoints

Every application service exposes a health endpoint:

| Service | Endpoint | Auth Required |
|---------|----------|---------------|
| Server | `GET /api/health` | No |
| Collector | `GET /api/health` | No |
| Widget | `GET /health` | No |

### Compose Healthchecks

All services except `frontend` configure a healthcheck:

| Service | Probe | Interval / Start period |
|---------|-------|------------------------|
| `server` | `wget --spider http://localhost:3000/api/health` | 30s / 40s |
| `collector` | `wget --spider http://localhost:3210/api/health` | 30s / 15s |
| `widget` | `wget --spider http://localhost:3211/health` | 30s / 15s |
| `postgres` | `pg_isready -d <db> -U <user>` | 5s / 10s |
| `redis` | `redis-cli ping` | 10s / 5s |
| `ollama` | `ollama ls >/dev/null` (the image ships no curl/wget — the probe talks to the local daemon via its own binary) | 30s / 40s |
| `qdrant` | `bash -c 'exec 3<>/dev/tcp/127.0.0.1/6333'` (the image ships no curl/wget and `/bin/sh` lacks `/dev/tcp`, so bash is invoked explicitly) | 30s / 10s |

Note: the collector and widget healthchecks use `wget --spider`; the runtime images install `wget` explicitly (`apt-get install` for the collector on Debian slim — `node:24-slim` ships without `wget`).

### Server Health Details

`GET /api/health` returns a lightweight status object. In production it is used by the Compose healthcheck as well as external load balancers.

### Logging

Structured logging is provided by Winston:

- **Console** — All levels, colorized, with module prefixes (`[server]`, `[agent]`, `[backup]`)
- **File: `storage/logs/error.log`** — Error-level only, 5 MB rotation, 3 retained files
- **File: `storage/logs/combined.log`** — All levels, 5 MB rotation, 5 retained files
- **Log level** — Controlled by `LOG_LEVEL` environment variable (default: `info`)

In Docker, logs are written to the container filesystem inside the mounted storage volume. Collect them with:

```bash
docker logs simmetric-chat-server
docker exec simmetric-chat-server cat /app/storage/logs/combined.log
```

### Scheduler Jobs

The server starts its background jobs depending on `NODE_ENV`:

**Production-only — pg-boss cron jobs** (Postgres-backed queues with native SKIP LOCKED dedup; `0 3 * * *` aligns to 03:00 UTC):

| Job | Cron | Purpose |
|-----|------|---------|
| MCP health check | `*/30 * * * *` | Polls every 30 min — see [MCP Health Monitoring](#mcp-health-monitoring) |
| MCP reaper | `*/5 * * * *` | Probes `listTools` on installed connections, disconnects stale |
| Synthesis reaper | `*/15 * * * *` | Flips orphaned PROCESSING synthesis runs to FAILED |
| Vector cleanup | `*/5 * * * *` | Removes orphaned vectors |
| Fidelity sampling | `0 3 * * 0` | Weekly Sunday 03:00 UTC |
| Wiki consistency | `0 * * * *` | Hourly archive/keyword consistency pass |
| Upload draft reaper | `0 3 * * *` (configurable via the `upload_draft_reaper_cron` system setting) | Daily 03:00 UTC removal of expired upload drafts |
| Chat message reaper | `0 3 * * *` | Daily 03:00 UTC retention enforcement |
| **Backup jobs** (enterprise plugin) | per `BackupJob` cron expression | Bree multi-job scheduler registered via `registerScheduler`; stopped during graceful shutdown |

**All environments — in-process pollers** (`setInterval`, 10s, with an isRunning overlap guard):

- **OCR/URL ingestion pipeline** — claims PENDING jobs; global concurrency limit of 2 active jobs
- **Synthesis pipeline** — dispatches pending synthesis jobs

Job failures are logged but do not crash the server process.

### MCP Health Monitoring

MCP connections installed from the marketplace are polled every 30 minutes (pg-boss cron). Each connection transitions through three states:

- **healthy** — Successful ping with retry-exhausted success
- **stale** — 1-2 consecutive failures
- **down** — 3+ consecutive failures

Status is visible in the admin panel and exposed via the MCP marketplace API.

## Host-Native Dev Networking

There are two distinct networking models depending on how you run the stack:

- **`pnpm dev` (host-native app)** — The server, collector, widget, and frontend run as Node/Vite processes on the host, NOT in containers. Therefore they reach Ollama and Qdrant via `localhost`, **not** container names. Set `OLLAMA_BASE_URL=http://localhost:11434` and (if using Qdrant) point `VECTOR_DB_URL` at `http://localhost:6333`. For the database, use `docker-compose.infra.yml` which binds PostgreSQL to `${POSTGRES_PORT:-5432}:5432` on the host, and set `DATABASE_URL=postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat`.

- **Pure Docker (`docker-compose.yml`)** — All services are containers on the compose bridge network. Use container hostnames: `OLLAMA_BASE_URL=http://ollama:11434`, `COLLECTOR_URL=http://collector:3210`, `DATABASE_URL=postgresql://...@postgres:5432/...`.

Mixing the two (e.g. pointing a host-native server at `http://ollama:11434`) will fail with a connection refused because the host has no `ollama` hostname.

## Scaling Considerations

### Horizontal Scaling

The current architecture is designed for single-node Docker Compose deployments. To scale horizontally:

1. **Move PostgreSQL to a managed database** (e.g., Amazon RDS, Google Cloud SQL, or a dedicated Postgres VM) and update `DATABASE_URL`. Ensure the managed Postgres has the `pgvector` extension available.
2. **Move LanceDB to Qdrant, pgvector, or Chroma** and run the vector store as a clustered or managed service. Update `VECTOR_DB_PROVIDER` and `VECTOR_DB_URL` accordingly. pgvector reuses the existing PostgreSQL instance (enable the `pgvector` extension).
3. **Run multiple server replicas** behind a load balancer. Ensure sticky sessions for SSE endpoints and **explicitly set `REDIS_URL`** so all replicas share the Redis-backed rate-limit stores, auth/JWT caches, SSE pub/sub fan-out, and pg-boss job dedup. The compose stack already runs Redis and wires `REDIS_URL=redis://redis:6379` into the server and widget.
4. **Scale the collector independently** by running multiple collector containers and load-balancing across them. The server already communicates via HTTP, so any HTTP load balancer works.
5. **Complete secret provisioning once before scaling the server** — concurrent first-boot replicas could each auto-generate a divergent `ENCRYPTION_KEY`/`API_KEY_HMAC_SECRET` (see [Production secret provisioning (Docker)](#production-secret-provisioning-docker)).

The full multi-instance guide (Redis layer, pg-boss dedup, shared-secret requirements) lives in [SCALING.md](SCALING.md).

### Rate Limiting at Scale

The default rate limiters use in-memory stores unless `REDIS_URL` is set. For multi-replica deployments, ensure a Redis-backed store compatible with `express-rate-limit` is configured on every instance:

<!-- VERIFY: Redis rate-limit store configuration is not included in the repository; configure according to your infrastructure. -->

### Resource Requirements

| Service | Baseline RAM | Notes |
|---------|-------------|-------|
| Server | 512 MB | Scales with concurrent SSE connections |
| Collector | 512 MB | Spikes during large document ingestion |
| Widget | 256 MB | Lightweight proxy service |
| Frontend (Nginx) | 128 MB | Static files, proxying, TLS |
| PostgreSQL | 1 GB | Scales with dataset size and connection count |
| Redis | 256 MB | Capped by `--maxmemory 256mb` in compose |
| Ollama | 4-8 GB | Depends on model size; GPU passthrough optional |
| Qdrant | 1 GB | Runs by default in compose; scales with vector count |

### Storage Growth

- **Documents** — Stored in `collector-storage` after parsing; growth is proportional to uploaded file volume.
- **Vectors** — Stored in the configured vector store (LanceDB, Qdrant, pgvector, or Chroma); each document chunk produces one embedding vector.
- **Backups** — Written to `storage/backups/final/`; growth is bounded per-job by `retentionDays`.
- **Logs** — Rotated automatically by Winston; maximum retained size is approximately 40 MB per service.

## Air-Gapped Deployment Notes

Simmetric Chat is designed to operate without internet connectivity. The default providers are all self-hosted:

- **LLM** — Ollama (local inference)
- **Embeddings** — `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2` (local, no API calls). For HuggingFace v3 runtime, set `EMBEDDING_PROVIDER=hf-local` (`@huggingface/transformers`); both are air-gap compatible.
- **Vector DB** — LanceDB (file-based, no external service)
- **Frontend assets** — Bundled into the Nginx image; no CDN references
- **PostgreSQL pgvector extension** — Bundled in the `pgvector/pgvector:pg16` image and in the single-container Dockerfile via `postgresql16-pgvector` apk package (D-08 -01); no internet needed at boot to enable the extension.
- **Enterprise plugin** — Tarball delivery, no npm install, no phone-home (local RS256 license validation only).
- **Reranker** — The collector image bakes the `bge-reranker-v2-m3-ONNX` cache into the image (`RERANKER_CACHE_DIR=/app/.cache/huggingface`, seeded before build with `pnpm --filter collector seed:reranker`) and defaults `HF_ALLOW_REMOTE_MODELS=false` — a cache miss throws fail-loud instead of downloading. Note: the Compose environment block sets `HF_ALLOW_REMOTE_MODELS=${HF_ALLOW_REMOTE_MODELS:-true}`, which **overrides the image default** — set it to `false` in the root `.env` for strict air-gap operation.

### HuggingFace Cache Directory

The default HuggingFace transformers cache lives under `node_modules/.pnpm/.../.cache/huggingface/`. In air-gap production this is a **landmine**: `pnpm install --prod` wipes `node_modules` and the cache is regenerated empty, forcing a re-download the next time embeddings initialize. Set `HF_CACHE_DIR` to a path **outside** `node_modules` (e.g. `/app/storage/hf-cache`) and bake the model files into a volume mounted at that path. This applies to both `local` (Xenova) and `hf-local` (HuggingFace v3) providers.

### Single-Container Air-Gap Steps

1. Build the image on an internet-connected machine:

```bash
docker build -f docker/Dockerfile -t simmetric-chat:airgap ..
```

2. Save and transfer the image:

```bash
docker save simmetric-chat:airgap | gzip > simmetric-chat-airgap.tar.gz
```

3. On the air-gapped host, load and run:

```bash
docker load < simmetric-chat-airgap.tar.gz
docker run -d \
--name simmetric-chat \
-p 3000:3000 -p 3210:3210 -p 3211:3211 \
-v simmetric-storage:/app/storage \
-e JWT_SECRET=<strong-secret> \
simmetric-chat:airgap
```

4. The container includes its own PostgreSQL instance (with pgvector) and supervisord (postgres → server → collector → widget). No external database is required.

### Offline Model Preparation

Ollama does not auto-pull models in this deployment. The server only requests models confirmed available via `/api/tags` (`isAvailable=true`), so unknown models are never sent to Ollama (which would trigger an auto-pull). Pre-pull the desired model before creating the air-gap image, or run `ollama pull` on the offline host after copying the model weights manually:

```bash
docker exec simmetric-chat-ollama ollama pull gemma4:latest
```

<!-- VERIFY: Model binary transfer procedures depend on your organization's secure transfer protocols. -->

### Telemetry

The application does not phone home — no external telemetry endpoints are configured in the codebase, and the enterprise package emits no usage data. The Compose file injects `DISABLE_TELEMETRY=${DISABLE_TELEMETRY:-true}` into the server, i.e. **telemetry is disabled by default in Docker**. Set `DISABLE_TELEMETRY=true` in the root `.env` if you want to be explicit outside Compose.

### Verifying Air-Gap Compliance

After deployment, confirm no external egress by inspecting container network traffic:

```bash
docker stats
# Or use host-level packet capture to verify no outbound connections to external IPs
```

No external API keys are required for core functionality when using Ollama + local embeddings + LanceDB.

---

## See also

- [Documentation index](./INDEX.md)
- [Configuration](./CONFIGURATION.md)
- [Getting Started](./GETTING_STARTED.md)
- [Enterprise plugin](./ENTERPRISE_PLUGIN.md)
- [Multi-Instance Scaling](./SCALING.md)
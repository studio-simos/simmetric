
# Getting Started

This guide walks you through installing Simmetric Chat from source, configuring the environment, initializing the database, and starting all services for local development.

---

## Prerequisites

| Tool | Version | Required | Notes |
|------|---------|----------|-------|
| Node.js | `>= 24.0.0` | Yes | Runtime for all packages (pinned in root `package.json` `engines`) |
| pnpm | `11.24.0` | Yes | Monorepo package manager (locked via `packageManager` field in root `package.json`) |
| PostgreSQL | `16` | Yes | Primary database (the Docker image is `pgvector/pgvector:pg16` — the pgvector extension is bundled for air-gap RAG) |
| Ollama | latest | Recommended | Local LLM inference (air-gap compatible) |
| Docker + Docker Compose | latest | Optional | Simplifies PostgreSQL and Ollama setup |
| Git | any | Yes | To clone the repository |

### Verify your environment

```bash
node --version # Must print v24.x.x or higher
pnpm --version # Must print 11.24.0
git --version
```

If `pnpm` is missing, enable it via Corepack:

```bash
corepack enable
corepack prepare pnpm@11.24.0 --activate
```

---

## 1. Clone and Install

```bash
git clone <repository-url> simmetric-chat
cd simmetric-chat
pnpm install
```

`pnpm install` downloads dependencies for all monorepo packages (`packages/server`, `packages/frontend`, `packages/collector`, `packages/shared`, `packages/widget`) and sets up workspace links. This also installs **pg-boss** (the Postgres-backed job queue used by the server's background schedulers) — no separate daemon to run and no manual schema setup: the server auto-creates the `pgboss` schema on boot.

---

## 2. Environment Configuration

Simmetric Chat uses a **single root `.env`** (repo root, gitignored) as its runtime config. Copy the root template and fill in the secrets — docker compose injects it into every container via `env_file`, and (since ) every package loader reads the root file (resolution: `process.env` > root `.env` > Zod default).

The per-package `.env` override layer that shipped during the transition has been **removed** — `packages/server/.env`, `packages/collector/.env`, and `packages/widget/.env` no longer exist and are never read. The loader resolves only the root `.env` (marker-walk up to `pnpm-workspace.yaml`, independent of the operator's `process.cwd()`).

> **Do not create a fresh `packages/server/.env`** (or a collector/widget one — they are no longer read). The root `.env` is the single runtime config — `cp .env.example .env` at the repo root; the root `.env.example` documents every key with per-package `[server]`/`[collector]`/`[widget]` markers.

### Root (`.env` — the single runtime config)

```bash
cp .env.example .env
```

Then set the required secrets in `.env`:

```bash
# Required — generate a secure random secret (Zod-validated min 1 char)
JWT_SECRET=$(openssl rand -hex 32)

# Required — shared secret for server↔collector communication (min 1 char, Zod-validated)
COLLECTOR_SECRET=$(openssl rand -hex 32)

# Required when API keys are used — base64 32-byte HMAC-SHA256 signing key for
# API-key auth (server-side validation fails loud with a 500 if unset)
API_KEY_HMAC_SECRET=$(openssl rand -base64 32)

# Data-at-rest encryption key (provider API keys, backup destination configs).
# REQUIRED in production — the server refuses to boot (process.exit(1)) when
# NODE_ENV=production and ENCRYPTION_KEY is unset. Dev/test may omit it: the
# server falls back to scryptSync(JWT_SECRET) derivation (legacy compatibility).
# ENCRYPTION_KEY=$(openssl rand -base64 32)

# PostgreSQL connection (localhost when running pnpm dev against Docker infra)
DATABASE_URL=postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat

# LLM provider (ollama is the local-first default; LLM_MODEL defaults to gemma4:latest)
# The code default is http://ollama:11434 (Docker service name); for host-native dev
# against a systemd Ollama on 127.0.0.1 set OLLAMA_BASE_URL=http://localhost:11434
# (see docker/docker-compose.infra.yml — Ollama is intentionally NOT containerized
# in the dev workflow; LLM keys are also admin-editable in Settings → SystemConfig).
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
LLM_MODEL=gemma4:latest

# Collector endpoint
COLLECTOR_URL=http://localhost:3210

# Redis (optional — enables horizontal scaling: auth cache, token revocation,
# SSE fan-out, distributed locks, Redis-backed rate limits). Single-instance
# mode with graceful degradation when absent.
# REDIS_URL=redis://localhost:6379

# License (optional — Community Edition when unset). Diagnose with:
# pnpm license:check # human-readable verdict (exit 0/1/2)
# pnpm license:check -- --json # machine-readable CheckResult
# LICENSE_KEY=
# (the public key is embedded in the source — no secret needed to verify)

# Bootstrap admin auto-seed (default true). On a fresh install the setup wizard
# owns admin creation and this seed is SKIPPED while setup_wizard_mode is
# "active". It only fires when the wizard mode is "completed" but no admin
# exists (e.g. pre-wizard installs). The seeded admin/admin123 account is
# created with mustChangePassword=true, so the first login forces a rotation.
# Set to false to disable this fallback entirely.
SEED_BOOTSTRAP_ADMIN=true
```

> **Note on `ALLOW_REGISTRATION`:** The Zod schema in `packages/server/src/config/env.ts` defaults to `false` when the variable is absent. Self-service signup stays closed by default; new users are created by an admin via `POST /api/auth/admin-register`. The setup wizard also forces `ALLOW_REGISTRATION=false` when it initializes a fresh install.

### Collector

The collector needs no dedicated file: it inherits `SERVER_URL` and
`COLLECTOR_SECRET` from the root `.env`, and its embedding/vector config is
pushed at runtime by the server (`/api/system/settings/embedding-config`).
Defaults: `EMBEDDING_PROVIDER=local`, `VECTOR_DB_PROVIDER=lancedb`.

> `EMBEDDING_PROVIDER` accepts `local` (Xenova 2.x, default), `openai`, `ollama`, or `hf-local` (HuggingFace v4, air-gap). `VECTOR_DB_PROVIDER` accepts `lancedb` (default, air-gap), `qdrant`, `pgvector` (reuses PostgreSQL), or `chroma` (embedded, mid-scale).

### Widget — optional

The widget service only needs to run if you are developing or testing the embeddable widget. `WIDGET_PORT=3211`, `SERVER_URL`, and `WIDGET_API_KEY` are already covered by the root `.env`/defaults — no per-package file is needed.

---

## 3. Database Setup

### Option A: PostgreSQL via Docker (recommended for local dev)

The main `docker/docker-compose.yml` exposes PostgreSQL on `${POSTGRES_PORT:-5432}:5432` to the host, but it also boots the full application stack (frontend, server, collector, widget, Ollama) — heavier than what a host-native `pnpm dev` workflow needs. For local development where the Node services run host-native and only need PostgreSQL, use the dedicated infra compose file (built for the dev-container workflow — infra only, no app containers):

```bash
docker compose -f docker/docker-compose.infra.yml up -d postgres
```

This starts PostgreSQL 16 (with the pgvector extension bundled) with:

- User: `simmetricchat`
- Password: `simmetricchat`
- Database: `simmetricchat`
- Host port: `5432` (configurable via `POSTGRES_PORT`)

> **Redis (optional, v0.19 scale layer):** the infra compose file does not include a Redis service. To enable horizontal scaling (auth cache, token revocation, SSE fan-out, distributed locks, Redis-backed rate limits), run Redis 7 any way you like — e.g. `docker run -d --name simmetric-chat-redis -p 6379:6379 redis:7-alpine` — and set `REDIS_URL=redis://localhost:6379` in the root `.env`. When `REDIS_URL` is absent, every Redis consumer degrades gracefully to its in-memory/DB fallback (`getRedis()` returns `null`), so Redis is never required for a single-instance setup.

### Option B: Existing PostgreSQL instance

Create the database and user manually, then set `DATABASE_URL` accordingly.

### Generate Prisma Client

```bash
pnpm db:generate
```

This runs `prisma generate` inside the server package, then applies the pnpm symlink fix (`scripts/fix-prisma-pnpm.cjs`) required by Prisma 7.x + pnpm.

### Apply Migrations

```bash
pnpm --filter server db:migrate
```

This runs `prisma migrate dev` interactively. For a fresh database, confirm the migration name when prompted.

> **Note on `tsvector` columns:** The `searchVector` / `searchVectorMulti` columns (on `document_chunks`, plus `searchVector` on `archive_pages`) are plain `tsvector` columns defined in the initial migration — there are no `CREATE TRIGGER` statements or trigger functions in `packages/server/prisma/migrations/`. The vector values are populated by explicit `INSERT` statements in `routes/documents.ts` and `routes/system.ts`, by runtime `UPDATE`s in `services/wikiEmbeddingService.ts` and `services/archivePageService.ts` (both set `archive_pages."searchVector"` via `$executeRaw`), and by a one-time idempotent backfill `UPDATE` in the init migration — so `prisma migrate dev` does not drift on them. `services/ftsService.ts` is SELECT-only — it reads `searchVectorMulti` via `$queryRaw` for FTS search and never writes it. For production, always use `npx prisma migrate deploy`.

### Seed Default Data

There are two seeding paths and they create **different** admin accounts. You do not need both — pick one.

#### Path A: Manual full seed (`pnpm --filter server db:seed`)

```bash
pnpm --filter server db:seed
```

Runs `prisma/seed.ts` and creates:

- **Roles:** Admin, User (Admin is the de-facto superuser — `DEFAULT_ADMIN_ROLE.permissions = [...PERMISSION_NAMES]` auto-inherits all 31 permissions)
- **Permissions:** 31 permission names mapped to roles via `RolePermission`
- **Menu sections:** 13 sidebar sections seeded via `DEFAULT_ROLE_MENU_SECTIONS`: `dashboard`, `chat`, `documents`, `knowledgeBase`, `workspaces`, `projects`, `marketplace`, `mcpConnections`, `eventLog`, `analytics`, `widget`, `settings`, `uploads`
- **System config:** Default LLM, embedding, and vector DB settings
- **MCP catalog:** Pre-populated marketplace entries
- **Provider presets:** One-click LLM provider catalog
- **Users:**
- `admin` / `admin123` (email: `admin@simmetric-chat.local`) — assigned Admin role
- `user` / `user123` (email: `user@simmetric-chat.local`) — assigned User role
- `widget-service` / random secret (email: `widget@simmetric-chat.local`) — service account that authenticates via API key, never password login

> The seeded `admin` account carries `mustChangePassword=true` (same as the bootstrap admin) — the first login forces a rotation via `POST /api/auth/set-initial-password`. The demo `user` account does not carry the flag and logs in directly. This path is intended for development demos. Rotate credentials before exposing the instance.

#### Path B: Bootstrap admin auto-seed (server startup fallback)

When the server starts and no admin user exists yet, `seedBootstrapAdmin()` (called from `src/index.ts`) creates a single admin account from env vars — **but only when the setup wizard is not active**. On a fresh install (`setup_wizard_mode=active`) the wizard owns admin creation and this seed is skipped:

- Username: `SEED_ADMIN_USERNAME` (default `admin`)
- Password: `SEED_ADMIN_PASSWORD` (default `admin123`)
- Email: `SEED_ADMIN_EMAIL` (default `admin@example.com`)
- `mustChangePassword: true` — the bootstrap password is single-use and must be rotated at first login via `POST /api/auth/set-initial-password`

Gated by `SEED_BOOTSTRAP_ADMIN` (default `true`). Set to `false` in deployments that manage their first admin out-of-band. Idempotent: skipped once any admin user already exists.

> On a fresh database, `GET /api/system/is-initialized` returns `{ initialized: false, setupWizardMode: "active" }` and the frontend renders the Setup Wizard (section 5.1a) instead of the login page. The bootstrap admin path (section 5.1c) only applies when the wizard mode is `completed` but no admin exists.

---

## 4. Starting Services

### All services at once (recommended)

```bash
pnpm dev
```

This runs `turbo dev`, which starts:

- Server on `http://localhost:3000`
- Collector on `http://localhost:3210`
- Frontend on `http://localhost:5173`
- Widget on `http://localhost:3211` (if configured)

> **Background schedulers:** the server's 8 background schedulers run as **pg-boss cron jobs** (not `setInterval` timers) — introduced with the pg-boss scheduler migration. pg-boss uses the same `DATABASE_URL` as app data and auto-creates its `pgboss` schema on server boot — no manual setup, no extra daemon. On a fresh database you will see `[jobQueue] pg-boss started` in the server logs. The two latency-sensitive 10-second pollers (OCR + synthesis pipelines) intentionally remain in-process `setInterval` loops. When Postgres is unreachable, pg-boss degrades gracefully (`getBoss() === null`) and the server keeps serving REST/SSE.

### Individual services (for debugging)

```bash
# Terminal 1 — API server
pnpm --filter server dev

# Terminal 2 — Document ingestion
pnpm --filter collector dev

# Terminal 3 — React frontend
pnpm --filter frontend dev

# Terminal 4 — Widget service (optional)
pnpm --filter widget dev
```

### Service URLs

| Service | URL | Purpose |
|---------|-----|---------|
| Frontend | `http://localhost:5173` | React SPA (Vite dev server) |
| Server API | `http://localhost:3000` | Express API + Swagger docs at `/api-docs` |
| Collector | `http://localhost:3210` | Document ingestion microservice |
| Widget | `http://localhost:3211` | Embeddable widget server |

---

## 5. First-Time Setup

There are three paths into the system. All end with a logged-in admin.

### 5.1a Setup wizard path — default on a fresh install

If you did **not** run `db:seed`, open `http://localhost:5173` on a fresh database. The frontend detects `setupWizardMode: "active"` from `GET /api/system/is-initialized` and renders the 4-step Setup Wizard instead of the login page:

1. **Admin account** — username, email, and password (min 8 characters).
2. **LLM provider** — Ollama (default, base URL `http://localhost:11434`), OpenAI, Anthropic, or OpenRouter, with a non-blocking "Test connection" probe (`POST /api/system/probe-llm`) that lists available models.
3. **Vector DB** — LanceDB (default), Qdrant, pgvector, or Chroma, with a probe (`POST /api/system/probe-vector`).
4. **Confirm** — submits `POST /api/system/initialize` with `{ username, email, password, config? }`.

The server creates the admin (with `mustChangePassword: false` — the wizard IS the first password set), persists the optional LLM/vector config, closes self-service registration (`ALLOW_REGISTRATION=false`), flips `setup_wizard_mode` to `completed`, and returns a JWT. The wizard stores the token (auto-login) and redirects to `/chat`. The probe and initialize endpoints are wizard-gated: they return `404 { error: "Not found" }` once the mode is `completed`.

### 5.1b Seeded path — log in with the seeded admin

If you ran `pnpm --filter server db:seed` (Path A above), an admin already exists, so the wizard mode is derived `completed` and the login page renders. Log in with:

- **Username:** `admin`
- **Password:** `admin123`

The seeded admin carries `mustChangePassword=true`, so the UI immediately prompts for a new password and calls `POST /api/auth/set-initial-password` with `{ newPassword }`. This endpoint is gated on the `mustChangePassword` flag — it clears the flag and stores the new hash in a single atomic update. Once cleared, password changes must go through `/change-password` (which verifies the current password), so a stolen session token alone cannot take over the account. Use `POST /api/auth/admin-register` (see 5.3) to provision additional users.

### 5.1c Bootstrap admin path — fallback when the wizard is not active

`seedBootstrapAdmin()` runs at server startup when `setup_wizard_mode` is `completed` but no admin user exists (e.g. a pre-wizard install, or an admin that was deleted). It creates a single admin from env vars:

- Username: `SEED_ADMIN_USERNAME` (default `admin`)
- Password: `SEED_ADMIN_PASSWORD` (default `admin123`)
- Email: `SEED_ADMIN_EMAIL` (default `admin@example.com`)
- `mustChangePassword: true` — the bootstrap password is single-use and must be rotated at first login via `POST /api/auth/set-initial-password`

Gated by `SEED_BOOTSTRAP_ADMIN` (default `true`). Idempotent: skipped once any admin user already exists.

### 5.2 Verify system initialization

After any of the three paths, `GET /api/system/is-initialized` returns `{ initialized: true, setupWizardMode: "completed" }`. Once the wizard mode is `completed`, `POST /api/system/initialize` returns `404 { error: "Not found" }` (the D-10 gate — indistinguishable from a missing route). A `409 System is already initialized` is only returned in the race window where the mode is still `active` but an admin already exists.

### 5.3 Create additional users (admin-only)

Self-service registration is closed by default (`ALLOW_REGISTRATION=false`). An authenticated admin creates users via:

```bash
curl -X POST http://localhost:3000/api/auth/admin-register \
-H "Authorization: Bearer <admin-jwt>" \
-H "Content-Type: application/json" \
-d '{"username":"jdoe","email":"jdoe@example.com","password":"strong-pass-123","role":"user"}'
```

`role` is optional; if omitted or set to `user`, the new account gets the default User role. Specify a role name (e.g., `admin`) to assign a different role.

### 5.4 Pull a local LLM model (if using Ollama)

```bash
ollama pull gemma4:latest
```

Or pull a lightweight alternative (e.g. `qwen2.5:3b` for low-VRAM machines):

```bash
ollama pull qwen2.5:3b
```

Ensure Ollama is running:

```bash
ollama serve
```

### 5.5 Create a workspace and start chatting

1. From the sidebar, click **Create Workspace**.
2. Enter a workspace name and select a project.
3. Open the workspace chat and send a message.
4. The agent streams tokens via SSE. Citations appear if RAG documents are uploaded.

---

## 6. Verifying the Installation

### 6.1 Health checks

```bash
# Server health
curl http://localhost:3000/api/health

# Collector health
curl http://localhost:3210/api/health

# Widget health (if running)
curl http://localhost:3211/health
```

Expected responses:

```json
// Server (ok)
{ "status": "ok", "timestamp": "2026-...", "checks": { "database": true, "collector": true, "disk": { "ok": true, "total": ..., "free": ..., "percentFree": ... } } }

// Server (degraded — e.g. collector unreachable)
{ "status": "degraded", "timestamp": "2026-...", "checks": { "database": true, "collector": false, "disk": { "ok": true, ... } }, "details": [{ "check": "collector", "error": "..." }] }

// Collector
{ "status": "ok", "service": "collector" }

// Widget
{ "status": "ok", "timestamp": "2026-..." }
```

### 6.2 Smoke test — API login

```bash
curl -X POST http://localhost:3000/api/auth/login \
-H "Content-Type: application/json" \
-d '{"username":"admin","password":"admin123"}'
```

You should receive a JSON response containing a JWT `token`. (Use your rotated password if you completed the bootstrap-admin path instead of the manual seed.)

### 6.3 Smoke test — Chat stream

```bash
curl -N http://localhost:3000/api/workspaces/:workspaceId/chat/stream \
-H "Authorization: Bearer <your-jwt-token>" \
-H "Content-Type: application/json" \
-d '{"message":"Hello, what can you do?"}'
```

Replace `:workspaceId` with the UUID of a workspace created in the UI. You should see SSE events (`token`, `status`, `done`).

### 6.4 Smoke test — Document ingestion

Upload a document via the frontend **Documents** page. The status should transition from `pending` → `processing` → `completed`. Check the collector logs for parse/chunk/embed/store progress.

### 6.5 Verify the build

```bash
pnpm typecheck # TypeScript checking across all packages (turbo)
pnpm lint # ESLint across all packages (turbo)
pnpm test # Jest suites via Turborepo
```

---

## 7. Common First-Run Issues

### `PrismaClientInitializationError: Can't reach database`

**Cause:** PostgreSQL is not running, not exposed to the host, or `DATABASE_URL` is incorrect.

**Fix:**

```bash
# Verify PostgreSQL is running and port 5432 is exposed to the host
docker compose -f docker/docker-compose.infra.yml ps

# Verify connection string matches your setup
grep DATABASE_URL .env
```

If running `pnpm dev` against Docker, the infra compose file is lighter (infra only, no app containers) and exposes `${POSTGRES_PORT:-5432}:5432` to the host, so `DATABASE_URL=postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat` works for host-native Node services:

```bash
docker compose -f docker/docker-compose.infra.yml up -d postgres
```

### `Error: JWT_SECRET is required`

**Cause:** `JWT_SECRET` is missing from the root `.env`.

**Fix:**

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
```

### `Error: COLLECTOR_SECRET is required`

**Cause:** `COLLECTOR_SECRET` is missing from the root `.env`. This variable is required for server↔collector communication (Zod-validated `min(1)` in `config/env.ts`).

**Fix:**

```bash
echo "COLLECTOR_SECRET=$(openssl rand -hex 32)" >> .env
```

### `API_KEY_HMAC_SECRET is required when API keys are used` (500 on API-key auth)

**Cause:** `API_KEY_HMAC_SECRET` is unset or not exactly 32 bytes when an API-key-authenticated request arrives. The middleware fails loud with a 500 (never a 401) so misconfiguration is not hidden as "invalid key".

**Fix:**

```bash
echo "API_KEY_HMAC_SECRET=$(openssl rand -base64 32)" >> .env
```

Must be base64-encoded and decode to exactly 32 bytes. Restart the server after setting it — existing API keys are invalidated because the HMAC digest changes.

### Server refuses to boot in production: `ENCRYPTION_KEY is required in production`

**Cause:** `NODE_ENV=production` with `ENCRYPTION_KEY` unset. Since v1.4 the legacy `scryptSync(JWT_SECRET)` derivation is disabled in production (rotating `JWT_SECRET` would silently invalidate every encrypted blob), so the server exits at boot.

**Fix:**

```bash
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
```

Optional in dev/test — the scrypt fallback remains for backward compatibility with existing ciphertexts. See `docs/ENCRYPTION_KEY_ROTATION.md` for rotation guidance.

### `ollama: connection refused` or chat returns no response

**Cause:** Ollama is not running, or `OLLAMA_BASE_URL` points to the wrong address.

**Fix:**

```bash
# Check Ollama status
ollama list

# If running inside Docker, use host.docker.internal
echo "OLLAMA_BASE_URL=http://host.docker.internal:11434" >> .env
```

### `pnpm db:generate` fails with `.prisma` symlink error

**Cause:** Prisma 7.x + pnpm requires a manual symlink inside `@prisma/client`.

**Fix:** The `db:generate` script in `packages/server/package.json` includes the symlink fix command (`scripts/fix-prisma-pnpm.cjs`) automatically. If it fails, run:

```bash
cd packages/server
prisma generate
ln -sf ../../.prisma "$(readlink -f node_modules/@prisma/client)/.prisma"
```

### Collector returns `502 Bad Gateway` or document stays in `processing`

**Cause:** The collector service is not running, or `COLLECTOR_URL` in the server `.env` is incorrect.

**Fix:**

```bash
# Start collector
pnpm --filter collector dev

# Verify collector health
curl http://localhost:3210/api/health
```

### Frontend shows `ECONNREFUSED` when calling `/api/...`

**Cause:** The Vite dev server proxy targets `http://localhost:3000`, but the server is not running.

**Fix:** Start the server before or alongside the frontend:

```bash
pnpm --filter server dev
```

### Setup wizard doesn't appear (login page shows instead)

**Cause:** `setup_wizard_mode` is `completed` — an admin user already exists (e.g. you ran `pnpm --filter server db:seed`, or the wizard already ran). The wizard only renders on a fresh install with no admin.

**Fix:** Log in with the existing admin credentials (seeded `admin`/`admin123` or the account you created in the wizard). To start over, reset the database (drop/recreate the schema) — the wizard mode is derived from admin presence at boot.

### `tsvector` columns and `prisma migrate dev`

**Cause:** Prisma does not natively model PostgreSQL `tsvector` columns, so they are declared as `Unsupported("tsvector")` in the schema (`document_chunks.searchVector`/`searchVectorMulti`, `archive_pages.searchVector`) and defined as plain `tsvector` columns in the initial migration (`00000000000000_init/migration.sql`). There are no `CREATE TRIGGER` statements or trigger functions in `packages/server/prisma/migrations/` — `searchVector` values are written by explicit `INSERT` statements in `routes/documents.ts` and `routes/system.ts`, by runtime `UPDATE`s in `services/wikiEmbeddingService.ts` and `services/archivePageService.ts` (both set `archive_pages."searchVector"` via `$executeRaw`), and by a one-time idempotent backfill `UPDATE` in the init migration — so `prisma migrate dev` does not detect drift from them. `services/ftsService.ts` is SELECT-only — it reads `searchVectorMulti` via `$queryRaw` for FTS search and never writes it.

**Fix:** No special handling is needed for local development — `prisma migrate dev` works normally. For production, always use `npx prisma migrate deploy`.

### `POST /api/auth/set-initial-password` returns 403

**Cause:** The endpoint is gated on `mustChangePassword=true`. Once the flag is cleared (after the first-login rotation) or never set (wizard-created admins from section 5.1a), calling this endpoint returns `403 This endpoint is only available when a password change is required`.

**Fix:** Use `POST /api/auth/change-password` (which verifies the current password) for all subsequent password changes.

### `POST /api/auth/register` returns 403

**Cause:** Self-service registration is closed — `ALLOW_REGISTRATION=false` (the Zod default). Only admins can create users.

**Fix:** Authenticate as an admin and use `POST /api/auth/admin-register` instead.

---

## Docker Quick Start

For an all-in-one containerized deployment (frontend, server, collector, widget, PostgreSQL, Ollama in one network):

```bash
docker compose -f docker/docker-compose.yml up --build -d
```

PostgreSQL 16 (image `pgvector/pgvector:pg16`, pgvector extension bundled) starts automatically (no profile gate) and exposes `${POSTGRES_PORT:-5432}:5432` to the host. Redis 7 (`redis:7-alpine`, `--maxmemory 256mb --maxmemory-policy allkeys-lru`) also starts automatically (no profile gate) and is wired into the server and widget containers via `REDIS_URL=redis://redis:6379`, enabling the horizontal-scaling features described in section 3. Qdrant (`qdrant/qdrant:latest`) starts automatically as well; the default `VECTOR_DB_PROVIDER=lancedb` does not use it, so it sits idle unless you switch providers. Chroma is commented out in the compose file — uncomment it and add a `chroma-data` volume if you want to use `VECTOR_DB_PROVIDER=chroma`.

In the main compose file, the server container reaches PostgreSQL as `postgres:5432` (Docker network DNS). Migrations run automatically on the server container startup via `docker/entrypoint-server.sh`: in production it first auto-provisions the production secrets (`ENCRYPTION_KEY`, `API_KEY_HMAC_SECRET`), then `prisma generate` → `prisma migrate deploy` → `prisma db seed` → the server binary.

**Secret auto-provisioning (/163):** when `NODE_ENV=production` and a secret is absent, `docker/provision-encryption-key.sh` restores it from `/app/storage/.encryption-key` / `.api-key-hmac-secret` inside the `server-storage` volume — or generates it once and persists it there (with a loud BACK IT UP warning on first boot). Operator-supplied values (root `.env` via `env_file`) always win. A corrupt persisted file fails the boot — it is never silently regenerated, since a different `ENCRYPTION_KEY` would brick stored provider API keys and a different `API_KEY_HMAC_SECRET` would invalidate every issued API key.

**Enterprise plugin (optional):** the compose file mounts `../../simmetric-enterprise` (the sibling private repo) at `/simmetric-enterprise:ro` with `NODE_PATH=/app/packages/server/node_modules:/simmetric-enterprise/node_modules`, so the loader's `require.resolve("@simmetric-chat/enterprise")` finds the plugin at boot. Without it the server runs in Community mode (graceful degradation). See `docs/ENTERPRISE_PLUGIN.md` for the air-gap tarball runbook and `DEPLOYMENT.md` for the full path-mapping rationale.

For local development where you need host access to PostgreSQL (e.g., running `pnpm dev` host-native), use the infra compose file as described in section 3.

---

## Tauri Desktop App

The frontend can be wrapped as a Tauri 2.x desktop app:

```bash
pnpm tauri:dev # Dev mode (wraps the running Vite frontend)
pnpm tauri:build # Production build of the desktop binary
```

Tauri configuration lives in `src-tauri/` (`tauri.conf.json`, `Cargo.toml`, `build.rs`).

---

## Air-Gap Notes

Simmetric Chat is local-first by default:

- **No phone home:** `DISABLE_TELEMETRY=true` is the env default.
- **Local embeddings:** `EMBEDDING_PROVIDER=local` (Xenova 2.x, `Xenova/all-MiniLM-L6-v2`, 384-dim) is the default and runs fully offline. `EMBEDDING_PROVIDER=hf-local` enables the HuggingFace v4 runtime (`@huggingface/transformers` ^4.2.0) for air-gap. OpenAI/Ollama embedding providers are opt-in.
- **Local vector store:** `VECTOR_DB_PROVIDER=lancedb` (default) runs in-process with no external server. Qdrant and pgvector are opt-in alternatives.
- **No Redis required:** `REDIS_URL` is unset by default — the system runs in single-instance mode with in-memory/DB fallbacks. Redis is an opt-in scale layer (v0.19) for multi-instance deployments.
- **Local LLM:** `LLM_PROVIDER=ollama` is the default, pointing at a host-native Ollama daemon (typically `http://localhost:11434` in dev). OpenAI, Anthropic, OpenRouter, Gemini, and 15+ OpenAI-compatible providers (DeepSeek, Mistral, Kimi, Qwen, xAI, Z.AI/GLM, MiniMax, LM Studio, etc.) are opt-in — any OpenAI-compatible endpoint can be added via Settings → Providers.
- **Bundled fonts:** `@fontsource-variable/inter`, `@fontsource-variable/geist`, `@fontsource/jetbrains-mono` ship in the frontend bundle — no Google Fonts CDN call.

---

## Next Steps

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System overview, component diagram, and data flow
- **[CONFIGURATION.md](CONFIGURATION.md)** — Full environment variable reference and config file format
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — Local development setup, monorepo workflow, code style
- **[TESTING.md](TESTING.md)** — Test framework, commands, integration harness, E2E, CI pipeline
- **[USAGE.md](USAGE.md)** — User guide: chat, documents, widgets, settings, analytics
- **[ADMIN.md](ADMIN.md)** — RBAC setup, roles, and license management (including the `pnpm license:check` diagnostics CLI)
- **[WIDGET.md](WIDGET.md)** — Embeddable chat widget integration guide
- **[MCP_MARKETPLACE.md](MCP_MARKETPLACE.md)** — MCP Marketplace user guide
- **[SCALING.md](SCALING.md)** — Multi-instance deployment guide (Redis, pg-boss, `ENCRYPTION_KEY` / `API_KEY_HMAC_SECRET` hard-defaults)

---

## See also

- [Documentation index](./INDEX.md)
- [Development Guide](./DEVELOPMENT.md)
- [Configuration](./CONFIGURATION.md)

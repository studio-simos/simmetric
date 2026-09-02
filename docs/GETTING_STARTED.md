<!-- generated-by: gsd-doc-writer -->
# Getting Started

This guide walks you through installing Simmetric Chat from source, configuring the environment, initializing the database, and starting all four services for local development. Simmetric Chat is a local-first AI chat workspace with RAG, RBAC, and an embeddable widget — defaulting to fully local components (Ollama LLM, LanceDB vector store, local embeddings).

---

## Prerequisites

| Tool | Version | Required | Notes |
|------|---------|----------|-------|
| Node.js | `>= 24.0.0` | Yes | Enforced via the `engines` field in the root `package.json` |
| pnpm | `11.24.0` | Yes | Pinned via the `packageManager` field in the root `package.json` (includes an integrity hash) |
| PostgreSQL | `16` | Yes | Primary database; the Docker image `pgvector/pgvector:pg16` bundles the pgvector extension |
| Git | any | Yes | To clone the repository |
| Ollama | latest | Recommended | Local LLM inference (the `LLM_PROVIDER=ollama` default; air-gap compatible) |
| Docker + Docker Compose | latest | Optional | Easiest way to run PostgreSQL locally; also enables the all-in-one container path |

Verify your environment:

```bash
node --version   # must print v24.x.x or higher
pnpm --version   # must print 11.24.0
```

If `pnpm` is missing, activate it with Corepack (bundled with Node.js):

```bash
corepack enable
corepack prepare pnpm@11.24.0 --activate
```

---

## Installation steps

### 1. Clone and install

```bash
git clone git@github.com:studio-simos/simmetric simmetric-chat
cd simmetric-chat
pnpm install
```

`pnpm install` installs dependencies for all five workspace packages (`packages/server`, `packages/frontend`, `packages/collector`, `packages/shared`, `packages/widget`) and sets up workspace links. This also pulls in **pg-boss** (the Postgres-backed job queue used by the server's background schedulers) — it needs no separate daemon and no manual schema setup: the server auto-creates its `pgboss` schema on boot.

### 2. Configure the environment

The repo-root `.env` is the **single runtime config** — every package (server, collector, widget) reads it; per-package `.env` files do not exist and are never read. Resolution order: `process.env` > root `.env` > code default.

```bash
cp .env.example .env
```

Then set the required secrets in `.env`:

```bash
# Required — the server refuses to boot without these (Zod-validated in
# packages/server/src/config/env.ts; missing keys fail boot with
# "[env] Missing required key(s): ...")
JWT_SECRET=$(openssl rand -hex 32)
COLLECTOR_SECRET=$(openssl rand -hex 32)

# Required by the widget service — any random value works; the server
# registers the env-provided key as an API key at boot (idempotent)
WIDGET_API_KEY=$(openssl rand -hex 32)
```

Key facts about the root `.env`:

- **`JWT_SECRET`** and **`COLLECTOR_SECRET`** are the only strictly required keys for the server (both Zod `.min(1)`). `COLLECTOR_SECRET` is the shared secret the server sends to the collector on every request (HTTP-only boundary — server and collector never import each other).
- **`WIDGET_API_KEY`** is required by the widget service's own Zod schema — the widget process exits without it. Any random string works: at server boot the value is registered as an API key owned by the `widget-service` account (idempotent). If you do not need the widget, the other three services run fine while the widget one is down.
- **`DATABASE_URL`** has a code default of `postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat`. When running the Node services host-native against Dockerized Postgres (the common local setup), use `localhost:5432` instead — pick whichever host matches where Postgres is running.
- **`ENCRYPTION_KEY`** and **`API_KEY_HMAC_SECRET`** are optional in development (dev falls back to a `scryptSync(JWT_SECRET)` derivation and API keys simply stay unusable until the HMAC secret is set). `ENCRYPTION_KEY` is required in production.
- **`LICENSE_KEY`** is optional — absent means Community build.
- The root `.env.example` documents every schema key of every package, organized in per-package sections with `[server]`/`[collector]`/`[widget]` markers. For the full variable reference, see [CONFIGURATION.md](CONFIGURATION.md).

### 3. Start PostgreSQL

The lightweight option for local development — infrastructure only, no app containers (Postgres 16 + pgvector exposed on `${POSTGRES_PORT:-5432}:5432`):

```bash
docker compose -f docker/docker-compose.infra.yml up -d postgres
```

Defaults: user `simmetricchat`, password `simmetricchat`, database `simmetricchat`. With this setup, set in `.env`:

```bash
DATABASE_URL=postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat
```

Alternatively, use any existing PostgreSQL 16 instance and point `DATABASE_URL` at it.

### 4. Initialize the database

```bash
pnpm db:generate          # prisma generate + the Prisma 7 / pnpm symlink fix (scripts/fix-prisma-pnpm.cjs)
pnpm --filter server db:migrate   # applies all pending migrations (prisma migrate dev)
pnpm --filter server db:seed      # optional — seeds roles, permissions, templates, config, and the admin account
```

Notes:

- `db:migrate` runs `prisma migrate dev`, which applies all pending migrations on a fresh database. It only prompts for a name when you are creating a *new* migration. For production, always use `npx prisma migrate deploy`.
- `db:seed` and the server's startup auto-seed create **different** admin paths — you do not need both. If you skip `db:seed`, the setup wizard owns admin creation on first launch (see [First run](#first-run) below).

---

## First run

Start all four services:

```bash
pnpm dev
```

This runs `turbo dev`, which starts every package's dev server in parallel:

| Service | Port | Purpose |
|---------|------|---------|
| Frontend | `:5173` | React 19 SPA (Vite dev server, proxies `/api` to `:3000`) |
| Server | `:3000` | Express 5 API (Swagger UI at `/api-docs`) |
| Collector | `:3210` | Document parse/chunk/embed pipeline |
| Widget | `:3211` | Embeddable widget service |

The server boots slowly the first time (Prisma connect, auto-seed, license init, pg-boss schedulers). The Vite dev proxy retries connection failures for a few seconds — give the server a moment before assuming it is down.

Verify health:

```bash
curl http://localhost:3000/api/health    # server — {"status":"ok",...} (or "degraded" if the collector is unreachable)
curl http://localhost:3210/api/health    # collector
curl http://localhost:3211/health        # widget
```

### First login

Open **http://localhost:5173**. Which login flow you get depends on how the database was initialized:

**Seeded path (you ran `pnpm --filter server db:seed`):** log in with the seeded admin account:

- Username: `admin`
- Password: `admin123`

The seeded account carries `mustChangePassword=true`, so the first login **forces a password rotation** before you can use the app. The seed also creates a demo `user` / `user123` account (no rotation required) and a `widget-service` account that authenticates only via API key.

**Setup wizard path (fresh database, no seed):** the frontend detects the wizard mode from `GET /api/system/is-initialized` and renders a 4-step setup wizard instead of the login page: create the admin account, pick an LLM provider (Ollama default), pick a vector DB (LanceDB default), and confirm. The wizard-created admin does **not** require a password rotation — the wizard password is the first password. The wizard also closes self-service registration.

**Bootstrap admin fallback:** if the server starts with no admin and the wizard is not active (e.g. a pre-wizard install), `SEED_BOOTSTRAP_ADMIN=true` (the default) auto-creates an admin from `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_EMAIL` (defaults `admin` / `admin123` / `admin@example.com`) with `mustChangePassword=true`. This seed is skipped while the setup wizard is active.

### Next steps after login

Self-service registration is closed by default (`ALLOW_REGISTRATION=false`): an authenticated admin creates additional users via the Settings UI or `POST /api/auth/admin-register`. If you use the Ollama default, pull the default model (`LLM_MODEL` defaults to `gemma4:latest`):

```bash
ollama pull gemma4:latest
ollama serve   # if the daemon is not already running
```

For host-native development, set `OLLAMA_BASE_URL=http://localhost:11434` in the root `.env` (the `.env.example` ships with the Docker-network value `http://ollama:11434`).

---

## Docker alternative

To run the entire stack containerized (frontend, server, collector, widget, PostgreSQL 16 with pgvector, Redis 7) in one network:

```bash
docker compose -f docker/docker-compose.yml up --build -d
```

- The root `.env` is injected into every container via `env_file`; inside the compose network the server reaches Postgres as `postgres:5432`.
- Migrations and the seed run automatically on server-container startup via `docker/entrypoint-server.sh` (`prisma generate` → `prisma migrate deploy` → `prisma db seed`), so the manual `db:generate` / `db:migrate` / `db:seed` steps are not needed on this path.
- Ollama is intentionally **not** containerized in the default compose file — point `OLLAMA_BASE_URL` at a host-native daemon (or uncomment the `ollama:` block in the compose file).
- Redis starts automatically and is wired into the server and widget containers via `REDIS_URL=redis://redis:6379` (it enables the horizontal-scaling layer; host-native `pnpm dev` runs fine without Redis).

For the full deployment guide (including air-gap and single-container setups), see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Common setup issues

### Server fails to boot: `[env] Missing required key(s): JWT_SECRET ...`

`JWT_SECRET` or `COLLECTOR_SECRET` is absent from the root `.env`. Both are Zod-validated with `.min(1)` in `packages/server/src/config/env.ts` — the server exits rather than start in an undefined state.

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "COLLECTOR_SECRET=$(openssl rand -hex 32)" >> .env
```

### `PrismaClientInitializationError: Can't reach database`

PostgreSQL is not running, not exposed to the host, or `DATABASE_URL` points at the wrong host. If the Node services run host-native against Dockerized Postgres, the host must be `localhost:5432` (not `host.docker.internal`, which is for the reverse case — containers reaching a host service):

```bash
docker compose -f docker/docker-compose.infra.yml ps   # is postgres up and port 5432 mapped?
grep DATABASE_URL .env
```

### Widget service exits at startup: `WIDGET_API_KEY is required`

The widget package validates `WIDGET_API_KEY` with `.min(1)` in its own `env.ts`. Set any random value in the root `.env` and restart — the server registers it as an API key at boot:

```bash
echo "WIDGET_API_KEY=$(openssl rand -hex 32)" >> .env
```

### Chat returns no response or `ollama: connection refused`

Ollama is not running, the model is not pulled, or `OLLAMA_BASE_URL` is wrong for your setup (use `http://localhost:11434` for host-native dev, `http://ollama:11434` only inside the Docker network):

```bash
ollama list                    # is gemma4:latest present?
ollama pull gemma4:latest      # if not
```

### `pnpm db:generate` fails with a `.prisma` symlink error

Prisma 7 + pnpm needs a manual symlink inside `@prisma/client`. The `db:generate` script already applies the fix (`scripts/fix-prisma-pnpm.cjs`) — if it still fails, re-run `pnpm install` and then `pnpm db:generate` from the repo root.

### Setup wizard does not appear (login page shows instead)

The wizard only renders on a fresh install with no admin user. If you ran `pnpm --filter server db:seed`, an admin already exists and the wizard mode is derived `completed` — log in with the seeded credentials (`admin` / `admin123`, rotation forced on first login) instead.

---

## Next steps

- [ARCHITECTURE.md](ARCHITECTURE.md) — system overview, component diagram, and data flow
- [CONFIGURATION.md](CONFIGURATION.md) — full environment variable reference for the root `.env`
- [DEVELOPMENT.md](DEVELOPMENT.md) — monorepo workflow, code style, database patterns
- [TESTING.md](TESTING.md) — test framework, integration harness, E2E, CI pipeline
- [USAGE.md](USAGE.md) — user guide: chat, documents, widgets, settings, analytics
- [DEPLOYMENT.md](DEPLOYMENT.md) — containerized and air-gap deployment
- [ADMIN.md](ADMIN.md) — RBAC setup, roles, and license management
- [WIDGET.md](WIDGET.md) — embeddable chat widget integration guide
- [Documentation index](INDEX.md) — hub for all docs
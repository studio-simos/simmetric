<!-- generated-by: gsd-doc-writer -->

# Configuration

Simmetric Chat uses a **single runtime configuration file**: the repository-root `.env` (gitignored). Every Node service — server, collector, and widget — reads the same file. There is no per-package `.env` layer: `packages/server/.env`, `packages/collector/.env`, and `packages/widget/.env` do not exist and are never read. The only other tracked env file is `packages/server/.env.test`, which exists solely for the test suites.

Template: [`/.env.example`](../.env.example) is the single exhaustive file. It documents every schema key of every package, organized in per-package sections with `[server]` / `[collector]` / `[widget]` applicability markers. Copy it to `.env` and fill in the secrets:

```bash
cp .env.example .env
```

Generate each secret with `openssl rand -base64 32`.

## How the root `.env` is loaded

All three services load the root file through the zero-dependency loader `loadRootEnv()` in `packages/shared/src/config/loadEnv.ts`:

- **Marker-walk discovery.** Starting from the package's compiled `__dirname` (not `process.cwd()`), the loader walks up parent directories until it finds `pnpm-workspace.yaml` — the repo-root marker. Resolution is therefore independent of where the operator starts the process.
- **Graceful fallback.** In packaged layouts without the marker (e.g., the Tauri desktop build), the load is a no-op: no values are merged, and the process relies on real environment variables. Containers receive env via docker compose `env_file` (see below).
- **Fill-only semantics.** Keys already present in `process.env` are never overwritten.
- **Presence, not truthiness.** `KEY=` (present but empty) counts as a *defined* key. This matters for keys such as `SEED_BOOTSTRAP_ADMIN` and `OIDC_ENABLED`, where a literal `false` must actually disable the feature.
- **No secrets in logs.** The loader and the validators log file paths and key names only — never values.
- **Parser limits.** Trimmed `KEY=VALUE` lines, `#` whole-line comments, optional `export ` prefix, single/double-quoted values stripped. No multiline values and no `${VAR}` expansion.

Each package then validates the merged environment with its own Zod schema (`packages/*/src/config/env.ts`) via a cached `getEnv()`. Invalid or missing required keys are **fail-loud**: the process prints an actionable diagnostic (`Expected .env at: <absolute path>` plus the missing key names and field errors) and exits with `process.exit(1)`.

### Resolution order

```
process.env  >  root .env  >  Zod default
```

This is locked precedence: `loadRootEnv()` only fills keys absent from `process.env`, and each Zod schema supplies defaults for keys absent from both.

### Runtime precedence for system settings (DB vs ENV)

On top of the env loading above, the server manages admin-editable settings in the database (`SystemConfig` table) via `packages/server/src/services/systemConfigService.ts`. Two disjoint resolution rules apply, verified in code:

| Key class | Resolution | UI-editable |
|---|---|---|
| `ALWAYS_READONLY` infra keys: `JWT_SECRET`, `DATABASE_URL`, `SERVER_PORT`, `COLLECTOR_PORT`, `SERVER_URL`, `COLLECTOR_URL` | **ENV > default — never the DB.** These keys are `readOnly: true` in the settings API, and `PUT /api/system/settings` rejects them. | No |
| Every other UI-editable key | **DB > ENV > default.** A DB row (set from the Settings UI) wins over an env value; the settings GET marks such keys with `envOverridden: true` so the UI can show that the env var is currently ineffective. UI edits take effect immediately (Redis cache is invalidated on write). | Yes |

Practical consequence: setting an env var for a UI-editable key only acts as a *fallback* — as soon as an admin saves that key in Settings, the DB value wins.

## Environment variables reference

Everything below mirrors the root `.env.example` and the Zod schemas (`packages/server/src/config/env.ts` — 83 keys, `packages/collector/src/config/env.ts`, `packages/widget/src/config/env.ts` — 6 keys). "Default" is the code default applied when the key is absent from both `process.env` and the root `.env`.

### Shared / bootstrap (cross-service)

| Variable | Applies to | Required | Default | Description |
|---|---|---|---|---|
| `NODE_ENV` | server, widget | No | `development` | `development` / `production` / `test`. |
| `LOG_LEVEL` | server, collector, widget | No | `info` | Server schema is a 4-value enum (`debug`/`info`/`warn`/`error`). The collector and widget loggers read it raw as a plain string. |
| `SERVER_URL` | server, collector, widget | No | `http://localhost:3000` | Canonical server URL. Infra key (`ALWAYS_READONLY` on the server). |
| `COLLECTOR_URL` | server, collector | No | `http://localhost:3210` | Collector ingest service URL. Infra key. |
| `WIDGET_SERVICE_URL` | server | No | `http://localhost:3211` | Widget service URL for push cache-busts. When unset on the server, the push cache-bust is a no-op (a 5-min TTL is the safety net). |
| `SERVER_PORT` | server | No | `3000` | Server HTTP port. Infra key. |
| `COLLECTOR_PORT` | server, collector | No | `3210` | Collector HTTP port. Infra key. |
| `WIDGET_PORT` | widget | No | `3211` | Widget service HTTP port. |
| `DATABASE_URL` | server | No | `postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat` | Postgres connection. Infra key — always env, never DB. Pick the host that matches your setup: `host.docker.internal:5432` (server on host, Postgres in Docker), `localhost:5432` (everything on host), or `postgres:5432` (server inside the compose network). The collector has **no** `DATABASE_URL` by design. |
| `JWT_SECRET` | server | **Yes** | — | Signs JWTs and cookies. Zod `.min(1)`, no default — the server refuses to boot without it. Infra key (never DB). |
| `COLLECTOR_SECRET` | server, collector | **Yes** | — | Shared secret sent by the server on the `X-Collector-Secret` header (HTTP-only server↔collector boundary). Zod `.min(1)` in both packages. |
| `WIDGET_API_KEY` | widget (required), server (optional) | widget: **Yes** | — | Shared secret sent on `X-Api-Key` to the server's internal widget API. Required on the widget (Zod `.min(1)`). Generate server-side with `pnpm --filter server generate-apikey`; when unset on the server, the push cache-bust is a no-op. |
| `API_KEY_HMAC_SECRET` | server | No | — | Base64 32-byte HMAC-SHA256 signing key for local API keys. Optional in the schema, but **fail-loud at use**: if an API key is actually used without it, the middleware returns 500 rather than silently accepting. |
| `ENCRYPTION_KEY` | server | Prod: **Yes** | — | Base64 32-byte AES-256-GCM data-at-rest key (provider API keys, backup destination configs). When unset, falls back to legacy `scryptSync(JWT_SECRET)` derivation — **but is required in production** (`NODE_ENV=production` throws at boot). Docker entrypoint auto-generates and persists one at `/app/storage/.encryption-key` when not supplied. |
| `REDIS_URL` | server, widget | No | — | Enables horizontal scaling (auth/config caches, SSE fan-out, distributed rate limits, Bree mutex). Absent = graceful single-instance fallback. Env-only key. |
| `LICENSE_KEY` | server | No | — | RS256 JWT granting Enterprise features. Absent = Community build (graceful degradation). |

### `[server]` — Express API :3000

| Variable | Required | Default | Description |
|---|---|---|---|
| `SESSION_EXPIRY` | No | `86400000` | JWT/session expiry in ms (24h). |
| `LLM_PROVIDER` | No | `ollama` | `openai` / `anthropic` / `ollama` / `openrouter`. |
| `LLM_MODEL` | No | `gemma4:latest` | Default chat model. |
| `LLM_TEMPERATURE` | No | `0.7` | 0–2. |
| `LLM_MAX_TOKENS` | No | `4096` | Max output tokens. |
| `LLM_TIMEOUT` | No | `0` | 0 = no timeout (local LLMs on underpowered hardware need unlimited time). |
| `LLM_API_KEY`, `LLM_API_BASE_URL` | No | — | Generic provider credentials. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | No | — | OpenAI-specific overrides. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | No | — | Anthropic-specific overrides. |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434` | Ollama endpoint. Host-native dev typically wants `http://localhost:11434`; docker compose uses `http://ollama:11434`. |
| `OLLAMA_MODEL`, `OLLAMA_API_KEY` | No | — | Ollama-specific overrides. |
| `OLLAMA_CONTAINER_NAME` | No | `simmetric-chat-ollama` | Container name for the `docker exec ... ollama login` cloud-auth flow (infra config only). |
| `OLLAMA_KEEP_ALIVE` | server, collector | No | `10m` | ollama-js keep_alive for warm KV cache (5–30 min guidance; never `-1`/infinite). |
| `OPENROUTER_API_KEY` | No | — | OpenRouter credentials. |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api` | OpenRouter API base URL. |
| `OPENROUTER_MODEL` | No | — | OpenRouter model override. |
| `AGENT_WALLCLOCK_TIMEOUT_MS` | No | `600000` | Absolute per-request wall-clock cap (10 min). |
| `AGENT_MAX_TOTAL_TOKENS` | No | `200000` | Prompt + completion token cap per request. |
| `AGENT_MAX_CONTEXT_BYTES` | No | `500000` | Context array size cap (500 KB). |
| `AGENT_MAX_TOOL_OUTPUT_LENGTH` | No | `5000` | Per-skill output truncation. |
| `AGENT_MAX_SKILL_EXECUTION_MS` | No | `60000` | Per-skill execution timeout (1 min). |
| `AGENT_LOOP_DETECTION_WINDOW` | No | `3` | Abort after N identical (tool, input) pairs in a row. |
| `CHAT_MAX_CONCURRENT_PER_USER` | No | `5` | Concurrent chat requests per user. |
| `AGENT_MEMORY_CHAR_LIMIT` | No | `2000` | Char cap for the rendered `<memory_context>` block. |
| `AGENT_MEMORY_REVIEW_INTERVAL` | No | `10` | Auto-extraction fires every N turns post-done; `0` disables. |
| `AGENT_MEMORY_DEDUP_THRESHOLD` | No | `0.92` | Cosine-similarity dedup threshold (tunable 0.85–0.99). |
| `OCR_MODEL` | No | `glm-ocr:latest` | Vision OCR model (supports `model:version`). |
| `OCR_TIMEOUT` | No | `600000` | OCR timeout (10 min — vision models are slow). |
| `OCR_NUM_PREDICT` | No | `8192` | Max output tokens for the OCR model (min 256). |
| `SYNTHESIS_LLM_MODEL` | No | `gemma4:latest` | Model for the auto-synthesis pipeline. |
| `EMBEDDING_PROVIDER` | server, collector | No | `local` | `local` / `openai` / `ollama` / `hf-local` (shared schema). |
| `EMBEDDING_MODEL`, `EMBEDDING_API_KEY` | server, collector | No | — | Embedding model override / credentials. |
| `VECTOR_DB_PROVIDER` | server, collector | No | `lancedb` | `lancedb` / `qdrant` / `pgvector` / `chroma`. The pgvector URL is served from `DATABASE_URL` via `/api/system/vector-db-config`. |
| `VECTOR_DB_URL`, `VECTOR_DB_API_KEY` | server, collector | No | — | Qdrant/Chroma connection settings. |
| `ALLOW_REGISTRATION` | No | `false` | Self-service registration gate. |
| `ALLOW_WEB_SEARCH` | No | `false` | Web search hard gate. |
| `SEARXNG_URL` | No | `http://localhost:8888` | SearXNG endpoint. |
| `TAVILY_API_KEY` | No | — | Optional Tavily fallback key. |
| `SEED_BOOTSTRAP_ADMIN` | No | `true` | Auto-seed a bootstrap admin on first startup when no admin exists (idempotent). Disabled by `false` / `0` / `no` / `off` / empty. |
| `SEED_ADMIN_USERNAME` | No | `admin` | Bootstrap admin username. |
| `SEED_ADMIN_PASSWORD` | No | `admin123` | One-shot bootstrap credential (min 8 chars) — the seeded account carries `mustChangePassword=true` and must be rotated at first login. Override in production / air-gap deployments. |
| `SEED_ADMIN_EMAIL` | No | `admin@example.com` | Bootstrap admin email. |
| `DISABLE_TELEMETRY` | No | `true` | No phone-home by default. |
| `SCIM_BEARER_TOKEN` | No | — | SCIM 2.0 Bearer token. Unset = all SCIM endpoints return 404 (stealth mode). |
| `MCP_API_KEY` | No | — | MCP shared-secret Bearer token for `/api/mcp/sse` + `/api/mcp/message`. Unset = localhost-only fallback plus a boot-time warning. Empty string = unset. |
| `OIDC_ENABLED` | No | — | OIDC/SSO toggle (Enterprise). Env overrides the DB `SsoConfig` row; disabled by `false` / `0` / `no` / `off` / empty. |
| `OIDC_PROVIDER` | No | — | `google` / `github` / `microsoft` / `oidc` (`oidc` = custom IdP via discovery URL). |
| `OIDC_DISCOVERY_URL` | No | — | Valid URL; https-only is enforced at the consumption site by openid-client. |
| `OIDC_CLIENT_ID` | No | — | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | No | — | Plaintext env secret (no at-rest encryption on the env path; the DB path encrypts). Empty string = unset. |
| `OIDC_REDIRECT_URI` | No | — | Valid URL. |
| `OIDC_SCOPE` | No | — | Space-delimited; consumption default `openid email profile`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | No | — | VAPID web-push keypair. Unset = ephemeral dev keys generated with a warning. |
| `VAPID_SUBJECT` | No | — | Push subject; consumption default `mailto:admin@simmetric-chat.local`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | No | — | SMTP for password reset + backup notifications. Unset = the related features log-and-skip instead of failing. `SMTP_PORT` validated 1–65535. |
| `PUPPETEER_EXECUTABLE_PATH` | No | consumption-site default | Chromium executable for archive PDF export. |
| `ALLOWED_ORIGINS` | No | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000` | CORS allowlist (comma-separated). Trimmed, empties dropped; empty/absent falls back to the dev-friendly default list. |

### `[collector]` — ingest pipeline :3210

The collector reads the shared keys above (`COLLECTOR_PORT`, `COLLECTOR_URL`, `SERVER_URL`, `EMBEDDING_*`, `VECTOR_DB_*`, `OLLAMA_BASE_URL`, `OLLAMA_KEEP_ALIVE`, `COLLECTOR_SECRET`, `LOG_LEVEL`) plus:

| Variable | Required | Default | Description |
|---|---|---|---|
| `STORAGE_PATH` | No | `./storage` | Document storage root for ingested sources. |
| `RERANKER_MODEL` | No | `Xenova/bge-reranker-base` | ONNX-quantized community reranker (loads via `@huggingface/transformers`). |
| `RERANKER_CACHE_DIR` | No | `RERANKER_CACHE_DIR` > `HF_CACHE_DIR` > HF default | Cache-dir override for the reranker model. |

### `[widget]` — embeddable service :3211

The widget reads exactly **6** schema keys: `NODE_ENV`, `WIDGET_PORT`, `SERVER_URL`, `WIDGET_API_KEY` (required), `LOG_LEVEL` (plain string, not the server enum), and `REDIS_URL`. All are defined in the shared section above; the `.env.example` lists them in the `[widget]` section for discoverability.

## Raw-read keys (outside the Zod schemas)

A small set of keys is deliberately read raw from `process.env` and is **not** part of any package schema. They are documented as pointer comments at the bottom of `.env.example` and pinned by the collector's `rawEnvReads.test.ts`:

| Variable | Applies to | Purpose |
|---|---|---|
| `LEGACY_PREVIOUS_ENCRYPTION_KEYS` | server | Comma-separated base64 key-chain tail used to decrypt old ciphertexts during `ENCRYPTION_KEY` rotation. See `docs/ENCRYPTION_KEY_ROTATION.md`. |
| `E2E_RUN` | server | Set to `1` by Playwright (`playwright.config.ts`) to skip the auth rate limiter during E2E runs. |
| `HF_CACHE_DIR` / `XENOVA_CACHE_DIR` | collector | Hugging Face / Xenova model cache directories. **Air-gap landmine:** never leave them inside `node_modules` — `pnpm install` wipes the `@huggingface/transformers` cache contents. Point them at a persistent path outside `node_modules`. |
| `HF_ALLOW_REMOTE_MODELS` | collector | Remote model-download gate for the local/reranker providers (`false` closes it for air-gapped deployments with a pre-seeded cache; anything other than the exact string `false` keeps it open). |
| `OPENAI_API_KEY` | collector (raw only) | Dual-path channel: it *is* a server schema key (documented in the `[server]` LLM section), but on the collector it is raw-only (used by `embeddings.ts`). |

## DB-backed system settings (Settings UI)

Beyond env vars, admins configure ~70 settings keys at runtime through the Settings UI (`GET`/`PUT /api/system/settings`, admin-only). The canonical key list is the `configKeySchema` enum in `packages/shared/src/schemas/config.schema.ts` (LLM, embedding, vector DB, agent watchdogs, branding, feature flags, OCR, synthesis, retention, web search, and more). Fallback values for these keys live in `CONFIG_DEFAULTS` (`packages/shared/src/constants/permissions.ts`) and are seeded into the DB on first boot.

Behavioral rules (verified in `systemConfigService.ts` and `routes/settings.ts`):

- `PUT /api/system/settings` returns `{ updated, rejected }` — partial success is normal; the frontend refetches after save.
- Rejected keys include: keys not in `configKeySchema`, `ALWAYS_READONLY` infra keys, `chat_message_retention_days` (it has a dedicated write route enforcing data-loss confirmation), and `BRANDING_*` keys when no Enterprise plugin is loaded.
- When Redis is configured, changed keys invalidate the `config:{key}` cache so other instances see the new value immediately (5-minute TTL as secondary expiry).

## Fail-loud behavior and diagnostics

Each package's `getEnv()` validates the merged environment once (cached) with `safeParse` and, on failure:

1. Logs an error naming the resolved `.env` absolute path (`Expected .env at:`), the missing required key names, and the Zod field errors — key names only, never secret values.
2. Exits with `process.exit(1)`.

Summary of hard requirements per package:

| Package | Required keys | Additional runtime enforcement |
|---|---|---|
| server | `JWT_SECRET`, `COLLECTOR_SECRET` | `ENCRYPTION_KEY` required when `NODE_ENV=production`; `API_KEY_HMAC_SECRET` required at first API-key use |
| collector | `COLLECTOR_SECRET` | — |
| widget | `WIDGET_API_KEY` | — |

## Per-environment overrides

- **Precedence channel:** to override any `.env` value for a single process (CI, systemd, compose), set a real environment variable — `process.env` always wins and is never overwritten by the file.
- **Docker Compose:** `docker/docker-compose.yml` passes `env_file: ../.env` (optional — the stack boots with image defaults if the file is absent) to all three services, and sets container-network values (`postgres:5432`, `http://server:3000`, `redis://redis:6379`) in its `environment:` blocks, which win over `env_file`. Do **not** redeclare `LICENSE_KEY` or `ENCRYPTION_KEY` as `${VAR:-}` interpolations in compose `environment:` — shell interpolation resolves to an empty string and silently overrides the `env_file` value (downgrading to Community / disabling at-rest encryption). See the guard comments in `docker-compose.yml`.
- **Production:** set `NODE_ENV=production`, provide `ENCRYPTION_KEY` (hard requirement), and override `SEED_ADMIN_PASSWORD` / `SEED_BOOTSTRAP_ADMIN` to avoid shipping the well-known bootstrap credential.
- **Tests:** server unit tests load the tracked `packages/server/.env.test` (via the test setup helper) and mock the DB; they never read the root `.env`. The Enterprise `LICENSE_KEY` JWT lives only in the gitignored root `.env` and is consumed by the E2E `globalSetup`.
- **Tauri desktop:** the packaged layout has no `pnpm-workspace.yaml` marker, so `loadRootEnv()` is a graceful no-op and configuration arrives through real environment variables supplied by the shell.

## Tripwires: schema ↔ `.env.example` parity

Three test suites — `packages/server/src/__tests__/envExampleParity.test.ts` (83-key sentinel), `packages/collector/src/__tests__/envExampleParity.test.ts`, and `packages/widget/src/__tests__/envExampleParity.test.ts` — fail the moment a Zod schema key loses documentation in the root `.env.example` (active `KEY=` and commented `# KEY=` lines both count). When you add or rename a schema key, update `.env.example` in the same change.

## Related docs

- [`docs/GETTING_STARTED.md`](GETTING_STARTED.md) — first-run setup, including the minimal `.env` secrets.
- [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) — production deployment, Docker, and air-gap guidance.
- [`docs/SCALING.md`](SCALING.md) — Redis-backed horizontal scaling.
- [`docs/ENCRYPTION_KEY_ROTATION.md`](ENCRYPTION_KEY_ROTATION.md) — `ENCRYPTION_KEY` / `LEGACY_PREVIOUS_ENCRYPTION_KEYS` rotation procedure.
- [`docs/ENTERPRISE_PLUGIN.md`](ENTERPRISE_PLUGIN.md) — `LICENSE_KEY` JWT shape and air-gap install.
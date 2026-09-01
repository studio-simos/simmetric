
# Configuration

This document covers all runtime configuration for Simmetric Chat: environment variables, database settings, LLM and embedding providers, vector stores, licensing, authentication, SSO, email, web push, Redis, Docker Compose, system settings resolution, and rate limiting.

## Environment Variables

**Root `.env` is the single runtime config (beta, ).** A zero-dependency loader (`loadRootEnv()` in `packages/shared/src/config/loadEnv.ts`) runs at startup in every Node service (server, collector, widget) and makes the repo-root `.env` the effective runtime config. The per-package `.env` override layer was **removed** after the transition — the root `.env` is the single runtime config (see the per-package `[server]`/`[collector]`/`[widget]` sections in the root `.env.example`).

**Resolution order (locked):** `process.env` (never overwritten) > root `.env` (fills ONLY keys absent from `process.env`) > Zod default. Presence — never truthiness — defines a key: `KEY=` (present-but-empty) counts as DEFINED. The loader discovers the repo root by walking up for `pnpm-workspace.yaml`; missing files or a missing marker are graceful no-ops (nothing is thrown, nothing exits, no values are ever logged — only paths and key names).

- Repo-root `.env` — the single runtime config (gitignored); template: root `.env.example` (documents every schema key of every package, organized in per-package sections with `[server]`/`[collector]`/`[widget]` applicability markers)
- `packages/server/.env.test` — tracked test env (loaded by server unit tests via `setupEnv.ts`)

Each service resolves the root `.env` by walking up from `__dirname` to the `pnpm-workspace.yaml` marker (`src/config/env.ts`), independent of the operator's working directory in both dev (`tsx watch`) and prod (`node dist/`).

**Root `.env.example` template:** single exhaustive template documenting every schema key of every package, organized in per-package sections with `[server]`/`[collector]`/`[widget]` applicability markers — `NODE_ENV`, service URLs (`SERVER_URL` / `COLLECTOR_URL` / `WIDGET_SERVICE_URL`), `DATABASE_URL` (`localhost:5432` variant; the Zod code default uses `host.docker.internal:5432` instead), the shared secrets (`JWT_SECRET`, `COLLECTOR_SECRET`, `WIDGET_API_KEY`, `API_KEY_HMAC_SECRET`), and commented optional keys (`ENCRYPTION_KEY`, `REDIS_URL`, `LICENSE_KEY`). Everything not listed there is either a code default (`packages/*/src/config/env.ts`), an admin-editable SystemConfig key (Settings UI, stored in DB), or an optional raw-read override documented below.

**Zod validation:** Variables listed in each service's Zod schema (`packages/*/src/config/env.ts`) are validated on startup via `getEnv()`; invalid values log the resolved `.env` path + the missing/invalid key names (never raw secret values) and cause the process to exit with code `1`. The parsed result is cached for the process lifetime (the server and collector `env.ts` modules expose `clearEnvCache()` for tests; the widget's `env.ts` has no cache-clear seam).

**Shared schema module:** `EMBEDDING_PROVIDER`, `VECTOR_DB_PROVIDER`, and `OLLAMA_KEEP_ALIVE` have their single source of truth in `packages/shared/src/schemas/env.schema.ts` (`embeddingProviderSchema`, `vectorDbProviderSchema`, `ollamaKeepAliveSchema`) — both the server and collector `env.ts` place these schemas inline, so the enums/defaults can no longer drift.

**Raw-read keys (deliberately NOT in any Zod schema):** a few variables are read via raw `process.env` at their consumption sites — `LEGACY_PREVIOUS_ENCRYPTION_KEYS` (`encryptionService.ts`), `ENCRYPTION_KEY` / `API_KEY_HMAC_SECRET` raw-value probes at those same consumption sites (both ARE declared optional in the server Zod schema; strict base64/32-byte validation happens at the consumption site), `HF_CACHE_DIR` / `XENOVA_CACHE_DIR` / `HF_ALLOW_REMOTE_MODELS` (collector `embeddings.ts` / `reranker.ts`), `E2E_RUN` (`rateLimit.ts` — Playwright harness rate-limit skip), and `LOG_LEVEL` (read directly by `logger.ts` at module-load in all three services). These raw reads are pinned by `rawEnvReads.test.ts` suites in the server and collector, which also assert the raw-only keys stay OUT of the Zod schemas. (The former test-only `GSD_TEST_MOCK_PLUGIN` seam was removed from production code in the dead-code sweep — subprocess tests now use a `tsx -r` bootstrap fixture.) SMTP, VAPID, and `PUPPETEER_EXECUTABLE_PATH` ARE declared in the Zod schema and read via `getEnv()`.

**Parity tripwires (/178.1):** each package's `envExampleParity.test.ts` statically introspects the exported `envSchema.shape` and fails the suite if any schema key loses documentation in the root `.env.example` — the root `.env.example` is a shape-complete reference for every package's Zod schema (with per-package section markers).

### Server Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime mode: `development`, `production`, or `test`. |
| `SERVER_PORT` | No | `3000` | Port the Express API server listens on. |
| `COLLECTOR_PORT` | No | `3210` | Port the collector microservice listens on (declared here for config parity; the collector owns the actual binding). |
| `SERVER_URL` | No | `http://localhost:3000` | Public URL of the server. Used for callbacks (SAML/OIDC redirect URIs) and CORS. |
| `COLLECTOR_URL` | No | `http://localhost:3210` | URL of the collector. Used by the server to forward documents. |
| `WIDGET_SERVICE_URL` | No | `http://localhost:3211` | URL of the widget Express service (WID-04). Used for push cache-bust calls. |
| `WIDGET_API_KEY` | No | — | Server-side shared secret matching the widget's `WIDGET_API_KEY` in the root `.env`; used to authenticate the cache-bust call to the widget service. When unset, `fireWidgetCacheBust` is a no-op (5-min TTL is the safety net). Optional so admins can disable push. |
| `DATABASE_URL` | No | `postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat` | PostgreSQL connection string. Also serves as the pgvector vector-store URL at runtime (see "Vector Store Configuration"). |
| `REDIS_URL` | No | — | Redis connection URL (D-08 / ). When absent, Redis features are disabled and the system runs in single-instance mode with graceful degradation (auth cache falls through to DB, SSE stays single-instance, locks stay redlock-less with PostgreSQL mutex fallback, rate limits stay in-memory). When set, enables horizontal scaling: auth cache, token revocation, SSE fan-out, distributed locks, SystemConfig cache, and Redis-backed rate-limit stores (see "Redis (Horizontal Scaling)" below). Env-only key — not UI-editable. |
| `JWT_SECRET` | **Yes** | — | Secret key for signing JWT authentication tokens. Must be non-empty. Also used as the legacy fallback key for `encryptionService` (AES-256-GCM) when `ENCRYPTION_KEY` is unset — dev/test only; in production an unset `ENCRYPTION_KEY` is a fail-loud boot error (see "Data-at-Rest Encryption" below). |
| `ENCRYPTION_KEY` | **In production** | — | Base64-encoded 32-byte AES-256-GCM key for `encryptionService` (provider API keys, backup destination configs, SSO client secrets). Decouples data-at-rest encryption from `JWT_SECRET`. **Required in production ( hard-default):** `NODE_ENV=production` + unset → fail-loud boot (`logger.error` + `process.exit(1)`, fired before `prisma.$connect()` in `index.ts`); the legacy `scryptSync(JWT_SECRET)` derivation remains the dev/test-only fallback so existing ciphertexts stay decryptable. Validated strictly at the consumption site (`encryptionService.ts`): must decode to exactly 32 bytes. Generate with `openssl rand -base64 32`. See `docs/ENCRYPTION_KEY_ROTATION.md` for the full rotation runbook. |
| `LEGACY_PREVIOUS_ENCRYPTION_KEYS` | No | — | Comma-separated list of prior `ENCRYPTION_KEY` values (base64 32-byte) used for decrypt-only fallback during key rotation. Read via raw `process.env` in `encryptionService.ts`. See `docs/ENCRYPTION_KEY_ROTATION.md` for the full rotation runbook (`pnpm --filter server rotate-encryption-key` / `verify-encryption-key`). |
| `API_KEY_HMAC_SECRET` | No | — | Base64-encoded 32-byte HMAC-SHA256 signing secret for API-key digests ( / SCALE-03). Replaces the bcrypt-loop verification with a deterministic HMAC digest stored in `api_keys.key_hash` (unique-index lookup — constant-time compare). **Required when API keys are used**: validated at the consumption site (`apiKeyService.ts` `getHmacSecret()` throws a named error if unset or not exactly 32 bytes after base64 decode). Misconfiguration is fail-loud: `apiKeyMiddleware` converts the throw to HTTP 500 (NOT 401) so a missing secret is never hidden as "invalid key" (T-163-02 spoofing vector). Decoupled from `JWT_SECRET`/`ENCRYPTION_KEY` rotation. Generate with `openssl rand -base64 32`. See `docs/API_KEY_MIGRATION.md` for the migration runbook. |
| `SESSION_EXPIRY` | No | `86400000` | JWT/session expiration in milliseconds (default 24 hours). |
| `LLM_PROVIDER` | No | `ollama` | Active LLM provider. Options: `ollama`, `openai`, `anthropic`, `openrouter`. (Additional provider types live in the Settings → Providers UI — see `packages/shared/src/constants/providerPresets.ts`: native Gemini has a runtime handler, Xiaomi MiMo and MiniMax native types are declared but their handlers fail fast with a named error; any OpenAI-compatible provider can be added via the preset catalog.) |
| `LLM_MODEL` | No | `gemma4:latest` | Default model name for the active LLM provider. |
| `LLM_TEMPERATURE` | No | `0.7` | Sampling temperature (0.0–2.0). |
| `LLM_MAX_TOKENS` | No | `4096` | Maximum tokens per LLM response. |
| `LLM_TIMEOUT` | No | `0` | Axios request timeout in ms (0 = no timeout). Increase if using slow local models. |
| `LLM_API_KEY` | No | — | Generic API key override for the active LLM provider. |
| `LLM_API_BASE_URL` | No | — | Custom base URL for the active LLM provider. |
| `OPENAI_API_KEY` | No | — | OpenAI-specific API key. |
| `OPENAI_MODEL` | No | — | OpenAI-specific model override. |
| `ANTHROPIC_API_KEY` | No | — | Anthropic-specific API key. |
| `ANTHROPIC_MODEL` | No | — | Anthropic-specific model override. |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434` | Base URL for the local Ollama instance. |
| `OLLAMA_MODEL` | No | — | Default Ollama model override. Falls back to `LLM_MODEL` if unset. |
| `OLLAMA_API_KEY` | No | — | API key for Ollama instances that require authentication. |
| `OLLAMA_KEEP_ALIVE` | No | `10m` | Ollama `keep_alive` duration (ollama-js) for warm KV cache between requests . Guidance 5–30 min; never `-1`/infinite (no permanent memory pinning on small deployments). Single source of truth: `packages/shared/src/schemas/env.schema.ts`. |
| `OLLAMA_CONTAINER_NAME` | No | `simmetric-chat-ollama` | Container name passed to `docker exec <name> ollama login` for Ollama Cloud SSH-key auth. The login is run via `execFile` (not `exec`) with hardcoded args — no user input reaches the docker CLI arguments. Purely infra config; matches the `container_name` of the `ollama` service in `docker/docker-compose.yml`. |
| `OPENROUTER_API_KEY` | No | — | OpenRouter API key (OpenAI-compatible API gateway). |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api` | Base URL for OpenRouter. `/v1` is appended by providerService. |
| `OPENROUTER_MODEL` | No | — | Default OpenRouter model (e.g. `openai/gpt-4o`). |
| `COLLECTOR_SECRET` | **Yes** | — | Shared secret for authenticating server-to-collector HTTP calls. Must be non-empty. |
| `OCR_MODEL` | No | `glm-ocr:latest` | Model used for OCR fallback on image-only PDFs. Supports `model:version` format . |
| `OCR_TIMEOUT` | No | `600000` | OCR operation timeout in milliseconds (10 min). |
| `OCR_NUM_PREDICT` | No | `8192` | Max output tokens for the vision OCR model (`num_predict` Ollama parameter, threaded by `ollamaVisionClient.ts`). Min 256 guards against typos. Raise for dense documents that trip the default cap (truncation is surfaced via `OcrPageResult.truncated`). |
| `SYNTHESIS_LLM_MODEL` | No | `gemma4:latest` | Model used for the auto-synthesis pipeline. |
| `EMBEDDING_PROVIDER` | No | `local` | Embedding strategy: `local` (Xenova 2.x), `openai`, `ollama`, or `hf-local` (HF v3/v4, added in -03). Single source of truth: `packages/shared/src/schemas/env.schema.ts`. |
| `EMBEDDING_MODEL` | No | — | Model name for the active embedding provider. Falls back to provider-specific defaults. |
| `EMBEDDING_API_KEY` | No | — | Required when `EMBEDDING_PROVIDER=openai`. |
| `VECTOR_DB_PROVIDER` | No | `lancedb` | Vector database: `lancedb`, `qdrant`, `pgvector` (added in -01 D-08), or `chroma` (added D-08 additive). Single source of truth: `packages/shared/src/schemas/env.schema.ts`. |
| `VECTOR_DB_URL` | No | — | Endpoint for Qdrant (e.g. `http://localhost:6333`). |
| `VECTOR_DB_API_KEY` | No | — | API key for Qdrant, when required. |
| `ALLOW_REGISTRATION` | No | `false` | When `false` (default), self-service signup is closed and only admins can create accounts via `/api/auth/admin-register` or the admin panel. When `true`, open signup via `/api/auth/register` is enabled. The runtime gate reads this env value via `getEnv()`; the `/api/system/initialize` route additionally seeds an `ALLOW_REGISTRATION=false` SystemConfig row for UI display when it initializes a fresh install. |
| `ALLOW_WEB_SEARCH` | No | `false` | Hard gate for the web search feature (, WEB-01). Must be `true` for web search to function. |
| `SEARXNG_URL` | No | `http://localhost:8888` | SearXNG instance URL used by the web search skill (air-gap primary). The `searxng_url` SystemConfig key takes precedence when set (see "Key DB Settings"). |
| `TAVILY_API_KEY` | No | — | Optional Tavily API key for the web search skill (cloud fallback). |
| `SEED_BOOTSTRAP_ADMIN` | No | `true` | Auto-seed a bootstrap admin on first startup when no admin user exists. Parsed via an explicit transform (not `z.coerce.boolean()`) so the literal string `"false"` actually disables it. Idempotent: skipped once any admin user exists. |
| `SEED_ADMIN_USERNAME` | No | `admin` | Bootstrap admin username. |
| `SEED_ADMIN_PASSWORD` | No | `admin123` | Bootstrap admin password. Must be ≥ 8 chars (Zod `min(8)`). One-shot credential: the seeded account carries `mustChangePassword=true` and MUST be rotated at first login. Override in prod/air-gap deploys. |
| `SEED_ADMIN_EMAIL` | No | `admin@example.com` | Bootstrap admin email. |
| `DISABLE_TELEMETRY` | No | `true` | When `true`, telemetry data collection is disabled. |
| `ALLOWED_ORIGINS` | No | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000` | Comma-separated CORS allowlist for the global `cors()` middleware (SEC-01). Trimmed, empties dropped. The `/api/internal/widget` path is excluded from this global CORS so `widgetCors` remains the sole CORS authority there. |
| `PUPPETEER_EXECUTABLE_PATH` | No | — | Puppeteer/Chromium executable path for archive PDF export. Declared in the Zod schema; defaults handled at the consumption site (`archiveExportService.ts` falls back to `/usr/bin/chromium-browser`). |
| `SCIM_BEARER_TOKEN` | No | — | SCIM 2.0 provisioning Bearer token secret used by the enterprise plugin's `scimAuth` middleware. When unset, all SCIM endpoints return 404 (stealth mode — don't advertise). |
| `MCP_API_KEY` | No | — | MCP server shared-secret Bearer token for `/api/mcp/sse` + `/api/mcp/message` (MCP-03 / ). This is a SHARED SECRET, NOT a user JWT — IDE clients (Cursor/VS Code) cannot mint user JWTs, so the model is a single admin-level integration secret set by the operator. When unset (empty or absent), the MCP server falls back to localhost-only (`127.0.0.1`/`::1`) connections + a boot-time `warn` log so local dev with Cursor keeps working without configuration. In authenticated mode (`MCP_API_KEY` set), the holder is treated as an admin-level principal (`list_workspaces` ignores `toolArgs.userId` and lists ALL workspaces); in loopback mode (unset), `toolArgs.userId` IS honored. |
| `LICENSE_KEY` | No | — | RS256 JWT Enterprise license key (issued by the vendor's private key). Community Edition features apply when absent or invalid. |
| `LOG_LEVEL` | No | `info` | Winston log level. Declared in the Zod schema as `enum(["debug","info","warn","error"])`, but `logger.ts` reads `process.env.LOG_LEVEL` directly at module-load (it is imported BY `env.ts`, so `getEnv()` cannot run there) — treat the Zod declaration as documentation/validation for other callers. |

**Note on storage paths:** The server does not expose a `STORAGE_PATH` env var. Storage locations are hardcoded relative to `process.cwd()`: `storage/uploads/` (document/OCR/avatar/chat-import uploads), `storage/branding/` (white-label icon assets), and `storage/logs/` (Winston file transports: `error.log`, `combined.log`). Backup working/final directories under `storage/backups/` are owned by the enterprise backup plugin (see "Data-at-Rest Encryption" below). The collector service does expose `STORAGE_PATH` (see below); the widget service does not.

**Note on backup configuration:** The server does not expose `BACKUP_PATH`, `BACKUP_ENCRYPTION_KEY`, or `BACKUP_RETENTION_DAYS` env vars. Backup encryption uses `ENCRYPTION_KEY` (with the `scryptSync(JWT_SECRET)` fallback in dev/test only — production requires an explicit `ENCRYPTION_KEY`, see "Data-at-Rest Encryption" below), and retention is governed by the `BackupJob.retentionDays` DB field (`packages/server/prisma/schema-enterprise.prisma`, default `30`) rather than an env var. The Docker Compose `server` service bind-mounts `${LOCAL_BACKUP_PATH:-/var/backups}` for local backup destinations.

#### Data-at-Rest Encryption

`encryptionService.ts` (AES-256-GCM) encrypts provider API keys, backup destination configs, and SSO client secrets. Key resolution builds an ordered decrypt chain:

1. **Current key**: `ENCRYPTION_KEY` (base64, exactly 32 raw bytes) — used for all new writes (`chain[0]`). **Required in production**: `NODE_ENV=production` + unset → fail-loud boot (`index.ts`), plus a defense-in-depth throw in `getEncryptionKey()` for CLI callers (`rotate-encryption-key` / `verify-encryption-key` run via `tsx`, bypassing `index.ts`). Dev/test (`NODE_ENV !== "production"`) keeps the scrypt fallback so local dev needs no `ENCRYPTION_KEY`.
2. **Previous keys**: `LEGACY_PREVIOUS_ENCRYPTION_KEYS` (comma-separated base64 32-byte values, tried in declared order) — decrypt-only fallback during rotation.
3. **Legacy scrypt key**: when `ENCRYPTION_KEY` is unset in dev/test, the key is derived via `crypto.scryptSync(JWT_SECRET, "simmetric-chat-encryption-salt", 32)` (legacy path) so pre-existing ciphertexts stay decryptable. The scrypt key is also appended as the chain tail when `ENCRYPTION_KEY` IS set, so pre-override blobs remain readable.

Rotation: set the new key as `ENCRYPTION_KEY` and list prior values in `LEGACY_PREVIOUS_ENCRYPTION_KEYS`, then run the rotation CLI (`pnpm --filter server rotate-encryption-key`, with `--dry-run` / `--resume` modes) and verify with `pnpm --filter server verify-encryption-key` (gate: `below_active = 0`). The full operator runbook — including rollback and failure modes — lives in `docs/ENCRYPTION_KEY_ROTATION.md`. `JWT_SECRET` rotation alone does NOT re-encrypt existing blobs — set `ENCRYPTION_KEY` explicitly to decouple the two.

The enterprise backup plugin consumes `ENCRYPTION_KEY` for backup destination configs and handles backup archive creation — that code lives in the `simmetric-enterprise` package, which is a separate private repo. <!-- VERIFY: exact archive-level encryption behavior of the enterprise backup plugin (unencrypted ZipArchive vs per-file cipher) is defined in the enterprise repo, not in this community tree. -->

#### Agent Watchdog Variables

These variables control safety limits for the ReAct agent loop. Each watchdog blocks a specific failure mode (infinite loops, runaway token usage, oversized context).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AGENT_WALLCLOCK_TIMEOUT_MS` | No | `600000` | Absolute upper bound per request (10 min). |
| `AGENT_MAX_TOTAL_TOKENS` | No | `200000` | Total prompt + completion tokens per request. |
| `AGENT_MAX_CONTEXT_BYTES` | No | `500000` | Context array size cap (500 KB). |
| `AGENT_MAX_TOOL_OUTPUT_LENGTH` | No | `5000` | Per-skill output truncation length. |
| `AGENT_MAX_SKILL_EXECUTION_MS` | No | `60000` | Per-skill execution timeout (1 min). |
| `AGENT_LOOP_DETECTION_WINDOW` | No | `3` | Abort after N identical (tool, input) pairs in a row. |
| `AGENT_MEMORY_CHAR_LIMIT` | No | `2000` | Char cap for the composed `<memory_context>` block injected into the system message (, MEM-02). |
| `AGENT_MEMORY_REVIEW_INTERVAL` | No | `10` | Auto-extraction fires every N turns post-done (, MEM-03). `0` disables the feature. |
| `AGENT_MEMORY_DEDUP_THRESHOLD` | No | `0.92` | Cosine similarity threshold for dedup before memory add. Tunable 0.85–0.99. |
| `CHAT_MAX_CONCURRENT_PER_USER` | No | `5` | Maximum concurrent chat streams per user. |

#### SMTP Variables (Backup Notifications)

These variables configure email delivery for backup job notifications. They are declared in the server Zod schema (optional) so misconfigured values surface at startup rather than at feature-use time. The actual SMTP consumers live in the enterprise backup plugin ( — the community repo has no SMTP-reading code besides the schema declaration); when unset, notifications are silently skipped.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SMTP_HOST` | No | — | SMTP server hostname. |
| `SMTP_PORT` | No | — | SMTP server port (commonly `587`; `465` selects `secure: true`). |
| `SMTP_USER` | No | — | SMTP authentication username. |
| `SMTP_PASS` | No | — | SMTP authentication password. |
| `SMTP_FROM` | No | — | From address for outgoing backup notification emails. Falls back to `SMTP_USER` (or the recipient's email) when unset. |

<!-- VERIFY: the failure-notification-only email behavior and the `sendFailureNotification()` call sites live in the enterprise backup plugin (formerly `backupService.ts` / `backupJobWorker.ts` in this repo, moved in ) — confirm details against the enterprise repo. -->

There is no `RESET_PASSWORD_STRATEGY` variable anywhere: it is not documented in the root `.env.example` and is **not** read by the server code. Password reset is admin-only via `POST /api/auth/admin-reset-password`; there is no email-based self-service reset flow and no `RESET_PASSWORD_STRATEGY` switch. The SMTP block above is the only consumer of the `SMTP_*` variables.

#### VAPID Variables (Web Push)

These variables configure VAPID Web Push notifications. They are declared in the Zod schema (optional strings) and read via `getEnv()` in `routes/push.ts`; they are auto-generated on first use if unset.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAPID_PUBLIC_KEY` | No | — | VAPID public key for Web Push. Auto-generated if unset. |
| `VAPID_PRIVATE_KEY` | No | — | VAPID private key for Web Push. Auto-generated if unset. |
| `VAPID_SUBJECT` | No | `mailto:admin@simmetric-chat.local` | VAPID subject identifier (e.g. `mailto:admin@example.com`). |

### Collector Variables

The collector validates environment variables via Zod (same pattern as the server). Invalid values cause the process to exit with code `1`. The collector never reads a `DATABASE_URL` env var of its own — when `VECTOR_DB_PROVIDER=pgvector`, its `pgVectorProvider.ts` opens a raw `pg.Pool` against the PostgreSQL URL fetched at runtime from the server's `/api/system/settings/vector-db-config` route (called in `vectorStore.ts`); there is no Prisma/ORM access on this service.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COLLECTOR_PORT` | No | `3210` | HTTP port for the collector microservice. |
| `COLLECTOR_URL` | No | `http://localhost:3210` | Public URL of the collector (declared for config parity; not used by the collector itself). |
| `SERVER_URL` | No | `http://localhost:3000` | Server endpoint for document status callbacks. |
| `COLLECTOR_SECRET` | **Yes** | — | Shared secret for authenticating collector-to-server HTTP calls. Must match the server's `COLLECTOR_SECRET`. |
| `OLLAMA_BASE_URL` | No | `http://ollama:11434` | Base URL for Ollama (used when `EMBEDDING_PROVIDER=ollama`). |
| `OLLAMA_KEEP_ALIVE` | No | `10m` | Ollama `keep_alive` for embed calls . Single source of truth: `packages/shared/src/schemas/env.schema.ts`. |
| `EMBEDDING_PROVIDER` | No | `local` | Embedding strategy: `local` (Xenova 2.x), `openai`, `ollama`, or `hf-local` (HF v3/v4, added in -03). Single source of truth: `packages/shared/src/schemas/env.schema.ts`. |
| `EMBEDDING_MODEL` | No | — | Model name for the active embedding provider. Falls back to provider-specific defaults. |
| `EMBEDDING_API_KEY` | No | — | Required when `EMBEDDING_PROVIDER=openai`. |
| `VECTOR_DB_PROVIDER` | No | `lancedb` | Vector database: `lancedb`, `qdrant`, `pgvector` (added in -01 D-08), or `chroma` (added D-08 additive). Single source of truth: `packages/shared/src/schemas/env.schema.ts`. |
| `VECTOR_DB_URL` | No | — | Qdrant endpoint (required when `VECTOR_DB_PROVIDER=qdrant`). |
| `VECTOR_DB_API_KEY` | No | — | Qdrant API key. |
| `STORAGE_PATH` | No | `./storage` | Local path for temporary uploads and LanceDB vectors. |
| `RERANKER_MODEL` | No | `Xenova/bge-reranker-base` | CrossEncoder reranker model for `/ingest/rerank`. The default is the ONNX-quantized community model (NOT `BAAI/bge-reranker-v2-m3`, which ships safetensors-only and throws at `pipeline()` load time under JS). Loads lazily on first call; server-side SystemConfig gate (`rag_reranker_enabled`) is default-OFF. |
| `RERANKER_CACHE_DIR` | No | — | Override cache dir for the reranker model. Falls back to `HF_CACHE_DIR`, then the HF v3 default. |
| `HF_CACHE_DIR` | No | — | Hugging Face cache directory for the `hf-local` embedding provider (HF v3/v4 / `@huggingface/transformers`). Read via raw `process.env` in `embeddings.ts` (not declared in the Zod schema). When unset, the HF v3 default (`./.cache/`) applies. In air-gap deployments this MUST point outside `node_modules` to a pre-seeded cache so the runtime never attempts HF hub downloads. |
| `XENOVA_CACHE_DIR` | No | — | Cache directory for the `local` (Xenova 2.x) embedding provider. Read via raw `process.env` in `embeddings.ts`. Defaults to the transformers default (`~/.cache/huggingface/`). For air-gapped deployments, point this at a pre-seeded cache outside `node_modules`. |
| `HF_ALLOW_REMOTE_MODELS` | No | `true` | Read via raw `process.env` in `embeddings.ts` / `reranker.ts` (not in the Zod schema). `env.allowRemoteModels = process.env.HF_ALLOW_REMOTE_MODELS !== "false"` — so the default allows first-use downloads when the cache is empty; set to `false` for air-gapped deployments with a pre-seeded cache (a cache miss then becomes a hard error, no auto-download). |

Chunk size (1000 characters) and chunk overlap (200 characters) are hardcoded in the chunker service (`src/services/chunker.ts`) and are not configurable via environment variables. The collector `env.ts` Zod schema does not declare `CHUNK_SIZE` / `CHUNK_OVERLAP`; treat the 1000/200 values as fixed unless the chunker is modified (per-call `options` overrides exist for some routes, e.g. wiki-pages uses `{ chunkSize: 800, chunkOverlap: 100 }`).

### Widget Variables

The widget service validates its env vars via a separate Zod schema in `packages/widget/src/config/env.ts`. Invalid values cause the process to exit with code `1`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime mode: `development`, `production`, or `test`. |
| `WIDGET_PORT` | No | `3211` | HTTP port for the widget Express service. |
| `SERVER_URL` | No | `http://localhost:3000` | Server URL for internal API calls. |
| `WIDGET_API_KEY` | **Yes** | — | API key for authenticating to the server's internal widget API (sent as `X-Api-Key`). Must match the server's `WIDGET_API_KEY` (used by the server for push cache-bust) and the internal widget API key (generated via `pnpm --filter server generate-apikey`). |
| `REDIS_URL` | No | — | Redis connection URL (mirrors the server's `redisService.ts` pattern). When set, enables the Redis widget-config cache (`widget:config:{widgetId}`) and Redis-backed rate-limit stores; when absent, falls back to the in-process cache and in-memory rate-limit stores. |
| `LOG_LEVEL` | No | `info` | Winston log level. Declared in the Zod schema as a plain string (unlike the server, where the schema declares an enum but the logger reads raw `process.env`). |

## Database Configuration

Simmetric Chat requires **PostgreSQL 16**. The Prisma schema is the single source of truth for all database shapes.

- **ORM**: Prisma 7.10.0
- **Schema files**: `packages/server/prisma/schema.prisma` + `packages/server/prisma/schema-enterprise.prisma` (merged via `prismaSchemaFolder` directory mode — the enterprise fragment always contributes `SsoConfig` / `IdentityProvider` / `ScimGroup` / backup models to the generated client, even in a pure community build)
- **Connection**: Managed via `DATABASE_URL` (PostgreSQL connection string)
- **Client**: Singleton `PrismaClient` initialized in `packages/server/src/utils/prisma.ts` (import from there, never `new PrismaClient()` directly)
- **Migrations**: Run interactively with `pnpm db:migrate` from the monorepo root. `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="yes"` is required in CI/automated contexts for destructive migration operations (enforced by `pnpm audit:migrations` and the `migration-safety-check` CI job).
- **Client generation**: `pnpm db:generate` (required after schema changes)
- **Seeding**: `pnpm db:seed` creates default roles, permissions, system config, and templates on first launch. A bootstrap admin (`admin` / `admin123` by default, override via `SEED_ADMIN_*` env vars) is auto-seeded when `SEED_BOOTSTRAP_ADMIN=true` and no admin user exists; the account carries `mustChangePassword=true`.
- **Full-text search**: PostgreSQL `tsvector` with GIN indexes on `document_chunks.searchVector` / `searchVectorMulti`, initialized at server startup

In Docker Compose, the database service uses `pgvector/pgvector:pg16` (D-08 / -01 swap — bundles the pgvector extension offline for air-gap) with persistent storage via the `pgdata` volume. Health checks rely on `pg_isready`. The `postgres` service maps port `${POSTGRES_PORT:-5432}:5432` to the host so `prisma migrate dev` from the host works against the container.

## Redis (Horizontal Scaling)

Redis is optional (D-08 / ). When `REDIS_URL` is set on the server and/or widget, the following subsystems switch from single-instance to distributed behavior; when absent, every consumer degrades gracefully to its in-memory/DB fallback (`getRedis()` returns `null`). **Multi-instance deployments REQUIRE `REDIS_URL` on every instance** — without it, the five consumers below silently fall back to per-process state that diverges across instances (rate-limit buckets become `N × limit`, revoked JWTs stay valid on other instances, SSE events never relay). In production with `REDIS_URL` unset the server logs an advisory boot warning (`index.ts`). See `docs/SCALING.md` for the full multi-instance deployment guide.

**Server (`packages/server/src/services/redisService.ts`):**
- **Auth cache** — cached auth lookups (`config:{key}`-style caching in `systemConfigService`; user records cached in `authService.ts` under `auth:user:{userId}`, invalidated on password/role changes)
- **Token revocation** — `rev:jti:<jti>` key presence check with TTL (`tokenRevocation.ts`); no-ops when Redis is absent
- **SSE fan-out** — chat stream events published to `sse:chat:{chatId}` channels; other instances relay them to their own clients (`routes/chat.ts`). Subscriber uses `redis.duplicate()`; originating instance does not relay its own events
- **Distributed locks** — redlock-based `distributedLock.ts` for backup mutex and reaper bodies, with PostgreSQL `BackupLog` mutex fallback
- **SystemConfig cache** — `config:{key}` with 5-minute TTL; invalidated (DEL) on `updateSettings()` so changes propagate across instances
- **Rate-limit stores** — `rate-limit-redis` stores with per-limiter prefixes `rl:auth:`, `rl:api:`, `rl:lead:`, `rl:probe:` (in-process MemoryStore fallback when absent)

**Widget (`packages/widget/src/services/redisService.ts`):**
- **Widget config cache** — `widget:config:{widgetId}` with 5-minute TTL (`routes/config.ts`); also read by `widgetChatLimiter`/`widgetDailyMessageLimiter` dynamic `max` functions
- **Rate-limit store** — `rate-limit-redis` with prefix `rl:`

The Docker Compose `redis` service runs `redis:7-alpine` with `--appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru`; `REDIS_URL=redis://redis:6379` is wired into the server and widget services.

**Background jobs (pg-boss) require no new env var:** the job queue is pg-boss (–165), backed by the **same Postgres** as app data — it uses `DATABASE_URL` and auto-creates a `pgboss` schema on `start()` (no separate database or connection string). Seven `setInterval` schedulers were migrated to pg-boss scheduled jobs, which provides distributed job dedup across instances (exactly one instance picks up each scheduled fire). Graceful degradation (Q-05): if Postgres is unavailable at boot or mid-run, pg-boss jobs are skipped and the server keeps serving requests. See `docs/SCALING.md` §3 for details.

## LLM Provider Configuration

The server supports four LLM providers. Configuration is selected via `LLM_PROVIDER` and provider-specific variables.

### Ollama (Default)

- **Base URL**: `OLLAMA_BASE_URL` (default `http://ollama:11434`)
- **Default model**: `gemma4:latest` (via `LLM_MODEL`)
- **Keep-alive**: `OLLAMA_KEEP_ALIVE` (default `10m`) — warm KV cache between requests
- **Docker Compose**: The `ollama` service exposes port `11434` internally. No automatic model pull is configured; run the following after first start:

```bash
docker exec simmetric-chat-ollama ollama pull gemma4:latest
```

- **GPU passthrough**: Uncomment the `deploy.resources.reservations.devices` block in `docker/docker-compose.infra.yml` to enable NVIDIA GPU passthrough. Falls back to CPU if unavailable.
- **Host-native dev**: In `pnpm dev` mode Ollama typically runs as a host systemd service on `127.0.0.1:11434`; set `OLLAMA_BASE_URL=http://localhost:11434` in the root `.env` for that setup. Use the Docker service name `http://ollama:11434` for pure-Docker deployments.

### OpenAI

- **Base URL**: `https://api.openai.com` (hardcoded fallback; override with `LLM_API_BASE_URL`)
- **API key**: `OPENAI_API_KEY` or the generic `LLM_API_KEY`
- **Model**: `OPENAI_MODEL` or the generic `LLM_MODEL`

### Anthropic

- **Base URL**: `https://api.anthropic.com` (hardcoded fallback; override with `LLM_API_BASE_URL`)
- **API key**: `ANTHROPIC_API_KEY` or the generic `LLM_API_KEY`
- **Model**: `ANTHROPIC_MODEL` or the generic `LLM_MODEL`
- **API version header**: `anthropic-version: 2023-06-01`

### OpenRouter

- **Base URL**: `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api`; `/v1` is appended by providerService)
- **API key**: `OPENROUTER_API_KEY`
- **Model**: `OPENROUTER_MODEL` (e.g. `openai/gpt-4o`)
- **Behavior**: OpenAI-compatible API gateway providing access to multiple model providers through a single endpoint.

### Model Resolution

At chat time, the server resolves the effective model using this priority chain:

1. Per-chat override (`PATCH /api/workspaces/:workspaceId/chats/:chatId/model`)
2. Workspace default (`WorkspaceAgentConfig.model` — applied when no per-request override is set)
3. Global default provider (`Provider.isDefault`)
4. Environment variables (`LLM_PROVIDER`, `LLM_MODEL`)

Provider model discovery runs via `refreshModels()` at server startup and when a provider is created (`providerService.ts`) or explicitly re-synced through the providers API (`POST /api/providers/:id/models/refresh`); `updateProvider()` does NOT call `refreshModels`, so model discovery is not re-run on provider updates. Discovery marks missing models `isAvailable: false`. If the selected model is unavailable, a fallback chain runs (explicit provider → global default provider → env-based `buildFallbackConfig`).

## Embedding Configuration

Document and query embeddings are generated by the collector microservice. Four embedding providers are supported via `EMBEDDING_PROVIDER` (schema shared between server and collector via `packages/shared/src/schemas/env.schema.ts`):

### Local Provider (Default — Xenova 2.x)

- **Enum value**: `local`
- **Library**: `@xenova/transformers`
- **Default model**: `Xenova/all-MiniLM-L6-v2` (384 dimensions)
- **Air-gap compatible**: Models download once to `~/.cache/huggingface/` (override with `XENOVA_CACHE_DIR`) and run entirely offline
- **Quantized**: Enabled by default for smaller memory footprint
- **Batch size**: One text at a time to avoid OOM

### HF v3/v4 Local Provider (added in -03)

- **Enum value**: `hf-local`
- **Library**: `@huggingface/transformers` (the Xenova package was renamed to HuggingFace; v3/v4 is the successor)
- **Same model IDs / dimensions as `local`** → no re-index required when switching `local` → `hf-local` (same 384-dim vectors)
- **Air-gap stance**: `env.allowRemoteModels = false` and `env.allowLocalModels = true` are forced on provider init, so the runtime never reaches the public HF hub. A cache miss is a **hard error** (no auto-download) — the cache must be pre-seeded.
- **Cache directory**: `env.cacheDir = process.env.HF_CACHE_DIR || env.cacheDir` (HF v3 default `./.cache/`). In air-gap deploys, set `HF_CACHE_DIR` to a path outside `node_modules` (e.g. a mounted volume) so the cache survives `pnpm install`/rebuilds and stays readable.

### OpenAI Provider

- **Enum value**: `openai`
- **Endpoint**: `https://api.openai.com/v1/embeddings`
- **Required**: `EMBEDDING_API_KEY` (or `OPENAI_API_KEY`)
- **Default model**: `text-embedding-3-small` (1536 dimensions)
- **Behavior**: Sends the full batch in a single API call

### Ollama Provider

- **Enum value**: `ollama`
- **Endpoint**: Uses the Ollama instance at `OLLAMA_BASE_URL`
- **Behavior**: Leverages Ollama's built-in embedding API for local embedding generation. `keep_alive` flows from `OLLAMA_KEEP_ALIVE` .

The collector attempts to fetch the active embedding config from the server at `/api/system/settings/embedding-config` before falling back to environment variables. The active embedding model can also be overridden per-request via the `embeddingModel` field on the ingest/query request body; the server persists the chosen model on the `Document` row so query vectors use the same model that produced the stored vectors.

## Vector Store Configuration

The collector stores document chunk vectors using a strategy pattern.

### LanceDB (Default)

- **Type**: Local, air-gap compatible, disk-based
- **Path**: `${STORAGE_PATH}/vectors/lancedb`
- **Table naming**: One table per workspace (`ws_${workspaceId}`) plus a `global` table
- **Backup**: Vector files are plain files on disk; back them up alongside PostgreSQL

### Qdrant

- **Type**: Remote, enterprise-oriented
- **Required**: `VECTOR_DB_URL` (e.g. `http://localhost:6333`)
- **Optional**: `VECTOR_DB_API_KEY`
- **Implementation**: Fully implemented via REST API (`/collections/{name}/points`). Supports collection auto-creation (409 create-race treated as idempotent), cosine distance, metadata filtering, scroll-based pagination, and retry with exponential backoff. Point IDs are deterministic UUIDv5 (RFC 4122 over a fixed `SIMMETRIC_CHAT_CHUNK_NAMESPACE` + chunk id) so logical chunk ids ride in the payload.

Docker Compose includes a `qdrant` service exposing ports `6333` (HTTP) and `6334` (gRPC) on the compose network with persistent `qdrant-storage`; the dev infra compose (`docker-compose.infra.yml`) maps them to `127.0.0.1:6333/6334` for host access.

### pgvector

- **Type**: PostgreSQL-native (requires the `pgvector` extension — the `pgvector/pgvector:pg16` image bundles it offline)
- **URL**: Sourced at runtime from the server's `DATABASE_URL` via `/api/system/settings/vector-db-config` — the collector never reads `DATABASE_URL` from its own env
- **Implementation**: Raw `pg.Pool` (`pgVectorProvider.ts`); per-dimension tables (LanceDB `ws_<id>` convention ignored); HNSW index (`m = 16`, `ef_construction = 64`); dim-mismatch detection on insert

### Chroma

- **Type**: Remote, mid-scale
- **Implementation**: Official `chromadb` npm SDK with `getOrCreateCollection` (Chroma 0.5+ auto-creates)
- **Docker Compose**: The `chroma` service block in `docker/docker-compose.yml` is currently commented out (with its `chroma-data` volume) — enable it when `VECTOR_DB_PROVIDER=chroma` is used

## License and Feature Flags

Simmetric Chat uses JWT-based license keys signed with RS256 (asymmetric — the public key is embedded in the source). Missing or expired licenses automatically degrade to Community tier at runtime.

### License Variables

| Variable | Description |
|----------|-------------|
| `LICENSE_KEY` | RS256 JWT Enterprise license key (issued by the vendor's private key). Community Edition applies if absent. |

### Verification Semantics

`verifyLicenseKey()` (in `licenseService.ts`) returns a closed-enum verdict — `missing`, `expired`, `bad-signature`, `malformed`, or `schema-mismatch` — and never falls back itself; `initLicense()` owns the Community fallback. Verification is strictly **RS256** (`algorithms: ["RS256"]` — the alg:none forgery guard). The public key is the one embedded in `license-public-key.ts` and ships with the source — there is intentionally NO env override (an override would let anyone replace the verifier and self-sign an enterprise license). Key rotation is done by replacing the embedded PEM and redeploying.

Diagnostics:
- `pnpm license:check` — CLI (`packages/server/scripts/check-license.ts`); exit `0` = entitled/Community, `1` = token invalid, `2` = env error. Never prints the key or payload.
- `GET /api/license/info` — unauthenticated; current license state for the frontend.
- `GET /api/license/diagnose` — admin-only (LIC-02); returns tier, reason, env presence booleans, and JWT structural booleans. The response is redacted: any occurrence of `LICENSE_KEY` is replaced with `[REDACTED]` (canary-absence tested).

### Feature Flags

The flag registry lives in `packages/shared/src/constants/license.ts`. (EPA-02) removed the commodity feature flags — `web_search`, `webhooks`, `push_notifications`, `memory_enabled`, `lead_export`, `widget_analytics`, `auto_title_enabled`, and `synthesis_rate_limit` are now always-ON in Community builds (their enterprise-only behaviors are owned by the enterprise plugin via `overrideFeatureLimit`); `priority_support` moved to a commercial/SLA contract; the `max_memories_per_user` numeric cap was removed entirely.

**Community defaults**:
- `sso_enabled`: `false`
- `audit_log_immutable`: `false`
- `white_label`: `false`
- `widget_enabled`: `false`
- `backup_enabled`: `false`
- `widget_credits_editing`: `false`
- `custom_agents`: `3` (numeric limit, verdict)
- `max_workspaces`: `3`
- `max_projects`: `3`
- `max_widgets`: `1`
- `max_backup_destinations`: `1`

**Enterprise defaults**: All boolean flags `true`; numeric limits (`max_workspaces`, `max_projects`, `custom_agents`, `max_widgets`, `max_backup_destinations`) are `Infinity`.

Boolean gating (`requireFeature`) returns HTTP `402` with `{ error, feature, tier }`; numeric limit enforcement (`requireFeatureLimit`) returns `402` with `{ error, feature, tier, limit, current }`. Note that `widget_credits_editing` is enforced inline in `routes/widgets.ts` (scoped to the `credits` field only), not via the `requireFeature` middleware.

## Authentication Configuration

### JWT Authentication

- **Secret**: `JWT_SECRET` (required; must be set before first startup). Used as the legacy AES-256-GCM key by `encryptionService` when `ENCRYPTION_KEY` is unset — dev/test only, since production requires an explicit `ENCRYPTION_KEY` (see "Data-at-Rest Encryption").
- **Expiry**: `SESSION_EXPIRY` (default 24 hours)
- **Storage**: Frontend stores tokens in `localStorage`; server validates `Authorization: Bearer <token>` headers
- **Refresh**: Not implemented; users must re-login after expiry
- **Revocation**: `revokeToken()` is implemented in `tokenRevocation.ts` — when Redis is available it writes a `rev:jti:<jti>` key with TTL (default `SESSION_EXPIRY/1000` = 86400s), and without Redis it no-ops. However, it currently has **zero call sites**: no `/logout` route exists in any server route file, and the frontend logout flow (`useLogout`) just clears `localStorage` without an API call. Revocation is enforced everywhere via `isTokenRevoked()` (`authMiddleware` + direct `verifyToken` call sites), but nothing ever populates the blacklist today.

### Registration Gating

Self-service registration defaults to **closed**. The default value of `ALLOW_REGISTRATION` is `false` (set in `packages/server/src/config/env.ts`).

- `ALLOW_REGISTRATION=true`: Open signup via `POST /api/auth/register` (gated by `authRateLimiter`, 10 req/min prod).
- `ALLOW_REGISTRATION=false` (default): `POST /api/auth/register` returns `403 Registration is disabled. Only admins can create users.` when no Bearer token is present; a valid **admin** Bearer token on the same route still mints users (revoked-token `jti` guarded). Admins create accounts via `POST /api/auth/admin-register` (requires `authMiddleware` + `requireAdmin`) or through the admin user panel.
- The `/api/system/initialize` route additionally writes an `ALLOW_REGISTRATION=false` SystemConfig row when it initializes a fresh install (the runtime gate itself reads the env var via `getEnv()`).

Newly created accounts (whether admin-created or, when registration is open, self-registered) have `mustChangePassword: true` on the `User` row. The first login then forces a password change via `POST /api/auth/set-initial-password`, which is gated on `mustChangePassword === true` to prevent account takeover. This flow is enforced in `packages/server/src/routes/auth.ts` and `packages/server/src/services/authService.ts`.

### Bootstrap Admin

When `SEED_BOOTSTRAP_ADMIN=true` (default) and no admin user exists, the server auto-seeds a bootstrap admin on startup using `SEED_ADMIN_USERNAME` (default `admin`), `SEED_ADMIN_PASSWORD` (default `admin123`, min 8 chars), and `SEED_ADMIN_EMAIL` (default `admin@example.com`). The seeded account carries `mustChangePassword=true` and the password MUST be rotated at first login. Override all three in prod/air-gap deploys. Seeding is idempotent — once any admin user exists, the bootstrap is skipped.

### Password Reset

Password reset is admin-only via `POST /api/auth/admin-reset-password`. An admin provides the target `userId` and a new password (minimum 8 characters). There is no email-based self-service password reset flow and no `RESET_PASSWORD_STRATEGY` switch in the code (the variable is not documented in the root `.env.example` and is not read by the server).

### API Keys

- External API access uses `X-Api-Key` headers with a `sk-` prefix
- Keys are verified via a deterministic **HMAC-SHA256** digest ( / SCALE-03): the raw key is signed with `API_KEY_HMAC_SECRET` and the 64-hex-char digest is stored in `api_keys.key_hash`, looked up with a unique-index `findUnique` — no bcrypt, no per-candidate CPU loop. The raw key is shown only once at creation
- `API_KEY_HMAC_SECRET` is **required when API keys are used**; a missing/invalid secret makes `validateApiKey` throw and the middleware return 500 (fail-loud, not 401 — misconfiguration is never hidden as "invalid key"). Existing `sk-` keys are invalidated by the SCALE-03 migration and must be re-issued — see `docs/API_KEY_MIGRATION.md`
- API keys populate `req.userId` and `req.user` for downstream RBAC
- Generate a widget-service API key with `pnpm --filter server generate-apikey`; the resulting `sk-...` string goes into `WIDGET_API_KEY` in the root `.env` (the same key also serves the server's `WIDGET_API_KEY` for push cache-bust).

## SSO Configuration (SAML / OIDC / SCIM)

Enterprise single sign-on (, v0.19) is configured at runtime via the admin SSO settings panel backed by a singleton `SsoConfig` record. Since (EPA-03), the SAML / OIDC / SCIM route handlers and `ssoService` logic live in the **enterprise plugin** (`simmetric-enterprise`, a separate private repo) and are mounted by `register(ctx)` via `ctx.mountProtected("/api/sso", ...)` + `ctx.mountPublic("/api/auth", ...)` + `ctx.mountPublic("/scim/v2", ...)`. The community server keeps only the public `GET /api/auth/sso/status` endpoint (with an inlined `getSsoConfig` helper) and the `SsoConfig` model (via the merged `schema-enterprise.prisma` fragment). In a community build without the plugin, the SSO routes 404.

All SSO config routes require `authMiddleware` + `requireAdmin` + the `sso_enabled` Enterprise license feature flag (Community tier gets `402`).

### SSO Config API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sso/config` | Retrieve the sanitized singleton config. The encrypted client secret is NEVER returned — only a `clientSecretConfigured` boolean (T-113-01-01). Returns `{ provider: null, enabled: false, clientSecretConfigured: false }` when no config exists. |
| `PUT` | `/api/sso/config` | Save the config. Body: `provider` (`saml` \| `oidc`), `enabled`, `clientId`, `clientSecret` (plaintext on input — encrypted at rest via `encryptionService` AES-256-GCM), `discoveryUrl`, `entryPoint`, `cert`, `entityId`, `redirectUri`. Passing `null` clears a field; `undefined` leaves it unchanged. |
| `POST` | `/api/sso/test` | Structural validation of the stored config (does NOT contact the IdP). SAML requires `entryPoint` + `cert`; OIDC requires `discoveryUrl` + `clientId` + client secret. |
| `POST` | `/api/sso/scim/test` | Reports whether `SCIM_BEARER_TOKEN` is configured and returns the SCIM endpoint URL (`${SERVER_URL}/scim/v2`). |

<!-- VERIFY: exact route handlers, validation rules, and SCIM auth behavior for `/api/sso/*` live in the enterprise package (mounted via `ctx.mountProtected` / `ctx.mountPublic`); the community tree only carries the models and the `sso/status` endpoint. -->

### SAML 2.0

- **Routes**: `GET /api/auth/saml/login` (SP-initiated redirect), `POST /api/auth/saml/callback` (assertion consumer), `GET /api/auth/saml/metadata` (SP metadata XML for IdP configuration)
- **Library**: `@node-saml/passport-saml` (dependency of the enterprise plugin); strategy initialized from the stored `SsoConfig` — missing/wrong-provider config logs and skips gracefully
- **Callback URL**: `${SERVER_URL}/api/auth/saml/callback`
- **Replay protection**: `validateInResponseTo: ValidateInResponseTo.always` with an in-memory request-ID cache (8h expiry)
- **Identifier format**: `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`
- **SLO**: Not supported

### OIDC / OAuth

- **Routes**: `GET /api/auth/oidc/:provider/login` (initiation), `GET /api/auth/oidc/callback` (unified callback)
- **Library**: `openid-client` v6 (stateless functions: `discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`, `fetchUserInfo`)
- **Built-in providers**: `google`, `github`, `microsoft` — discovery URLs are hardcoded (`getProviderDiscoveryUrl()`); credentials are stored in the `SsoConfig` record
- **Custom providers**: any other provider name uses `SsoConfig.discoveryUrl`; the discovery URL MUST be `https://` (openid-client v6 rejects `http://` issuers)
- **Security**: `state` (CSRF) and `nonce` (ID-token replay) are stored in signed cookies (10-min expiry); the callback validates both; the full callback URL is passed to the token exchange (Keycloak `iss`-param compatibility)
- **Redirect URI**: `SsoConfig.redirectUri` or `${SERVER_URL}/api/auth/oidc/callback`

### OIDC via Environment Variables

In addition to the DB-driven admin SSO panel, OIDC provider options can be configured entirely via the root `.env` — useful for air-gap / infra-as-code deployments that ship a working OIDC config without ever opening the admin panel. This is **additive**: when no `OIDC_*` env vars are set, the admin SSO panel (DB `SsoConfig` row) remains the sole source of truth and behaves exactly as before. When `OIDC_*` env vars ARE set, they **override** the corresponding DB field on every request (same env-over-DB semantics as `REDIS_URL` / `DATABASE_URL`).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OIDC_ENABLED` | No | unset → DB `enabled` | Master toggle. Parsed via an explicit string-aware transform (NOT `z.coerce.boolean()`) so the literal string `"false"` actually disables it — same pattern as `SEED_BOOTSTRAP_ADMIN`. When set, overrides the DB `enabled` flag. |
| `OIDC_PROVIDER` | No | unset → derived from `OIDC_DISCOVERY_URL` / DB | One of `google`, `github`, `microsoft` (built-in discovery URL) or `oidc` (custom IdP via `OIDC_DISCOVERY_URL`). |
| `OIDC_DISCOVERY_URL` | No | unset → built-in URL (when `OIDC_PROVIDER` is built-in) or DB `discoveryUrl` | Custom IdP discovery endpoint. MUST be a valid URL (Zod `.url()` refinement). The `https://`-only constraint for production is enforced by `openid-client` v6 (it rejects `http://` issuers); `http://` is allowed by the Zod schema so dev/test setups against a local IdP (e.g. Keycloak on `http://localhost:8080`) keep working — see [Dev-Only TLS for OIDC Discovery](#dev-only-tls-for-oidc-discovery) for the self-signed-cert companion. |
| `OIDC_CLIENT_ID` | No | unset → DB `clientId` | OAuth client ID. |
| `OIDC_CLIENT_SECRET` | No | unset → decrypt DB `clientSecretEncrypted` | OAuth client secret. **Plaintext in env** (same posture as `JWT_SECRET` / `OPENAI_API_KEY`) — NOT encrypted at rest. The DB path encrypts via `encryptionService` AES-256-GCM; the env path skips that and uses the value as-is. Env-file secrecy is the operator's responsibility (file perms, secrets manager). |
| `OIDC_REDIRECT_URI` | No | unset → DB `redirectUri` → `${SERVER_URL}/api/auth/oidc/callback` | Override the registered callback URL. |
| `OIDC_SCOPE` | No | unset → `"openid email profile"` | Space-delimited OAuth scopes. No enum — providers accept arbitrary scopes. |

**Resolution order (per field):** `env.OIDC_*` → DB `SsoConfig` row → hardcoded default. When env is active and the DB row is empty, OIDC still works (env acts as bootstrap). `OIDC_ENABLED` independently overrides the DB `enabled` flag; setting `OIDC_ENABLED=false` forces OIDC off even if the DB row has `enabled=true`.

**Admin panel interaction:** the admin SSO settings panel continues to write to the DB `SsoConfig` row. When `OIDC_*` env vars are set, the panel's save still succeeds, but env wins on the next request — the panel is effectively read-only for OIDC while env is active. To manage OIDC via the panel, unset the `OIDC_*` env vars and restart the server.

**Public status endpoint:** `GET /api/auth/sso/status` is env-aware and stays in the community server — when `OIDC_*` env vars are active, it returns `{ enabled, provider: "oidc", oidcProvider }` derived from env (with DB filling gaps for unset fields). The response shape is unchanged: booleans/enums ONLY, never `clientId` / `discoveryUrl` / `redirectUri` / `clientSecret` (T-260808-p5y-01).

#### Worked Example — Custom Keycloak IdP

```bash
# root .env (the single runtime config)
OIDC_ENABLED=true
OIDC_PROVIDER=oidc
OIDC_DISCOVERY_URL=https://keycloak.example.com/realms/myrealm/.well-known/openid-configuration
OIDC_CLIENT_ID=simmetric-chat
OIDC_CLIENT_SECRET=<plaintext-secret>
OIDC_SCOPE=openid email profile groups
# OIDC_REDIRECT_URI left unset → defaults to ${SERVER_URL}/api/auth/oidc/callback
```

With this `.env` and an empty `sso_configs` table, `GET /api/auth/sso/status` returns `{"enabled":true,"provider":"oidc","oidcProvider":"oidc"}` and `GET /api/auth/oidc/oidc/login` redirects to Keycloak (not `/login?error=sso_not_configured`).

### JIT Provisioning

All SSO callbacks delegate to `ssoLoginOrRegister()` (enterprise `ssoService`): an existing `IdentityProvider` link logs the user in; otherwise a new `User` is JIT-provisioned with the default `user` role, an empty `passwordHash` (SSO users authenticate via IdP, never password), and an `IdentityProvider` link. There is no soft-delete re-activation path: the `User` model has no `deletedAt` field, and the `IdentityProvider.userId` FK has `onDelete: Cascade`, so hard-deleting a user cascades their IdP links (preventing orphan links) — a deleted user's IdP link is gone and a fresh login JIT-provisions a new user. <!-- VERIFY: JIT-provisioning details (default role, empty passwordHash, cascade semantics) live in the enterprise package's `ssoService`; the `IdentityProvider` model + `onDelete: Cascade` are verifiable in `packages/server/prisma/schema-enterprise.prisma`. -->

### SCIM 2.0 Provisioning

- **Endpoint**: `/scim/v2` (Users + Groups CRUD), authenticated via `Authorization: Bearer <SCIM_BEARER_TOKEN>`
- **Stealth mode**: when `SCIM_BEARER_TOKEN` is unset, all SCIM endpoints return `404` (don't advertise)
- **IdP push**: configure your IdP to push users/groups to `${SERVER_URL}/scim/v2`
- **Ownership**: the SCIM router is mounted by the enterprise plugin (`ctx.mountPublic("/scim/v2", ...)`) and applies its own `scimAuth` Bearer-token middleware — <!-- VERIFY: exact `scimAuth` middleware behavior lives in the enterprise package. -->

### Dev-Only TLS for OIDC Discovery

When testing OIDC against a local IdP behind a self-signed TLS proxy (e.g. Keycloak on `https://localhost:8443`), start the dev server with `NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem` so openid-client's discovery call trusts the proxy CA. This is a **DEV-ONLY** pattern — never add self-signed certs to production trust stores. See `docs/operations/sso-verification-runbook.md` for the full verification runbook.

## Email / SMTP Configuration

SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) are used for **backup job email notifications**, not for password reset. They are declared in the server Zod schema (optional) and validated at startup; the notification consumers live in the enterprise backup plugin. <!-- VERIFY: exact send behavior (failure-only emails, `from` fallback chain, port-465 `secure: true`, STARTTLS) is implemented in the enterprise backup plugin — the community tree only carries the schema declaration. -->

## Web Push Configuration

Push notifications use VAPID (Voluntary Application Server Identification).

- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are auto-generated on first use if unset (in `routes/push.ts`); set them explicitly in production to ensure key consistency across restarts
- `VAPID_SUBJECT` defaults to `mailto:admin@simmetric-chat.local`
- Push is **available in all tiers** (Community + Enterprise) — the `push_notifications` license flag was removed in and is no longer a premium gate (see `routes/push.ts`: "a core UX feature, not a premium gate")

## Docker Compose Overview

The default orchestration is defined in `docker/docker-compose.yml`. Additional files: `docker-compose.dev.yml` (source-mount hot-reload override for pure-Docker dev) and `docker-compose.infra.yml` (dev-container infrastructure: postgres + optional qdrant only).

### Services

| Service | Image / Build | Ports | Purpose |
|---------|---------------|-------|---------|
| `frontend` | `docker/Dockerfile.frontend` | `${FRONTEND_PORT:-80}:80`, `443:443` | Nginx serving the React SPA |
| `server` | `docker/Dockerfile.server` | `${SERVER_PORT:-3000}:3000` | Express API |
| `collector` | `docker/Dockerfile.collector` | Exposes `3210` | Document ingestion |
| `widget` | `docker/Dockerfile.widget` | Exposes `3211` | Embeddable widget service |
| `postgres` | `pgvector/pgvector:pg16` | `${POSTGRES_PORT:-5432}:5432` | Primary database |
| `redis` | `redis:7-alpine` | Exposes `6379` | Horizontal-scaling cache |
| `ollama` | `ollama/ollama:latest` | Exposes `11434` | Local LLM inference |
| `qdrant` | `qdrant/qdrant:latest` | Exposes `6333`, `6334` (internal only in the main compose; `127.0.0.1`-mapped in the infra compose) | Vector database |
| `chroma` | `chromadb/chroma:latest` | Exposes `8000` (block commented out) | Vector database |

The `postgres` service maps port `${POSTGRES_PORT:-5432}:5432` to the host (host access is needed for `prisma migrate dev`). The `redis` service runs with `--appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru`; `REDIS_URL=redis://redis:6379` is wired into the `server` and `widget` services. The `server` service also bind-mounts `${LOCAL_BACKUP_PATH:-/var/backups}` for local backup destinations and the host Docker socket (for the Ollama Cloud `docker exec ... ollama login` flow), wires `OLLAMA_KEEP_ALIVE` / `OLLAMA_CONTAINER_NAME` from the host env, and receives `WIDGET_API_KEY` with the default `${WIDGET_API_KEY:-sk-default-widget-key}` on both the server and widget services. `LICENSE_KEY` and `ENCRYPTION_KEY` flow through `env_file: ../.env` (deliberately NOT redeclared inline — a shell-interpolated `LICENSE_KEY=${LICENSE_KEY:-}` would resolve to `""` and override `env_file`, silently downgrading to Community). The collector and widget services read the root `.env` via `env_file: ../.env` (`required: false`).

### Volumes

- `pgdata` — PostgreSQL data
- `redis-data` — Redis append-only persistence
- `ollama-data` — Ollama model weights
- `qdrant-storage` — Qdrant vector data
- `xenova-cache` — Collector embedding-model cache (also mounted at `/app/.cache/xenova`)
- `server-storage` — Server uploads, backups, logs
- `collector-storage` — Collector uploads and LanceDB vectors
- `widget-storage` — Widget service storage
- `chroma-data` — Chroma vector data (declared but commented out together with the `chroma` service)

### Health Checks

All active services except the frontend define Docker health checks. `server`, `collector`, `widget`, `postgres`, `ollama`, `redis`, and `qdrant` each define a `healthcheck`; the `frontend` service has none — it only `depends_on` the server being healthy. The server depends on `postgres` being healthy, and the frontend and widget depend on the server being healthy — the collector declares no `depends_on` (it only defines its own healthcheck).

## System Settings Resolution

Runtime settings can be managed via the admin UI (`/settings`) or seeded at startup. The settings surface is `GET /api/system/settings` (all keys with `readOnly` + `envOverridden` hints) and `PUT /api/system/settings` (bulk upsert returning `{ updated, rejected }` — **partial success is normal**; refetch after save). All settings routes require `authMiddleware` + `requireAdmin`. When Redis is available, `getSetting()` reads through a `config:{key}` cache (5-min TTL) that is invalidated on every `updateSettings()` write, so config changes propagate across instances immediately.

### Read-Only Infrastructure Keys

The following keys are **always read-only** in the UI because they control infrastructure:

- `JWT_SECRET`
- `DATABASE_URL`
- `SERVER_PORT`
- `COLLECTOR_PORT`
- `SERVER_URL`
- `COLLECTOR_URL`

Priority: **ENV > Default**. If an environment variable is set, the DB value is ignored. `REDIS_URL` is also env-only and not UI-editable, but through a different channel entirely: it is read only via the Zod env schema (`getEnv()`) at boot and never passes through SystemConfig storage or the settings UI, so no DB row exists for it.

### Editable Keys

All other keys declared by `configKeySchema` (`packages/shared/src/schemas/config.schema.ts`) follow this priority:

**DB > ENV > Default**

- Values changed in the UI are written to the `SystemConfig` table and take effect immediately
- If an ENV variable exists for an editable key, it acts as the default until overridden in the DB
- If neither DB nor ENV values exist, `CONFIG_DEFAULTS` constants apply (`packages/shared/src/constants/permissions.ts`)
- When an env var is set but loses to the DB value, the settings GET marks the entry with `envOverridden: true` ( D-08 — a boolean-only hint; the env value itself is never exposed through the settings surface) so the UI can show a muted presence hint instead of letting operators believe the env var is effective

### Key DB Settings

| Key | Default | Description |
|-----|---------|-------------|
| `chat_message_retention_days` | `""` (OFF) | Chat message retention window in days. `""` = retention disabled. The **sole write path** is `PUT /api/system/chat-retention` (requires `confirmDataLoss: true`); the bulk `PUT /api/system/settings` rejects this key . Read every run by the pg-boss reaper job (`chatMessageReaperJob.ts`). |
| `ALLOW_NON_ADMIN_UPLOAD` | `true` | Global non-admin upload toggle. OR-inclusive with the workspace-level `allowMemberUploads` flag: either one allows non-admin uploads (`uploadGate.ts`). Flips take effect without restart. |
| `upload_draft_retention_days` | `30` | Expiry window for staged upload drafts. Corrupted values fall back to 30 days. |
| `upload_draft_reaper_enabled` | `true` | Enables/disables the daily upload-draft reaper's pg-boss cron schedule. Only the literal "true" enables (fail-closed); "false" or "" disables. Disable takes effect for the next scheduled job immediately (the work handler re-reads the toggle) and fully after a restart, which also removes the stale pg-boss schedule row. Managed via `PUT /api/system/settings` (admin:settings). |
| `upload_draft_reaper_cron` | `0 3 * * *` | pg-boss cron expression for the reaper cadence. Validated by pg-boss (cron-parser, UTC) when the schedule is registered at boot; an invalid value logs a warning and falls back to the default instead of failing boot. Cadence changes apply on the next server restart. Managed via `PUT /api/system/settings` (admin:settings). |
| `DLP_ENABLED` | `true` | Master gate for DLP scanning/redaction on the chat stream (inlet/outlet plugins + the inline progressive-flush block in `routes/chat.ts`). |
| `DLP_BYPASS_ROLES` | `[]` | JSON array of role NAMES whose members bypass all DLP scanning/redaction (e.g. `["trusted_analyst"]`). Malformed JSON is treated as `[]` (fail-closed — redaction still runs). Admin-editable via `PUT /api/system/settings`. |
| `rag_reranker_enabled` | `false` | Gates the server → collector `/ingest/rerank` CrossEncoder call ( / SC1). Anything other than the literal "true" is off. |
| `rag_reranker_candidate_pool` | `4` | Over-fetch ratio for rerank candidates: the retriever fetches `finalK × pool` candidates (capped at 100) before the optional reranker stage . |
| `rag_min_score_ratio` | `0.2` | Relative score floor for rag_search results: keep results whose score ≥ 20% of the top result's score (scoring-mode-agnostic — works for RRF, rerank sigmoid, and vector-only fallback). `"0"` disables the cutoff. Admin-editable via `PUT /api/system/settings`; consumed in `builtinSkills.ts`. |
| `OCR_ENABLED` | `true` | Master OCR gate for the document pipeline (`routes/documents.ts` precheck). |
| `OCR_PRECHECK_CHARS` | `200` | Text-extracted char threshold below which a PDF is considered image-only and routed to OCR fallback. |
| `OCR_DEFAULT_MODEL` | `""` | Per-request OCR model default (empty → the `OCR_MODEL` env / collector default applies). |
| `OCR_DEFAULT_MODE` | `text` | Default OCR mode (`text` vs vision-style modes) seeded for the upload flow. |
| `OCR_DEFAULT_CUSTOM_INSTRUCTIONS` | `""` | Optional custom instructions passed to the OCR model. |
| `sso_enabled` | `false` (Community) | **License feature flag**, not a SystemConfig key — gates all `/api/sso/*` routes and the SSO login flows. |

Other admin-editable keys in `configKeySchema` follow the same resolution: `auto_title_enabled` (default `"true"`, fire-and-forget title generation), `auto_title_model` (default `""` → workspace default / `LLM_MODEL`), `auto_tags_enabled` (default `"false"`, opt-in tag + follow-up suggestions), `auto_batch_title_tags` (default unset/"false" — single-call batched post-processing), `web_search_provider` (default `"searxng"`, `tavily` is the cloud fallback), `searxng_url` (default `""` → falls back to the `SEARXNG_URL` env), and `setup_wizard_mode` (`""` = boot derivation owns it: `"active"` when no admin exists, `"completed"` once the wizard or initialize flow finishes — the wizard's probe/initialize routes 404 after completion).

### White-Label Gating

Branding keys (`BRANDING_APP_NAME`, `BRANDING_PRIMARY_COLOR`, `BRANDING_APP_SUBTITLE`, `BRANDING_APP_ICON_URL`) are rejected by the settings API unless the `white_label` Enterprise feature is enabled. Since (EPA-05), the check is validator-based: the enterprise plugin registers a config-key validator via `ctx.registerConfigKeyValidator` that allows `BRANDING_*` keys when `white_label` is on and rejects them with a reason when off; a pure community build (no plugin loaded) falls back to rejecting any `BRANDING_*` key (`systemConfigService.ts` — the first registered validator with an opinion wins, and the community fallback only fires when no validators are registered). The branding icon upload/removal routes (`POST`/`DELETE /api/system/settings/branding/icon`) were extracted to the enterprise plugin in — the community tree contains zero branding-icon route code (enforced by `whiteLabelExtractionGuard.test.ts`).

## Rate Limiting

Rate limits are enforced by `express-rate-limit` with hardcoded dev (10×) and prod values per limiter (`NODE_ENV !== "production"` selects the dev value; there is no multiplier knob). When `REDIS_URL` is set, limiters use `rate-limit-redis` stores (per-limiter prefixes `rl:auth:`, `rl:api:`, `rl:lead:`, `rl:probe:` on the server; `rl:` on the widget) so buckets are shared across instances; without Redis they fall back to in-process MemoryStore. Under the Playwright E2E harness (`E2E_RUN=1`, set by `playwright.config.ts` for the spawned server only — never in `pnpm dev`, `pnpm start`, or production), `authRateLimiter` skips all requests to prevent test-suite 429 cascades.

### Server Rate Limits

| Scope | Window | Limit (prod) | Limit (dev) | Key |
|-------|--------|--------------|-------------|-----|
| General API (`apiRateLimiter`) | 1 minute | 200 | 2000 | Client IP |
| Auth endpoints (`authRateLimiter`) | 1 minute | 10 | 100 | Client IP |
| Wizard probes (`probeRateLimiter` — `/api/system/probe-llm`, `/api/system/probe-vector`) | 1 minute | 10 | 100 | Client IP |
| Widget leads (`widgetLeadLimiter`) | 1 hour | 3 | 30 | Client IP |

The `apiRateLimiter` `skip` function bypasses rate limiting for requests carrying the `X-Widget-Id` header (SEC-02 D-08): widget-originated upstream calls are throttled by the widget service's `widgetChatLimiter` (30/min prod / 200/min dev), and the server's per-IP bucket would otherwise exhaust first because all widget traffic shares the widget service's IP. The `widgetChatLimiter` key generator (`packages/widget/src/middleware/rateLimit.ts`) keys on the `widgetId` parsed from `req.originalUrl` (falling back to the client IP); it does NOT key on a hashed apiKey — `X-Api-Key` is an outbound proxy header the widget adds when calling the server and is explicitly rejected as an inbound key. The `authRateLimiter` skips GET requests in dev mode (e.g. `/auth/me`) and every request under the E2E harness (`E2E_RUN=1`).

The per-request chat rate limiter (`chatRateLimiter`) was removed as part of the Variante A refactor; see the NOTE comment in `packages/server/src/middleware/rateLimit.ts`. The ReAct agent now enforces its own budget via `AgentBudgetTracker`:
- Per-user concurrency cap (`CHAT_MAX_CONCURRENT_PER_USER`, default 5)
- Per-request token budget (`AGENT_MAX_TOTAL_TOKENS`, default 200000)
- Per-request wallclock timeout (`AGENT_WALLCLOCK_TIMEOUT_MS`, default 600000)

The general `apiRateLimiter` (200 req/min per IP) provides a coarse global safety net. The server also mounts `widgetLeadLimiter` (3 req/hour per IP in prod / 30 req/hour in dev) to co-exist with the widget service's own `widgetLeadLimiter`.

### Widget Rate Limits

| Scope | Window | Limit (prod) | Limit (dev) | Key |
|-------|--------|--------------|-------------|-----|
| Widget chat (`widgetChatLimiter`) | 1 minute | 30 (dynamic) | 200 (dynamic) | `widgetId` from URL path (falls back to IP) |
| Widget daily messages (`widgetDailyMessageLimiter`) | 24 hours | 5 (dynamic) | 50 (dynamic) | `widget:${widgetId}:${IP}` composite |
| Widget sessions (`widgetSessionLimiter`) | 24 hours | 50 | 500 | Client IP |
| Widget leads (`widgetLeadLimiter`) | 1 hour | 3 | 30 | Client IP |

`widgetChatLimiter` is keyed by the `widgetId` parsed from `req.originalUrl` (NOT `req.params` and NOT `X-Api-Key`, which is an outbound proxy header never sent inbound by the Preact client). The `max` is a dynamic function: it reads the per-widget `rateLimitPerMinute` from the Redis widget-config cache (`widget:config:{widgetId}`) when Redis is available, falling back to the global default (30 prod / 200 dev) on cache miss or Redis absence. `widgetDailyMessageLimiter` (added 151-02) reads `sessionLimitPerDay` the same way (default 5/day prod / 50/day dev) and is mounted before `widgetChatLimiter` so the daily budget is checked first. Widget chat limits are also enforced server-side via DB-tracked counters (`hourlyRemaining` 20/hour, `dailyRemaining` 5/day) returned during session validation (`routes/internalWidget.ts`).

### Collector Rate Limits

No rate limiting is applied on the collector. Upload rate limiting was removed because the collector is an internal microservice and every mutating route is already gated by `requireCollectorSecret` — a per-IP cap of 10/min throttled legitimate bulk archive imports (all server traffic shares one IP). The secret check is the real authz boundary.

All rate-limited responses include a `429` status code and, where applicable, a `Retry-After` header.

---

## See also

- [Documentation index](./INDEX.md)
- [API Reference](./API.md)
- [Deployment](./DEPLOYMENT.md)
- [Multi-Instance Scaling Guide](./SCALING.md) — multi-instance deployment, `REDIS_URL` requirements, pg-boss, and the `ENCRYPTION_KEY` / `API_KEY_HMAC_SECRET` hard-defaults
- [Encryption Key Rotation](./ENCRYPTION_KEY_ROTATION.md) — `ENCRYPTION_KEY` / `LEGACY_PREVIOUS_ENCRYPTION_KEYS` rotation runbook
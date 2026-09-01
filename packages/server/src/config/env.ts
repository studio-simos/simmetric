// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import path from "path";
import { z } from "zod";
import {
  embeddingProviderSchema,
  vectorDbProviderSchema,
  ollamaKeepAliveSchema,
  loadRootEnv,
  resolveRootEnvPath,
} from "@simmetric-chat/shared";
import { logger } from "../utils/logger";

// OPS-05 (D-12) lineage: env paths resolve __dirname-relative, not
// process.cwd(). The per-package .env files were REMOVED (Phase 177
// cleanup) — the repo-root .env is THE single runtime config. ENV_PATH now
// points at the root file (marker-walk; cwd-adjacent fallback when no
// pnpm-workspace.yaml exists up-chain, e.g. the Tauri packaged layout) and
// stays exported because the fail-loud Zod diagnostics below print it as
// the `Expected .env at:` path.
export const ENV_PATH = resolveRootEnvPath(__dirname);

// Root-only loader: fills ONLY keys absent from process.env (never
// overridden), no values logged. ENV_PATH is the SAME resolved path the
// diagnostics print, keeping the contract byte-identical.
loadRootEnv(__dirname);

// Phase 178.1 (CF-08): exported for the envExampleParity tripwire's shape
// introspection only — do not mutate (.shape is mutable in Zod).
export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  SERVER_PORT: z.coerce.number().default(3000),
  COLLECTOR_PORT: z.coerce.number().default(3210),
  SERVER_URL: z.string().default("http://localhost:3000"),
  COLLECTOR_URL: z.string().default("http://localhost:3210"),
  // WID-04: widget service URL + shared secret for push HTTP cache-bust.
  // WIDGET_SERVICE_URL points at the widget Express service (default :3211).
  // WIDGET_API_KEY is the symmetric shared secret matching the widget
  // service's WIDGET_API_KEY (root .env); when unset, fireWidgetCacheBust is
  // a no-op (5-min TTL is safety net). Optional on the server side so the
  // admin can disable push.
  WIDGET_SERVICE_URL: z.string().default("http://localhost:3211"),
  WIDGET_API_KEY: z.string().min(1).optional(),
  DATABASE_URL: z
    .string()
    .default(
      "postgresql://simmetricchat:simmetricchat@host.docker.internal:5432/simmetricchat",
    ),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  // Data-at-rest encryption key (provider API keys, backup destination configs).
  // Optional: when set, encryptionService uses this base64 32-byte key directly,
  // decoupling encryption from JWT_SECRET. When unset, falls back to the legacy
  // scryptSync(JWT_SECRET) derivation so existing ciphertexts stay decryptable.
  // Strict base64/length validation lives in encryptionService.ts (consumption site).
  ENCRYPTION_KEY: z.string().optional(),
  // Phase 163 (SCALE-03): HMAC-SHA256 signing key for API keys. Optional base64
  // 32-byte key — strict base64/32-byte validation lives in apiKeyService.ts
  // (consumption site), mirroring the ENCRYPTION_KEY pattern above.
  API_KEY_HMAC_SECRET: z.string().optional(),
  SESSION_EXPIRY: z.coerce.number().default(86400000), // 24h in ms
  // D-08 (Phase 104): Redis connection URL — optional. When absent, Redis
  // features are disabled (graceful degradation per D-02: auth cache falls
  // through to DB, SSE stays single-instance, Bree mutex stays PostgreSQL,
  // rate limits stay in-memory). When set, enables horizontal scaling.
  // Env-only key (not in ALWAYS_READONLY, not UI-editable — follows the same
  // pattern as other infra keys like DATABASE_URL).
  REDIS_URL: z.string().optional(),
  LLM_PROVIDER: z
    .enum(["openai", "anthropic", "ollama", "openrouter"])
    .default("ollama"),
  LLM_MODEL: z.string().default("gemma4:latest"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  LLM_MAX_TOKENS: z.coerce.number().default(4096),
  LLM_TIMEOUT: z.coerce.number().default(0), // no timeout by default — local LLMs on underpowered hardware need unlimited time
  LLM_API_KEY: z.string().optional(),
  LLM_API_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://ollama:11434"),
  OLLAMA_MODEL: z.string().optional(),
  OLLAMA_API_KEY: z.string().optional(),
  // Ollama Cloud Login — the server container runs `docker exec
  // <OLLAMA_CONTAINER_NAME> ollama login` against the host Docker daemon
  // (socket mounted in docker-compose.yml) to trigger the Ollama daemon's
  // SSH-key-based cloud auth flow. Optional with a default matching the
  // docker-compose ollama service container_name. No request input reaches
  // the docker CLI arguments (hardcoded `exec <name> ollama login` via
  // execFile, not exec), so this value is purely infra config.
  OLLAMA_CONTAINER_NAME: z.string().default("simmetric-chat-ollama"),
  // D-04 (Phase 92-01): ollama-js keep_alive for warm KV cache between
  // requests (guidance 5–30min; never -1/infinite — no permanent memory
  // pinning on small deployments). Threaded to chat/generate/embed calls by
  // the migration plans (92-02+); schema-only in this plan.
  // Single source of truth: packages/shared/src/schemas/env.schema.ts.
  OLLAMA_KEEP_ALIVE: ollamaKeepAliveSchema,
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api"),
  OPENROUTER_MODEL: z.string().optional(),
  // Agent Watchdogs — replace the removed `maxIterations` cap (ReAct loop is now `while (true)`).
  // Each watchdog blocks a specific failure mode; see docs/agent-watchdogs.md.
  AGENT_WALLCLOCK_TIMEOUT_MS: z.coerce.number().default(600000), // 10 min — absolute upper bound per request
  AGENT_MAX_TOTAL_TOKENS: z.coerce.number().default(200000), // total prompt + completion tokens per request
  AGENT_MAX_CONTEXT_BYTES: z.coerce.number().default(500000), // 500 KB — context array size cap
  AGENT_MAX_TOOL_OUTPUT_LENGTH: z.coerce.number().default(5000), // per-skill output truncation
  AGENT_MAX_SKILL_EXECUTION_MS: z.coerce.number().default(60000), // 1 min — per-skill execution timeout
  AGENT_LOOP_DETECTION_WINDOW: z.coerce.number().default(3), // abort after N identical (tool, input) in a row
  CHAT_MAX_CONCURRENT_PER_USER: z.coerce.number().default(5), // partial replacement of removed chatRateLimiter
  // Phase 97 (MEM-02 D-04): char cap for the composed <memory_context> block
  // injected into the system message by the pre-LLM retrieval hook. The limit
  // bounds only the rendered memory lines (marker + wrapper tags excluded).
  // Default 2000 (Open WebUI precedent). Optional — when unset the default
  // applies. AGENT_MEMORY_REVIEW_INTERVAL is NOT used here (Wave 3 auto-
  // extraction).
  AGENT_MEMORY_CHAR_LIMIT: z.coerce.number().int().positive().default(2000),
  // Phase 97 (MEM-03 D-06): auto-extraction fires every N turns post-done
  // (fire-and-forget, non-blocking). 0 disables the feature. Default 10
  // (Open WebUI precedent). The orchestrator checks turnCount % interval === 0
  // before scheduling the extraction; the in-process setImmediate call is
  // gated by userId non-null (Pitfall 3 anonymous widget guard) +
  // memory_enabled license flag.
  AGENT_MEMORY_REVIEW_INTERVAL: z.coerce.number().int().min(0).default(10),
  // Phase 97 (MEM-03 D-06): cosine similarity threshold for dedup before add.
  // Open WebUI precedent 0.92; tunable 0.85..0.99 per RESEARCH Common Pitfalls.
  AGENT_MEMORY_DEDUP_THRESHOLD: z.coerce.number().min(0.85).max(0.99).default(0.92),
  // OCR Configuration — admin-configurable, supports model:version format per D-03
  OCR_MODEL: z.string().default("glm-ocr:latest"),
  OCR_TIMEOUT: z.coerce.number().default(600000), // 10 min — vision models are slow
  // Max output tokens for the vision OCR model. Admins raise this for dense
  // documents that trip the default cap (the resulting truncation is surfaced
  // via OcrPageResult.truncated). Min 256 guards against pathological typos.
  OCR_NUM_PREDICT: z.coerce.number().int().min(256).default(8192),
  // Synthesis Configuration — model used for the auto-synthesis pipeline
  SYNTHESIS_LLM_MODEL: z.string().default("gemma4:latest"),
  // D-05 (Phase 89-03): "hf-local" is the additive HF v3 provider (@huggingface/transformers).
  // "local" stays the unchanged default (Xenova 2.x). Additive enum, no re-index.
  // Single source of truth: packages/shared/src/schemas/env.schema.ts.
  EMBEDDING_PROVIDER: embeddingProviderSchema,
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  // D-08 (Phase 91-01): "pgvector" widened additively — mirrors the collector
  // enum. Default "lancedb" is invariant (Rule 3 additive widening). URL is
  // served by /api/system/vector-db-config from getEnv().DATABASE_URL when
  // provider=pgvector.
  // Single source of truth: packages/shared/src/schemas/env.schema.ts.
  VECTOR_DB_PROVIDER: vectorDbProviderSchema,
  VECTOR_DB_URL: z.string().optional(),
  VECTOR_DB_API_KEY: z.string().optional(),
  ALLOW_REGISTRATION: z.coerce.boolean().default(false),
  // Phase 99 (WEB-01 D-07): web search env keys — ALLOW_WEB_SEARCH hard gate
  // (default false), SEARXNG_URL default localhost:8888, TAVILY_API_KEY optional.
  ALLOW_WEB_SEARCH: z.coerce.boolean().default(false),
  SEARXNG_URL: z.string().default("http://localhost:8888"),
  TAVILY_API_KEY: z.string().optional(),
  // Bootstrap admin — auto-seeded on first startup when no admin user exists
  // yet. The password is a one-shot bootstrap credential: the seeded account
  // carries mustChangePassword=true, so it MUST be rotated at first login via
  // /api/auth/set-initial-password (or /change-password). Override in prod /
  // air-gap deploys to avoid shipping the well-known default. Seeding is
  // skipped entirely once any admin user already exists (idempotent guard).
  // NOTE: parsed via an explicit transform rather than z.coerce.boolean(),
  // because Boolean("false") is true — a literal "false" in the env must
  // actually disable the toggle.
  SEED_BOOTSTRAP_ADMIN: z
    .union([z.boolean(), z.string()])
    .transform((v) => {
      if (typeof v === "boolean") return v;
      return !["false", "0", "no", "off", ""].includes(v.trim().toLowerCase());
    })
    .default(true),
  SEED_ADMIN_USERNAME: z.string().default("admin"),
  SEED_ADMIN_PASSWORD: z.string().min(8).default("admin123"),
  SEED_ADMIN_EMAIL: z.string().default("admin@example.com"),
  DISABLE_TELEMETRY: z.coerce.boolean().default(true),
  LICENSE_KEY: z.string().optional(),
  COLLECTOR_SECRET: z
    .string()
    .min(1, "COLLECTOR_SECRET is required"),
  // SCIM 2.0 provisioning — Bearer token secret used by scimAuth middleware.
  // When unset, all SCIM endpoints return 404 (stealth mode — don't advertise).
  SCIM_BEARER_TOKEN: z.string().optional(),
  // MCP-03 (D-05 / Phase 150): MCP server shared-secret Bearer token for
  // /api/mcp/sse + /api/mcp/message. This is a SHARED SECRET, NOT a user JWT
  // — IDE clients (Cursor/VS Code) cannot mint user JWTs, so the model is a
  // single admin-level integration secret set by the operator. When unset
  // (empty or absent), the MCP server falls back to localhost-only
  // (127.0.0.1/::1) connections + a boot-time warn log (D-06) so local dev
  // with Cursor keeps working without configuration. No `.min(1)` — empty
  // string = unset (matches the SCIM_BEARER_TOKEN precedent above).
  MCP_API_KEY: z.string().optional(),
  // OIDC / OAuth provider configuration (Enterprise). Env overrides the DB
  // SsoConfig row; see docs/CONFIGURATION.md "OIDC via environment variables".
  // All optional — when unset, the admin SSO settings panel (DB) remains the
  // source of truth. Air-gap / infra-as-code deployments can ship a working
  // OIDC config via .env alone, with no admin panel interaction and no DB row.
  // NOTE: parsed via an explicit transform rather than z.coerce.boolean(),
  // because Boolean("false") is true — a literal "false" in the env must
  // actually disable the toggle. Same precedent as SEED_BOOTSTRAP_ADMIN above.
  OIDC_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => {
      if (typeof v === "boolean") return v;
      return !["false", "0", "no", "off", ""].includes(v.trim().toLowerCase());
    })
    .optional(),
  // Built-in providers get a hardcoded discovery URL (getProviderDiscoveryUrl
  // in the enterprise package); "oidc" = custom IdP via OIDC_DISCOVERY_URL.
  OIDC_PROVIDER: z.enum(["google", "github", "microsoft", "oidc"]).optional(),
  // .url() enforces a valid URL; the https://-only constraint is enforced at
  // the consumption site by openid-client v6 (which rejects http:// issuers in
  // production). Do NOT add a custom https-only regex here — it would reject
  // valid http:// test URLs in dev and duplicate the openid-client check.
  OIDC_DISCOVERY_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  // Plaintext env secret (same posture as OPENAI_API_KEY / COLLECTOR_SECRET
  // before it was made required) — no .min(1) so empty string = unset. The DB
  // path encrypts at rest via encryptionService; the env path does NOT (env
  // file secrecy is the operator's responsibility — file perms, secrets mgr).
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  // Space-delimited scopes; no enum — providers accept arbitrary scopes.
  // Defaults to "openid email profile" at the consumption site when unset.
  OIDC_SCOPE: z.string().optional(),
  // --- Optional integration env vars (validated here so missing/malformed
  // values surface at startup, not at feature-use time). All optional with
  // sensible behavior when unset. See CONCERNS.md "Unvalidated process.env". ---
  // VAPID Web Push (push_notifications feature). When unset, push.ts generates
  // ephemeral keys for development and warns.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  // SMTP for password-reset + backup failure notifications. When unset, the
  // relevant features log+skip instead of failing.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().min(1).max(65535).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // Puppeteer/Chromium executable for archive PDF export. Defaults handled at
  // the consumption site (archiveExportService.ts).
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),
  // CORS allowlist for the global cors() in index.ts (SEC-01). Comma-separated
  // string parsed into string[] — trim entries, drop empties, fall back to the
  // dev-friendly default list when unset/empty. Do NOT validate URL format
  // strictly: IP/hostname origins (e.g. http://127.0.0.1:5173) must work. The
  // /api/internal/widget path is excluded from this global cors by a wrapper
  // middleware in index.ts so widgetCors remains the sole CORS authority there.
  ALLOWED_ORIGINS: z
    .string()
    .default(
      "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000",
    )
    .transform((val) => {
      const parsed = val
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return parsed.length > 0
        ? parsed
        : [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
          ];
    }),
  // Logging level. NOTE: logger.ts reads process.env.LOG_LEVEL directly at
  // module-load (it is imported BY this module, so getEnv() cannot run there).
  // Declaring it here documents/validates the value for any caller that reads
  // it via getEnv(); the logger init path is an accepted structural exception.
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env | null = null;

export function getEnv(): Env {
  if (!parsedEnv) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      // OPS-05 (D-13): emit an actionable diagnostic naming the resolved .env
      // absolute path + the missing/invalid keys BEFORE the non-zero exit.
      // Only key NAMES + Zod field-error metadata are logged — never raw
      // secret values (T-83-05b: no new information-disclosure surface).
      const missing = result.error.issues
        .filter(
          (i) =>
            i.code === "invalid_type" &&
            i.message.includes("received undefined"),
        )
        .map((i) => i.path.join("."))
        .join(", ");
      logger.error(
        `[env] Invalid environment variables. Expected .env at: ${ENV_PATH}` +
          (missing ? `\n[env] Missing required key(s): ${missing}` : "") +
          `\n[env] Validation errors: ${JSON.stringify(
            result.error.flatten().fieldErrors,
          )}`,
      );
      process.exit(1);
    }
    parsedEnv = result.data;
  }
  return parsedEnv;
}

export function clearEnvCache(): void {
  parsedEnv = null;
}

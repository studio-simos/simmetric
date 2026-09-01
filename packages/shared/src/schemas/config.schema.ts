// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== System Config Schemas =====

export const configKeySchema = z.enum([
  // LLM Configuration
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_API_KEY",
  "LLM_API_BASE_URL",
  "LLM_TEMPERATURE",
  "LLM_MAX_TOKENS",

  // Anthropic-specific
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",

  // OpenAI-specific
  "OPENAI_API_KEY",
  "OPENAI_MODEL",

  // Ollama-specific
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",

  // Embedding Configuration
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "EMBEDDING_API_KEY",

  // Vector DB Configuration
  "VECTOR_DB_PROVIDER",
  "VECTOR_DB_URL",
  "VECTOR_DB_API_KEY",

  // Server Configuration
  "SERVER_PORT",
  "COLLECTOR_PORT",
  "SERVER_URL",
  "COLLECTOR_URL",

  // Database
  "DATABASE_URL",

  // Auth
  "JWT_SECRET",
  "SESSION_EXPIRY",
  "SCIM_BEARER_TOKEN",

  // Agent Watchdog (Phase 113+ — admin-editable budget/threshold knobs)
  "AGENT_WALLCLOCK_TIMEOUT_MS",
  "AGENT_MAX_TOTAL_TOKENS",
  "AGENT_MAX_CONTEXT_BYTES",
  "AGENT_MAX_TOOL_OUTPUT_LENGTH",
  "AGENT_MAX_SKILL_EXECUTION_MS",
  "AGENT_LOOP_DETECTION_WINDOW",
  "AGENT_MEMORY_CHAR_LIMIT",
  "AGENT_MEMORY_REVIEW_INTERVAL",
  "AGENT_MEMORY_DEDUP_THRESHOLD",

  // VAPID Web Push (push_notifications feature)
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",

  // Branding
  "BRANDING_APP_NAME",
  "BRANDING_PRIMARY_COLOR",
  "BRANDING_APP_SUBTITLE",
  "BRANDING_APP_ICON_URL",

  // Feature Flags
  "DISABLE_TELEMETRY",
  "ALLOW_REGISTRATION",
  "DLP_ENABLED",
  // 260829-n95 — DLP_FEATURES_SPEC §2.2: role-name JSON array ("[]") whose
  // members bypass DLP redaction. Admin-editable via PUT /api/system/settings
  // (NOT ALWAYS_READONLY). String VALUE carries a JSON array of role names.
  "DLP_BYPASS_ROLES",

  // OCR Configuration
  "OCR_DEFAULT_MODEL",
  "OCR_DEFAULT_MODE",
  "OCR_DEFAULT_CUSTOM_INSTRUCTIONS",
  "OCR_ENABLED",
  "OCR_PRECHECK_CHARS",

  // Synthesis Configuration
  "SYNTHESIS_LLM_PROVIDER_ID",
  "SYNTHESIS_LLM_MODEL",

  // Phase 68/84 — retention knobs + non-admin upload toggle (UI-editable)
  "upload_draft_retention_days",
  "ALLOW_NON_ADMIN_UPLOAD",
  // 260829-kkn — Upload-draft reaper configurability. Admin-editable via
  // PUT /api/system/settings (DB > ENV > Default; NOT ALWAYS_READONLY);
  // consumed by initUploadDraftReaperScheduler at boot.
  "upload_draft_reaper_enabled",
  "upload_draft_reaper_cron",
  // Phase 84 — Chat message retention (default "" = OFF; sole write path is
  // PUT /api/system/chat-retention, rejected by bulk updateSettings per D-09).
  "chat_message_retention_days",

  // Phase 93 — CrossEncoder reranker gate (SC1 default OFF; admin-editable).
  // `rag_reranker_enabled` gates the server→collector /ingest/rerank call;
  // `rag_reranker_candidate_pool` is the over-fetch ratio (D-03, default 4×).
  // Both are DB>ENV>Default (NOT ALWAYS_READONLY) — admin-editable at runtime.
  "rag_reranker_enabled",
  "rag_reranker_candidate_pool",
  // 260815-i4s — rag_search relative score floor (default 0.2 = keep results
  // >= 20% of top score; "0" disables). Admin-editable via PUT /api/system/settings.
  "rag_min_score_ratio",

  // Phase 98 (POST-01 D-05/D-06) — Async post-processing config (admin-editable).
  // `auto_title_enabled` gates fire-and-forget title gen (default ON — UX-critical).
  // `auto_title_model` is the cheap model for title gen (default "" → workspace default).
  // `auto_tags_enabled` gates tag + follow-up suggestions (default OFF — opt-in, Plan 02).
  "auto_title_enabled",
  "auto_title_model",
  "auto_tags_enabled",
  // Phase 157 (CSW-12 D-06) — Batched post-processing opt-in. When "true" AND
  // both auto_title_enabled + auto_tags_enabled are on, a single LLM call
  // returns {title, tags, followUps} JSON (halves first-exchange round-trips).
  // Default unset = "false" (existing two-call path preserved, no breaking change).
  "auto_batch_title_tags",
  // Phase 99 (WEB-01 D-07) — Web search config (admin-editable). web_search_provider
  // default "searxng"; searxng_url default "" (falls back to SEARXNG_URL env).
  "web_search_provider",
  "searxng_url",

  // Phase 152 (WIZ-02, D-04) — Setup-wizard state machine. Values: "active"
  // (fresh install, no admin — wizard owns admin creation) | "completed"
  // (admin exists OR initialize succeeded). Default "" so the boot-time
  // derivation (ensureSetupWizardMode) owns the initial value; mirrors the
  // chat_message_retention_days: "" precedent. NOT in ALWAYS_READONLY — the
  // initialize flow + boot derivation must be able to write it.
  "setup_wizard_mode",
]);

export const setConfigSchema = z.object({
  key: configKeySchema,
  value: z.string(),
});

export const bulkSetConfigSchema = z.object({
  configs: z.array(setConfigSchema),
});

export type ConfigKey = z.infer<typeof configKeySchema>;
export type SetConfigInput = z.infer<typeof setConfigSchema>;
type BulkSetConfigInput = z.infer<typeof bulkSetConfigSchema>;
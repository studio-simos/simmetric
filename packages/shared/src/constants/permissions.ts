// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Permission Definitions =====
// Stored as an enum table in Prisma.

export const PERMISSION_NAMES = [
  // Workspace permissions
  "workspace:read",
  "workspace:write",
  "workspace:delete",
  // Project permissions
  "project:read",
  "project:write",
  "project:delete",
  // Chat permissions
  "chat:read",
  "chat:write",
  "chat:delete",
  // Document permissions
  "document:read",
  "document:write",
  "document:delete",
  // Admin permissions
  "admin:users",
  "admin:settings",
  "admin:roles",
  // Creation permissions
  "project:create",
  "workspace:create",
  // Provider permissions
  "provider:read",
  "provider:write",
  // Archive permissions
  "archive:read",
  "archive:write",
  "archive:delete",
  // Backup permissions
  "backup:destination:read",
  "backup:destination:write",
  "backup:job:read",
  "backup:job:write",
  "backup:log:read",
  "backup:restore:write",
  // Phase 97 (MEM-01 D-02): memory permissions — 29th/30th. User manages their own
  // per-user-per-workspace memories (read + write); the auto-extraction (MEM-03)
  // uses `memory:write` server-side. `permissionNameSchema` (Zod enum) widens from
  // 28 to 30 values automatically. `DEFAULT_ADMIN_ROLE.permissions` spreads
  // `[...PERMISSION_NAMES]` so it auto-gains both.
  "memory:read",
  "memory:write",
  // Phase 100 (PLG-01 D-09): filter management permission — 31st. Admin +
  // superuser only (DEFAULT_ADMIN_ROLE spreads [...PERMISSION_NAMES] so it
  // auto-gains; DEFAULT_USER_ROLE intentionally does NOT include it). Gates
  // GET /api/filters + PATCH /api/filters/:name. No new menu section — Filters
  // is a sub-tab of Settings (handled in Plan 03 frontend).
  "filters:manage",
] as const;

export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const permissionNameSchema = z.enum(PERMISSION_NAMES);

// ===== Default Role Definitions =====
// These are seeded on first boot via prisma/seed.ts

const DEFAULT_ADMIN_ROLE = {
  name: "admin",
  description: "Full access to all features and settings",
  isDefault: true,
  permissions: [...PERMISSION_NAMES] as PermissionName[],
} as const;

const DEFAULT_USER_ROLE = {
  name: "user",
  description: "Standard user with limited access",
  isDefault: true,
  permissions: [
    "workspace:read",
    "chat:read",
    "chat:write",
    "document:read",
    "document:write",
    "archive:read",
    "provider:read",
    "project:create",
    "workspace:create",
    // Phase 97 (MEM-01 D-02): user manages their own memories (read + write).
    // The auto-extraction (MEM-03) uses `memory:write` server-side, not user-facing.
    "memory:read",
    "memory:write",
  ] as PermissionName[],
} as const;

// Feature 3.4a — Settings reorganized into 5 top-level tabs (General / LLM
// Providers / Appearance / Security / Advanced). Each top-level tab nests the
// pre-existing sub-section components. Visibility = OR on the permissions of
// the sub-sections it contains (SettingsPage.tsx uses `.some()`, so a
// multi-element array means OR). An empty array = visible to all authenticated
// users (e.g. General contains SettingsProfile which is always visible).
//
// Deep-link (`?tab=<legacy>`) and localStorage `lastSettingsSection` back-compat
// is handled entirely frontend-side by SettingsPage's `LEGACY_TAB_MAP`, which
// maps any old sub-section key (profile, providers, roles, vectordb, backups,
// widgets, …) onto one of the 5 canonical keys below. The server never inspects
// these keys, so only the 5 canonical entries need to live here.
export const SETTINGS_TAB_PERMISSIONS: Record<string, PermissionName[]> = {
  profile: [],  // Personal info + custom instructions (always) + languages (admin:settings) → OR ⇒ always visible
  llm: ["provider:read", "provider:write", "admin:settings"], // Providers + LLM/Embedding
  appearance: [],  // Theme/accent/font/density — visible to all authenticated users
  // Phase 70 Pitfall 6: admin:settings added so a settings-only admin sees the
  // Security tab where the ALLOW_NON_ADMIN_UPLOAD toggle lives (OR semantics).
  security: ["admin:roles", "admin:users", "admin:settings"], // Roles + Users + non-admin upload toggle
  advanced: [],  // Chat Data (always visible) keeps the tab open to all; admin-only
                // sub-sections (VectorDB, ApiKeys, Mcp, Maintenance, DLP, ResetDB,
                // Backups) are gated individually via per-sub-section `show`.
};

export const DEFAULT_ROLES = [DEFAULT_ADMIN_ROLE, DEFAULT_USER_ROLE] as const;

// ===== Menu Sections =====
// Controls which sidebar navigation items are visible per role.

// Order is canonical only — the visible sidebar order is controlled by the
// frontend (App.tsx inline Sidebar). Stored as strings in RoleMenuSection so
// adding sections is additive and requires no Prisma migration.
export const MENU_SECTIONS = [
  "dashboard",
  "chat",
  "documents",
  "knowledgeBase",
  "workspaces",
  "projects",
  "marketplace",
  "mcpConnections",
  "eventLog",
  "analytics",
  "widget",
  "settings",
  // Phase 71-03: 'uploads' is the 13th section (additive, D-01 menu placement).
  // User role has document:write (SC-1 visibility); admin spreads [...MENU_SECTIONS].
  "uploads",
] as const;

export type MenuSection = (typeof MENU_SECTIONS)[number];

export const menuSectionSchema = z.enum(MENU_SECTIONS);

export const DEFAULT_ROLE_MENU_SECTIONS: Record<string, MenuSection[]> = {
  admin: [...MENU_SECTIONS],
  user: ["dashboard", "chat", "documents", "knowledgeBase", "workspaces", "widget", "uploads"],
};

// ===== Config Defaults =====

export const CONFIG_DEFAULTS: Record<string, string> = {
  LLM_PROVIDER: "ollama",
  LLM_MODEL: "gemma4:latest",
  LLM_TEMPERATURE: "0.7",
  LLM_MAX_TOKENS: "4096",
  EMBEDDING_PROVIDER: "local",
  EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  VECTOR_DB_PROVIDER: "lancedb",
  SERVER_PORT: "3000",
  COLLECTOR_PORT: "3210",
  SESSION_EXPIRY: "86400000", // 24h in ms
  ALLOW_REGISTRATION: "true",
  DISABLE_TELEMETRY: "true",
  DLP_ENABLED: "true",
  // 260829-n95 — DLP_FEATURES_SPEC §2.2: JSON array of role NAMES whose
  // members bypass ALL DLP scanning/redaction (dlpPlugin inlet/outlet + the
  // handleChatStream inline progressive-flush block). Default "[]" = no
  // bypass (every request is scanned). The seedConfigDefaults loop
  // auto-seeds this row; admin-editable via PUT /api/system/settings.
  DLP_BYPASS_ROLES: "[]",
  OCR_DEFAULT_MODEL: "",
  OCR_DEFAULT_MODE: "text",
  OCR_DEFAULT_CUSTOM_INSTRUCTIONS: "",
  OCR_ENABLED: "true",
  OCR_PRECHECK_CHARS: "200",
  SYNTHESIS_LLM_PROVIDER_ID: "",
  SYNTHESIS_LLM_MODEL: "",
  // Phase 68 — UploadDraft retention + non-admin upload toggle defaults
  upload_draft_retention_days: "30",
  ALLOW_NON_ADMIN_UPLOAD: "true",
  // 260829-kkn — Upload-draft reaper configurability. `enabled` is fail-closed:
  // only the literal "true" enables (mirrors ALLOW_NON_ADMIN_UPLOAD parse in
  // uploadGate.ts); "false" or "" disables the schedule. `cron` is the pg-boss
  // cadence, validated at schedule() time by pg-boss's cron-parser; invalid
  // values fall back to this default with a warn (never crash boot).
  upload_draft_reaper_enabled: "true",
  upload_draft_reaper_cron: "0 3 * * *",
  // Phase 84 — Chat message retention default OFF ("" = OFF per Pitfall 4;
  // Record<string,string> cannot hold null; reaper treats "" as no-op per D-15).
  chat_message_retention_days: "",
  // Phase 93 — CrossEncoder reranker (SC1 default OFF; D-03 over-fetch ratio).
  // `rag_reranker_enabled` default "false" → SC1 zero behavior change at rest;
  // `rag_reranker_candidate_pool` default "4" → over-fetch 4× final K (capped 100).
  rag_reranker_enabled: "false",
  rag_reranker_candidate_pool: "4",
  // 260815-i4s — rag_search relative score floor. Default "0.2" = keep results
  // whose score >= 20% of the top result's score (scoring-mode-agnostic: works
  // for RRF, rerank sigmoid, and vector-only fallback scores). "0" disables
  // the cutoff (backward-compat — all results pass through regardless of score).
  rag_min_score_ratio: "0.2",
  // Phase 98 (POST-01 D-05/D-06) — Async post-processing config defaults.
  // `auto_title_enabled` default "true" → feature ON by default (UX-critical).
  // `auto_title_model` default "" → resolves to workspace default or LLM_MODEL env.
  // `auto_tags_enabled` default "false" → opt-in (Plan 02; cost control).
  auto_title_enabled: "true",
  auto_title_model: "",
  auto_tags_enabled: "false",
  // Phase 99 (WEB-01 D-07) — Web search config defaults. web_search_provider
  // default "searxng" (air-gap primary); searxng_url default "" (falls back
  // to SEARXNG_URL env).
  web_search_provider: "searxng",
  searxng_url: "",
  // Phase 152 (WIZ-02, D-04) — Setup-wizard mode default unset. The boot
  // derivation (ensureSetupWizardMode) derives "active" (no admin) or
  // "completed" (admin exists) on first boot. Mirrors the
  // chat_message_retention_days: "" precedent — "" means "boot owns it".
  setup_wizard_mode: "",
} as const;
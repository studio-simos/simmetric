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
  // Phase 190 (SKIL-01 D-07): skills CRUD permission surface — 32nd–35th.
  // Admin role spreads [...PERMISSION_NAMES] so it auto-gains all four.
  // DEFAULT_USER_ROLE gains create/read/write/delete (users manage their own
  // personal skills, mirroring the memory:read/write Phase 97 pattern);
  // WR-04: skill:delete IS granted — the DELETE route still enforces
  // owner(createdBy)-or-admin server-side, and self-service deletion keeps
  // the max_skills count-at-provision limit escapable (a user who hits the
  // community limit can free headroom without an admin). Gates the /api/skills
  // CRUD routes (Plan 02) + the /skills management page (Plan 04).
  "skill:create",
  "skill:read",
  "skill:write",
  "skill:delete",
  // Phase 192 (DLP-04 D-10): document-PII unmask permission — 36th. Gates the
  // document-preview unmask variant (GET /:documentId/text?unmask=true) and
  // the chat stream-end re-composition (placeholders [PERSON_1] → decrypted
  // originals). Admin role spreads [...PERMISSION_NAMES] so it auto-gains;
  // DEFAULT_USER_ROLE intentionally does NOT include it — unmask is an
  // elevated capability, not a default user ability. Resolved per-request via
  // the Phase 189 resolveWorkspaceRole() machinery (never a parallel check).
  "dlp:unmask",
  // Phase 195 (MCPO-01 D-15): MCP OAuth management permission — 37th. Gates the
  // oauth start/revoke routes (POST /:id/oauth/start, DELETE /:id/oauth) via
  // requirePermission — deliberately separate from the router's default
  // requireAdmin so "configure but not authorize" delegations become possible.
  // Colon-separated supersedes the dotted mcp.connection.oauth.manage label in
  // ROADMAP SC-2 / spec §3.7 (Phase 198 D-04 precedent: colon wins, cosmetic).
  // Admin role spreads [...PERMISSION_NAMES] so it auto-gains;
  // DEFAULT_USER_ROLE intentionally does NOT include it — authorizing
  // connections toward external providers is an elevated admin capability.
  "mcp:oauth:manage",
  // Phase 198 (ECCO-01 D-04): external chat-connector permissions — 38th/39th.
  // Gates the connector CRUD + validate/webhook-setup/test-message routes
  // (connector:manage) and the list/detail/status reads (connector:view).
  // Colon-separated supersedes the dotted mcp.connection.oauth.manage
  // placeholder label in the v0.25-ROADMAP doc (Phase 195 D-04 precedent:
  // colon wins, cosmetic). Admin role spreads [...PERMISSION_NAMES] so both
  // auto-gain; DEFAULT_USER_ROLE intentionally does NOT include either —
  // configuring external chat channels is an elevated admin capability.
  "connector:manage",
  "connector:view",
  // Phase 202 (PLGM-05 D-08): plugin-manager permission — 40th. Gates the
  // /api/plugins CRUD/license/restart routes via requirePermission (202-04).
  // The spec's "32nd" count is STALE — PERMISSION_NAMES.length is 39 today
  // (skill:create..delete 32-35th, dlp:unmask 36th, mcp:oauth:manage 37th,
  // connector:manage/view 38-39th), so this lands as the 40th entry.
  // Admin role spreads [...PERMISSION_NAMES] so it auto-gains;
  // DEFAULT_USER_ROLE intentionally does NOT include it — installing
  // server-side plugins executes their code in-process (D6 trust model:
  // the admin who uploads the zip is the trust boundary), an elevated
  // admin capability by construction.
  "plugins:manage",
  // Phase 206 (AGENCY-01..03 D-07): web-agency sub-user management — 41st.
  // Gates the /api/agency CRUD routes via requirePermission — deliberately
  // NOT requireAdmin (that would exclude the exact audience this phase
  // creates). Admin role spreads [...PERMISSION_NAMES] so it auto-gains;
  // DEFAULT_USER_ROLE does NOT include it. DELEGATION_DENYLIST marks it
  // non-delegable — an agency holding it must not be able to re-grant it
  // (2-level hierarchy, D-03).
  "agency:users:manage",
] as const;

export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const permissionNameSchema = z.enum(PERMISSION_NAMES);

// ===== Phase 206 (AGENCY-03 D-08): delegation denylist =====
// THE lattice guard rail: permissions a Web Agency can NEVER grant to its
// sub-users, on top of the subset-of-own rule (granted ⊆ own effective).
// THE LANDMINE: isAdmin() (server utils/auth.ts) is keyed on admin:settings
// — ANY role carrying it IS an admin to every middleware. The admin:* prefix
// rule keeps admin terminal (AGENCY-03 "admin ruolo terminale"); the exact
// set covers the other elevated/terminal capabilities. New elevated
// permissions added in later phases MUST be appended here.
export const DELEGATION_DENYLIST: {
  prefixRules: readonly string[];
  exact: readonly PermissionName[];
} = {
  prefixRules: ["admin:"],
  exact: [
    "plugins:manage",
    "backup:destination:read",
    "backup:destination:write",
    "backup:job:read",
    "backup:job:write",
    "backup:log:read",
    "backup:restore:write",
    "dlp:unmask",
    "mcp:oauth:manage",
    "connector:manage",
    "agency:users:manage",
  ],
} as const;

/** Phase 206 (D-08): a permission is delegable when it is neither an exact
 * denylist member nor under a denylist prefix rule. Failure mode is
 * deny-by-default for unknown-shaped names (fail-closed). */
export function isDelegatable(permission: PermissionName): boolean {
  if (DELEGATION_DENYLIST.exact.includes(permission)) return false;
  return !DELEGATION_DENYLIST.prefixRules.some((prefix) => permission.startsWith(prefix));
}

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
    // Phase 190 (SKIL-01 D-07): users manage their own personal skills —
    // create/read/write/delete (WR-04: the DELETE route still enforces
    // owner-or-admin server-side; self-service deletion keeps max_skills
    // escapable without admin intervention).
    "skill:create",
    "skill:read",
    "skill:write",
    "skill:delete",
  ] as PermissionName[],
} as const;

// Phase 206 (CLOUD-01 D-18): least-privilege cloud-user role — chat +
// knowledge/RAG + own memories; NO project/workspace creation, NO uploads,
// NO admin anything. Landing role for Phase 208 self-registration (CLOUD-05).
const DEFAULT_CLOUD_USER_ROLE = {
  name: "Utente Cloud",
  description: "Cloud user — widget, knowledge/RAG and own memories (least privilege)",
  isDefault: true,
  permissions: [
    "workspace:read",
    "chat:read",
    "chat:write",
    "document:read",
    "document:write",
    "archive:read",
    "provider:read",
    "memory:read",
    "memory:write",
    "skill:read",
  ] as PermissionName[],
} as const;

// Phase 206 (AGENCY-01..03 D-19): delegation-capable agency role. User-level
// set + agency:users:manage; NEVER admin:* (isAdmin() flips on admin:settings
// — the Web Agency must remain a non-admin role). Menu omits admin-only
// sections (marketplace, mcpConnections, eventLog, analytics, plugins).
const DEFAULT_WEB_AGENCY_ROLE = {
  name: "Web Agency",
  description: "Web agency — manages its own sub-users within its permission subset",
  isDefault: false,
  permissions: [
    "workspace:read",
    "workspace:write",
    "chat:read",
    "chat:write",
    "document:read",
    "document:write",
    "archive:read",
    "archive:write",
    "provider:read",
    "project:create",
    "workspace:create",
    "memory:read",
    "memory:write",
    "skill:create",
    "skill:read",
    "skill:write",
    "skill:delete",
    "agency:users:manage",
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
  // Phase 206 (AGENCY-01 D-10/UI-SPEC): agency team-management tab — visible
  // to agency:users:manage holders (admin auto-gains). The component renders
  // server-derived data only (D-10: the client never computes the lattice).
  team: ["agency:users:manage"],
};

export const DEFAULT_ROLES = [DEFAULT_ADMIN_ROLE, DEFAULT_USER_ROLE, DEFAULT_CLOUD_USER_ROLE, DEFAULT_WEB_AGENCY_ROLE] as const;

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
  // Phase 190 (SKIL-01 D-19): 'skills' is the 14th section (additive — stored
  // as strings in RoleMenuSection, no migration; seedMenuSections upserts it
  // for both default roles at next boot so existing installs gain the nav
  // entry on restart). Dedicated /skills management page (D-19).
  "skills",
  // Phase 202 (PLGM-05 D-08): 'plugins' is the 15th section (additive —
  // stored as strings in RoleMenuSection, no migration; seedMenuSections
  // upserts it for both default roles at next boot). Dedicated /plugins
  // management page (202-05); menuSectionSchema widens automatically.
  "plugins",
] as const;

export type MenuSection = (typeof MENU_SECTIONS)[number];

export const menuSectionSchema = z.enum(MENU_SECTIONS);

export const DEFAULT_ROLE_MENU_SECTIONS: Record<string, MenuSection[]> = {
  admin: [...MENU_SECTIONS],
  // Phase 190 (SKIL-01 D-19): user gains the skills management entry.
  user: ["dashboard", "chat", "documents", "knowledgeBase", "workspaces", "widget", "uploads", "skills"],
  // Phase 206 (CLOUD-01 D-18): Utente Cloud — widget + knowledge/RAG focus.
  "Utente Cloud": ["dashboard", "chat", "knowledgeBase", "documents", "widget"],
  // Phase 206 (D-19): Web Agency — user-level surfaces + settings (own
  // profile); admin-only sections excluded.
  "Web Agency": ["dashboard", "chat", "documents", "knowledgeBase", "workspaces", "projects", "widget", "uploads", "skills", "settings"],
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
  // Phase 184 (SAAS-03) — storage provider config. STORAGE_PROVIDER selects
  // the StorageProvider strategy: "localfs" (default, byte-compatible with
  // the pre-184 fs behavior) or "s3" (S3-compatible: AWS/MinIO/R2/Wasabi).
  // The S3_* keys ride getSetting's generic ENV tier (NOT env.ts Zod — same
  // doctrine as upload_draft_reaper_*); S3_ENDPOINT empty = AWS-native
  // signing (no forcePathStyle). All resolve per-org via the Phase 183
  // cascade (getSetting(key, organizationId?) — tenant > global > ENV > default).
  STORAGE_PROVIDER: "localfs",
  S3_ENDPOINT: "",
  S3_BUCKET: "",
  S3_REGION: "",
  S3_ACCESS_KEY_ID: "",
  S3_SECRET_ACCESS_KEY: "",
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
  // Phase 189 (WSIS-04, D-13): workspace role-graded enforcement — FLIPPED
  // "false"→"true" on 2026-09-16 (Plan 189-04 Task 2) after the checkpoint
  // approved it on the three parity-evidence classes: (1) Plan 02 route-matrix
  // unit pins (workspaceAccess.routes.test.ts enforced+shadow arms green),
  // (2) the E2E parity probes (e2e/workspace-access.spec.ts green in a real
  // browser against the rebuilt 189 stack), (3) the shadow-log spot-check
  // (78 [workspace-access] shadow decision lines across admin/editor/viewer,
  // zero drift). The FRESH-INSTALL half: new installs seed "true" directly.
  // The UPGRADED-INSTALL half: scripts/set-workspace-role-enforcement.cjs
  // overwrites the persisted global row + invalidates the config cache — a
  // constants-only flip is a runtime no-op on upgraded installs (getDbValue
  // resolves DB-row-first; seedConfigDefaults persists this value with
  // overwrite:false at every boot). Rollback: re-run the script with "false"
  // or PUT the key via the settings UI.
  WORKSPACE_ROLE_ENFORCEMENT: "true",
  OCR_DEFAULT_MODEL: "",
  OCR_DEFAULT_MODE: "text",
  OCR_DEFAULT_CUSTOM_INSTRUCTIONS: "",
  OCR_ENABLED: "true",
  OCR_PRECHECK_CHARS: "200",
  // Phase 205 D-11 (OCR-04) — standardized glm-ocr system prompt. The
  // seedConfigDefaults loop auto-seeds this row (overwrite:false — fresh
  // installs get it immediately, upgraded installs get it on next boot;
  // user edits preserved). Empty string resolves to the legacy per-mode
  // prompts in buildGlmOcrPrompt (byte-identical fallback).
  OCR_PROMPT: "Text recognition:",
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

  // Phase 207 (CLOUD-03/04, D-08) — quota presets. "0"/"" = NOT configured
  // (the D-08 resolution chain falls through to unlimited); a positive value
  // is the install-level default applied to users without a per-user
  // override. UI-editable via the system-config area (Plan 207-04); the
  // per-user override tier rides the User columns (207 schema, D-07).
  QUOTA_TOKEN_DEFAULT: "0",
  QUOTA_STORAGE_GB_DEFAULT: "",
} as const;
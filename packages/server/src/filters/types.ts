// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Filter Plugin System — Type definitions (D-02)
 *
 * FilterContext: the data carrier that flows through the inlet/outlet chain.
 * FilterPlugin: the contract every filter plugin in filters/plugins/ must
 *   `export default`. Priority < 0 is reserved for system plugins (DLP = -1);
 *   priority >= 0 is for user plugins (D-06).
 *
 * Phase 100-01 — filter-plugin-system-last-feature.
 */

export interface FilterContext {
  /** Primary content (user input for inlet, assistant output for outlet). */
  message: string;
  /** Chat ID — for audit logging. */
  chatId: string;
  /** Workspace ID — for workspace-scoped operations. */
  workspaceId: string;
  /** User ID — for audit logging. */
  userId: string;
  /** 'user' = inlet, 'assistant' = outlet. */
  role: "user" | "assistant";
  /** Extensible carrier for future plugins. */
  metadata: Record<string, unknown>;
  /** true = SSE route (progressive), false = non-streaming (full-text). */
  streaming?: boolean;
  /**
   * Origin surface of the message — DLP audit tagging (quick 260829-ms8,
   * DLP_FEATURES_SPEC §2.1). "chat" = authenticated JWT chat route,
   * "widget" = internal widget API-key route (anonymous visitor session).
   * Additive-optional: omitted → key absent from dlp.* event metadata
   * (legacy callers stay byte-identical).
   */
  source?: "chat" | "widget";
  /**
   * Role NAMES of the acting user (260829-n95, DLP_FEATURES_SPEC §2.2) —
   * derived from req.user.roles[].role.name by the caller (chat.ts routes +
   * handleChatStream, which also serves the widget service account via
   * apiKeyMiddleware). Consumed by dlpPlugin's DLP_BYPASS_ROLES check.
   * Additive-optional: omitted/empty → no bypass possible (legacy callers
   * stay byte-identical and always scan).
   */
  userRoles?: string[];
}

export interface FilterPlugin {
  /** Unique identifier (must match filename without extension). */
  name: string;
  /** < 0 = reserved for system (DLP = -1); >= 0 = user plugins (D-06). */
  priority: number;
  /** Default true; overridden by SystemConfig filter_<name>_enabled. */
  enabled?: boolean;
  /** Shown in admin UI. */
  description?: string;
  /** If true, plugin operates token-by-token in streaming mode; if false/absent, operates on full-text only. */
  outletStreaming?: boolean;
  /** Pre-LLM hook. Return new ctx to modify, return void/undefined for pass-through. */
  inlet?(ctx: FilterContext): Promise<FilterContext | void>;
  /** Post-LLM pre-user hook. Return new ctx to modify, return void/undefined for pass-through. */
  outlet?(ctx: FilterContext): Promise<FilterContext | void>;
}
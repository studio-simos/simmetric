// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/** Feature flag keys — used in both server middleware and frontend gating.
 *
 * Phase 140 (EPA-02 / EPA-08 / EPA-10): commodity feature flags removed.
 * Only enterprise-only flags + numeric limits remain. The 8 commodity
 * features (web_search, webhooks, push_notifications, memory_enabled,
 * lead_export, widget_analytics, auto_title_enabled, synthesis_rate_limit)
 * are now always-ON in Community builds — the enterprise plugin will own
 * their enterprise-only behaviors via `ctx.overrideFeatureLimit` in
 * Phase 147. `priority_support` moved to a commercial/SLA contract (EPA-08).
 *
 * `licensePayloadSchema` (z.record(z.string(), ...)) and `LicenseInfo.features`
 * (Record<string, ...>) are NOT narrowed to this union — a v1.0 JWT carrying
 * a removed flag still parses (additive-only invariant, EPA-10). Removed
 * keys in a JWT payload are silently dropped by the override loop in
 * licenseService (the `key in tierFeatures` check).
 */
export const FEATURE_FLAGS = [
  "sso_enabled",
  "audit_log_immutable",
  "white_label",
  "max_workspaces",
  "max_projects",
  "custom_agents",
  "widget_enabled",
  "max_widgets",
  "backup_enabled",
  "max_backup_destinations",
  "widget_credits_editing",
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/** Community Edition defaults — all boolean flags off, numeric limits set low */
export const COMMUNITY_FEATURE_DEFAULTS: Record<FeatureFlag, boolean | number> = {
  sso_enabled: false,
  audit_log_immutable: false,
  white_label: false,
  max_workspaces: 3,
  max_projects: 3,
  /**
   * Phase 148 (EPA-09) verdict: custom_agents is a NUMERIC LIMIT (config-only),
   * NOT an enterprise orchestration feature. Community: up to 3 custom agents;
   * Enterprise: unlimited. Evidence: zero isFeatureEnabled("custom_agents") call
   * sites in server/frontend (F-09); flag name parallels max_workspaces /
   * max_projects / max_widgets (numeric limits); REQUIREMENTS.md note
   * "community con limite numerico" hints at option (a). The custom-agents UI is
   * a future milestone — useFeatureLimit("custom_agents") is the consumer hook
   * (parallels max_workspaces, F-12). requireFeature("custom_agents") returns 402
   * because isFeatureEnabled treats numeric as false (F-14) — the boolean gate is
   * legacy; requireFeatureLimit is the correct gate for the future UI (F-15).
   * See Phase 148 SUMMARY for the verdict evidence.
   * @phase 148 D-09/D-10
   */
  custom_agents: 3,
  widget_enabled: false,
  max_widgets: 1,
  backup_enabled: false,
  max_backup_destinations: 1,
  widget_credits_editing: false,
};

/** Enterprise defaults — everything unlocked */
export const ENTERPRISE_FEATURE_DEFAULTS: Record<FeatureFlag, boolean | number> = {
  sso_enabled: true,
  audit_log_immutable: true,
  white_label: true,
  max_workspaces: Infinity,
  max_projects: Infinity,
  custom_agents: Infinity,
  widget_enabled: true,
  max_widgets: Infinity,
  backup_enabled: true,
  max_backup_destinations: Infinity,
  widget_credits_editing: true,
};

const LICENSE_TIERS = ["community", "enterprise"] as const;
type LicenseTier = (typeof LICENSE_TIERS)[number];
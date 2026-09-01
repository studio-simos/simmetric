// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 140 (EPA-02 / EPA-08 / EPA-10) + quick 260826-hx5 — FEATURE_FLAGS
 * regression guard.
 *
 * After the commodity flag removal, FEATURE_FLAGS contained exactly 10
 * enterprise flags + numeric limits (down from 20). Quick 260826-hx5 added
 * `widget_credits_editing` (Community=false, Enterprise=true) → now 11.
 * This test guards against accidental re-addition of the 10 removed flags
 * (9 commodity + priority_support).
 *
 * The 10 removed flags (must NOT reappear):
 *   web_search, webhooks, push_notifications, memory_enabled,
 *   max_memories_per_user, lead_export, widget_analytics,
 *   auto_title_enabled, synthesis_rate_limit, priority_support
 *
 * The 11 current flags (enterprise surface):
 *   sso_enabled, audit_log_immutable, white_label, max_workspaces,
 *   max_projects, custom_agents, widget_enabled, max_widgets,
 *   backup_enabled, max_backup_destinations, widget_credits_editing
 *
 * `COMMUNITY_FEATURE_DEFAULTS` and `ENTERPRISE_FEATURE_DEFAULTS` are typed
 * `Record<FeatureFlag, boolean | number>` — TypeScript enforces that their
 * keys exactly match the `FeatureFlag` union, so this test also catches a
 * map that drifts out of sync with the array.
 */
import {
  FEATURE_FLAGS,
  COMMUNITY_FEATURE_DEFAULTS,
  ENTERPRISE_FEATURE_DEFAULTS,
} from "../constants/license";

describe("FEATURE_FLAGS regression guard (Phase 140)", () => {
  it("contains exactly 11 entries after commodity flag removal + widget_credits_editing", () => {
    expect(FEATURE_FLAGS).toHaveLength(11);
  });

  it("does NOT contain any of the 10 removed flags", () => {
    const removed = [
      "web_search",
      "webhooks",
      "push_notifications",
      "memory_enabled",
      "max_memories_per_user",
      "lead_export",
      "widget_analytics",
      "auto_title_enabled",
      "synthesis_rate_limit",
      "priority_support",
    ];
    for (const flag of removed) {
      expect(FEATURE_FLAGS).not.toContain(flag);
    }
  });

  it("COMMUNITY_FEATURE_DEFAULTS keys equal FEATURE_FLAGS keys", () => {
    const flagKeys = new Set(FEATURE_FLAGS as readonly string[]);
    expect(new Set(Object.keys(COMMUNITY_FEATURE_DEFAULTS))).toEqual(flagKeys);
  });

  it("ENTERPRISE_FEATURE_DEFAULTS keys equal FEATURE_FLAGS keys", () => {
    const flagKeys = new Set(FEATURE_FLAGS as readonly string[]);
    expect(new Set(Object.keys(ENTERPRISE_FEATURE_DEFAULTS))).toEqual(flagKeys);
  });

  it("custom_agents is a numeric limit (Phase 148 D-09 verdict)", () => {
    expect(typeof COMMUNITY_FEATURE_DEFAULTS.custom_agents).toBe("number");
    expect(COMMUNITY_FEATURE_DEFAULTS.custom_agents).toBe(3);
    expect(ENTERPRISE_FEATURE_DEFAULTS.custom_agents).toBe(Infinity);
  });
});
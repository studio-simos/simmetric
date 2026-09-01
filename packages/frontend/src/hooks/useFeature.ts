// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useLicenseInfo } from "../queries/useLicense";

/**
 * Check if a boolean feature flag is enabled.
 *
 * Phase 140 (EPA-02): the param type was widened from `FeatureFlag` to
 * `string` so the hook can be called with commodity flag names
 * (`web_search`, `lead_export`, `widget_analytics`) that were removed from
 * the `FeatureFlag` union. The runtime type of `license.features` is
 * `Record<string, boolean | number>` (types/index.ts), so `string` is the
 * correct runtime type. Phase 147 will rework frontend conditional
 * enterprise loading.
 */
export function useFeature(flag: string): boolean {
  const { data: license } = useLicenseInfo();
  if (!license) return false;
  const value = license.features[flag];
  return typeof value === "boolean" ? value : false;
}

/** Get a numeric feature limit (widened to `string` — see useFeature note). */
/**
 * @public — documented license-gating API (packages/frontend/AGENTS.md hook
 * list: "useFeatureLimit (numeric license limit)"). Zero current callers;
 * kept as the stable public hook for numeric-limit gating (Phase 180
 * reviewed-keep).
 */
export function useFeatureLimit(flag: string): number {
  const { data: license } = useLicenseInfo();
  if (!license) return 0;
  const value = license.features[flag];
  return typeof value === "number" ? value : 0;
}

/** Get the current license tier */
export function useLicenseTier(): "community" | "enterprise" {
  const { data: license } = useLicenseInfo();
  return license?.tier ?? "community";
}
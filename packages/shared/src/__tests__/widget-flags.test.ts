// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  FEATURE_FLAGS,
  COMMUNITY_FEATURE_DEFAULTS,
  ENTERPRISE_FEATURE_DEFAULTS,
} from "../constants/license";
import type { FeatureFlag } from "../constants/license";

describe("Widget feature flags", () => {
  it("FEATURE_FLAGS array includes widget_enabled", () => {
    expect(FEATURE_FLAGS).toContain("widget_enabled");
  });

  it("FEATURE_FLAGS array includes max_widgets", () => {
    expect(FEATURE_FLAGS).toContain("max_widgets");
  });

  it("COMMUNITY_FEATURE_DEFAULTS has widget_enabled: false", () => {
    expect(COMMUNITY_FEATURE_DEFAULTS.widget_enabled).toBe(false);
  });

  it("COMMUNITY_FEATURE_DEFAULTS has max_widgets: 1", () => {
    expect(COMMUNITY_FEATURE_DEFAULTS.max_widgets).toBe(1);
  });

  it("ENTERPRISE_FEATURE_DEFAULTS has widget_enabled: true", () => {
    expect(ENTERPRISE_FEATURE_DEFAULTS.widget_enabled).toBe(true);
  });

  it("ENTERPRISE_FEATURE_DEFAULTS has max_widgets: Infinity", () => {
    expect(ENTERPRISE_FEATURE_DEFAULTS.max_widgets).toBe(Infinity);
  });

  it("widget_enabled and max_widgets are valid FeatureFlag types", () => {
    const flags: FeatureFlag[] = ["widget_enabled", "max_widgets"];
    expect(flags).toEqual(["widget_enabled", "max_widgets"]);
  });
});
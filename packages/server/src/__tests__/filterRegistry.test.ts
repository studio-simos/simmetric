// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Filter Registry unit tests (Phase 100-01)
 *
 * Covers registerFilter reserved-band validation (D-06), duplicate overwrite
 * with warn, getEnabledFilters (enabled !== false), and _clearAllFilters.
 */
import "./helpers/setupEnv";

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  registerFilter,
  getFilter,
  getAllFilters,
  getEnabledFilters,
  _clearAllFilters,
} from "../filters/filterRegistry";
import type { FilterPlugin } from "../filters/types";

const makePlugin = (overrides: Partial<FilterPlugin> = {}): FilterPlugin => ({
  name: "test-plugin",
  priority: 0,
  enabled: true,
  inlet: async () => {},
  outlet: async () => {},
  ...overrides,
});

describe("filterRegistry", () => {
  beforeEach(() => {
    _clearAllFilters();
  });

  it("registerFilter accepts DLP plugin at priority -1 (reserved band)", () => {
    const dlp = makePlugin({ name: "dlp", priority: -1 });
    expect(() => registerFilter(dlp)).not.toThrow();
    expect(getFilter("dlp")).toBe(dlp);
  });

  it("registerFilter rejects non-DLP plugin with priority < 0 (D-06)", () => {
    const bad = makePlugin({ name: "user-plugin", priority: -1 });
    expect(() => registerFilter(bad)).toThrow(/Reserved priority band/);
    expect(() => registerFilter(bad)).toThrow(/user-plugin/);
    expect(() => registerFilter(bad)).toThrow(/-1/);
  });

  it("registerFilter rejects non-DLP plugin at priority -2 (D-06)", () => {
    const bad = makePlugin({ name: "evil", priority: -2 });
    expect(() => registerFilter(bad)).toThrow(/Reserved priority band/);
  });

  it("registerFilter overwrites duplicate name with warn log", () => {
    const first = makePlugin({ name: "dup", priority: 0, description: "first" });
    const second = makePlugin({ name: "dup", priority: 0, description: "second" });
    registerFilter(first);
    registerFilter(second);
    expect(getFilter("dup")?.description).toBe("second");
  });

  it("getEnabledFilters excludes plugins with enabled === false", () => {
    const on = makePlugin({ name: "on", priority: 0, enabled: true });
    const off = makePlugin({ name: "off", priority: 1, enabled: false });
    registerFilter(on);
    registerFilter(off);
    const enabled = getEnabledFilters();
    expect(enabled.find(p => p.name === "on")).toBeDefined();
    expect(enabled.find(p => p.name === "off")).toBeUndefined();
  });

  it("getEnabledFilters treats undefined enabled as true (default)", () => {
    registerFilter({ name: "implicit", priority: 0, inlet: async () => {} } as FilterPlugin);
    const enabled = getEnabledFilters();
    expect(enabled.find(p => p.name === "implicit")).toBeDefined();
  });

  it("getAllFilters returns every registered plugin regardless of enabled", () => {
    const on = makePlugin({ name: "on2", priority: 0, enabled: true });
    const off = makePlugin({ name: "off2", priority: 1, enabled: false });
    registerFilter(on);
    registerFilter(off);
    const all = getAllFilters();
    expect(all.length).toBe(2);
  });

  it("_clearAllFilters empties the registry", () => {
    registerFilter(makePlugin({ name: "x", priority: 0 }));
    _clearAllFilters();
    expect(getAllFilters().length).toBe(0);
  });
});
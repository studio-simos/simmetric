// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "../helpers/setupEnv";
import { pathRank } from "../../agent/memoryPathRank";

describe("memoryPathRank — path prefix match score (tiers 0-5)", () => {
  // Tier 0: exact match
  it("exact match returns [0, 0]", () => {
    expect(pathRank("preferences.theme", "preferences.theme")).toEqual([0, 0]);
  });

  // Tier 1: memory is descendant of lookup (memory path starts with lookup path)
  it("memory descendant of lookup returns [1, depth]", () => {
    expect(pathRank("preferences.theme.dark", "preferences.theme")).toEqual([1, 1]);
  });

  // Tier 2: memory is ancestor of lookup (lookup path starts with memory path)
  it("memory ancestor of lookup returns [2, depth]", () => {
    expect(pathRank("preferences", "preferences.theme")).toEqual([2, 1]);
  });

  // Tier 3: same parent, different last segment
  it("same parent different last segment returns [3, 0]", () => {
    expect(pathRank("preferences.theme", "preferences.color")).toEqual([3, 0]);
  });

  // Tier 4: shared parent segment (not same immediate parent)
  it("shared ancestor segment returns [4, sharedDepth] — preferences.theme vs preferences.color shares preferences", () => {
    // Per the plan's behavior block: pathRank("preferences.theme", "preferences.color")
    // shares "preferences" → [4, -1]. But note Tier 3 also matches same-parent.
    // Tier 4 is for shared segments that are NOT the immediate parent — e.g.
    // preferences.theme.dark vs preferences.color.light shares "preferences" (depth 1).
    expect(pathRank("preferences.theme.dark", "preferences.color.light")).toEqual([4, 1]);
  });

  // Tier 5: shared last segment only
  it("shared last segment returns [5, 0]", () => {
    expect(pathRank("x.y.last", "a.b.last")).toEqual([5, 0]);
  });

  // null / unrelated
  it("completely unrelated paths return null", () => {
    expect(pathRank("completely.unrelated", "different.path")).toBeNull();
  });

  it("null memoryPath returns null", () => {
    expect(pathRank(null, "anything")).toBeNull();
  });

  it("null lookupPath returns null", () => {
    expect(pathRank("anything", null)).toBeNull();
  });

  it("empty memoryPath returns null", () => {
    expect(pathRank("", "anything")).toBeNull();
  });

  it("empty lookupPath returns null", () => {
    expect(pathRank("anything", "")).toBeNull();
  });

  // Tier precedence: exact beats descendant beats ancestor beats same-parent beats shared beats last-segment
  it("tier 0 (exact) is the strongest match", () => {
    expect(pathRank("a.b", "a.b")![0]).toBe(0);
  });

  it("tier 1 (descendant) is stronger than tier 2 (ancestor)", () => {
    expect(pathRank("a.b.c", "a.b")![0]).toBeLessThan(pathRank("a.b", "a.b.c")![0]);
  });
});
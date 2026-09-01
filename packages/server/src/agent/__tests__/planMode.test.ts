// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { parsePlan } from "../planParser";

/**
 * parsePlan — unit coverage for the plan-parsing fallbacks (spec §6).
 * Exercises: clean JSON, fenced JSON, malformed → raw-text wrap, empty.
 */
describe("parsePlan", () => {
  it("parses a clean JSON object", () => {
    const raw = JSON.stringify({
      goal: "Find retention policy",
      steps: [
        { step: 1, action: "Search documents", tool: "rag_search" },
        { step: 2, action: "Summarize and answer", tool: null },
      ],
    });
    const plan = parsePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.goal).toBe("Find retention policy");
    expect(plan!.steps).toHaveLength(2);
    expect((plan!.steps[0] as { tool: string | null }).tool).toBe("rag_search");
    expect((plan!.steps[1] as { tool: string | null }).tool).toBeNull();
  });

  it("extracts JSON from a markdown-fenced response", () => {
    const raw = "```json\n" + JSON.stringify({
      goal: "G",
      steps: [{ step: 1, action: "Do it", tool: null }],
    }) + "\n```";
    const plan = parsePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.goal).toBe("G");
    expect((plan!.steps[0] as { action: string }).action).toBe("Do it");
  });

  it("caps steps at 5 and renumbers", () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({ step: i + 1, action: `a${i}`, tool: null }));
    const raw = JSON.stringify({ goal: "g", steps });
    const plan = parsePlan(raw);
    expect(plan!.steps).toHaveLength(5);
    expect(plan!.steps.map((s) => s.step)).toEqual([1, 2, 3, 4, 5]);
  });

  it("wraps malformed (non-JSON) text as a single-step plan", () => {
    const raw = "I will search the documents and then answer the user.";
    const plan = parsePlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(1);
    expect((plan!.steps[0] as { tool: string | null }).tool).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parsePlan("")).toBeNull();
    expect(parsePlan("   ")).toBeNull();
  });

  it("wraps malformed JSON (no goal/empty steps) as raw-text plan", () => {
    const plan = parsePlan('{"steps":[]}');
    expect(plan).not.toBeNull();
    expect(plan!.steps).toHaveLength(1);
    expect((plan!.steps[0] as { tool: string | null }).tool).toBeNull();
  });
});
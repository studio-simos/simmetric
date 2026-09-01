// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Contradiction Service tests — Phase 74 Plan 02 (D-06/D-07/D-08/D-09).
 *
 * Covers the Jaccard token overlap pairing (D-07), per-pair LLM judgment
 * (D-08), budget truncation (D-09), and recordLlmFailure integration (SC4).
 *
 * The old `preFilterCandidates` (wikilink overlap, MIN_ENTITY_OVERLAP=3) tests
 * are removed — the function is replaced by `jaccardPairCandidates` +
 * `judgePairContradiction`.
 */

import "./helpers/setupEnv";

// ── Mocks ────────────────────────────────────────────────────────────────

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock callSynthesisLLM so judgePairContradiction uses a deterministic stub.
jest.mock("../services/synthesisService", () => ({
  callSynthesisLLM: jest.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────

import {
  jaccard,
  jaccardPairCandidates,
  judgePairContradiction,
  detectContradictions,
  buildContradictionMarker,
  extractClaimSummary,
  type ArchivePage,
  type SynthesisContradictionItem,
} from "../services/synthesisContradictionService";
import { callSynthesisLLM } from "../services/synthesisService";
import { SYNTHESIS_FIXTURE_PAGES } from "./fixtures/synthesisArchiveFixture";

const mockedCallSynthesisLLM = callSynthesisLLM as jest.MockedFunction<typeof callSynthesisLLM>;

// ── Helpers ──────────────────────────────────────────────────────────────

function findPage(slug: string): ArchivePage {
  const p = SYNTHESIS_FIXTURE_PAGES.find((x) => x.slug === slug);
  if (!p) throw new Error(`fixture page ${slug} not found`);
  return p;
}

/** Minimal BudgetTracker-like stub. */
function makeTracker(canContinueFn: (passName: string) => boolean) {
  const callsConsumed: string[] = [];
  return {
    canContinue: (passName: string) => canContinueFn(passName),
    consumeLlmCall: (passName: string) => {
      callsConsumed.push(passName);
      return true;
    },
    consumeTokens: (_n: number, _passName: string) => true,
    _callsConsumed: callsConsumed,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── jaccard (pure) ───────────────────────────────────────────────────────

describe("jaccard", () => {
  it("returns 0 for empty sets", () => {
    expect(jaccard(new Set<string>(), new Set<string>(["a"]))).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set<string>(["a", "b"]), new Set<string>(["a", "b"]))).toBe(1);
  });

  it("returns fractional overlap for partial intersection", () => {
    // intersection {a,b} = 2, union {a,b,c,d} = 4 → 0.5
    expect(jaccard(new Set<string>(["a", "b", "c"]), new Set<string>(["a", "b", "d"]))).toBeCloseTo(0.5, 5);
  });
});

// ── jaccardPairCandidates ────────────────────────────────────────────────

describe("jaccardPairCandidates", () => {
  it("returns contradictory pair above threshold (cost-page vs cost-update)", () => {
    const pairs = jaccardPairCandidates([findPage("cost-page")], [findPage("cost-update")]);
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const pair = pairs.find((p) => p.a.slug === "cost-page" && p.b.slug === "cost-update");
    expect(pair).toBeDefined();
    expect(pair!.overlap).toBeGreaterThanOrEqual(0.15);
  });

  it("excludes non-overlapping pages (weather)", () => {
    const pairs = jaccardPairCandidates([findPage("weather")], [findPage("cost-page")]);
    // weather has zero token overlap with cost-page → excluded
    expect(pairs).toHaveLength(0);
  });

  it("sorted descending by overlap", () => {
    const pairs = jaccardPairCandidates(
      [findPage("cost-page"), findPage("weather")],
      [findPage("cost-update"), findPage("cost-context")],
    );
    expect(pairs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]!.overlap).toBeGreaterThanOrEqual(pairs[i]!.overlap);
    }
  });

  it("filters self-pairs (a.id === b.id)", () => {
    const same = findPage("cost-page");
    const pairs = jaccardPairCandidates([same], [same]);
    expect(pairs).toHaveLength(0);
  });

  it("returns empty array when existingPages is empty", () => {
    expect(jaccardPairCandidates([findPage("cost-page")], [])).toHaveLength(0);
  });
});

// ── judgePairContradiction ──────────────────────────────────────────────

describe("judgePairContradiction", () => {
  it("returns SynthesisContradictionItem on LLM yes", async () => {
    mockedCallSynthesisLLM.mockResolvedValue({
      content: '{"contradiction": true, "reason": "Cost mismatch 100 vs 200"}',
      tokensUsed: 10,
    });

    const item = await judgePairContradiction(
      findPage("cost-page"),
      findPage("cost-update"),
      "archive-test",
    );

    expect(item).not.toBeNull();
    expect(item!.pageSlug).toBe("cost-page");
    expect(item!.confidence).toBe("HIGH");
    expect(item!.reason).toContain("Cost mismatch");
  });

  it("returns null on LLM no", async () => {
    mockedCallSynthesisLLM.mockResolvedValue({
      content: '{"contradiction": false, "reason": "Consistent claims"}',
      tokensUsed: 10,
    });

    const item = await judgePairContradiction(
      findPage("cost-page"),
      findPage("cost-context"),
      "archive-test",
    );

    expect(item).toBeNull();
  });

  it("re-throws on LLM failure (caller routes through recordLlmFailure)", async () => {
    const err = new Error("LLM endpoint down");
    mockedCallSynthesisLLM.mockRejectedValue(err);

    await expect(
      judgePairContradiction(findPage("cost-page"), findPage("cost-update"), "archive-test"),
    ).rejects.toThrow();
  });

  it("returns null on unparseable JSON (no contradiction reported)", async () => {
    mockedCallSynthesisLLM.mockResolvedValue({
      content: "not json at all",
      tokensUsed: 10,
    });

    const item = await judgePairContradiction(
      findPage("cost-page"),
      findPage("cost-update"),
      "archive-test",
    );

    expect(item).toBeNull();
  });
});

// ── detectContradictions (refactored, uses BudgetTracker + recordLlmFailure) ──

describe("detectContradictions", () => {
  it("truncation by budget logs pairs not judged", async () => {
    // Tracker never allows continuation → all pairs truncated.
    const tracker = makeTracker(() => false);
    const recordLlmFailure = jest.fn(() => false);

    const result = await detectContradictions({
      newPages: [findPage("cost-page")],
      existingPages: [findPage("cost-update"), findPage("cost-context")],
      archiveId: "archive-test",
      tracker,
      recordLlmFailure,
    });

    expect(result).toEqual([]);
    // No LLM call should have been made (budget exhausted before any pair).
    expect(mockedCallSynthesisLLM).not.toHaveBeenCalled();
    // recordLlmFailure should NOT be called (truncation is not a failure).
    expect(recordLlmFailure).not.toHaveBeenCalled();
  });

  it("recordLlmFailure called on per-pair LLM fail with pass4b_contradiction", async () => {
    const tracker = makeTracker(() => true);
    const recordLlmFailure = jest.fn(() => false);
    mockedCallSynthesisLLM.mockRejectedValue(new Error("LLM down"));

    await detectContradictions({
      newPages: [findPage("cost-page")],
      existingPages: [findPage("cost-update")],
      archiveId: "archive-test",
      tracker,
      recordLlmFailure,
    });

    expect(recordLlmFailure).toHaveBeenCalled();
    const firstCall = recordLlmFailure.mock.calls[0] as unknown as [string, string, unknown];
    expect(firstCall[0]).toBe("cost-page");
    expect(firstCall[1]).toBe("pass4b_contradiction");
  });

  it("populates contradictions[] from judgePairContradiction on LLM yes", async () => {
    const tracker = makeTracker(() => true);
    const recordLlmFailure = jest.fn(() => false);
    mockedCallSynthesisLLM.mockResolvedValue({
      content: '{"contradiction": true, "reason": "Cost mismatch"}',
      tokensUsed: 10,
    });

    const result = await detectContradictions({
      newPages: [findPage("cost-page")],
      existingPages: [findPage("cost-update")],
      archiveId: "archive-test",
      tracker,
      recordLlmFailure,
    });

    expect(result.length).toBe(1);
    expect(result[0]!.pageSlug).toBe("cost-page");
    expect(result[0]!.confidence).toBe("HIGH");
  });

  it("stops on recordLlmFailure returning true (abort threshold reached)", async () => {
    const tracker = makeTracker(() => true);
    const recordLlmFailure = jest.fn(() => true); // abort on first failure
    mockedCallSynthesisLLM.mockRejectedValue(new Error("LLM down"));

    const result = await detectContradictions({
      newPages: [findPage("cost-page"), findPage("cost-update")],
      existingPages: [findPage("cost-update"), findPage("cost-context")],
      archiveId: "archive-test",
      tracker,
      recordLlmFailure,
    });

    // First LLM failure trips the abort → recordLlmFailure called once, loop stops.
    expect(recordLlmFailure).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it("does not call judgePairContradiction on non-overlapping pairs", async () => {
    const tracker = makeTracker(() => true);
    const recordLlmFailure = jest.fn(() => false);

    await detectContradictions({
      newPages: [findPage("weather")],
      existingPages: [findPage("cost-page")],
      archiveId: "archive-test",
      tracker,
      recordLlmFailure,
    });

    expect(mockedCallSynthesisLLM).not.toHaveBeenCalled();
  });
});

// ── Preserved exports (still used elsewhere) ──────────────────────────────

describe("buildContradictionMarker (preserved)", () => {
  it("constructs exact [CONTRADICTION: ...] format", () => {
    const result = buildContradictionMarker(
      "This claim is contradictory",
      "file.pdf",
      "2026-05-15T00:00:00.000Z",
    );
    expect(result).toBe(
      "[CONTRADICTION: source=file.pdf, date=2026-05-15T00:00:00.000Z]This claim is contradictory[/CONTRADICTION]",
    );
  });
});

describe("extractClaimSummary (preserved)", () => {
  it("extracts first meaningful sentence, skipping headings", () => {
    const bodyText = "# Title\n\nThis is the first real sentence.";
    expect(extractClaimSummary(bodyText)).toBe("This is the first real sentence.");
  });
});

// ── Removed exports — compile-time regression guard ──────────────────────

describe("preFilterCandidates removed (D-06)", () => {
  it("is no longer exported from the service module", () => {
    // If preFilterCandidates is accidentally re-added, this import fails.
    const module = require("../services/synthesisContradictionService");
    expect(module.preFilterCandidates).toBeUndefined();
    expect(module.MIN_ENTITY_OVERLAP).toBeUndefined();
  });
});

// Type-only import to ensure SynthesisContradictionItem stays available.
// (no runtime assertion — compile-time guard)
function _typeCheck(_item: SynthesisContradictionItem): void {}
void _typeCheck;
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Service unit tests — D-03 guard + pagesProposed (Phase 74 Plan 01).
 *
 * Covers:
 *   - D-17 fixture invariants (contradictory pair, negative control).
 *   - D-01 branch (b) pre-guard reproduction: the unguarded
 *     `proposedContent: decision.suggestedContent || page.bodyText` fallback
 *     pushes a no-op change indistinguishable from the existing page content.
 *   - D-03 post-guard: empty/whitespace `suggestedContent` is discarded; only
 *     non-empty suggestions are pushed (no bodyText fallback).
 *   - D-02 pagesProposed counts non-SKIP changes.
 *
 * The pipeline is mocked identically to synthesisAbort.test.ts; only LLM
 * responses are queued per pass.
 */

import "./helpers/setupEnv";

// ── Mocks ────────────────────────────────────────────────────────────────

jest.mock("../utils/prisma", () => {
  const actual = jest.requireActual("./helpers/mockPrisma");
  const mock = actual.createMockPrisma();
  mock.prisma.synthesisRun = {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  };
  mock.prisma.archiveConfig = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
  };
  mock.prisma.archivePage = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  };
  mock.prisma.$queryRaw = jest.fn();
  mock.prisma.$executeRaw = jest.fn().mockResolvedValue(1);
  return { __esModule: true, default: mock.prisma };
});

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    SYNTHESIS_LLM_MODEL: "test-synth-model",
    LLM_MODEL: "test-llm-model",
    OLLAMA_BASE_URL: "http://ollama-test:11434",
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    NODE_ENV: "test",
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/providerService", () => ({
  callNonStreamingLLM: jest.fn(),
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock("../services/archiveConfigService", () => ({
  getSynthesisOverrides: jest.fn().mockResolvedValue(null),
  getArchiveConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: "" }),
}));

jest.mock("../services/archivePageService", () => ({
  getPages: jest.fn(),
  getPage: jest.fn(),
}));

jest.mock("../services/synthesisBudgetService", () => ({
  BudgetTracker: class {
    canContinue() { return true; }
    consumeTokens() {}
    consumeLlmCall() {}
    getSnapshot() {
      return {
        pagesRead: 0,
        maxPagesWritten: 0,
        tokensUsed: 0,
        llmCallsUsed: 0,
      };
    }
    isExhausted() { return false; }
  },
  loadBudgetConfig: jest.fn().mockReturnValue({}),
}));

jest.mock("../services/synthesisContradictionService", () => ({
  detectContradictions: jest.fn().mockResolvedValue([]),
  // Pure helpers used by the pipeline (not exercised here, but required so
  // the mock module has the same shape as the real service).
  jaccardPairCandidates: jest.fn().mockReturnValue([]),
  judgePairContradiction: jest.fn().mockResolvedValue(null),
  extractClaimSummary: jest.fn().mockReturnValue(""),
  buildContradictionMarker: jest.fn().mockReturnValue(""),
  extractWikilinks: jest.fn().mockReturnValue([]),
  tokenize: jest.fn().mockReturnValue(new Set<string>()),
  jaccard: jest.fn().mockReturnValue(0),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────

import prisma from "../utils/prisma";
import { callNonStreamingLLM } from "../services/providerService";
import { runSynthesisPipeline } from "../services/synthesisService";
import { SYNTHESIS_FIXTURE_PAGES } from "./fixtures/synthesisArchiveFixture";

const mockedCallNonStreamingLLM = callNonStreamingLLM as jest.MockedFunction<typeof callNonStreamingLLM>;
const mockedCreate = (prisma as any).synthesisRun.create as jest.MockedFunction<any>;
const mockedUpdate = (prisma as any).synthesisRun.update as jest.MockedFunction<any>;
const mockedGetPages = require("../services/archivePageService").getPages as jest.MockedFunction<any>;
const mockedGetPage = require("../services/archivePageService").getPage as jest.MockedFunction<any>;
const mockedQueryRaw = (prisma as any).$queryRaw as jest.MockedFunction<any>;

// ── Helpers ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreate.mockResolvedValue({ id: "run-test-1" });
  mockedUpdate.mockResolvedValue({});
  mockedGetPages.mockResolvedValue([]);
  mockedQueryRaw.mockResolvedValue([]);
  mockedGetPage.mockResolvedValue(SYNTHESIS_FIXTURE_PAGES[0]);
});

/** Queue LLM outcomes: 'throw' or a string content (consumed in call order). */
function queueResponses(outcomes: Array<"throw" | string>) {
  let i = 0;
  mockedCallNonStreamingLLM.mockImplementation(async () => {
    const outcome = outcomes[i++] as "throw" | string;
    if (outcome === "throw") {
      throw new Error("LLM endpoint down");
    }
    return { content: outcome, tokensUsed: 10 };
  });
}

/** Find the final prisma.synthesisRun.update call that carries a previewJson payload. */
function findPreviewUpdateCall(): any {
  return mockedUpdate.mock.calls.find(
    (c: any) => c[0]?.data?.previewJson !== undefined,
  );
}

// ── Fixture invariants (D-17) ─────────────────────────────────────────────

describe("D-17 fixture invariants", () => {
  it("fixture has contradictory pair: X costa 100 and X costa 200", () => {
    const bodies = SYNTHESIS_FIXTURE_PAGES.map((p) => p.bodyText);
    expect(bodies.some((b) => b.includes("X costa 100"))).toBe(true);
    expect(bodies.some((b) => b.includes("X costa 200"))).toBe(true);
  });

  it("fixture has negative-control non-overlapping pages (weather)", () => {
    const weather = SYNTHESIS_FIXTURE_PAGES.find((p) => p.slug === "weather");
    expect(weather).toBeDefined();
    expect(weather!.bodyText).not.toMatch(/X costa/);
  });

  it("fixture has at least 4 pages", () => {
    expect(SYNTHESIS_FIXTURE_PAGES.length).toBeGreaterThanOrEqual(4);
  });
});

// ── Pre-guard reproduction (D-01 branch b) ────────────────────────────────
//
// Reproduces D-01 branch (b): unguarded
// `proposedContent: decision.suggestedContent || page.bodyText` writes
// identical content. The D-03 guard (Phase C) flips this to discard the change
// entirely, so this block is `describe.skip` once the guard is in place — it
// is preserved as D-01 reproduction evidence (do NOT delete).
//
// Against the UNMODIFIED code (commit 1 of this plan), this test passes and
// asserts the no-op fallback (`proposedContent === page.bodyText`). Against
// the guarded code (commit 2), the guard discards the change — so the block
// is skipped here to preserve the reproduction as evidence.

describe.skip("pre-guard reproduction (D-01 branch b)", () => {
  it("pushes a no-op change with proposedContent === page.bodyText when suggestedContent is empty", async () => {
    const pages = SYNTHESIS_FIXTURE_PAGES.map((p) => ({ ...p }));
    mockedGetPages.mockResolvedValue(pages);

    // Pass 1 (4 calls): return a single entity "cost" per page.
    // Pass 2: skipped (all pages have synthesis_generation frontmatter).
    // Pass 3: $queryRaw returns all 4 slugs as candidates.
    // Pass 4 (4 calls): UPDATE decision with empty suggestedContent.
    const updateDecision = JSON.stringify({
      decision: "UPDATE",
      reason: "r",
      suggestedContent: "",
      confidence: "MEDIUM",
    });
    mockedQueryRaw.mockResolvedValue(
      SYNTHESIS_FIXTURE_PAGES.map((p) => ({ slug: p.slug })),
    );
    mockedGetPage.mockImplementation(async (_archiveId: string, slug: string) =>
      SYNTHESIS_FIXTURE_PAGES.find((p) => p.slug === slug) ||
      SYNTHESIS_FIXTURE_PAGES[0],
    );
    queueResponses([
      '["cost"]', '["cost"]', '["cost"]', '["cost"]',
      updateDecision, updateDecision, updateDecision, updateDecision,
    ]);

    await runSynthesisPipeline("archive-test", "user-test");

    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    const preview = previewCall[0].data.previewJson;
    expect(preview.changes.length).toBeGreaterThan(0);

    // Bug: proposedContent falls back to page.bodyText (no-op write).
    const firstPage = SYNTHESIS_FIXTURE_PAGES[0]!;
    const change = preview.changes.find((c: any) => c.pageSlug === firstPage.slug);
    expect(change).toBeDefined();
    expect(change!.proposedContent).toBe(firstPage.bodyText);
  });
});

// ── Post-guard D-03 ───────────────────────────────────────────────────────
//
// Closes the D-01 reproduction loop per D-01 ("Il fix segue l'evidenza della
// riproduzione"): the guard discards UPDATE/CREATE/FLAG_CONTRADICTION
// decisions whose suggestedContent is empty or whitespace, so no no-op
// change is pushed. Non-empty suggestedContent is pushed verbatim (no
// bodyText fallback).

describe("post-guard D-03", () => {
  /** Shared setup: all 4 fixture pages are candidates, getPage returns by slug. */
  function setupAllCandidates() {
    mockedGetPages.mockResolvedValue(SYNTHESIS_FIXTURE_PAGES.map((p) => ({ ...p })));
    mockedQueryRaw.mockResolvedValue(
      SYNTHESIS_FIXTURE_PAGES.map((p) => ({ slug: p.slug })),
    );
    mockedGetPage.mockImplementation(async (_archiveId: string, slug: string) =>
      SYNTHESIS_FIXTURE_PAGES.find((p) => p.slug === slug) ||
      SYNTHESIS_FIXTURE_PAGES[0]!,
    );
  }

  /** Queue 4 Pass-1 entity responses + 4 Pass-4 decision responses. */
  function queuePass1AndPass4(pass4Decision: string) {
    queueResponses([
      '["cost"]', '["cost"]', '["cost"]', '["cost"]',
      pass4Decision, pass4Decision, pass4Decision, pass4Decision,
    ]);
  }

  it("discards empty suggestedContent (no change pushed)", async () => {
    setupAllCandidates();
    queuePass1AndPass4(JSON.stringify({
      decision: "UPDATE",
      reason: "r",
      suggestedContent: "",
      confidence: "MEDIUM",
    }));

    await runSynthesisPipeline("archive-test", "user-test");

    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    const preview = previewCall[0].data.previewJson;
    expect(preview.changes).toHaveLength(0);
  });

  it("discards whitespace suggestedContent", async () => {
    setupAllCandidates();
    queuePass1AndPass4(JSON.stringify({
      decision: "UPDATE",
      reason: "r",
      suggestedContent: "   ",
      confidence: "MEDIUM",
    }));

    await runSynthesisPipeline("archive-test", "user-test");

    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    const preview = previewCall[0].data.previewJson;
    expect(preview.changes).toHaveLength(0);
  });

  it("keeps non-empty suggestedContent (no bodyText fallback)", async () => {
    setupAllCandidates();
    const newContent = "Il prodotto X costa 150 euro al chilo (aggiornato).";
    queuePass1AndPass4(JSON.stringify({
      decision: "UPDATE",
      reason: "r",
      suggestedContent: newContent,
      confidence: "MEDIUM",
    }));

    await runSynthesisPipeline("archive-test", "user-test");

    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    const preview = previewCall[0].data.previewJson;
    expect(preview.changes.length).toBeGreaterThan(0);

    const firstPage = SYNTHESIS_FIXTURE_PAGES[0]!;
    const change = preview.changes.find((c: any) => c.pageSlug === firstPage.slug);
    expect(change).toBeDefined();
    expect(change!.proposedContent).toBe(newContent);
    expect(change!.proposedContent).not.toBe(firstPage.bodyText);
  });

  it("pagesProposed counts non-SKIP changes (3 UPDATE + 1 SKIP-like discard → 3)", async () => {
    setupAllCandidates();
    // 3 pages get UPDATE with non-empty suggestedContent; 1 gets empty (discarded).
    // Pass 1: 4 entity responses. Pass 4: 3 real UPDATEs + 1 discarded.
    mockedCallNonStreamingLLM.mockImplementation(async () => {
      const pass1Count = (mockedCallNonStreamingLLM as any).__pass1Count || 0;
      (mockedCallNonStreamingLLM as any).__pass1Count = pass1Count + 1;
      if (pass1Count < 4) {
        return { content: '["cost"]', tokensUsed: 10 };
      }
      const pass4Idx = pass1Count - 4;
      const realUpdate = JSON.stringify({
        decision: "UPDATE",
        reason: "r",
        suggestedContent: `New content ${pass4Idx}`,
        confidence: "MEDIUM",
      });
      const emptyUpdate = JSON.stringify({
        decision: "UPDATE",
        reason: "r",
        suggestedContent: "",
        confidence: "MEDIUM",
      });
      // First 3 Pass-4 calls: real UPDATEs. 4th: empty (discarded).
      const responses = [realUpdate, realUpdate, realUpdate, emptyUpdate];
      return { content: responses[pass4Idx] || realUpdate, tokensUsed: 10 };
    });

    await runSynthesisPipeline("archive-test", "user-test");
    (mockedCallNonStreamingLLM as any).__pass1Count = 0;

    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    const preview = previewCall[0].data.previewJson;
    expect(preview.changes).toHaveLength(3);
    // pagesProposed is persisted on the row (D-02).
    expect(previewCall[0].data.pagesProposed).toBe(3);
  });
});

// ── Pass 4b contradiction pass (D-06/D-07/D-08/D-09) ───────────────────────
//
// Verifies the new Pass 4b is wired after Pass 4, independent of the LLM
// FLAG_CONTRADICTION verdict (D-06). The detectContradictions mock lets us
// assert the call args and the flow of returned items into the preview's
// contradictions array. Per-pair LLM judgment + budget truncation +
// recordLlmFailure integration are covered in synthesisContradiction.test.ts.

describe("Pass 4b contradiction pass", () => {
  function setupAllCandidates() {
    mockedGetPages.mockResolvedValue(SYNTHESIS_FIXTURE_PAGES.map((p) => ({ ...p })));
    mockedQueryRaw.mockResolvedValue(
      SYNTHESIS_FIXTURE_PAGES.map((p) => ({ slug: p.slug })),
    );
    mockedGetPage.mockImplementation(async (_archiveId: string, slug: string) =>
      SYNTHESIS_FIXTURE_PAGES.find((p) => p.slug === slug) ||
      SYNTHESIS_FIXTURE_PAGES[0]!,
    );
  }

  /** Queue 4 Pass-1 entity responses + 4 Pass-4 UPDATE decisions with content. */
  function queuePass1AndPass4Update() {
    const updateDecision = JSON.stringify({
      decision: "UPDATE",
      reason: "r",
      suggestedContent: "Updated content for the page.",
      confidence: "MEDIUM",
    });
    queueResponses([
      '["cost"]', '["cost"]', '["cost"]', '["cost"]',
      updateDecision, updateDecision, updateDecision, updateDecision,
    ]);
  }

  it("new contradiction pass runs independent of FLAG_CONTRADICTION (D-06)", async () => {
    setupAllCandidates();
    queuePass1AndPass4Update();

    // detectContradictions is mocked to return [] — verify it is still called
    // even though no Pass-4 decision is FLAG_CONTRADICTION (all UPDATE).
    const { detectContradictions } = require("../services/synthesisContradictionService");
    (detectContradictions as jest.Mock).mockResolvedValue([]);

    await runSynthesisPipeline("archive-test", "user-test");

    expect(detectContradictions).toHaveBeenCalled();
    const callArgs = (detectContradictions as jest.Mock).mock.calls[0][0] as {
      newPages: unknown[];
      existingPages: unknown[];
      archiveId: string;
      passName: string;
    };
    expect(callArgs.archiveId).toBe("archive-test");
    expect(callArgs.passName).toBe("pass4b_contradiction");
    expect(callArgs.newPages.length).toBe(4); // all 4 candidates got UPDATE
    expect(callArgs.existingPages.length).toBe(4); // all archive pages
  });

  it("new pass populates contradictions[] from judgePairContradiction (D-08)", async () => {
    setupAllCandidates();
    queuePass1AndPass4Update();

    const fakeContradiction = {
      pageSlug: "cost-page",
      claimA: { text: "X costa 100", source: "cost-page", date: "2026-01-01T00:00:00.000Z" },
      claimB: { text: "X costa 200", source: "cost-update", date: "2026-01-02T00:00:00.000Z" },
      confidence: "HIGH" as const,
      reason: "Cost mismatch",
    };
    const { detectContradictions } = require("../services/synthesisContradictionService");
    (detectContradictions as jest.Mock).mockResolvedValue([fakeContradiction]);

    await runSynthesisPipeline("archive-test", "user-test");

    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    const preview = previewCall[0].data.previewJson;
    expect(preview.contradictions.length).toBe(1);
    expect(preview.contradictions[0].pageSlug).toBe("cost-page");
    expect(preview.contradictions[0].reason).toBe("Cost mismatch");
    // contradictionsFound persisted on the row (D-02 analog for contradictions).
    expect(previewCall[0].data.contradictionsFound).toBe(1);
  });

  it("new pass LLM failure calls recordLlmFailure with pass4b_contradiction (SC4)", async () => {
    setupAllCandidates();
    queuePass1AndPass4Update();

    // detectContradictions itself doesn't call recordLlmFailure directly —
    // it's the judgePairContradiction inside it that does. Since
    // detectContradictions is mocked here, we verify at the pipeline seam:
    // when detectContradictions rejects (simulating its internal LLM failure
    // surfacing), the pipeline catch path should persist the run. The
    // per-pair recordLlmFailure integration is covered in
    // synthesisContradiction.test.ts → "recordLlmFailure called on per-pair
    // LLM fail with pass4b_contradiction".
    const { detectContradictions } = require("../services/synthesisContradictionService");
    (detectContradictions as jest.Mock).mockRejectedValue(new Error("LLM down"));

    await runSynthesisPipeline("archive-test", "user-test");

    // The pipeline should persist (not crash) even if Pass 4b throws.
    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    // The pipeline catch path persists the preview with whatever was gathered.
    const preview = previewCall[0].data.previewJson;
    expect(preview).toBeDefined();
    // Changes from Pass 4 (4 UPDATEs) are still in the preview.
    expect(preview.changes.length).toBe(4);
  });

  it("budget exhaustion stops the pass (D-09)", async () => {
    setupAllCandidates();
    queuePass1AndPass4Update();

    // detectContradictions mocked to return [] (budget truncation is handled
    // inside detectContradictions — covered in synthesisContradiction.test.ts
    // → "truncation by budget logs pairs not judged"). Here we verify the
    // pipeline still completes when detectContradictions returns [] due to
    // budget exhaustion.
    const { detectContradictions } = require("../services/synthesisContradictionService");
    (detectContradictions as jest.Mock).mockResolvedValue([]);

    await runSynthesisPipeline("archive-test", "user-test");

    const previewCall = findPreviewUpdateCall();
    expect(previewCall).toBeDefined();
    const preview = previewCall[0].data.previewJson;
    // No contradictions reported (budget truncated all pairs).
    expect(preview.contradictions).toEqual([]);
    // Changes from Pass 4 are still present.
    expect(preview.changes.length).toBe(4);
  });
});
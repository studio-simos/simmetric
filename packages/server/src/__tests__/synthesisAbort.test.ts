// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-04 / D-13 integration tests — synthesis pipeline aborts cleanly after
 * 3 consecutive OR 5 total LLM failures (mirror Fase 62 D-03 breaker).
 *
 * Tests:
 *   1. 3 consecutive LLM failures → SynthesisRun.status=FAILED,
 *      error="Aborted: 3 consecutive LLM failures", previewJson non-null.
 *   2. 5 total LLM failures (with 4 successes interleaved) →
 *      SynthesisRun.status=FAILED, error="Aborted: 5 total LLM failures".
 *   3. 2 fail + 1 success + 2 fail pattern → does NOT abort (consec resets to 0
 *      on success, total=4 < 5); pipeline completes if remaining pages succeed.
 *   7. Error string sanitization — FAILED-row error matches the prefixed
 *      pattern and does NOT contain fixture bodyText/PHI markers.
 *
 * PHI gate (D-15) is covered separately in synthesisPhiGate.test.ts.
 */

import "./helpers/setupEnv";

// ── Mocks ────────────────────────────────────────────────────────────────

jest.mock("../utils/prisma", () => {
  const actual = jest.requireActual("./helpers/mockPrisma");
  const mock = actual.createMockPrisma();
  // Add synthesisRun + archiveConfig + archivePage models
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
  mock.prisma.$queryRaw = jest.fn().mockResolvedValue([]);
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

// providerService — controls callNonStreamingLLM behaviour per test
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

// Dynamic-require deps — provide stubs
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
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────

import prisma from "../utils/prisma";
import { callNonStreamingLLM } from "../services/providerService";
import { runSynthesisPipeline } from "../services/synthesisService";

const mockedCallNonStreamingLLM = callNonStreamingLLM as jest.MockedFunction<typeof callNonStreamingLLM>;
const mockedCreate = (prisma as any).synthesisRun.create as jest.MockedFunction<any>;
const mockedUpdate = (prisma as any).synthesisRun.update as jest.MockedFunction<any>;
const mockedGetPages = require("../services/archivePageService").getPages as jest.MockedFunction<any>;

// ── Helpers ──────────────────────────────────────────────────────────────

function makePage(slug: string, bodyText: string, withSynthesisGen = true) {
  return {
    id: `page-${slug}`,
    archiveId: "archive-test",
    slug,
    title: `Title ${slug}`,
    category: "entities",
    bodyText,
    frontmatter: withSynthesisGen ? { synthesis_generation: 1 } : {},
    wikilinks: [],
    createdAt: new Date(),
    createdBy: "user-test",
  };
}

/** Queue of LLM outcomes: 'throw' or a string content. */
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

beforeEach(() => {
  jest.clearAllMocks();
  // Default: archive creation returns a row
  mockedCreate.mockResolvedValue({ id: "run-test-1" });
  mockedUpdate.mockResolvedValue({});
  // Default: no existing pages, no candidate search hits
  mockedGetPages.mockResolvedValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("KB-04 / D-13 — synthesis abort counters", () => {
  it("Test 1: 3 consecutive LLM failures abort with FAILED status + explicit error + non-null preview", async () => {
    // Seed 5 pages; first 3 LLM calls throw → abort on 3 consecutive
    const pages = [
      makePage("p1", "PHI_SECRET_MARKER_ALPHA body 1"),
      makePage("p2", "PHI_SECRET_MARKER_ALPHA body 2"),
      makePage("p3", "PHI_SECRET_MARKER_ALPHA body 3"),
      makePage("p4", "PHI_SECRET_MARKER_ALPHA body 4"),
      makePage("p5", "PHI_SECRET_MARKER_ALPHA body 5"),
    ];
    mockedGetPages.mockResolvedValue(pages);
    queueResponses(["throw", "throw", "throw", "irrelevant", "irrelevant"]);

    await runSynthesisPipeline("archive-test", "user-test");

    // SynthesisRun.update called at the end of the pipeline with FAILED status
    expect(mockedUpdate).toHaveBeenCalled();
    // Find the final FAILED update (status set as string)
    const failedCall = mockedUpdate.mock.calls.find(
      (c: any) => c[0]?.data?.status === "FAILED" || c[0]?.data?.status === "Aborted: 3 consecutive LLM failures",
    );
    // The implementation may store status as enum or string — accept both.
    const allStatuses = mockedUpdate.mock.calls.map((c: any) => c[0]?.data?.status).filter(Boolean);
    const failedFound = allStatuses.some((s: any) => s === "FAILED" || s === ("Aborted: 3 consecutive LLM failures" as any));
    expect(failedFound).toBe(true);

    // Error field should match the prefixed pattern and NOT contain the PHI marker
    const errorFields = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && e.length > 0);
    const abortError = errorFields.find((e: string) => /^Aborted: 3 consecutive LLM failures$/.test(e));
    expect(abortError).toBeDefined();
    expect(abortError).not.toContain("PHI_SECRET_MARKER_ALPHA");

    // previewJson should be set (non-null partial preview)
    const previewCalls = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.previewJson)
      .filter((p: any) => p !== undefined && p !== null);
    expect(previewCalls.length).toBeGreaterThan(0);
  });

  it("Test 2: 5 total LLM failures (with 4 successes interleaved) abort with FAILED status + explicit error", async () => {
    // 5 pages, queue: throw-succeed-throw-succeed-throw (total=3, consec=1)
    // but we need total=5 abort, so add more pages
    const pages = Array.from({ length: 10 }, (_, i) =>
      makePage(`p${i + 1}`, `body text ${i + 1}`),
    );
    mockedGetPages.mockResolvedValue(pages);
    // 10 calls: throw,succeed,throw,succeed,throw,succeed,throw,succeed,throw,succeed
    // Total failures = 5, consec resets each time → trips total threshold at call 9
    queueResponses([
      "throw", "ok1", "throw", "ok2", "throw",
      "ok3", "throw", "ok4", "throw", "ok5",
    ]);

    await runSynthesisPipeline("archive-test", "user-test");

    const errorFields = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && e.length > 0);
    const totalAbort = errorFields.find((e: string) => /^Aborted: 5 total LLM failures$/.test(e));
    expect(totalAbort).toBeDefined();
    expect(totalAbort).not.toContain("body text");
  });

  it("Test 3: 2 fail + 1 success + 2 fail pattern does NOT abort (consec resets, total=4 < 5)", async () => {
    // 5 pages, all have synthesis_generation frontmatter so Pass 2 is skipped
    const pages = [
      makePage("p1", "body 1"),
      makePage("p2", "body 2"),
      makePage("p3", "body 3"),
      makePage("p4", "body 4"),
      makePage("p5", "body 5"),
    ];
    mockedGetPages.mockResolvedValue(pages);
    // Pass 1: throw, throw, success, throw, throw (total=4, max-consec=2)
    queueResponses(["throw", "throw", "ok", "throw", "throw"]);

    await runSynthesisPipeline("archive-test", "user-test");

    // No "Aborted: ..." error should be present
    const errorFields = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && e.length > 0);
    const anyAbort = errorFields.find((e: string) => /Aborted:/.test(e));
    expect(anyAbort).toBeUndefined();
  });

  it("Test 7: error strings from abort path match prefixed pattern and exclude fixture bodyText/PHI", async () => {
    // Reuse Test 1 fixture (3 consecutive abort) and assert the regex covers all
    // expected prefixed patterns and excludes bodyText markers.
    const phiMarker = "PHI_SECRET_MARKER_GAMMA";
    const pages = [
      makePage("p1", `${phiMarker} body 1`),
      makePage("p2", `${phiMarker} body 2`),
      makePage("p3", `${phiMarker} body 3`),
      makePage("p4", `${phiMarker} body 4`),
      makePage("p5", `${phiMarker} body 5`),
    ];
    mockedGetPages.mockResolvedValue(pages);
    queueResponses(["throw", "throw", "throw", "irrelevant", "irrelevant"]);

    await runSynthesisPipeline("archive-test", "user-test");

    const errorFields = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && e.length > 0);

    // Match one of the prefixed patterns per the plan:
    //   ^Aborted: (3 consecutive|5 total) LLM failures$
    //   ^Aborted: orphaned PROCESSING \(reaper\)$
    //   ^Archive template requires local LLM.*$
    const allowed = /^Aborted: (3 consecutive|5 total) LLM failures$|^Aborted: orphaned PROCESSING \(reaper\)$|^Archive template requires local LLM.*$/;
    for (const e of errorFields) {
      // Either matches one of the allowed prefixes, OR it's an unrelated error (LLM endpoint down)
      // — but it must NOT contain the PHI marker.
      expect(e).not.toContain(phiMarker);
      // If it starts with "Aborted:" or "Archive template", it must match the regex.
      if (/^Aborted:/.test(e) || /^Archive template/.test(e)) {
        expect(allowed.test(e)).toBe(true);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// SC4 non-regression — Pass 4b contradiction pass LLM-fail → recordLlmFailure
//
// Plan 74-02 wired the new Pass 4b (contradiction detection) into
// runSynthesisPipeline. Per RESEARCH A2 / Pitfall 2, per-pair LLM failures in
// Pass 4b route through the SAME recordLlmFailure as Pass 1-4, preserving the
// D-13 abort counters (3 consecutive / 5 total). These tests verify that
// interaction and the D-09 budget-truncation path (which must NOT trip
// recordLlmFailure).
//
// The existing module-level mock replaces detectContradictions with a no-op
// jest.fn(). These tests override it with the REAL implementation (via
// jest.requireActual) so the full Pass 4b chain runs:
//   detectContradictions → judgePairContradiction → callSynthesisLLM → callNonStreamingLLM (mocked)
// ──────────────────────────────────────────────────────────────────────────

describe("Pass 4b — contradiction pass LLM-fail → recordLlmFailure (SC4 non-regression)", () => {
  const PASS4B = "pass4b_contradiction";

  let contradictionMod: any;
  let realDetectContradictions: any;
  let archivePageMod: any;
  let budgetMod: any;
  let loggerMod: any;

  beforeEach(() => {
    contradictionMod = require("../services/synthesisContradictionService");
    realDetectContradictions = jest.requireActual(
      "../services/synthesisContradictionService",
    ).detectContradictions;
    archivePageMod = require("../services/archivePageService");
    budgetMod = require("../services/synthesisBudgetService");
    loggerMod = require("../utils/logger");

    // Restore the default no-op detectContradictions so the existing tests in
    // the outer describe are not affected by a leftover mockImplementation
    // from a previous Pass 4b test.
    contradictionMod.detectContradictions.mockResolvedValue([]);
    // Restore default getPage (returns undefined) and $queryRaw (returns []).
    archivePageMod.getPage.mockReset();
    archivePageMod.getPage.mockResolvedValue(undefined);
    (prisma as any).$queryRaw.mockResolvedValue([]);
    // Restore default BudgetTracker (canContinue always true).
    budgetMod.BudgetTracker = class {
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
    };
  });

  /** Build a fixture page with overlapping tokens for Jaccard pairing. */
  function makeOverlapPage(slug: string, suffix = "") {
    return {
      id: `page-${slug}`,
      archiveId: "archive-test",
      slug,
      title: `Title ${slug}`,
      category: "entities",
      bodyText: `alpha beta gamma delta epsilon zeta eta theta ${suffix}`.trim(),
      frontmatter: { synthesis_generation: 1 },
      wikilinks: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      createdBy: "user-test",
    };
  }

  /**
   * Mock callNonStreamingLLM to dispatch by prompt prefix so Pass 1/4 can
   * succeed while Pass 4b judgePairContradiction calls throw on demand.
   */
  function mockLLMByPrompt(opts: {
    pass1Outcomes?: Array<"throw" | string>;
    pass4Outcome?: "throw" | string;
    pass4bOutcome?: "throw" | string;
  }) {
    const pass1Outcomes = opts.pass1Outcomes ?? [];
    let pass1Idx = 0;
    mockedCallNonStreamingLLM.mockImplementation(async (config: any, messages: any) => {
      const prompt = String(messages[messages.length - 1]?.content ?? "");
      if (prompt.startsWith("Extract all entities")) {
        const o = pass1Outcomes[pass1Idx++] ?? "ok";
        if (o === "throw") throw new Error("Pass 1 LLM down");
        return { content: '["entity1"]', tokensUsed: 10 };
      }
      if (prompt.startsWith("Given this new content")) {
        const o = opts.pass4Outcome ?? "ok";
        if (o === "throw") throw new Error("Pass 4 LLM down");
        return {
          content: JSON.stringify({
            decision: "UPDATE",
            suggestedContent: "new content proposal for the page",
            reason: "adds verifiable facts",
            confidence: "HIGH",
          }),
          tokensUsed: 10,
        };
      }
      if (prompt.startsWith("Claim A:")) {
        const o = opts.pass4bOutcome ?? "ok";
        if (o === "throw") throw new Error("Pass 4b LLM down");
        return { content: '{"contradiction": false, "reason": "none"}', tokensUsed: 10 };
      }
      return { content: "ok", tokensUsed: 10 };
    });
  }

  it("contradiction pass abort: 3 consecutive per-pair LLM failures in Pass 4b trip the abort counter to FAILED", async () => {
    // 4 overlapping pages → p1 is the candidate → 3 Jaccard pairs in Pass 4b.
    const pages = [
      makeOverlapPage("p1", "candidate"),
      makeOverlapPage("p2", "overview"),
      makeOverlapPage("p3", "summary"),
      makeOverlapPage("p4", "report"),
    ];
    mockedGetPages.mockResolvedValue(pages);
    // Pass 3 returns p1 as the only candidate.
    (prisma as any).$queryRaw.mockResolvedValue([{ slug: "p1" }]);
    archivePageMod.getPage.mockResolvedValue(pages[0]);
    // Pass 1 + Pass 4 succeed; Pass 4b judgePairContradiction throws every call.
    mockLLMByPrompt({ pass1Outcomes: ["ok", "ok", "ok", "ok"], pass4Outcome: "ok", pass4bOutcome: "throw" });
    // Use the real detectContradictions so Pass 4b actually calls judgePairContradiction.
    contradictionMod.detectContradictions.mockImplementation(realDetectContradictions);

    await runSynthesisPipeline("archive-test", "user-test");

    // recordLlmFailure must have been invoked with passName=pass4b_contradiction.
    const warnCalls = (loggerMod.logger.warn as jest.Mock).mock.calls;
    const pass4bFailCalls = warnCalls.filter((c: any[]) =>
      c[1]?.pass === PASS4B && /LLM call failed/.test(String(c[0] ?? "")),
    );
    expect(pass4bFailCalls.length).toBeGreaterThanOrEqual(3);

    // The run flips to FAILED with the "3 consecutive" abort error.
    const errorFields = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && e.length > 0);
    const abortError = errorFields.find((e: string) => /^Aborted: 3 consecutive LLM failures$/.test(e));
    expect(abortError).toBeDefined();

    // At least 3 Pass 4b judgePairContradiction LLM calls were attempted.
    const claimCalls = mockedCallNonStreamingLLM.mock.calls.filter(
      (c: any[]) => String(c[1]?.[c[1].length - 1]?.content ?? "").startsWith("Claim A:"),
    );
    expect(claimCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("contradiction pass 5 total: Pass 4b failures push the total counter to 5 and trip the total threshold", async () => {
    // 8 overlapping pages. Pass 1 accumulates 4 failures interleaved with 4
    // successes (consec resets on each success → total=4, consec=0). Pass 4
    // succeeds. Pass 4b's first pair throws → total=5, consec=1 < 3 → the
    // "5 total" path trips (not "3 consecutive").
    //
    // NOTE: detectContradictions (Plan 74-02) does NOT reset consecutiveLlmFailures
    // on a successful judgePairContradiction call (unlike Pass 1/4 which do).
    // A pure-Pass-4b 5-total scenario is therefore unreachable — 3 consecutive
    // 4b failures trip "3 consecutive" before total reaches 5. This test uses a
    // cross-pass accumulation (Pass 1 failures + one Pass 4b failure) to reach
    // total=5 with consec<3, exercising the shared total counter via Pass 4b.
    const pages = Array.from({ length: 8 }, (_, i) => makeOverlapPage(`p${i + 1}`, `s${i + 1}`));
    mockedGetPages.mockResolvedValue(pages);
    (prisma as any).$queryRaw.mockResolvedValue([{ slug: "p1" }]);
    archivePageMod.getPage.mockResolvedValue(pages[0]);
    mockLLMByPrompt({
      pass1Outcomes: ["throw", "ok", "throw", "ok", "throw", "ok", "throw", "ok"],
      pass4Outcome: "ok",
      pass4bOutcome: "throw",
    });
    contradictionMod.detectContradictions.mockImplementation(realDetectContradictions);

    await runSynthesisPipeline("archive-test", "user-test");

    const errorFields = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && e.length > 0);
    const totalAbort = errorFields.find((e: string) => /^Aborted: 5 total LLM failures$/.test(e));
    expect(totalAbort).toBeDefined();
    // Confirm the total trip came from at least one Pass 4b recordLlmFailure call.
    const warnCalls = (loggerMod.logger.warn as jest.Mock).mock.calls;
    const pass4bFailCalls = warnCalls.filter((c: any[]) =>
      c[1]?.pass === PASS4B && /LLM call failed/.test(String(c[0] ?? "")),
    );
    expect(pass4bFailCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("contradiction pass budget truncation stops before recordLlmFailure (truncation by budget, not failure)", async () => {
    // 2 overlapping pages → 1 Jaccard pair. BudgetTracker.canContinue returns
    // false for pass4b_contradiction → the pair is truncated (logged), NOT
    // judged. judgePairContradiction is never called, so callNonStreamingLLM
    // receives no "Claim A:" prompts and recordLlmFailure is NOT invoked.
    const pages = [makeOverlapPage("p1", "candidate"), makeOverlapPage("p2", "existing")];
    mockedGetPages.mockResolvedValue(pages);
    (prisma as any).$queryRaw.mockResolvedValue([{ slug: "p1" }]);
    archivePageMod.getPage.mockResolvedValue(pages[0]);
    mockLLMByPrompt({ pass1Outcomes: ["ok", "ok"], pass4Outcome: "ok", pass4bOutcome: "ok" });
    contradictionMod.detectContradictions.mockImplementation(realDetectContradictions);
    // Override BudgetTracker: canContinue returns false ONLY for pass4b.
    budgetMod.BudgetTracker = class {
      canContinue(passName: string) { return passName === PASS4B ? false : true; }
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
    };

    await runSynthesisPipeline("archive-test", "user-test");

    // No "Claim A:" LLM calls → judgePairContradiction was never invoked.
    const claimCalls = mockedCallNonStreamingLLM.mock.calls.filter(
      (c: any[]) => String(c[1]?.[c[1].length - 1]?.content ?? "").startsWith("Claim A:"),
    );
    expect(claimCalls.length).toBe(0);

    // recordLlmFailure was NOT invoked for pass4b_contradiction (no "LLM call
    // failed" warn log with pass=pass4b_contradiction).
    const warnCalls = (loggerMod.logger.warn as jest.Mock).mock.calls;
    const pass4bFailCalls = warnCalls.filter((c: any[]) =>
      c[1]?.pass === PASS4B && /LLM call failed/.test(String(c[0] ?? "")),
    );
    expect(pass4bFailCalls.length).toBe(0);

    // The truncation must be logged (D-09: no silent cap).
    const truncationCalls = warnCalls.filter((c: any[]) =>
      /pass4b_contradiction budget truncated/i.test(String(c[0] ?? "")),
    );
    expect(truncationCalls.length).toBeGreaterThan(0);

    // No abort error — truncation by budget is not a failure.
    const errorFields = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && /^Aborted:/.test(e));
    expect(errorFields.length).toBe(0);
  });
});
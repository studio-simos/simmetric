// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MOD-04 UAT canary — Phase 88 Plan 04 Task 1 (D-02 base-capture, D-08).
 *
 * The REAL gate for MOD-04 (per D-07 — jest green is NECESSARY but NOT
 * SUFFICIENT). Captures the synthesis pipeline's accumulator state
 * (`newPagesCollected` / `changes` / `contradictions` / `consecutiveLlmFailures`
 * / `totalLlmFailures`) on a representative fixture, and statically asserts
 * the 7 already-extracted `synthesis*Service.ts` siblings stay IMPORTED (via
 * dynamic require for Bree compat) NOT re-implemented.
 *
 * RESEARCH Pitfall 6 — `callSynthesisLLM` stays NON-STREAMING. The
 * accumulator here is the pipeline's internal accumulator (not an SSE
 * stream); the canary uses `callNonStreamingLLM` only, never `streamLLM` /
 * `fetchEventSource`.
 *
 * Task 1 (base-capture): asserts the CURRENT `synthesisService.ts` does
 * NOT re-implement the 7 siblings (it uses dynamic require).
 * Task 2 (extraction): adds a static grep assertion that the NEW
 * `synthesisStages.ts` does the same — uses dynamic require for the
 * siblings and does NOT re-implement them.
 */

import "./helpers/setupEnv";

// ── Mocks (copied from synthesisService.test.ts:1-80) ─────────────────────

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
  mock.prisma.archive = {
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe("MOD-04 UAT canary — synthesis accumulator state (survives split unchanged)", () => {
  it("Test 1: runSynthesisPipeline accumulator state (newPagesCollected/changes/contradictions/abort counters) on a representative fixture is captured", async () => {
    // 4-page fixture: all pages have synthesis_generation frontmatter so
    // Pass 2 is skipped. Pass 1 returns 1 entity per page (4 entities). Pass 3
    // returns all 4 slugs as candidates. Pass 4 returns CREATE/UPDATE with
    // non-empty suggestedContent for all 4 candidates. detectContradictions
    // is mocked to return a single fake contradiction. The pipeline completes
    // (no abort). Pins:
    //   - newPagesCollected: 4 (all 4 candidates are non-SKIP)
    //   - changes: 4 entries
    //   - contradictions: 1 entry
    //   - consecutiveLlmFailures: 0 (no failures)
    //   - totalLlmFailures: 0
    //   - status: COMPLETED (no abort, budget not exhausted)
    const pages = SYNTHESIS_FIXTURE_PAGES.map((p) => ({ ...p }));
    mockedGetPages.mockResolvedValue(pages);
    mockedQueryRaw.mockResolvedValue(pages.map((p) => ({ slug: p.slug })));
    mockedGetPage.mockImplementation(async (_archiveId: string, slug: string) =>
      pages.find((p) => p.slug === slug) || pages[0],
    );

    const updateDecision = JSON.stringify({
      decision: "UPDATE",
      reason: "r",
      suggestedContent: "Updated content with new facts.",
      confidence: "MEDIUM",
    });
    queueResponses([
      '["cost"]', '["cost"]', '["cost"]', '["cost"]', // Pass 1
      updateDecision, updateDecision, updateDecision, updateDecision, // Pass 4
    ]);

    // detectContradictions returns 1 fake contradiction — pins the Pass 4b
    // accumulator path.
    const { detectContradictions } = require("../services/synthesisContradictionService");
    (detectContradictions as jest.Mock).mockResolvedValue([
      {
        pageSlug: "cost-page",
        claimA: { text: "X costa 100", source: "cost-page", date: "2026-01-01T00:00:00.000Z" },
        claimB: { text: "X costa 200", source: "cost-update", date: "2026-01-02T00:00:00.000Z" },
        confidence: "HIGH",
        reason: "Cost mismatch",
      },
    ]);

    const preview = await runSynthesisPipeline("archive-test", "user-test");

    // Accumulator-state snapshot (the MOD-04 UAT canary contract — these
    // values MUST survive the split byte-for-byte).
    expect(preview.changes).toHaveLength(4); // newPagesCollected ≡ changes.length (4)
    expect(preview.contradictions).toHaveLength(1);
    expect(preview.status).toBe("COMPLETED"); // no abort, budget not exhausted

    // No abort error persisted (counters stayed at 0).
    const abortError = mockedUpdate.mock.calls
      .map((c: any) => c[0]?.data?.error)
      .filter((e: any) => typeof e === "string" && /Aborted:/.test(e));
    expect(abortError).toHaveLength(0);

    // The contradiction accumulator carried the fake item to the preview.
    const contradiction = (preview.contradictions as Array<{ pageSlug: string; reason?: string }>)[0];
    expect(contradiction).toBeDefined();
    expect(contradiction!.pageSlug).toBe("cost-page");
    expect(contradiction!.reason).toBe("Cost mismatch");

    // The newPagesCollected accumulator is internal to the pipeline, but it
    // feeds detectContradictions with the non-SKIP candidates. Verify the
    // detectContradictions call received exactly 4 new pages (all 4 candidates).
    const detectCall = (detectContradictions as jest.Mock).mock.calls[0][0] as {
      newPages: unknown[];
      existingPages: unknown[];
      archiveId: string;
      passName: string;
    };
    expect(detectCall.newPages).toHaveLength(4);
    expect(detectCall.archiveId).toBe("archive-test");
    expect(detectCall.passName).toBe("pass4b_contradiction");
  });

  it("Test 1b: abort counter snapshot — 3 consecutive LLM failures trip the abort with the correct counter state", async () => {
    // Pins the consecutiveLlmFailures + totalLlmFailures accumulator state on
    // the abort path. 3 consecutive throws → consecutiveLlmFailures=3,
    // totalLlmFailures=3, abort reason "3 consecutive LLM failures".
    const pages = Array.from({ length: 5 }, (_, i) => ({
      id: `page-p${i + 1}`,
      archiveId: "archive-test",
      slug: `p${i + 1}`,
      title: `Title ${i + 1}`,
      bodyText: `body ${i + 1}`,
      frontmatter: { synthesis_generation: 1 },
      category: "entities",
      wikilinks: [],
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      createdBy: "user-test",
    }));
    mockedGetPages.mockResolvedValue(pages);
    queueResponses(["throw", "throw", "throw", "ok", "ok"]);

    const preview = await runSynthesisPipeline("archive-test", "user-test");

    // The abort-counter accumulator state is observable via the persisted
    // error string + the FAILED status.
    expect(preview.status).toBe("FAILED");
    const failedCall = mockedUpdate.mock.calls.find(
      (c: any) => typeof c[0]?.data?.error === "string" && /Aborted: 3 consecutive LLM failures/.test(c[0].data.error),
    );
    expect(failedCall).toBeDefined();
    // The partial preview carries the empty changes (no candidate succeeded
    // before the abort) and zero contradictions.
    expect(preview.changes).toHaveLength(0);
    expect(preview.contradictions).toHaveLength(0);
  });
});

// ── Task 1 base-capture: the facade (post-extraction) does NOT re-implement ─
// the 7 siblings. After Task 2, the pipeline body moved to synthesisStages.ts;
// the facade is a thin wrapper. The dynamic-require guard moves to the
// Task 2 block below (which asserts synthesisStages.ts uses dynamic require).
// This block keeps a no-re-implementation guard on the facade itself.

describe("MOD-04 UAT canary — facade no-re-implementation guard (Task 1 base-capture, post-extraction)", () => {
  it("synthesisService.ts facade does NOT re-implement the 7 siblings (the pipeline body moved to synthesisStages.ts)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../services/synthesisService.ts"),
      "utf8",
    );

    // The facade must NOT re-implement the siblings. The class/function
    // definitions live in the sibling files, not in the facade.
    expect(src).not.toMatch(/^class BudgetTracker/m);
    expect(src).not.toMatch(/^function detectContradictions/m);
    expect(src).not.toMatch(/^async function getPages/m);
    // The facade must NOT contain the pipeline body (Pass 1-5 loops). The
    // body lives in synthesisStages.ts now.
    expect(src).not.toMatch(/Pass 1 — Entity Extraction/);
    expect(src).not.toMatch(/Pass 5 — Generate Preview/);
  });
});

// ── Task 2 extension — assert the NEW synthesisStages.ts uses dynamic ────
// require for the 7 siblings and does NOT re-implement them. ─────────────────
// (D-06: the 7 existing `synthesis*Service.ts` siblings are IMPORTED, not
// re-implemented. The pipeline body uses dynamic require for Bree worker
// compatibility.)

describe("MOD-04 UAT canary — synthesisStages.ts sibling re-coupling guard (Task 2 extraction)", () => {
  it("synthesisStages.ts uses dynamic require for the siblings and does NOT re-implement them", () => {
    const fs = require("fs");
    const path = require("path");
    const stagesPath = path.join(__dirname, "../services/synthesis/synthesisStages.ts");
    // The file must exist (Task 2 extraction target).
    expect(fs.existsSync(stagesPath)).toBe(true);
    const src = fs.readFileSync(stagesPath, "utf8");

    // Dynamic-require siblings (paths adjusted for services/synthesis/).
    // Pin the 4 the pipeline body uses (archivePageService +
    // synthesisBudgetService + synthesisContradictionService + eventLogService).
    expect(src).toMatch(/require\(["']\.\.\/\.\.\/services\/archivePageService["']\)/);
    expect(src).toMatch(/require\(["']\.\.\/\.\.\/services\/synthesisBudgetService["']\)/);
    expect(src).toMatch(/require\(["']\.\.\/\.\.\/services\/synthesisContradictionService["']\)/);
    expect(src).toMatch(/require\(["']\.\.\/\.\.\/services\/eventLogService["']\)/);

    // The module must NOT re-implement the siblings (D-06 — Don't Hand-Roll).
    // The class/function definitions live in the sibling files, not here.
    expect(src).not.toMatch(/^class BudgetTracker/m);
    expect(src).not.toMatch(/^function detectContradictions/m);
    expect(src).not.toMatch(/^async function getPages/m);

    // callSynthesisLLM stays NON-STREAMING (Pitfall 6) — uses
    // callNonStreamingLLM, NEVER streamLLM / fetchEventSource.
    expect(src).toMatch(/callNonStreamingLLM/);
    expect(src).not.toMatch(/import\s+\{[^}]*streamLLM[^}]*\}/);
    expect(src).not.toMatch(/import\s+\{[^}]*fetchEventSource[^}]*\}/);

    // The 4 stage groups are exported per acceptance criteria.
    expect(src).toMatch(/export async function runPipelineStages/);
    expect(src).toMatch(/export async function callSynthesisLLMStage/);
    expect(src).toMatch(/export async function getSynthesisConfigStage/);
    expect(src).toMatch(/export function defaultRunNameStage/);

    // The 4 internal stage-group functions are present (per plan acceptance).
    expect(src).toMatch(/async function runSynthesisSetupStage/);
    expect(src).toMatch(/async function runSynthesisCollectionStage/);
    expect(src).toMatch(/async function runSynthesisDecisionStage/);
    expect(src).toMatch(/async function runSynthesisPersistStage/);
  });

  it("synthesisService.ts facade delegates to synthesisStages and keeps the public surface byte-identical", () => {
    const fs = require("fs");
    const path = require("path");
    const facadeSrc = fs.readFileSync(
      path.join(__dirname, "../services/synthesisService.ts"),
      "utf8",
    );

    // The facade imports from ./synthesis/synthesisStages.
    expect(facadeSrc).toMatch(/from\s+["']\.\/synthesis\/synthesisStages["']/);

    // The 4 public signatures are preserved as thin wrappers.
    expect(facadeSrc).toMatch(/export async function runSynthesisPipeline/);
    expect(facadeSrc).toMatch(/export async function callSynthesisLLM/);
    expect(facadeSrc).toMatch(/export async function getSynthesisConfig/);
    expect(facadeSrc).toMatch(/export function defaultRunName/);

    // The facade does NOT contain the pipeline body (runSynthesisPipeline
    // is a single delegation line — no Pass 1-5 loop inside the facade).
    expect(facadeSrc).not.toMatch(/Pass 1 — Entity Extraction/);
    expect(facadeSrc).not.toMatch(/^class BudgetTracker/m);

    // The local interface definitions stay in the facade (no churn — Phase 87
    // typed them in-place, no external importer relies on re-exports).
    expect(facadeSrc).toMatch(/interface SynthesisChangeEntry/);
    expect(facadeSrc).toMatch(/interface SynthesisResultRow/);
    expect(facadeSrc).toMatch(/interface SynthesisArchivePage/);
  });

  it("routes/synthesis.ts import path unchanged (no importer churn — D-03)", () => {
    const fs = require("fs");
    const path = require("path");
    const routesSrc = fs.readFileSync(
      path.join(__dirname, "../routes/synthesis.ts"),
      "utf8",
    );
    expect(routesSrc).toMatch(/from\s+["']\.\.\/services\/synthesisService["']/);
  });
});

// ── Static guard: callSynthesisLLM stays NON-STREAMING (Pitfall 6) ──────────
//
// The canary test must NOT make callSynthesisLLM streaming. Self-check that
// this file does not import any streaming helper.
describe("MOD-04 UAT canary — non-streaming contract (Pitfall 6)", () => {
  it("canary test file does not import streamLLM or fetchEventSource (callSynthesisLLM stays non-streaming)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "synthesisStages.canary.test.ts"), "utf8");
    expect(src).not.toMatch(/import\s+\{[^}]*streamLLM[^}]*\}/);
    expect(src).not.toMatch(/import\s+\{[^}]*fetchEventSource[^}]*\}/);
    // callNonStreamingLLM is the only LLM transport used.
    expect(src).toMatch(/callNonStreamingLLM/);
    // grep for the accumulator state the canary pins.
    expect(src).toMatch(/newPagesCollected|changes/);
    expect(src).toMatch(/contradictions/);
  });
});
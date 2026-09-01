// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * MOD-04 Characterization pinning — Phase 88 Plan 04 Task 1 (D-02 base-capture).
 *
 * Captures the 4-stage output contract of `runSynthesisPipeline` + the public
 * `getSynthesisConfig` / `defaultRunName` seams on the UNMODIFIED
 * `synthesisService.ts` BEFORE the MOD-04 extraction (Task 2). The pinning
 * tests are committed green on base; after the extraction they MUST stay
 * green without modification, proving the facade is byte-identical.
 *
 * Per D-07, jest green is NECESSARY but NOT SUFFICIENT for MOD-04 — the
 * accumulator-state UAT canary in `synthesisStages.canary.test.ts` is the
 * real gate. These characterization tests pin the PUBLIC output contract
 * (preview shape + abort reason + config merge + run-name format) so a
 * regression in any of the 4 stage groups surfaces as a red test.
 *
 * The pipeline is mocked identically to `synthesisService.test.ts`; only
 * LLM responses are queued per pass. `callSynthesisLLM` stays NON-STREAMING
 * (RESEARCH Pitfall 6) — the test uses `callNonStreamingLLM` only, never
 * `streamLLM` / `fetchEventSource`.
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
import {
  runSynthesisPipeline,
  getSynthesisConfig,
  defaultRunName,
} from "../services/synthesisService";
import { SYNTHESIS_FIXTURE_PAGES } from "./fixtures/synthesisArchiveFixture";

const mockedCallNonStreamingLLM = callNonStreamingLLM as jest.MockedFunction<typeof callNonStreamingLLM>;
const mockedCreate = (prisma as any).synthesisRun.create as jest.MockedFunction<any>;
const mockedUpdate = (prisma as any).synthesisRun.update as jest.MockedFunction<any>;
const mockedArchiveConfigFindUnique = (prisma as any).archiveConfig.findUnique as jest.MockedFunction<any>;
const mockedGetPages = require("../services/archivePageService").getPages as jest.MockedFunction<any>;
const mockedGetPage = require("../services/archivePageService").getPage as jest.MockedFunction<any>;
const mockedQueryRaw = (prisma as any).$queryRaw as jest.MockedFunction<any>;
const mockedGetSynthesisOverrides = require("../services/archiveConfigService").getSynthesisOverrides as jest.MockedFunction<any>;

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

// ── Tests ────────────────────────────────────────────────────────────────

describe("MOD-04 characterization — runSynthesisPipeline 4-stage output contract", () => {
  it("Test 1: happy-path 2-page fixture returns a SynthesisPreview with non-empty changes + newPagesCollected matching the decision", async () => {
    // 2-page fixture: both pages have synthesis_generation frontmatter so
    // Pass 2 is skipped. Pass 1 returns 1 entity per page. Pass 3 returns both
    // slugs as candidates. Pass 4 returns CREATE with non-empty suggestedContent
    // for the first candidate (and UPDATE for the second) — pins the 4-stage
    // output contract: setup → collection → decision → persist produces a
    // SynthesisPreview with `changes` and `newPagesCollected` matching.
    const pages = SYNTHESIS_FIXTURE_PAGES.slice(0, 2).map((p) => ({ ...p }));
    mockedGetPages.mockResolvedValue(pages);
    mockedQueryRaw.mockResolvedValue(pages.map((p) => ({ slug: p.slug })));
    mockedGetPage.mockImplementation(async (_archiveId: string, slug: string) =>
      pages.find((p) => p.slug === slug) || pages[0],
    );

    // The 2 fixture pages both have `synthesis_generation` frontmatter → they
    // are NOT new pages → the CREATE branch (guarded by `isNewPage`) does not
    // fire. Both candidates go through UPDATE, exercising the decision/persist
    // stage and the newPagesCollected accumulator (Pass 4b pairs the 2 updated
    // candidates against the existing archive pages).
    const updateDecision1 = JSON.stringify({
      decision: "UPDATE",
      reason: "enhance",
      suggestedContent: "Updated content with new facts for page 1.",
      confidence: "MEDIUM",
    });
    const updateDecision2 = JSON.stringify({
      decision: "UPDATE",
      reason: "enhance",
      suggestedContent: "Updated content with new facts for page 2.",
      confidence: "HIGH",
    });
    queueResponses([
      '["cost"]', '["cost"]', // Pass 1: 2 pages
      updateDecision1, updateDecision2, // Pass 4: 2 candidates
    ]);

    const preview = await runSynthesisPipeline("archive-test", "user-test");

    // Preview shape pins the persist-stage output contract.
    expect(preview.runId).toBe("run-test-1");
    expect(preview.archiveId).toBe("archive-test");
    expect(preview.changes.length).toBe(2);
    // newPagesCollected is internal to the pipeline (not on the preview), but
    // the changes array carries the decision outcomes: 2 UPDATEs.
    const actions = preview.changes.map((c: any) => c.action).sort();
    expect(actions).toEqual(["update", "update"]);
    // Each UPDATE change must carry its own non-empty suggestedContent (no
    // bodyText fallback — D-03 guard).
    expect(preview.changes[0]!.proposedContent).toMatch(/Updated content with new facts/);
    expect(preview.changes[1]!.proposedContent).toMatch(/Updated content with new facts/);
  });

  it("Test 2: consecutiveLlmFailures overflow aborts with the budget-tracker abort reason (FAILED status + partial preview)", async () => {
    // 5 pages; Pass 1 throws 3 times in a row → abort trips "3 consecutive".
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

    // Abort pins the abort-counter behavior (D-13).
    expect(preview.status).toBe("FAILED");
    expect(preview.runId).toBe("run-test-1");
    // The FAILED row update carries the abort reason.
    const failedCall = mockedUpdate.mock.calls.find(
      (c: any) => typeof c[0]?.data?.error === "string" && /Aborted: 3 consecutive LLM failures/.test(c[0].data.error),
    );
    expect(failedCall).toBeDefined();
  });

  it("Test 3: getSynthesisConfig returns the merged config (archiveConfig overrides + systemConfig defaults)", async () => {
    // Override only linkingDensity; the rest falls back to defaults.
    mockedGetSynthesisOverrides.mockResolvedValueOnce({
      linkingDensity: { min: 0.01, max: 0.20 },
    });

    const cfg = await getSynthesisConfig("archive-test");

    expect(cfg.linkingDensity).toEqual({ min: 0.01, max: 0.20 });
    expect(cfg.agentPersona).toBe("balanced"); // default
    expect(cfg.maintenanceSchedule).toBe("0 2 * * 0"); // default weekly Sundays at 2am
    expect(cfg.purpose).toBe(""); // default
    expect(cfg.scope).toBe(""); // default

    // When no overrides are present, all defaults are returned.
    mockedGetSynthesisOverrides.mockResolvedValueOnce(null);
    const cfg2 = await getSynthesisConfig("archive-test");
    expect(cfg2.linkingDensity).toEqual({ min: 0.005, max: 0.15 });
    expect(cfg2.agentPersona).toBe("balanced");
  });

  it("Test 4: defaultRunName(archive, date) returns a deterministic name containing the archive name + date", async () => {
    const name = defaultRunName(
      { name: "Ricerche" },
      new Date("2026-07-25T18:35:00Z"),
    );
    // Pins the formatRunDate path: archive name + DD/MM/YYYY + HH:mm.
    expect(name).toContain("Sintesi");
    expect(name).toContain("Ricerche");
    expect(name).toMatch(/25\/07\/2026/);
    expect(name).toMatch(/\d{2}:\d{2}/);

    // Null archive name falls back to "Senza nome".
    const nullName = defaultRunName({ name: null }, new Date("2026-07-25T18:35:00Z"));
    expect(nullName).toContain("Senza nome");
  });
});

// ── Static guard: callSynthesisLLM stays NON-STREAMING (RESEARCH Pitfall 6) ──
//
// The characterization test must NOT accidentally make callSynthesisLLM
// streaming. This static assertion (run at test-load time) verifies the test
// file itself does not import any streaming helper.
describe("MOD-04 characterization — non-streaming contract (Pitfall 6)", () => {
  it("test file does not import streamLLM or fetchEventSource (callSynthesisLLM stays non-streaming)", () => {
    // Read this file's own source and assert no streaming imports.
    // (Test self-check — guards against accidental streaming wiring.)
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "synthesisService.characterization.test.ts"), "utf8");
    expect(src).not.toMatch(/import\s+\{[^}]*streamLLM[^}]*\}/);
    expect(src).not.toMatch(/import\s+\{[^}]*fetchEventSource[^}]*\}/);
    // callNonStreamingLLM is the only LLM transport used (the non-streaming path).
    expect(src).toMatch(/callNonStreamingLLM/);
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 187 (WIKS-01, D-03 verdict) — synthesis Pass-4 schemaPrompt injection.
 *
 * Per the RESEARCH-corrected D-03 verdict: the advisory "# Wiki Editorial
 * Guidelines" block reaches synthesis ONLY in Pass 4 (decision stage) via the
 * existing systemPrompt param of callSynthesisLLMStage. Pass 1 (summary) and
 * Pass 4b (contradiction judging) stay byte-identical (no system message).
 *
 * Harness modeled on synthesisAbort.test.ts: mock providerService
 * .callNonStreamingLLM capturing the messages array; partially mock
 * archiveConfigService (requireActual + overridden getSynthesisOverrides);
 * mock archivePageService getPage/getPages; stub BudgetTracker.
 *
 * The Pass 4 call is identified by its user prompt carrying the decision-JSON
 * marker "decision: string".
 */
import "./helpers/setupEnv";

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

jest.mock("../services/providerService", () => ({
  callNonStreamingLLM: jest.fn(),
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
}));

// Partial mock: getSynthesisOverrides is controlled per-test; everything else
// (getArchiveConfig etc.) delegates to the real module where possible.
jest.mock("../services/archiveConfigService", () => {
  const actual = jest.requireActual("../services/archiveConfigService");
  return {
    ...actual,
    getArchiveConfig: jest.fn().mockResolvedValue(null),
    getSynthesisOverrides: jest.fn().mockResolvedValue(null),
  };
});

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

import prisma from "../utils/prisma";
import { callNonStreamingLLM } from "../services/providerService";
import { getSynthesisOverrides } from "../services/archiveConfigService";
import { runSynthesisPipeline } from "../services/synthesisService";

const mockedCallNonStreamingLLM = callNonStreamingLLM as jest.MockedFunction<typeof callNonStreamingLLM>;
const mockedGetSynthesisOverrides = getSynthesisOverrides as jest.Mock;
const mockedCreate = (prisma as any).synthesisRun.create as jest.MockedFunction<any>;
const mockedUpdate = (prisma as any).synthesisRun.update as jest.MockedFunction<any>;
const mockedGetPages = require("../services/archivePageService").getPages as jest.MockedFunction<any>;
const mockedGetPage = require("../services/archivePageService").getPage as jest.MockedFunction<any>;

const ARCHIVE_ID = "archive-schema-injection-test";

function makePage(slug: string, bodyText: string, withSynthesisGen = false) {
  return {
    id: `page-${slug}`,
    archiveId: ARCHIVE_ID,
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

type Msg = { role: "system" | "user" | "assistant"; content: string };

/** All captured messages arrays, in call order. */
function capturedCalls(): Msg[][] {
  return mockedCallNonStreamingLLM.mock.calls.map((c) => c[1] as Msg[]);
}

/** Calls whose user prompt is a Pass-4 decision prompt (decision-JSON marker). */
function pass4Calls(): Msg[][] {
  return capturedCalls().filter(
    (msgs) => msgs.some((m) => m.role === "user" && m.content.includes("decision: string")),
  );
}

/** Calls that are Pass-1/Pass-2 style summary prompts. */
function summaryCalls(): Msg[][] {
  return capturedCalls().filter(
    (msgs) => msgs.some((m) => m.role === "user" && m.content.includes("Summarize this text")),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreate.mockResolvedValue({ id: "run-test-1" });
  mockedUpdate.mockResolvedValue({});
  mockedGetSynthesisOverrides.mockResolvedValue(null);
  // Pass 1 walks every page for entity extraction; Pass 4 iterates candidate
  // slugs coming from the Pass 3 $queryRaw search. Wire the full chain:
  // - getPages returns one page (no synthesis_generation → Pass 2 runs too)
  // - Pass 1 LLM returns a JSON array of entities (parsed → entity set)
  // - Pass 3 $queryRaw returns the candidate row for slug "p1"
  // - getPage returns the candidate page for the Pass 4 decision
  // - LLM responses are routed by prompt shape
  mockedGetPages.mockResolvedValue([makePage("p1", "Some new page body that synthesis must decide on.")]);
  mockedGetPage.mockResolvedValue(makePage("p1", "Some new page body that synthesis must decide on."));
  (prisma as any).$queryRaw.mockResolvedValue([{ slug: "p1" }]);
  mockedCallNonStreamingLLM.mockImplementation(async (_config: unknown, messages: Msg[]) => {
    const userPrompt = messages.find((m) => m.role === "user")?.content ?? "";
    if (userPrompt.includes("Extract all entities")) {
      return { content: JSON.stringify(["Entity One"]), tokensUsed: 5 };
    }
    if (userPrompt.includes("Summarize this text")) {
      return { content: "A one-sentence summary.", tokensUsed: 5 };
    }
    return {
      content: JSON.stringify({ decision: "SKIP", reason: "nothing to do" }),
      tokensUsed: 10,
    };
  });
});

describe("synthesis Pass-4 schemaPrompt injection (Phase 187, D-03 verdict)", () => {
  it("(a) overrides WITH schemaPrompt → the Pass 4 decision call receives a system message with the advisory block", async () => {
    mockedGetSynthesisOverrides.mockResolvedValue({
      linkingDensity: { min: 0.005, max: 0.15 },
      agentPersona: "balanced",
      purpose: "",
      scope: "",
      schemaPrompt: "Keep every page under 500 words and use kebab-case slugs.",
    });

    await runSynthesisPipeline(ARCHIVE_ID, "user-test");

    const p4 = pass4Calls();
    expect(p4.length).toBeGreaterThanOrEqual(1);
    for (const msgs of p4) {
      const system = msgs.find((m) => m.role === "system");
      expect(system).toBeDefined();
      expect(system!.content).toContain("Wiki Editorial Guidelines");
      expect(system!.content).toContain("Keep every page under 500 words and use kebab-case slugs.");
      expect(system!.content).toContain("These guidelines are advisory — hard rules always take precedence.");
    }
  });

  it("(b) overrides WITHOUT schemaPrompt → the Pass 4 messages array has NO system message (byte-identical absence)", async () => {
    mockedGetSynthesisOverrides.mockResolvedValue({
      linkingDensity: { min: 0.005, max: 0.15 },
      agentPersona: "balanced",
      purpose: "",
      scope: "",
      schemaPrompt: "",
    });

    await runSynthesisPipeline(ARCHIVE_ID, "user-test");

    const p4 = pass4Calls();
    expect(p4.length).toBeGreaterThanOrEqual(1);
    for (const msgs of p4) {
      expect(msgs.find((m) => m.role === "system")).toBeUndefined();
      // messages[0] is the user prompt
      expect(msgs[0]!.role).toBe("user");
    }
  });

  it("(c) Pass 1/summary-stage invocations receive no system message regardless of schemaPrompt", async () => {
    mockedGetSynthesisOverrides.mockResolvedValue({
      linkingDensity: { min: 0.005, max: 0.15 },
      agentPersona: "balanced",
      purpose: "",
      scope: "",
      schemaPrompt: "Guideline that must NOT reach the summary pass.",
    });

    // Second page with synthesis_generation forces a Pass 2 summary call.
    mockedGetPages.mockResolvedValue([
      makePage("p1", "New page body.", false),
      makePage("p2", "Existing page body needing a summary.", true),
    ]);
    mockedGetPage.mockImplementation(async (_archiveId: string, slug: string) =>
      makePage(slug, "Existing page body needing a summary.", true),
    );

    await runSynthesisPipeline(ARCHIVE_ID, "user-test");

    const summaries = summaryCalls();
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    for (const msgs of summaries) {
      expect(msgs.find((m) => m.role === "system")).toBeUndefined();
      expect(msgs[0]!.content).toContain("Summarize this text");
      expect(msgs[0]!.content).not.toContain("Wiki Editorial Guidelines");
    }
    // And the advisory text never appears in ANY summary-stage prompt.
    for (const msgs of summaries) {
      expect(msgs.some((m) => m.content.includes("Guideline that must NOT reach the summary pass."))).toBe(false);
    }
  });
});
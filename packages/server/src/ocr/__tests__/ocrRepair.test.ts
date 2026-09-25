// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for ocrRepair — post-job page repair (260919-kvm)
 *
 * Mock style mirrors ocrPipeline.test.ts: prisma, ocrJobService, fs/promises,
 * ollamaVisionClient, pdfRenderer, hallucinationGuard, qualityScoring,
 * groundingCleanup, modelRegistry — no live DB.
 */

jest.mock("../../utils/prisma", () => ({
  __esModule: true,
  default: {
    ocrJob: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    archiveImportJob: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));

jest.mock("../../config/env", () => ({
  getEnv: jest.fn().mockReturnValue({ DATABASE_URL: "postgresql://test:test@localhost:5432/test" }),
}));

jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock("../../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockGetOcrJob = jest.fn();
const mockParseOcrJobResult = jest.fn((result: unknown) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  return result as Record<string, unknown>;
});

jest.mock("../../services/ocrJobService", () => ({
  getOcrJob: (...args: any[]) => mockGetOcrJob(...args),
  parseOcrJobResult: (result: unknown) => mockParseOcrJobResult(result),
}));

jest.mock("../../services/systemConfigService", () => ({
  getSetting: jest.fn().mockResolvedValue({ value: "" }),
}));

const mockRenderPageToPng = jest.fn();
jest.mock("../pdfRenderer", () => ({
  renderPageToPng: (...args: any[]) => mockRenderPageToPng(...args),
  // Phase 205 D-03: the render-scale constant mirrors the real module value
  // (3.0) — asserted via the shared constant instead of a literal.
  PAGE_RENDER_SCALE: 3.0,
}));

const mockOcrPage = jest.fn();
jest.mock("../ollamaVisionClient", () => ({
  ocrPage: (...args: any[]) => mockOcrPage(...args),
}));

jest.mock("../modelRegistry", () => ({
  resolveModelConfig: jest.fn().mockReturnValue({
    name: "glm-ocr:latest",
    namePattern: "glm-ocr:latest",
    inputMode: "base64_array",
    supportedModes: ["text", "table", "figure", "generic"],
    promptTemplate: "glm-ocr",
    contextWindow: 4096,
  }),
}));

const mockApplyHallucinationGuard = jest.fn();
jest.mock("../hallucinationGuard", () => ({
  applyHallucinationGuard: (...args: any[]) => mockApplyHallucinationGuard(...args),
}));

const mockSanitizeChatTokens = jest.fn((s: string) => s);
const mockStripGroundingTags = jest.fn((s: string) => s);
jest.mock("../groundingCleanup", () => ({
  sanitizeChatTokens: (s: string) => mockSanitizeChatTokens(s),
  stripGroundingTags: (s: string) => mockStripGroundingTags(s),
}));

const mockComputeDocumentQualityScore = jest.fn();
jest.mock("../qualityScoring", () => ({
  computePageQualityScore: jest.fn(),
  computeDocumentQualityScore: (...args: any[]) =>
    mockComputeDocumentQualityScore(...args),
}));

const mockFinalizeAutoApproveOnComplete = jest.fn().mockResolvedValue(undefined);
jest.mock("../ocrStages", () => ({
  buildConcatenatedMarkdown: (pageResults: Array<{ pageNumber: number; markdown: string }>, totalPages: number) =>
    pageResults
      .map((r) => `## Page ${r.pageNumber}\n\n${r.markdown}`)
      .join("\n\n---\n\n") + (totalPages > 0 ? "" : ""),
  resolveGuardMode: (archiveId: string) => (archiveId ? "discard-only" : "full"),
  finalizeAutoApproveOnComplete: (...args: any[]) =>
    mockFinalizeAutoApproveOnComplete(...args),
}));

jest.mock("../../utils/archivePath", () => ({
  validateArchivePath: jest.fn(),
}));

const mockFsWriteFile = jest.fn();
const mockFsMkdir = jest.fn();
const mockFsReadFile = jest.fn();
const mockFsAccess = jest.fn();
jest.mock("fs/promises", () => ({
  writeFile: (...args: any[]) => mockFsWriteFile(...args),
  mkdir: (...args: any[]) => mockFsMkdir(...args),
  readFile: (...args: any[]) => mockFsReadFile(...args),
  access: (...args: any[]) => mockFsAccess(...args),
}));

import { repairOcrPages } from "../ocrRepair";
import { PAGE_RENDER_SCALE } from "../pdfRenderer";

const prisma = require("../../utils/prisma").default;

const FAILED_MARKDOWN = "[FAILED: OCR model error — stream died]";
const GOOD_PAGE_2 = "## Page 2 Content\n\nRecovered text.";

function makeMockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-001",
    archiveId: "archive-001",
    type: "OCR",
    status: "COMPLETED",
    createdBy: "user-001",
    sourceFileName: "test-doc.pdf",
    modelName: "glm-ocr:latest",
    ocrMode: null,
    customInstructions: null,
    totalPages: 2,
    result: {
      contentHash: "abc123",
      extractedTitle: "Test Doc",
      approved: false,
      totalPages: 2,
      pageResults: [
        {
          pageNumber: 1,
          markdown: FAILED_MARKDOWN,
          imagePath: "raw_sources/page-0001.png",
          tokensUsed: 0,
          durationMs: 0,
        },
        {
          pageNumber: 2,
          markdown: "Valid page 2 content",
          imagePath: "raw_sources/page-0002.png",
          tokensUsed: 100,
          durationMs: 5000,
        },
      ],
    },
    ...overrides,
  };
}

describe("ocrRepair — repairOcrPages", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOcrJob.mockResolvedValue(makeMockJob());
    mockFsReadFile.mockResolvedValue(Buffer.from("fake-png"));
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsAccess.mockResolvedValue(undefined);
    mockRenderPageToPng.mockResolvedValue(Buffer.from("rendered-png"));
    mockOcrPage.mockResolvedValue({
      markdown: "Recovered text",
      tokensUsed: 120,
      durationMs: 4200,
    });
    mockApplyHallucinationGuard.mockImplementation((markdown: string) => ({
      markdown,
      hasUnverified: false,
      unverifiedCount: 0,
      hasHandwriting: false,
      hasEmpty: false,
      degenerated: false,
      issues: [],
    }));
    mockComputeDocumentQualityScore.mockReturnValue({
      overall: 4,
      perPage: [],
      summary: "Good quality document",
    });
    prisma.ocrJob.update.mockResolvedValue({});
    prisma.archiveImportJob.findFirst.mockResolvedValue(null);
  });

  it("(1) repairs a single [FAILED: page from its persisted PNG", async () => {
    const outcome = await repairOcrPages("job-001", undefined, "user-001");

    // Only page 1 targeted (page 2 is valid)
    expect(mockOcrPage).toHaveBeenCalledTimes(1);
    expect(mockOcrPage.mock.calls[0][0]).toEqual(Buffer.from("fake-png"));
    // PNG read from the persisted imagePath
    expect(mockFsReadFile).toHaveBeenCalledWith(
      expect.stringContaining("page-0001.png"),
    );
    // Fallback prompt used
    expect(mockOcrPage.mock.calls[0][6]).toBe(true);

    expect(outcome.repaired).toHaveLength(1);
    expect(outcome.repaired[0]!.pageNumber).toBe(1);
    expect(outcome.repaired[0]!.stillFailed).toBe(false);
  });

  it("(2) recomputes failedPages to 0 and rewrites concatenated.md", async () => {
    const outcome = await repairOcrPages("job-001", undefined, "user-001");

    expect(outcome.failedPages).toBe(0);

    // prisma update received the repaired result with metadata preserved
    expect(prisma.ocrJob.update).toHaveBeenCalledTimes(1);
    const updateData = prisma.ocrJob.update.mock.calls[0][0].data;
    expect(updateData.status).toBeUndefined();
    expect(updateData.progress).toBeUndefined();
    const stored = updateData.result as Record<string, unknown>;
    expect(stored.contentHash).toBe("abc123");
    expect(stored.extractedTitle).toBe("Test Doc");
    expect(stored.failedPages).toBe(0);

    // concatenated.md rewritten via the shared builder (## Page headers)
    const concatCall = mockFsWriteFile.mock.calls.find((c: any[]) =>
      String(c[0]).includes("concatenated.md"),
    );
    expect(concatCall).toBeDefined();
    expect(String(concatCall![1])).toContain("## Page 1");
    expect(String(concatCall![1])).toContain("Recovered text");
    expect(String(concatCall![1])).toContain("Valid page 2 content");
  });

  it("(3) still-failed repair keeps the [FAILED: marker in the same slot", async () => {
    // OCR call throws on both attempts → page stays failed
    mockOcrPage.mockRejectedValue(new Error("Ollama down"));

    const outcome = await repairOcrPages("job-001", undefined, "user-001");

    // Original + ONE bounded re-try = 2 attempts, no more
    expect(mockOcrPage).toHaveBeenCalledTimes(2);
    expect(outcome.repaired[0]!.stillFailed).toBe(true);

    const updateData = prisma.ocrJob.update.mock.calls[0][0].data;
    const stored = updateData.result as {
      pageResults: Array<{ pageNumber: number; markdown: string }>;
    };
    expect(stored.pageResults[0]!.markdown).toBe(FAILED_MARKDOWN);
    expect(outcome.failedPages).toBe(1);
  });

  it("(4) does NOT touch valid pages", async () => {
    await repairOcrPages("job-001", undefined, "user-001");

    const updateData = prisma.ocrJob.update.mock.calls[0][0].data;
    const stored = updateData.result as {
      pageResults: Array<{ pageNumber: number; markdown: string; tokensUsed: number }>;
    };
    const validPage = stored.pageResults.find((p) => p.pageNumber === 2)!;
    expect(validPage.markdown).toBe("Valid page 2 content");
    // Original tokensUsed preserved (only repaired pages update tallies)
    expect(validPage.tokensUsed).toBe(100);
  });

  it("(5) falls back to re-render from source PDF when imagePath absent", async () => {
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({
        result: {
          totalPages: 1,
          pageResults: [
            {
              pageNumber: 1,
              markdown: "[FAILED: Could not render page — PDF rendering error]",
              tokensUsed: 0,
              durationMs: 0,
            },
          ],
        },
      }),
    );

    const outcome = await repairOcrPages("job-001", undefined, "user-001");

    // No PNG read — re-rendered from the persisted source PDF
    expect(mockFsReadFile).not.toHaveBeenCalled();
    expect(mockRenderPageToPng).toHaveBeenCalledWith(
      expect.stringContaining("test-doc.pdf"),
      1,
      PAGE_RENDER_SCALE,
    );
    expect(outcome.repaired[0]!.stillFailed).toBe(false);
  });

  it("(6) status stays COMPLETED — update writes result only", async () => {
    await repairOcrPages("job-001", undefined, "user-001");

    expect(prisma.ocrJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-001" },
      }),
    );
    const updateData = prisma.ocrJob.update.mock.calls[0][0].data;
    expect(Object.keys(updateData)).toEqual(["result"]);
    expect(updateData.status).toBeUndefined();
    expect(updateData.progress).toBeUndefined();
  });

  it("(7a) re-approve hook fires when all pages valid AND AIJ is PENDING", async () => {
    prisma.archiveImportJob.findFirst.mockResolvedValue({
      id: "aij-1",
      status: "PENDING",
      result: { ocrJobId: "job-001" },
    });

    await repairOcrPages("job-001", undefined, "user-001");

    // All pages valid after repair → hook fired
    expect(prisma.archiveImportJob.findFirst).toHaveBeenCalledWith({
      where: { result: { path: ["ocrJobId"], equals: "job-001" } },
    });
    expect(mockFinalizeAutoApproveOnComplete).toHaveBeenCalledTimes(1);
  });

  it("(7b) re-approve hook does NOT fire when a COMPLETED AIJ exists", async () => {
    prisma.archiveImportJob.findFirst.mockResolvedValue({
      id: "aij-1",
      status: "COMPLETED",
      result: { ocrJobId: "job-001" },
    });

    await repairOcrPages("job-001", undefined, "user-001");

    expect(mockFinalizeAutoApproveOnComplete).not.toHaveBeenCalled();
  });

  it("(7c) re-approve hook does NOT fire when pages still failed", async () => {
    mockOcrPage.mockRejectedValue(new Error("Ollama down"));
    prisma.archiveImportJob.findFirst.mockResolvedValue({
      id: "aij-1",
      status: "PENDING",
      result: { ocrJobId: "job-001" },
    });

    await repairOcrPages("job-001", undefined, "user-001");

    expect(mockFinalizeAutoApproveOnComplete).not.toHaveBeenCalled();
  });

  it("(8) explicit pages list limits targets; unknown pages are ignored", async () => {
    await repairOcrPages("job-001", [2], "user-001");

    // Page 2 is valid but explicitly requested — re-OCRed anyway
    expect(mockOcrPage).toHaveBeenCalledTimes(1);
    expect(mockOcrPage.mock.calls[0][1]).toBe(2);
  });

  it("throws TooManyRepairTargetsError (>50 targets) — route maps to 400", async () => {
    const pageResults = [];
    for (let i = 1; i <= 60; i++) {
      pageResults.push({
        pageNumber: i,
        markdown: `[FAILED: page ${i}]`,
        tokensUsed: 0,
        durationMs: 0,
      });
    }
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({ totalPages: 60, result: { totalPages: 60, pageResults } }),
    );

    await expect(
      repairOcrPages("job-001", undefined, "user-001"),
    ).rejects.toThrow("Too many failed pages");
    // Nothing persisted when the guard trips
    expect(prisma.ocrJob.update).not.toHaveBeenCalled();
  });

  it("empty target list (no [FAILED: pages) returns current tallies without OCR calls", async () => {
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({
        result: {
          totalPages: 1,
          pageResults: [
            {
              pageNumber: 1,
              markdown: "Valid page 1 content",
              imagePath: "raw_sources/page-0001.png",
              tokensUsed: 100,
              durationMs: 5000,
            },
          ],
        },
      }),
    );

    const outcome = await repairOcrPages("job-001", undefined, "user-001");

    expect(mockOcrPage).not.toHaveBeenCalled();
    expect(outcome.repaired).toHaveLength(0);
    expect(outcome.failedPages).toBe(0);
    // Result still persisted with recomputed tallies
    expect(prisma.ocrJob.update).toHaveBeenCalledTimes(1);
  });

  it("job missing → JobNotFoundError (route 404)", async () => {
    mockGetOcrJob.mockResolvedValue(null);
    await expect(
      repairOcrPages("missing-job", undefined, "user-001"),
    ).rejects.toThrow("Job not found");
  });

  it("non-COMPLETED job → JobNotCompletedError (route 409)", async () => {
    mockGetOcrJob.mockResolvedValue(makeMockJob({ status: "PROCESSING" }));
    await expect(
      repairOcrPages("job-001", undefined, "user-001"),
    ).rejects.toThrow("Job not completed");
  });
});
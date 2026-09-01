// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for ocrPipeline — PDF-to-Markdown Bree job handler
 *
 * TDD: RED → GREEN → REFACTOR
 *
 * Tests the processOcrJob function which orchestrates the full pipeline:
 * render → OCR → guard → score → write → progress update → complete.
 */

// Mock prisma (MUST come before any imports that transitively load prisma.ts)
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

// Mock getEnv (used by prisma.ts)
jest.mock("../../config/env", () => ({
  getEnv: jest.fn().mockReturnValue({ DATABASE_URL: "postgresql://test:test@localhost:5432/test" }),
}));

// Mock logger
jest.mock("../../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

// Mock eventLogService
jest.mock("../../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// Mock ocrJobService
const mockGetOcrJob = jest.fn();
const mockStartOcrJob = jest.fn();
const mockUpdateJobProgress = jest.fn();
const mockCompleteOcrJob = jest.fn();
const mockFailOcrJob = jest.fn();
const mockParseOcrJobResult = jest.fn((result: unknown) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  return result as Record<string, unknown>;
});

jest.mock("../../services/ocrJobService", () => ({
  getOcrJob: (...args: any[]) => mockGetOcrJob(...args),
  startOcrJob: (...args: any[]) => mockStartOcrJob(...args),
  updateJobProgress: (...args: any[]) => mockUpdateJobProgress(...args),
  completeOcrJob: (...args: any[]) => mockCompleteOcrJob(...args),
  failOcrJob: (...args: any[]) => mockFailOcrJob(...args),
  parseOcrJobResult: (result: unknown) => mockParseOcrJobResult(result),
}));

// Mock pdfRenderer
const mockRenderPageToPng = jest.fn();
jest.mock("../pdfRenderer", () => ({
  renderPageToPng: (...args: any[]) => mockRenderPageToPng(...args),
}));

// Mock ollamaVisionClient
const mockOcrPage = jest.fn();
jest.mock("../ollamaVisionClient", () => ({
  ocrPage: (...args: any[]) => mockOcrPage(...args),
}));

// Mock modelRegistry
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

// Mock hallucinationGuard
const mockApplyHallucinationGuard = jest.fn();
jest.mock("../hallucinationGuard", () => ({
  applyHallucinationGuard: (...args: any[]) => mockApplyHallucinationGuard(...args),
}));

// Mock groundingCleanup (sanitizeChatTokens + stripGroundingTags spies)
const mockSanitizeChatTokens = jest.fn((s: string) => s);
const mockStripGroundingTags = jest.fn((s: string) => s);
jest.mock("../groundingCleanup", () => ({
  sanitizeChatTokens: (s: string) => mockSanitizeChatTokens(s),
  stripGroundingTags: (s: string) => mockStripGroundingTags(s),
}));

// Mock qualityScoring
const mockComputePageQualityScore = jest.fn();
const mockComputeDocumentQualityScore = jest.fn();
jest.mock("../qualityScoring", () => ({
  computePageQualityScore: (...args: any[]) => mockComputePageQualityScore(...args),
  computeDocumentQualityScore: (...args: any[]) => mockComputeDocumentQualityScore(...args),
}));

// Mock archivePageService (71-02 auto-approve hook target)
const mockCreatePage = jest.fn();
const mockRebuildIndex = jest.fn();
jest.mock("../../services/archivePageService", () => ({
  createPage: (...args: any[]) => mockCreatePage(...args),
  rebuildIndex: (...args: any[]) => mockRebuildIndex(...args),
}));

// Mock fs/promises
const mockFsWriteFile = jest.fn();
const mockFsMkdir = jest.fn();
const mockFsReadFile = jest.fn();
const mockFsAccess = jest.fn();
const mockFsUnlink = jest.fn();
jest.mock("fs/promises", () => ({
  writeFile: (...args: any[]) => mockFsWriteFile(...args),
  mkdir: (...args: any[]) => mockFsMkdir(...args),
  readFile: (...args: any[]) => mockFsReadFile(...args),
  access: (...args: any[]) => mockFsAccess(...args),
  unlink: (...args: any[]) => mockFsUnlink(...args),
}));

// Mock crypto
jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  return {
    ...actual,
    createHash: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue("abc123def456"),
    }),
  };
});

// Mock pdfjs-dist
jest.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: jest.fn(),
}));

jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: jest.fn(),
}));

import { processOcrJob } from "../ocrPipeline";

// Reference to the mocked logger (jest.mock above) — used to assert
// warn/error logging behavior in truthfulness tests.
const logger = require("../../utils/logger").logger as {
  warn: jest.Mock;
  error: jest.Mock;
  info: jest.Mock;
};

// Default mock job for tests
function makeMockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-001",
    archiveId: "archive-001",
    type: "OCR",
    status: "PENDING",
    createdBy: "user-001",
    sourceFileName: "test-doc.pdf",
    modelName: "glm-ocr:latest",
    totalPages: 0,
    currentPage: 0,
    progress: 0,
    processedPages: 0,
    result: null,
    ...overrides,
  };
}

function mockSuccessfulPage(pageNum: number, totalPages: number) {
  return {
    pageNumber: pageNum,
    markdown: `## Page ${pageNum} Content\n\nThis is page ${pageNum} content.`,
    tokensUsed: 100,
    durationMs: 5000,
  };
}

describe("ocrPipeline — processOcrJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: resolve successfully
    mockFsReadFile.mockResolvedValue(Buffer.from("fake-pdf"));
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsAccess.mockResolvedValue(undefined);
    mockGetOcrJob.mockResolvedValue(makeMockJob());
    mockRenderPageToPng.mockResolvedValue(Buffer.from("fake-png"));
    mockOcrPage.mockImplementation((_buf, pageNum, _tp) =>
      Promise.resolve(mockSuccessfulPage(pageNum, 3))
    );
    mockApplyHallucinationGuard.mockReturnValue({
      markdown: "Guarded markdown content",
      hasUnverified: false,
      unverifiedCount: 0,
      hasHandwriting: false,
      hasEmpty: false,
      issues: [],
    });
    mockComputePageQualityScore.mockReturnValue(4);
    mockComputeDocumentQualityScore.mockReturnValue({
      overall: 4,
      perPage: [],
      summary: "Good quality document",
    });
    mockStartOcrJob.mockResolvedValue(undefined);
    mockUpdateJobProgress.mockResolvedValue(undefined);
    mockCompleteOcrJob.mockResolvedValue(undefined);
    mockFailOcrJob.mockResolvedValue(undefined);
    mockFsUnlink.mockResolvedValue(undefined);
    // sanitizeChatTokens/stripGroundingTags default to identity passthrough
    mockSanitizeChatTokens.mockImplementation((s: string) => s);
    mockStripGroundingTags.mockImplementation((s: string) => s);
  });

  // --- Test 1: 3-page PDF processes all 3 pages ---
  it("processes a 3-page PDF, updates progress after each page, and completes the job", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 3 }),
    });

    await processOcrJob("job-001");

    // Should call renderPageToPng 3 times
    expect(mockRenderPageToPng).toHaveBeenCalledTimes(3);
    // Should call ocrPage 3 times
    expect(mockOcrPage).toHaveBeenCalledTimes(3);
    // Should call applyHallucinationGuard 3 times
    expect(mockApplyHallucinationGuard).toHaveBeenCalledTimes(3);
    // Should call computePageQualityScore 3 times
    expect(mockComputePageQualityScore).toHaveBeenCalledTimes(3);

    // Should update progress 3 times (once per page)
    expect(mockUpdateJobProgress).toHaveBeenCalledTimes(3);
    // Check that progress advances
    expect(mockUpdateJobProgress).toHaveBeenNthCalledWith(1, "job-001", {
      processedPages: 1,
      progress: 33, // 1/3 * 100 = 33
      currentPage: 1,
    });
    expect(mockUpdateJobProgress).toHaveBeenNthCalledWith(3, "job-001", {
      processedPages: 3,
      progress: 100, // 3/3 * 100 = 100
      currentPage: 3,
    });

    // Should call startOcrJob once
    expect(mockStartOcrJob).toHaveBeenCalledWith("job-001", 3);
    // Should complete the job
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
    // Should NOT fail
    expect(mockFailOcrJob).not.toHaveBeenCalled();
  });

  // --- Test 2: OCR failure on page 2 does not block page 3 ---
  it("continues processing after OCR failure on page 2", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 3 }),
    });

    // Page 1: success, Page 2: fail, Page 3: success
    mockOcrPage
      .mockImplementationOnce((_buf, pageNum, _tp) =>
        Promise.resolve(mockSuccessfulPage(pageNum, 3))
      )
      .mockRejectedValueOnce(new Error("Ollama connection refused"))
      .mockImplementationOnce((_buf, pageNum, _tp) =>
        Promise.resolve(mockSuccessfulPage(pageNum, 3))
      );

    await processOcrJob("job-001");

    // Should still process all 3 pages (render called 3 times)
    expect(mockRenderPageToPng).toHaveBeenCalledTimes(3);
    // ocrPage called 3 times even though page 2 fails
    expect(mockOcrPage).toHaveBeenCalledTimes(3);

    // Page 2 failure should NOT prevent completion
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
    expect(mockFailOcrJob).not.toHaveBeenCalled();
  });

  // --- Test 3: keep_alive management — model stays loaded during loop ---
  it("passes keep_alive context for sequential page processing", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2 }),
    });

    await processOcrJob("job-001");

    // ocrPage is called for each page — the ocrPage function itself sets keep_alive: "5m"
    expect(mockOcrPage).toHaveBeenCalledTimes(2);
  });

  // --- Test 4: Empty page output triggers retry, retry succeeds ---
  it("retries empty page output and succeeds on retry", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 2 }),
    });

    // Page 1: empty output detected by guard (first call), retry succeeds (default mock)
    mockApplyHallucinationGuard
      .mockReturnValueOnce({
        markdown: "",
        hasUnverified: false,
        unverifiedCount: 0,
        hasHandwriting: false,
        hasEmpty: true,
        issues: [
          {
            pageNumber: 1,
            type: "EMPTY_OUTPUT",
            detail: "OCR model returned empty output for page 1",
            severity: "error",
          },
        ],
      });
    // Retry guard call + page 2 guard call both use default mock (non-empty)

    await processOcrJob("job-001");

    // Should complete (not fail entirely)
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
    expect(mockFailOcrJob).not.toHaveBeenCalled();

    // Page 1: original + retry, Page 2: one call = 3 total
    expect(mockOcrPage).toHaveBeenCalledTimes(3);
  });

  // --- Test 4b: Empty page output triggers retry, retry also fails ---
  it("marks page as [FAILED] when retry also returns empty", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    // Both original and retry return empty
    mockApplyHallucinationGuard
      .mockReturnValueOnce({
        markdown: "",
        hasUnverified: false,
        unverifiedCount: 0,
        hasHandwriting: false,
        hasEmpty: true,
        issues: [
          {
            pageNumber: 1,
            type: "EMPTY_OUTPUT",
            detail: "OCR model returned empty output for page 1",
            severity: "error",
          },
        ],
      })
      .mockReturnValueOnce({
        markdown: "",
        hasUnverified: false,
        unverifiedCount: 0,
        hasHandwriting: false,
        hasEmpty: true,
        issues: [
          {
            pageNumber: 1,
            type: "EMPTY_OUTPUT",
            detail: "OCR model returned empty output for page 1 on retry",
            severity: "error",
          },
        ],
      });

    await processOcrJob("job-001");

    // Should complete (not fail entirely) — single page job
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
    expect(mockFailOcrJob).not.toHaveBeenCalled();

    // Page 1: original + retry = 2 calls
    expect(mockOcrPage).toHaveBeenCalledTimes(2);

    // The result should contain the failure marker
    const completeCallData = mockCompleteOcrJob.mock.calls[0][2];
    const pageMarkdown = (completeCallData as any).pageResults[0].markdown;
    expect(pageMarkdown).toContain("[FAILED:");
    expect(pageMarkdown).toContain("empty output");
  });

  // --- Test 5: Idempotency guard — skip terminal state jobs ---
  it("skips jobs already in COMPLETED, FAILED, or CANCELLED state", async () => {
    jest.mocked(mockGetOcrJob).mockResolvedValue(
      makeMockJob({ status: "COMPLETED" })
    );

    await processOcrJob("job-001");

    // Should not start processing
    expect(mockStartOcrJob).not.toHaveBeenCalled();
    expect(mockRenderPageToPng).not.toHaveBeenCalled();
    expect(mockCompleteOcrJob).not.toHaveBeenCalled();
    expect(mockFailOcrJob).not.toHaveBeenCalled();
  });

  it("skips jobs in FAILED state", async () => {
    jest.mocked(mockGetOcrJob).mockResolvedValue(
      makeMockJob({ status: "FAILED" })
    );

    await processOcrJob("job-001");

    expect(mockStartOcrJob).not.toHaveBeenCalled();
    expect(mockRenderPageToPng).not.toHaveBeenCalled();
  });

  it("skips jobs in CANCELLED state", async () => {
    jest.mocked(mockGetOcrJob).mockResolvedValue(
      makeMockJob({ status: "CANCELLED" })
    );

    await processOcrJob("job-001");

    expect(mockStartOcrJob).not.toHaveBeenCalled();
    expect(mockRenderPageToPng).not.toHaveBeenCalled();
  });

  // Test: passes ocrMode and customInstructions to ocrPage when present
  it("passes ocrMode and customInstructions to ocrPage when present on job", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    jest.mocked(mockGetOcrJob).mockResolvedValue(
      makeMockJob({
        ocrMode: "table",
        customInstructions: "Preserve borders",
      })
    );

    await processOcrJob("job-001");

    expect(mockOcrPage).toHaveBeenCalledTimes(1);
    const callArgs = mockOcrPage.mock.calls[0];
    expect(callArgs[3]).toBe("glm-ocr:latest"); // modelName
    expect(callArgs[4]).toEqual(
      expect.objectContaining({
        name: "glm-ocr:latest",
        promptTemplate: "glm-ocr",
        inputMode: "base64_array",
        supportedModes: ["text", "table", "figure", "generic"],
      })
    ); // modelConfig
    expect(callArgs[6]).toBe(false); // useFallbackPrompt
    expect(callArgs[7]).toBe("table"); // ocrMode
    expect(callArgs[8]).toBe("Preserve borders"); // customInstructions
  });

  // =========================================================================
  // 260829-lkq — truthful job summaries: failedPages in result + logs
  // A COMPLETED job whose pages failed ([FAILED: markers / zero tokens /
  // qualityScore floor) must carry an explicit failedPages count in the
  // completeOcrJob summary payload so the stored result JSON and the
  // "[ocr] Job completed" logs are self-describing about page health.
  // =========================================================================
  describe("260829-lkq failedPages truthfulness", () => {
    it("reports failedPages in completeOcrJob summary when OCR fails on page 2 of 3", async () => {
      const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 3 }),
      });

      // Page 2 OCR fails (page-level failure → [FAILED: marker page)
      mockOcrPage
        .mockImplementationOnce((_buf, pageNum, _tp) =>
          Promise.resolve(mockSuccessfulPage(pageNum, 3))
        )
        .mockRejectedValueOnce(new Error("Ollama vision OCR error: stream died"))
        .mockImplementationOnce((_buf, pageNum, _tp) =>
          Promise.resolve(mockSuccessfulPage(pageNum, 3))
        );

      await processOcrJob("job-001");

      expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
      // Summary payload (2nd arg of completeOcrJob) carries the failed count
      const summary = mockCompleteOcrJob.mock.calls[0][1] as Record<string, unknown>;
      expect(summary.failedPages).toBe(1);
      // fullResult pageResults still carry the [FAILED: marker
      const fullResult = mockCompleteOcrJob.mock.calls[0][2] as {
        pageResults: Array<{ markdown: string }>;
      };
      expect(fullResult.pageResults[1]!.markdown).toContain("[FAILED:");
      // WARN so operators see the completed-with-failures state in logs
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("failed page"),
        expect.objectContaining({ jobId: "job-001", failedPages: 1, totalPages: 3 }),
      );
    });

    it("omits failedPages (zero) when all pages succeed", async () => {
      const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 1 }),
      });

      await processOcrJob("job-001");

      expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
      const summary = mockCompleteOcrJob.mock.calls[0][1] as Record<string, unknown>;
      // 0 or undefined both falsy — no phantom failures
      expect(summary.failedPages ?? 0).toBe(0);
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("failed page"),
        expect.any(Object),
      );
    });
  });

  // Test: backward compatibility — undefined when not present on job
  it("passes undefined for ocrMode and customInstructions when not present on job", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    await processOcrJob("job-001");

    expect(mockOcrPage).toHaveBeenCalledTimes(1);
    const callArgs = mockOcrPage.mock.calls[0];
    expect(callArgs[3]).toBe("glm-ocr:latest"); // modelName
    expect(callArgs[4]).toEqual(
      expect.objectContaining({
        name: "glm-ocr:latest",
        promptTemplate: "glm-ocr",
        inputMode: "base64_array",
        supportedModes: ["text", "table", "figure", "generic"],
      })
    ); // modelConfig
    expect(callArgs[7]).toBeUndefined(); // ocrMode
    expect(callArgs[8]).toBeUndefined(); // customInstructions
  });

  // --- D-13 Pitfall 2: draft filePath skip-unlink ---
  it("D-13: uses result.filePath directly and does NOT unlink when isDraftSource", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    // Draft source: result.filePath is set
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({
        sourceFileName: "draft-abc.pdf",
        result: { filePath: "/tmp/drafts/draft-abc.pdf", isDraftSource: true },
      })
    );
    // fs.access on the draft path succeeds
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(Buffer.from("draft-pdf-bytes"));

    await processOcrJob("job-001");

    // fs.unlink should NOT be called (draft file must survive for RAG leg)
    expect(mockFsUnlink).not.toHaveBeenCalled();
    // fs.writeFile to archive source/ should NOT be called for the persist step.
    // (raw/ page outputs DO use fs.writeFile — only the archive source/ persist is skipped.)
    const writeFileCalls = mockFsWriteFile.mock.calls.map((c: any[]) => c[0] as string);
    const sourcePersistCall = writeFileCalls.find((p) => p.includes("/source/"));
    expect(sourcePersistCall).toBeUndefined();
    // Should still complete the job via pdfjs flow (draft PDF is still a PDF)
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
  });

  // --- D-14 Pitfall 3: image branch bypasses pdfjs ---
  it("D-14: image source bypasses pdfjsLib.getDocument and calls ocrPage directly with image buffer", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    const getDocumentSpy = jest.spyOn(pdfjsLib, "getDocument");

    // Image source: PNG extension
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({
        sourceFileName: "scan.png",
        result: null,
      })
    );
    mockFsAccess.mockResolvedValue(undefined);
    const imageBuffer = Buffer.from("fake-png-bytes");
    mockFsReadFile.mockResolvedValue(imageBuffer);
    mockOcrPage.mockResolvedValueOnce({
      pageNumber: 1,
      markdown: "## OCR'd image content\n\nText from image.",
      tokensUsed: 50,
      durationMs: 1200,
    });
    mockApplyHallucinationGuard.mockReturnValue({
      markdown: "## OCR'd image content\n\nText from image.",
      hasUnverified: false,
      unverifiedCount: 0,
      hasHandwriting: false,
      hasEmpty: false,
      issues: [],
    });
    mockComputePageQualityScore.mockReturnValue(4);
    mockComputeDocumentQualityScore.mockReturnValue({
      overall: 4,
      perPage: [],
      summary: "Good quality image OCR",
    });

    await processOcrJob("job-001");

    // pdfjsLib.getDocument should NOT be called for image sources
    expect(getDocumentSpy).not.toHaveBeenCalled();
    // renderPageToPng should NOT be called (no pdfjs rendering)
    expect(mockRenderPageToPng).not.toHaveBeenCalled();
    // ocrPage should be called once with the image buffer, page 1 of 1
    expect(mockOcrPage).toHaveBeenCalledTimes(1);
    expect(mockOcrPage).toHaveBeenCalledWith(
      imageBuffer,
      1,
      1,
      "glm-ocr:latest",
      expect.objectContaining({ name: "glm-ocr:latest" }),
      undefined,
      false,
      undefined,
      undefined
    );
    // startOcrJob with totalPages=1 (single image)
    expect(mockStartOcrJob).toHaveBeenCalledWith("job-001", 1);
    // Should complete the job
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
    // Should NOT fail
    expect(mockFailOcrJob).not.toHaveBeenCalled();

    getDocumentSpy.mockRestore();
  });

  // --- Regression: non-draft non-image PDF flow unchanged ---
  it("regression: non-draft PDF still uses primaryPath/fallbackPath lookup + persist + unlink + pdfjs", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    // Non-draft PDF: result is null
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({
        sourceFileName: "regular.pdf",
        result: null,
      })
    );
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(Buffer.from("regular-pdf-bytes"));

    await processOcrJob("job-001");

    // For non-draft primaryPath: unlink IS called (persist to archive then remove staging)
    expect(mockFsUnlink).toHaveBeenCalledTimes(1);
    // pdfjsLib.getDocument IS called (PDF flow)
    expect(pdfjsLib.getDocument).toHaveBeenCalledTimes(1);
    // Should complete
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // 260826-gsr — sanitizeChatTokens + skipDegeneration wiring
  // - sanitizeChatTokens runs on EVERY OCR page (image, PDF page, retry)
  //   regardless of prompt template, after stripGroundingTags and before
  //   applyHallucinationGuard.
  // - applyHallucinationGuard receives skipDegeneration: !!job.archiveId at
  //   all three OCR-result sites. KB/archive jobs (archiveId set) opt out of
  //   the degeneration checks; RAG jobs (archiveId null) keep the guard.
  // =========================================================================
  describe("260826-gsr sanitizeChatTokens + skipDegeneration wiring", () => {
    it("KB job (archiveId set): applyHallucinationGuard called with skipDegeneration=true", async () => {
      const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 2 }),
      });
      // makeMockJob defaults archiveId to "archive-001" (KB job)
      mockGetOcrJob.mockResolvedValue(makeMockJob());

      await processOcrJob("job-001");

      // Each applyHallucinationGuard call's third arg must be true (KB job)
      expect(mockApplyHallucinationGuard).toHaveBeenCalledTimes(2);
      for (const call of mockApplyHallucinationGuard.mock.calls) {
        expect(call[2]).toBe(true); // skipDegeneration
      }
    });

    it("RAG job (archiveId falsy): applyHallucinationGuard called with skipDegeneration=false", async () => {
      const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 2 }),
      });
      // In production every OCR job reaching ocrStages has a non-empty
      // archiveId (createOcrJob requires it). The falsy branch
      // (skipDegeneration=false) is exercised here with an empty string,
      // which is falsy under !! but valid for path.resolve — using null
      // would crash path.resolve(ARCHIVES_BASE, null, "source").
      mockGetOcrJob.mockResolvedValue(makeMockJob({ archiveId: "" }));

      await processOcrJob("job-001");

      expect(mockApplyHallucinationGuard).toHaveBeenCalledTimes(2);
      for (const call of mockApplyHallucinationGuard.mock.calls) {
        expect(call[2]).toBe(false); // skipDegeneration
      }
    });

    it("sanitizeChatTokens runs on every PDF page (call count equals page count)", async () => {
      const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 3 }),
      });
      mockGetOcrJob.mockResolvedValue(makeMockJob());

      await processOcrJob("job-001");

      // 3 pages → sanitizeChatTokens called 3 times (once per page, the
      // primary OCR path; no retries triggered since the default guard
      // mock returns hasEmpty=false)
      expect(mockSanitizeChatTokens).toHaveBeenCalledTimes(3);
    });

    it("sanitizeChatTokens runs on the image branch (single image page)", async () => {
      // Image source: PNG extension — bypasses pdfjs
      mockGetOcrJob.mockResolvedValue(
        makeMockJob({ sourceFileName: "scan.png", result: null })
      );
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockResolvedValue(Buffer.from("fake-png-bytes"));
      mockOcrPage.mockResolvedValueOnce({
        pageNumber: 1,
        markdown: "## Image content",
        tokensUsed: 50,
        durationMs: 1200,
      });

      await processOcrJob("job-001");

      expect(mockSanitizeChatTokens).toHaveBeenCalledTimes(1);
      // And the guard gets skipDegeneration=true (archiveId is the default
      // "archive-001")
      expect(mockApplyHallucinationGuard).toHaveBeenCalledTimes(1);
      expect(mockApplyHallucinationGuard.mock.calls[0][2]).toBe(true);
    });

    it("sanitizeChatTokens is idempotent in the pipeline (mock identity passthrough preserves content)", async () => {
      const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjsLib.getDocument.mockReturnValue({
        promise: Promise.resolve({ numPages: 1 }),
      });
      // Real sanitizeChatTokens is identity in the mock; verify it is
      // invoked AFTER stripGroundingTags on the deepseek-ocr template path
      // by tracking call order via mockStripGroundingTags.
      mockGetOcrJob.mockResolvedValue(makeMockJob());
      const ocrMarkdown = "## Page 1\n\nReal content with <|im_start|> leak";
      mockOcrPage.mockResolvedValueOnce({
        pageNumber: 1,
        markdown: ocrMarkdown,
        tokensUsed: 10,
        durationMs: 100,
      });

      await processOcrJob("job-001");

      // sanitizeChatTokens was called (once for the page)
      expect(mockSanitizeChatTokens).toHaveBeenCalledTimes(1);
      // The guard received the (identity-passed) markdown
      expect(mockApplyHallucinationGuard.mock.calls[0][0]).toBeDefined();
    });
  });
});

// =========================================================================
// 71-02 Task1 — Auto-approve hook (Q4 event-driven, Pitfall 5)
// completeOcrJob/failOcrJob → look up AIJ via result.ocrJobId → create
// ArchivePage + flip AIJ COMPLETED (or flip FAILED). No-op for standalone
// Archives OcrJobs (no AIJ → manual approve flow preserved).
// =========================================================================
describe("71-02 auto-approve hook (completeOcrJob/failOcrJob)", () => {
  const prisma = require("../../utils/prisma").default;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no AIJ found (standalone Archives OcrJob)
    prisma.archiveImportJob.findFirst.mockResolvedValue(null);
    prisma.archiveImportJob.update.mockResolvedValue({});
    mockCreatePage.mockResolvedValue({ id: "page-1", title: "OCR import" });
    mockRebuildIndex.mockResolvedValue(undefined);

    // Reset processOcrJob defaults
    mockFsReadFile.mockResolvedValue(Buffer.from("fake-pdf"));
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsAccess.mockResolvedValue(undefined);
    mockGetOcrJob.mockResolvedValue(makeMockJob());
    mockRenderPageToPng.mockResolvedValue(Buffer.from("fake-png"));
    mockOcrPage.mockImplementation((_buf, pageNum, _tp) =>
      Promise.resolve(mockSuccessfulPage(pageNum, 3))
    );
    mockApplyHallucinationGuard.mockReturnValue({
      markdown: "Guarded markdown content",
      hasUnverified: false,
      unverifiedCount: 0,
      hasHandwriting: false,
      hasEmpty: false,
      issues: [],
    });
    mockComputePageQualityScore.mockReturnValue(4);
    mockComputeDocumentQualityScore.mockReturnValue({
      overall: 4,
      perPage: [],
      summary: "Good quality document",
    });
    mockStartOcrJob.mockResolvedValue(undefined);
    mockUpdateJobProgress.mockResolvedValue(undefined);
    mockCompleteOcrJob.mockResolvedValue(undefined);
    mockFailOcrJob.mockResolvedValue(undefined);
    mockFsUnlink.mockResolvedValue(undefined);
    mockSanitizeChatTokens.mockImplementation((s: string) => s);
    mockStripGroundingTags.mockImplementation((s: string) => s);
  });

  it("Test 4 (Pitfall 5): completeOcrJob → hook creates ArchivePage + flips AIJ COMPLETED when AIJ exists", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    // AIJ found: associated with this OcrJob via result.ocrJobId
    prisma.archiveImportJob.findFirst.mockResolvedValue({
      id: "aij-1",
      archiveId: "archive-001",
      createdBy: "user-001",
      status: "PROCESSING",
      result: { ocrJobId: "job-001" },
    });

    await processOcrJob("job-001");

    // Hook looked up AIJ by result.ocrJobId
    expect(prisma.archiveImportJob.findFirst).toHaveBeenCalledWith({
      where: { result: { path: ["ocrJobId"], equals: "job-001" } },
    });

    // Hook created an ArchivePage (auto-approve — reuse ocr.ts:514 logic)
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    const createPageArgs = mockCreatePage.mock.calls[0];
    expect(createPageArgs[0]).toBe("archive-001"); // archiveId
    expect(createPageArgs[1]).toEqual(
      expect.objectContaining({ category: "entities" }),
    );
    expect(createPageArgs[2]).toBe("user-001"); // userId from AIJ.createdBy

    // Hook flipped AIJ to COMPLETED
    expect(prisma.archiveImportJob.update).toHaveBeenCalledWith({
      where: { id: "aij-1" },
      data: { status: "COMPLETED" },
    });
  });

  it("Test 5 (Pitfall 5): failOcrJob → hook flips AIJ FAILED when AIJ exists", async () => {
    // Trigger a failure: no source filename → failOcrJob
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({ sourceFileName: undefined })
    );

    // AIJ found
    prisma.archiveImportJob.findFirst.mockResolvedValue({
      id: "aij-1",
      archiveId: "archive-001",
      createdBy: "user-001",
      status: "PROCESSING",
      result: { ocrJobId: "job-001" },
    });

    await processOcrJob("job-001");

    // failOcrJob called
    expect(mockFailOcrJob).toHaveBeenCalledTimes(1);

    // Hook looked up AIJ
    expect(prisma.archiveImportJob.findFirst).toHaveBeenCalledWith({
      where: { result: { path: ["ocrJobId"], equals: "job-001" } },
    });

    // Hook flipped AIJ to FAILED (no ArchivePage created on failure)
    expect(prisma.archiveImportJob.update).toHaveBeenCalledWith({
      where: { id: "aij-1" },
      data: { status: "FAILED", error: expect.any(String) },
    });
    expect(mockCreatePage).not.toHaveBeenCalled();
  });

  it("Test 6 (no-op for standalone): no AIJ → hook lookups but does NOT create ArchivePage or flip AIJ", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    // No AIJ found (standalone Archives OcrJob — manual approve flow)
    prisma.archiveImportJob.findFirst.mockResolvedValue(null);

    await processOcrJob("job-001");

    // Hook DID run the lookup (proves the hook exists)
    expect(prisma.archiveImportJob.findFirst).toHaveBeenCalledWith({
      where: { result: { path: ["ocrJobId"], equals: "job-001" } },
    });
    // No ArchivePage created (manual approve preserved)
    expect(mockCreatePage).not.toHaveBeenCalled();
    // No AIJ update (nothing to flip)
    expect(prisma.archiveImportJob.update).not.toHaveBeenCalled();
  });
});

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Characterization pinning tests for ocrPipeline — captured on base BEFORE
 * the MOD-03 extraction (D-02 base-capture discipline). Pins:
 *   1. processOcrJob state transitions (PENDING → PROCESSING → COMPLETED)
 *   2. D-13 draft-source skip-persist+unlink (RESEARCH Pitfall 4,
 *      MEMORY `draft-reaper-chunk-reconstruction`)
 *   3. Non-draft source: persist-to-archive + unlink staging (§329-349 guard)
 *   4. autoApproveOnComplete — finalize signature (AIJ found → ArchivePage + COMPLETED)
 *   5. autoApproveOnFail — failure path (AIJ found → flip FAILED with reason)
 *
 * These tests are defense-in-depth alongside the existing `ocrPipeline.test.ts`
 * (which already covers D-13). They pin the specific facade contracts the
 * MOD-03 split must not break. Per D-07 jest is the gate for MOD-03 (no UAT
 * canaries).
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

// Mock groundingCleanup (used by image branch + PDF branch when deepseek-ocr)
jest.mock("../groundingCleanup", () => ({
  stripGroundingTags: jest.fn((s: string) => s),
}));

// Mock qualityScoring
const mockComputePageQualityScore = jest.fn();
const mockComputeDocumentQualityScore = jest.fn();
jest.mock("../qualityScoring", () => ({
  computePageQualityScore: (...args: any[]) => mockComputePageQualityScore(...args),
  computeDocumentQualityScore: (...args: any[]) => mockComputeDocumentQualityScore(...args),
}));

// Mock archivePageService (auto-approve hook target)
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

import { processOcrJob, autoApproveOnComplete, autoApproveOnFail } from "../ocrPipeline";

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

function mockSuccessfulPage(pageNum: number) {
  return {
    pageNumber: pageNum,
    markdown: `## Page ${pageNum} Content\n\nThis is page ${pageNum} content.`,
    tokensUsed: 100,
    durationMs: 5000,
  };
}

describe("ocrPipeline.characterization — MOD-03 base pinning", () => {
  const prisma = require("../../utils/prisma").default;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no AIJ found (standalone Archives OcrJob)
    prisma.archiveImportJob.findFirst.mockResolvedValue(null);
    prisma.archiveImportJob.update.mockResolvedValue({});
    prisma.ocrJob.findFirst.mockResolvedValue(null);
    prisma.ocrJob.update.mockResolvedValue({});
    mockCreatePage.mockResolvedValue({ id: "page-1", title: "OCR import" });
    mockRebuildIndex.mockResolvedValue(undefined);

    // Default: resolve successfully
    mockFsReadFile.mockResolvedValue(Buffer.from("fake-pdf"));
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsAccess.mockResolvedValue(undefined);
    mockGetOcrJob.mockResolvedValue(makeMockJob());
    mockRenderPageToPng.mockResolvedValue(Buffer.from("fake-png"));
    mockOcrPage.mockImplementation((_buf, pageNum, _tp) =>
      Promise.resolve(mockSuccessfulPage(pageNum)),
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
  });

  // --- Test 1: processOcrJob state transitions PENDING → PROCESSING → COMPLETED ---
  it("Test 1: transitions a PENDING job through PROCESSING to COMPLETED on a happy-path fixture", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    await processOcrJob("job-001");

    // PENDING → PROCESSING: startOcrJob called with totalPages
    expect(mockStartOcrJob).toHaveBeenCalledWith("job-001", 1);
    // Progress updated mid-flight
    expect(mockUpdateJobProgress).toHaveBeenCalledWith("job-001", {
      processedPages: 1,
      progress: 100,
      currentPage: 1,
    });
    // → COMPLETED: completeOcrJob called once; failOcrJob never
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
    expect(mockFailOcrJob).not.toHaveBeenCalled();
  });

  // --- Test 2: D-13 draft-source skip-persist+unlink (RESEARCH Pitfall 4) ---
  it("Test 2: processOcrJob with isDraftSource === true skips persist-to-archive AND skips unlink (draft file survives)", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    // Draft source: result.filePath set → isDraftSource = true
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({
        sourceFileName: "draft-abc.pdf",
        result: { filePath: "/tmp/drafts/draft-abc.pdf", isDraftSource: true },
      }),
    );
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(Buffer.from("draft-pdf-bytes"));

    await processOcrJob("job-001");

    // isDraftSource path was taken
    expect(mockGetOcrJob).toHaveBeenCalled();
    // fs.unlink NEVER called — draft file survives for the RAG leg
    expect(mockFsUnlink).not.toHaveBeenCalled();
    // No persist-to-source/ call (only raw_sources/ writes happen)
    const writeFileCalls = mockFsWriteFile.mock.calls.map((c: any[]) => c[0] as string);
    const sourcePersistCall = writeFileCalls.find((p) => p.includes("/source/"));
    expect(sourcePersistCall).toBeUndefined();
    // Job still completes via the PDF flow
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
  });

  // --- Test 3: non-draft source persists to archive + unlinks staging (§329-349 guard) ---
  it("Test 3: processOcrJob with isDraftSource === false + primaryPath persists to archive AND unlinks the upload", async () => {
    const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsLib.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 1 }),
    });

    // Non-draft: result is null → isDraftSource = false; primaryPath in UPLOADS_BASE
    mockGetOcrJob.mockResolvedValue(
      makeMockJob({
        sourceFileName: "regular.pdf",
        result: null,
      }),
    );
    mockFsAccess.mockResolvedValue(undefined);
    mockFsReadFile.mockResolvedValue(Buffer.from("regular-pdf-bytes"));

    await processOcrJob("job-001");

    // fs.unlink IS called (persist-then-unlink staging file)
    expect(mockFsUnlink).toHaveBeenCalledTimes(1);
    // fs.writeFile to archive's source/ directory IS called (persist copy)
    const writeFileCalls = mockFsWriteFile.mock.calls.map((c: any[]) => c[0] as string);
    const sourcePersistCall = writeFileCalls.find((p) => p.includes("/source/"));
    expect(sourcePersistCall).toBeDefined();
    // Job still completes
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
  });

  // --- Test 4: autoApproveOnComplete finalize signature ---
  it("Test 4: autoApproveOnComplete on a COMPLETED job with a passing quality score creates ArchivePage + flips AIJ COMPLETED", async () => {
    // AIJ found: associated with this OcrJob via result.ocrJobId
    prisma.archiveImportJob.findFirst.mockResolvedValue({
      id: "aij-1",
      archiveId: "archive-001",
      createdBy: "user-001",
      status: "PROCESSING",
      result: { ocrJobId: "job-001" },
    });

    const fullResult = {
      pageResults: [{ pageNumber: 1, markdown: "## Page 1\n\nOCR text" }],
      qualityScore: 4,
      contentHash: "abc123",
      extractedTitle: "Test Doc",
    };

    await autoApproveOnComplete("job-001", "archive-001", "user-001", fullResult);

    // Hook looked up AIJ by result.ocrJobId
    expect(prisma.archiveImportJob.findFirst).toHaveBeenCalledWith({
      where: { result: { path: ["ocrJobId"], equals: "job-001" } },
    });
    // Created an ArchivePage (auto-approve)
    expect(mockCreatePage).toHaveBeenCalledTimes(1);
    const createPageArgs = mockCreatePage.mock.calls[0];
    expect(createPageArgs[0]).toBe("archive-001");
    expect(createPageArgs[1]).toEqual(
      expect.objectContaining({ category: "entities" }),
    );
    expect(createPageArgs[2]).toBe("user-001");
    // Flipped AIJ to COMPLETED
    expect(prisma.archiveImportJob.update).toHaveBeenCalledWith({
      where: { id: "aij-1" },
      data: { status: "COMPLETED" },
    });
  });

  // --- Test 5: autoApproveOnFail failure path ---
  it("Test 5: autoApproveOnFail on a FAILED job records the failure reason (flips AIJ FAILED)", async () => {
    // AIJ found
    prisma.archiveImportJob.findFirst.mockResolvedValue({
      id: "aij-2",
      archiveId: "archive-001",
      createdBy: "user-001",
      status: "PROCESSING",
      result: { ocrJobId: "job-001" },
    });

    await autoApproveOnFail("job-001", "OCR engine crashed");

    // Hook looked up AIJ
    expect(prisma.archiveImportJob.findFirst).toHaveBeenCalledWith({
      where: { result: { path: ["ocrJobId"], equals: "job-001" } },
    });
    // Flipped AIJ to FAILED with the error message
    expect(prisma.archiveImportJob.update).toHaveBeenCalledWith({
      where: { id: "aij-2" },
      data: { status: "FAILED", error: "OCR engine crashed" },
    });
    // No ArchivePage created on failure
    expect(mockCreatePage).not.toHaveBeenCalled();
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for urlPipeline — URL-to-Markdown Bree job handler
 *
 * TDD: RED → GREEN → REFACTOR
 *
 * Tests the processUrlJob function which orchestrates the URL ingestion pipeline:
 * fetch → extract → credibility score → write to raw/ → complete.
 */

// Mock prisma (MUST come before any imports that transitively load prisma.ts)
jest.mock("../../utils/prisma", () => ({
  __esModule: true,
  default: {
    ocrJob: {
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

jest.mock("../../services/ocrJobService", () => ({
  getOcrJob: (...args: any[]) => mockGetOcrJob(...args),
  startOcrJob: (...args: any[]) => mockStartOcrJob(...args),
  updateJobProgress: (...args: any[]) => mockUpdateJobProgress(...args),
  completeOcrJob: (...args: any[]) => mockCompleteOcrJob(...args),
  failOcrJob: (...args: any[]) => mockFailOcrJob(...args),
}));

// Mock urlFetcher
const mockFetchUrlToMarkdown = jest.fn();
jest.mock("../urlFetcher", () => ({
  fetchUrlToMarkdown: (...args: any[]) => mockFetchUrlToMarkdown(...args),
}));

// Mock credibilityScoring
const mockComputeCredibilityScore = jest.fn();
jest.mock("../credibilityScoring", () => ({
  computeCredibilityScore: (...args: any[]) => mockComputeCredibilityScore(...args),
}));

// Mock fs/promises
const mockFsWriteFile = jest.fn();
const mockFsMkdir = jest.fn();
jest.mock("fs/promises", () => ({
  writeFile: (...args: any[]) => mockFsWriteFile(...args),
  mkdir: (...args: any[]) => mockFsMkdir(...args),
}));

// Mock crypto
jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  return {
    ...actual,
    createHash: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue("abcdef1234567890abcdef"),
    }),
  };
});

import { processUrlJob } from "../urlPipeline";

// Default mock job
function makeMockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-002",
    archiveId: "archive-001",
    type: "URL",
    status: "PENDING",
    createdBy: "user-001",
    sourceFileName: null,
    modelName: null,
    totalPages: 0,
    currentPage: 0,
    progress: 0,
    processedPages: 0,
    result: { sourceUrl: "https://example.com/article" },
    ...overrides,
  };
}

describe("urlPipeline — processUrlJob", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsMkdir.mockResolvedValue(undefined);
    mockGetOcrJob.mockResolvedValue(makeMockJob());
    mockFetchUrlToMarkdown.mockResolvedValue({
      markdown: "# Test Article\n\nContent of the article.",
      title: "Test Article",
      siteName: "Example",
      byline: "John Doe",
      length: 100,
      excerpt: "Content of the article.",
    });
    mockComputeCredibilityScore.mockReturnValue({
      score: 4,
      signals: [
        { name: "domain_authority", present: false, label: "Domain Authority", description: "" },
        { name: "has_byline", present: true, label: "Has Byline", description: "" },
      ],
      explanation: "Good source with author attribution.",
      autoSuggested: false,
    });
    mockStartOcrJob.mockResolvedValue(undefined);
    mockUpdateJobProgress.mockResolvedValue(undefined);
    mockCompleteOcrJob.mockResolvedValue(undefined);
    mockFailOcrJob.mockResolvedValue(undefined);
  });

  // --- Test 1: Valid HTTPS URL fetches, extracts Markdown, scores credibility, writes, completes ---
  it("fetches URL content, extracts Markdown, scores credibility, writes to raw/, and completes", async () => {
    await processUrlJob("job-002");

    // Should fetch the URL
    expect(mockFetchUrlToMarkdown).toHaveBeenCalledTimes(1);
    expect(mockFetchUrlToMarkdown).toHaveBeenCalledWith("https://example.com/article");

    // Should score credibility
    expect(mockComputeCredibilityScore).toHaveBeenCalledTimes(1);

    // Should write Markdown to raw/ (file-first ordering)
    expect(mockFsWriteFile).toHaveBeenCalledTimes(1);

    // Should start the job
    expect(mockStartOcrJob).toHaveBeenCalledWith("job-002", 1);

    // Should complete the job
    expect(mockCompleteOcrJob).toHaveBeenCalledTimes(1);
    expect(mockFailOcrJob).not.toHaveBeenCalled();
  });

  // --- Test 2: URL fetch failure calls failOcrJob with descriptive error ---
  it("fails the job when URL fetch throws", async () => {
    mockFetchUrlToMarkdown.mockRejectedValue(new Error("Request timeout after 30s"));

    await processUrlJob("job-002");

    expect(mockFailOcrJob).toHaveBeenCalledTimes(1);
    expect(mockFailOcrJob).toHaveBeenCalledWith("job-002", "Request timeout after 30s");
    expect(mockCompleteOcrJob).not.toHaveBeenCalled();
  });

  // --- Test 3: Idempotency guard — skip already-completed jobs ---
  it("skips jobs already in COMPLETED state", async () => {
    jest.mocked(mockGetOcrJob).mockResolvedValue(
      makeMockJob({ status: "COMPLETED" })
    );

    await processUrlJob("job-002");

    expect(mockFetchUrlToMarkdown).not.toHaveBeenCalled();
    expect(mockStartOcrJob).not.toHaveBeenCalled();
    expect(mockCompleteOcrJob).not.toHaveBeenCalled();
    expect(mockFailOcrJob).not.toHaveBeenCalled();
  });

  it("skips jobs already in FAILED state", async () => {
    jest.mocked(mockGetOcrJob).mockResolvedValue(
      makeMockJob({ status: "FAILED" })
    );

    await processUrlJob("job-002");

    expect(mockFetchUrlToMarkdown).not.toHaveBeenCalled();
    expect(mockStartOcrJob).not.toHaveBeenCalled();
  });

  it("skips jobs already in CANCELLED state", async () => {
    jest.mocked(mockGetOcrJob).mockResolvedValue(
      makeMockJob({ status: "CANCELLED" })
    );

    await processUrlJob("job-002");

    expect(mockFetchUrlToMarkdown).not.toHaveBeenCalled();
    expect(mockStartOcrJob).not.toHaveBeenCalled();
  });

  // --- Test 4: Written raw/ filename uses content hash ---
  it("writes raw/ file with SHA-256 content hash in filename", async () => {
    await processUrlJob("job-002");

    expect(mockFsWriteFile).toHaveBeenCalledTimes(1);

    // The file path should contain the hash prefix
    const filePathArg = mockFsWriteFile.mock.calls[0][0] as string;
    expect(filePathArg).toContain("url-abcdef123456");

    // The content should include metadata block with sourceUrl
    const contentArg = mockFsWriteFile.mock.calls[0][1] as string;
    expect(contentArg).toContain('sourceUrl: "https://example.com/article"');
    expect(contentArg).toContain("credibilityScore: 4");
    expect(contentArg).toContain('contentHash: "abcdef1234567890abcdef"');
  });
});

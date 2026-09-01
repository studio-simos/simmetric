// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck — Prisma 7 + TS 6 circular type references in mock setup
// Mock prisma and eventLogService before importing the service
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    ocrJob: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import {
  createOcrJob,
  startOcrJob,
  updateJobProgress,
  completeOcrJob,
  failOcrJob,
  getOcrJob,
  getOcrJobsByArchive,
  resetStaleJobs,
  getActiveJobCount,
  getNextPendingJob,
} from "../services/ocrJobService";

const mockOcrJob = prisma.ocrJob as unknown as jest.Mocked<typeof prisma.ocrJob>;

describe("ocrJobService", () => {
  const archiveId = "archive-123";
  const userId = "user-456";
  const jobId = "job-789";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createOcrJob", () => {
    it("should create a pending OCR job in the database", async () => {
      const createdJob = {
        id: jobId,
        archiveId,
        type: "OCR",
        status: "PENDING",
        progress: 0,
        totalPages: null,
        processedPages: 0,
        currentPage: null,
        modelName: "glm-ocr",
        sourceFileName: "document.pdf",
        contentHash: null,
        result: null,
        error: null,
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockOcrJob.create.mockResolvedValueOnce(createdJob as any);

      const result = await createOcrJob(archiveId, "OCR", userId, "document.pdf", "glm-ocr");

      expect(mockOcrJob.create).toHaveBeenCalledTimes(1);
      expect(mockOcrJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            archiveId,
            type: "OCR",
            status: "PENDING",
            createdBy: userId,
            sourceFileName: "document.pdf",
            modelName: "glm-ocr",
          }),
        })
      );

      expect(result).toEqual(createdJob);

      // Should fire event log asynchronously
      expect(logEvent).toHaveBeenCalledWith(
        "ocr_job",
        jobId,
        "job.created",
        userId,
        expect.objectContaining({ archiveId, type: "OCR" })
      );
    });

    it("should create a URL job with sourceUrl in result JSON", async () => {
      const createdJob = {
        id: jobId,
        archiveId,
        type: "URL",
        status: "PENDING",
        progress: 0,
        totalPages: null,
        processedPages: 0,
        currentPage: null,
        modelName: null,
        sourceFileName: null,
        contentHash: null,
        result: { sourceUrl: "https://example.com" },
        error: null,
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockOcrJob.create.mockResolvedValueOnce(createdJob as any);

      const result = await createOcrJob(
        archiveId,
        "URL",
        userId,
        undefined,
        undefined,
        "https://example.com"
      );

      expect(mockOcrJob.create).toHaveBeenCalledTimes(1);
      expect(mockOcrJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "URL",
            result: { sourceUrl: "https://example.com" },
          }),
        })
      );

      expect(result).toEqual(createdJob);
    });

    it("should create an OCR job with ocrMode and customInstructions", async () => {
      const createdJob = {
        id: jobId,
        archiveId,
        type: "OCR",
        status: "PENDING",
        progress: 0,
        totalPages: null,
        processedPages: 0,
        currentPage: null,
        modelName: "deepseek-ocr",
        ocrMode: "table",
        customInstructions: "Preserve borders",
        sourceFileName: "table.pdf",
        contentHash: null,
        result: null,
        error: null,
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockOcrJob.create.mockResolvedValueOnce(createdJob as any);

      const result = await createOcrJob(
        archiveId,
        "OCR",
        userId,
        "table.pdf",
        "deepseek-ocr",
        undefined,
        "table",
        "Preserve borders"
      );

      expect(mockOcrJob.create).toHaveBeenCalledTimes(1);
      expect(mockOcrJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            archiveId,
            type: "OCR",
            status: "PENDING",
            createdBy: userId,
            sourceFileName: "table.pdf",
            modelName: "deepseek-ocr",
            ocrMode: "table",
            customInstructions: "Preserve borders",
          }),
        })
      );

      expect(result).toEqual(createdJob);
    });

    // D-13: createOcrJob accepts an optional draft filePath (9th additive param)
    // and persists it in the OcrJob.result JSON with isDraftSource=true.
    it("D-13: persists result.filePath + isDraftSource when filePath provided", async () => {
      const createdJob = {
        id: jobId,
        archiveId,
        type: "OCR",
        status: "PENDING",
        sourceFileName: "draft.pdf",
        result: { filePath: "/tmp/drafts/abc.pdf", isDraftSource: true },
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockOcrJob.create.mockResolvedValueOnce(createdJob as any);

      await createOcrJob(
        archiveId,
        "OCR",
        userId,
        "draft.pdf",
        "glm-ocr",
        undefined,
        undefined,
        undefined,
        "/tmp/drafts/abc.pdf"
      );

      expect(mockOcrJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            result: { filePath: "/tmp/drafts/abc.pdf", isDraftSource: true },
          }),
        })
      );
    });

    it("D-13: does NOT set result.filePath or isDraftSource when filePath undefined (additive, no regression)", async () => {
      const createdJob = {
        id: jobId,
        archiveId,
        type: "OCR",
        status: "PENDING",
        sourceFileName: "document.pdf",
        result: null,
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockOcrJob.create.mockResolvedValueOnce(createdJob as any);

      await createOcrJob(archiveId, "OCR", userId, "document.pdf", "glm-ocr");

      const callArgs = mockOcrJob.create.mock.calls[0][0] as any;
      expect(callArgs.data.result).toBeUndefined();
    });

    it("D-13: type=URL + sourceUrl + filePath merges both into result (not overwrite)", async () => {
      const createdJob = {
        id: jobId,
        archiveId,
        type: "URL",
        status: "PENDING",
        result: {
          sourceUrl: "https://example.com",
          filePath: "/tmp/drafts/url-draft.pdf",
          isDraftSource: true,
        },
        createdBy: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockOcrJob.create.mockResolvedValueOnce(createdJob as any);

      await createOcrJob(
        archiveId,
        "URL",
        userId,
        undefined,
        undefined,
        "https://example.com",
        undefined,
        undefined,
        "/tmp/drafts/url-draft.pdf"
      );

      expect(mockOcrJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            result: {
              sourceUrl: "https://example.com",
              filePath: "/tmp/drafts/url-draft.pdf",
              isDraftSource: true,
            },
          }),
        })
      );
    });
  });

  describe("startOcrJob", () => {
    it("should set status to PROCESSING with totalPages", async () => {
      mockOcrJob.update.mockResolvedValueOnce({} as any);

      await startOcrJob(jobId, 10);

      expect(mockOcrJob.update).toHaveBeenCalledWith({
        where: { id: jobId },
        data: {
          status: "PROCESSING",
          totalPages: 10,
          currentPage: 1,
          progress: 0,
        },
      });
    });
  });

  describe("updateJobProgress", () => {
    it("should update progress fields in database", async () => {
      mockOcrJob.update.mockResolvedValueOnce({} as any);

      await updateJobProgress(jobId, {
        processedPages: 3,
        progress: 30,
        currentPage: 3,
      });

      expect(mockOcrJob.update).toHaveBeenCalledWith({
        where: { id: jobId },
        data: {
          processedPages: 3,
          progress: 30,
          currentPage: 3,
        },
      });
    });

    it("should clamp progress to 0-100 range", async () => {
      mockOcrJob.update.mockResolvedValueOnce({} as any);

      await updateJobProgress(jobId, {
        processedPages: 5,
        progress: 150,
        currentPage: 5,
      });

      expect(mockOcrJob.update).toHaveBeenCalledWith({
        where: { id: jobId },
        data: {
          processedPages: 5,
          progress: 100,
          currentPage: 5,
        },
      });
    });
  });

  describe("completeOcrJob", () => {
    it("should set status to COMPLETED with result JSON", async () => {
      mockOcrJob.update.mockResolvedValueOnce({} as any);

      const result = {
        totalPages: 10,
        qualityScore: 4,
        totalTokens: 5000,
        totalDurationMs: 30000,
        hasUnverified: false,
      };

      await completeOcrJob(jobId, result);

      expect(mockOcrJob.update).toHaveBeenCalledWith({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          progress: 100,
          result: result as any,
          processedPages: 10,
        },
      });
    });
  });

  describe("failOcrJob", () => {
    it("should set status to FAILED with error message", async () => {
      mockOcrJob.update.mockResolvedValueOnce({} as any);

      await failOcrJob(jobId, "OCR processing failed: invalid PDF");

      expect(mockOcrJob.update).toHaveBeenCalledWith({
        where: { id: jobId },
        data: {
          status: "FAILED",
          error: "OCR processing failed: invalid PDF",
        },
      });
    });
  });

  describe("getOcrJob", () => {
    it("should retrieve a job by ID", async () => {
      const job = { id: jobId, archiveId, status: "PENDING" };
      mockOcrJob.findUnique.mockResolvedValueOnce(job as any);

      const result = await getOcrJob(jobId);

      expect(mockOcrJob.findUnique).toHaveBeenCalledWith({
        where: { id: jobId },
      });
      expect(result).toEqual(job);
    });

    it("should return null for non-existent job", async () => {
      mockOcrJob.findUnique.mockResolvedValueOnce(null);

      const result = await getOcrJob("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("getOcrJobsByArchive", () => {
    it("should return jobs for an archive ordered by createdAt desc", async () => {
      const jobs = [
        { id: "job-2", archiveId, createdAt: new Date("2024-02-01") },
        { id: "job-1", archiveId, createdAt: new Date("2024-01-01") },
      ];
      mockOcrJob.findMany.mockResolvedValueOnce(jobs as any);

      const result = await getOcrJobsByArchive(archiveId);

      expect(mockOcrJob.findMany).toHaveBeenCalledWith({
        where: { archiveId },
        orderBy: { createdAt: "desc" },
      });
      expect(result).toEqual(jobs);
    });
  });

  describe("resetStaleJobs", () => {
    it("should reset PROCESSING jobs older than 5 minutes to PENDING", async () => {
      mockOcrJob.updateMany.mockResolvedValueOnce({ count: 3 } as any);

      const count = await resetStaleJobs();

      expect(count).toBe(3);
      expect(mockOcrJob.updateMany).toHaveBeenCalledWith({
        where: {
          status: "PROCESSING",
          updatedAt: { lt: expect.any(Date) },
        },
        data: { status: "PENDING" },
      });
    });

    it("should return 0 when no stale jobs exist", async () => {
      mockOcrJob.updateMany.mockResolvedValueOnce({ count: 0 } as any);

      const count = await resetStaleJobs();

      expect(count).toBe(0);
    });
  });

  describe("getActiveJobCount", () => {
    it("should count only PROCESSING jobs (PENDING is queued, not active)", async () => {
      mockOcrJob.count.mockResolvedValueOnce(5);

      const count = await getActiveJobCount();

      expect(mockOcrJob.count).toHaveBeenCalledWith({
        where: {
          status: "PROCESSING",
        },
      });
      expect(count).toBe(5);
    });
  });

  describe("getNextPendingJob", () => {
    it("should return the oldest PENDING job", async () => {
      const job = {
        id: "oldest-job",
        archiveId,
        status: "PENDING",
        createdAt: new Date("2024-01-01"),
      };
      mockOcrJob.findFirst.mockResolvedValueOnce(job as any);

      const result = await getNextPendingJob();

      expect(mockOcrJob.findFirst).toHaveBeenCalledWith({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
      });
      expect(result).toEqual(job);
    });

    it("should return null when no pending jobs", async () => {
      mockOcrJob.findFirst.mockResolvedValueOnce(null);

      const result = await getNextPendingJob();

      expect(result).toBeNull();
    });
  });
});

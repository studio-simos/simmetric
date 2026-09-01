// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "./eventLogService";
import fs from "fs/promises";
import path from "path";

// ---------------------------------------------------------------------------
// Result shape helpers — reduces `as any` proliferation on Prisma JsonValue
// ---------------------------------------------------------------------------

export interface OcrJobResultData {
  qualityScore?: number;
  totalTokens?: number;
  totalDurationMs?: number;
  hasUnverified?: boolean;
  /** 260829-lkq: count of pages whose markdown carries a [FAILED: marker */
  failedPages?: number;
  sourceUrl?: string;
  contentHash?: string;
  // D-13: draft filePath for unified-upload KB leg (set by createOcrJob)
  filePath?: string;
  isDraftSource?: boolean;
  // D-14: optional mimeType hint for image branch detection in processOcrJob
  mimeType?: string;
  pageResults?: Array<{
    pageNumber: number;
    markdown: string;
    imagePath?: string;
    tokensUsed: number;
    durationMs: number;
  }>;
  qualityScoreDetail?: { overall: number; breakdown: string };
  credibilityScore?: { score: number; explanation: string; signals?: Record<string, boolean> };
  extractedTitle?: string;
  originalFileName?: string;
  siteName?: string | null;
  fileName?: string;
  approved?: boolean;
  approvedAt?: string;
  approvedBy?: string;
  rejected?: boolean;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string | null;
  userCorrectedScore?: number;
}

/**
 * Safely parse an OcrJob.result JSON column into a typed object.
 */
export function parseOcrJobResult(
  result: unknown
): OcrJobResultData {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }
  return result as OcrJobResultData;
}

/**
 * Create a new OcrJob in PENDING status.
 *
 * @param archiveId - Target archive ID
 * @param type - Job type: "OCR" or "URL"
 * @param userId - Creator user ID
 * @param sourceFileName - Optional source filename (for OCR jobs)
 * @param modelName - Optional model name (for OCR jobs)
 * @param sourceUrl - Optional source URL (for URL jobs, stored in result JSON)
 * @param ocrMode - Optional OCR mode (text, table, figure, generic)
 * @param customInstructions - Optional custom instructions for the OCR job
 * @param filePath - Optional draft filePath (D-13, unified-upload KB leg).
 *   When provided, the pipeline reads the file from this path directly and
 *   skips fs.unlink (Pitfall 2 — the draft file must survive for the RAG leg
 *   of a "both" fan-out). Persisted in result JSON as { filePath, isDraftSource: true }.
 */
export async function createOcrJob(
  archiveId: string,
  type: "OCR" | "URL",
  userId: string,
  sourceFileName?: string,
  modelName?: string,
  sourceUrl?: string,
  ocrMode?: string,
  customInstructions?: string,
  filePath?: string,
) {
  // D-08: UncheckedCreateInput accepts the scalar FKs (archiveId, createdBy)
  // directly, matching the existing object-literal shape. The checked
  // OcrJobCreateInput requires relation connects (`archive: { connect }`),
  // which would force a structural rewrite — out of scope for this type-only
  // refactor. The `result` sub-field is JSON, narrowed via InputJsonValue.
  const data: Prisma.OcrJobUncheckedCreateInput = {
    archiveId,
    type,
    status: "PENDING",
    createdBy: userId,
    sourceFileName,
    modelName,
    ocrMode,
    customInstructions,
  };

  // Build result JSON: merge sourceUrl (URL jobs) and filePath (draft sources).
  // Spread existing keys first so filePath/isDraftSource do NOT overwrite sourceUrl.
  const result: Record<string, unknown> = {};
  if (type === "URL" && sourceUrl) {
    result.sourceUrl = sourceUrl;
  }
  if (filePath) {
    result.filePath = filePath;
    result.isDraftSource = true;
  }
  if (Object.keys(result).length > 0) {
    // D-08: `result` is a plain Record<string, unknown>; the OcrJob.result
    // column is Prisma.JsonValue (InputJsonValue at write time). The
    // accumulated object literal is JSON-serializable by construction
    // (string + boolean values only), so the narrowing cast is honest.
    data.result = result as Prisma.InputJsonValue;
  }

  const job = await prisma.ocrJob.create({ data });

  // Fire-and-forget event log
  logEvent("ocr_job", job.id, "job.created", userId, {
    archiveId,
    type,
  }).catch((err: Error) => {
    logger.error("[ocr] Failed to log job creation event", {
      jobId: job.id,
      error: err.message,
    });
  });

  return job;
}

/**
 * Start an OcrJob — sets status to PROCESSING.
 *
 * @param jobId - Job ID to start
 * @param totalPages - Total number of pages to process
 */
export async function startOcrJob(jobId: string, totalPages: number) {
  await prisma.ocrJob.update({
    where: { id: jobId },
    data: {
      status: "PROCESSING",
      totalPages,
      currentPage: 1,
      progress: 0,
    },
  });

  logger.info("[ocr] Job started", { jobId, totalPages });
}

/**
 * Update job progress during processing.
 * Progress is clamped to 0-100 range.
 *
 * @param jobId - Job ID to update
 * @param data - Progress data: processedPages, progress (0-100), currentPage
 */
export async function updateJobProgress(
  jobId: string,
  data: { processedPages: number; progress: number; currentPage: number }
) {
  const clampedProgress = Math.max(0, Math.min(100, data.progress));

  await prisma.ocrJob.update({
    where: { id: jobId },
    data: {
      processedPages: data.processedPages,
      progress: clampedProgress,
      currentPage: data.currentPage,
    },
  });
}

/**
 * Complete an OcrJob — sets status to COMPLETED with final result.
 *
 * @param jobId - Job ID to complete
 * @param result - Final result metadata
 */
export async function completeOcrJob(
  jobId: string,
  result: {
    totalPages?: number;
    qualityScore?: number;
    totalTokens?: number;
    totalDurationMs?: number;
    hasUnverified?: boolean;
    /** 260829-lkq: pages that ended with a [FAILED: marker (truthful summaries) */
    failedPages?: number;
  },
  fullResult?: Record<string, unknown>
) {
  const resultToStore = (fullResult ?? result) as Prisma.InputJsonValue;
  await prisma.ocrJob.update({
    where: { id: jobId },
    data: {
      status: "COMPLETED",
      progress: 100,
      result: resultToStore,
      processedPages: result.totalPages,
    },
  });

  // Fire-and-forget event log
  logEvent("ocr_job", jobId, "job.completed", null, {
    ...result,
  }).catch((err: Error) => {
    logger.error("[ocr] Failed to log job completion event", {
      jobId,
      error: err.message,
    });
  });

  logger.info("[ocr] Job completed", { jobId, ...result });
}

/**
 * Fail an OcrJob — sets status to FAILED with error message.
 * Error message is sanitized: no stack traces.
 *
 * @param jobId - Job ID to fail
 * @param errorMessage - Human-readable error description
 */
export async function failOcrJob(jobId: string, errorMessage: string) {
  await prisma.ocrJob.update({
    where: { id: jobId },
    data: {
      status: "FAILED",
      error: errorMessage,
    },
  });

  logger.error("[ocr] Job failed", { jobId, error: errorMessage });
}

/**
 * Get a single OcrJob by ID.
 *
 * @param jobId - Job ID to retrieve
 * @returns OcrJob or null if not found
 */
export async function getOcrJob(jobId: string) {
  return prisma.ocrJob.findUnique({ where: { id: jobId } });
}

/**
 * Get all OcrJobs for an archive, ordered by creation date descending.
 *
 * @param archiveId - Archive ID to query
 */
export async function getOcrJobsByArchive(archiveId: string) {
  return prisma.ocrJob.findMany({
    where: { archiveId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Delete an OcrJob by ID, verifying it belongs to the specified archive.
 * Hard-deletes the job record (OCR jobs are transient, not soft-deleted).
 *
 * @param jobId - Job ID to delete
 * @param archiveId - Expected archive ID (ownership check)
 * @returns true if deleted, false if job not found or doesn't belong to archive
 */
export async function deleteOcrJob(
  jobId: string,
  archiveId: string
): Promise<boolean> {
  const job = await prisma.ocrJob.findUnique({ where: { id: jobId } });
  if (!job || job.archiveId !== archiveId) {
    return false;
  }

  await prisma.ocrJob.delete({ where: { id: jobId } });

  // Fire-and-forget event log
  logEvent("ocr_job", jobId, "job.deleted", null, {
    archiveId,
    type: job.type,
    status: job.status,
  }).catch((err: Error) => {
    logger.error("[ocr] Failed to log job deletion event", {
      jobId,
      error: err.message,
    });
  });

  logger.info("[ocr] Job deleted", { jobId, archiveId });
  return true;
}

/**
 * Reset stale PROCESSING jobs back to PENDING.
 * Threshold: 5 minutes (300,000ms).
 * Used on server restart to recover orphaned jobs.
 *
 * @returns Number of jobs reset
 */
export async function resetStaleJobs(): Promise<number> {
  const threshold = new Date(Date.now() - 300_000); // 5 minutes ago

  const result = await prisma.ocrJob.updateMany({
    where: {
      status: "PROCESSING",
      updatedAt: { lt: threshold },
    },
    data: { status: "PENDING" },
  });

  if (result.count > 0) {
    logger.info(`[ocr] Reset ${result.count} stale jobs to PENDING`);
  }

  return result.count;
}

/**
 * Count currently processing jobs.
 * Used by concurrency limiter to cap simultaneous jobs.
 * Only counts PROCESSING (not PENDING) — PENDING jobs are waiting
 * to be dispatched, not consuming resources.
 */
export async function getActiveJobCount(): Promise<number> {
  return prisma.ocrJob.count({
    where: {
      status: "PROCESSING",
    },
  });
}

/**
 * Get the next PENDING job (oldest first).
 * Used by Bree scheduler to pick up work.
 *
 * @returns Oldest PENDING job or null
 */
export async function getNextPendingJob() {
  return prisma.ocrJob.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });
}

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");

/**
 * Clean up orphaned raw/ files that have no corresponding OcrJob record.
 * Runs on server startup to reclaim disk space from failed/interrupted pipelines.
 *
 * Only removes files whose parent archive directory is known to the database.
 * Archive directories that do not exist in the archives table are left untouched.
 *
 * @returns Number of files removed
 */
export async function cleanupOrphanedRawFiles(): Promise<number> {
  let removedCount = 0;

  try {
    await fs.mkdir(ARCHIVES_BASE, { recursive: true });
    const archiveDirs = await fs.readdir(ARCHIVES_BASE, { withFileTypes: true });
    for (const entry of archiveDirs) {
      if (!entry.isDirectory()) continue;
      const archiveId = entry.name;

      // Verify the archive exists in the database
      const archive = await prisma.archive.findUnique({
        where: { id: archiveId },
        select: { id: true },
      });
      if (!archive) continue; // Skip unknown directories

      const rawDir = path.resolve(ARCHIVES_BASE, archiveId, "raw_sources");
      try {
        await fs.access(rawDir);
      } catch {
        continue; // No raw/ directory for this archive
      }

      const rawFiles = await fs.readdir(rawDir, { withFileTypes: true });
      for (const file of rawFiles) {
        if (!file.isFile()) continue;

        // Check if any OcrJob references this archive
        const jobCount = await prisma.ocrJob.count({
          where: { archiveId },
        });
        if (jobCount === 0) {
          // No jobs at all for this archive — raw/ files are orphaned
          try {
            await fs.unlink(path.resolve(rawDir, file.name));
            removedCount++;
          } catch (unlinkErr: unknown) {
  const message = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
            logger.warn("[ocr] Could not remove orphaned raw file", {
              file: file.name,
              archiveId,
              error: message,
            });
          }
        }
      }
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn("[ocr] Orphan file cleanup scan failed", { error: message });
  }

  if (removedCount > 0) {
    logger.info(`[ocr] Removed ${removedCount} orphaned raw/ files`);
  }

  return removedCount;
}

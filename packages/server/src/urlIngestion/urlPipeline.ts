// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * urlPipeline.ts — URL-to-Markdown Bree job handler
 *
 * Orchestrates the URL ingestion pipeline for a single OcrJob:
 *   1. Load job, validate state (idempotency guard for terminal states)
 *   2. Extract sourceUrl from job.result metadata
 *   3. Fetch URL → extract content via Readability + Turndown
 *   4. Compute credibility score (heuristic: domain, byline, date, etc.)
 *   5. Compute SHA-256 content hash
 *   6. Write Markdown to raw/ with metadata frontmatter (file-first ordering)
 *   7. Complete job + fire-and-forget event log
 *
 * Bree integration:
 *   - Exported async function signature: (jobId: string) => Promise<void>
 *   - Called via Bree's path() dynamic import pattern
 *
 * File-first write ordering (ARCH-04):
 *   - raw/ url-{hash12}-{timestamp}.md written BEFORE OcrJob state is updated
 */

import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { logger } from "../utils/logger";
import { validateArchivePath } from "../utils/archivePath";
import { logEvent } from "../services/eventLogService";
import {
  getOcrJob,
  startOcrJob,
  updateJobProgress,
  completeOcrJob,
  failOcrJob,
} from "../services/ocrJobService";
import { fetchUrlToMarkdown } from "./urlFetcher";
import { computeCredibilityScore } from "./credibilityScoring";
import { autoApproveOnComplete, autoApproveOnFail } from "../ocr/ocrPipeline";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// validateArchivePath imported from ../utils/archivePath

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Process a single URL-ingestion OcrJob from PENDING to COMPLETED (or FAILED).
 *
 * Designed as a Bree-compatible job handler:
 *   - Accepts a jobId string
 *   - Returns a Promise<void>
 *   - All errors caught internally, job state set to FAILED on unhandled errors
 */
export async function processUrlJob(jobId: string): Promise<void> {
  let userId: string | null = null;
  let sourceUrl: string | undefined;

  try {
    // ---- Step 1: Load job and validate state ----
    const job = await getOcrJob(jobId);
    if (!job) {
      throw new Error(`OcrJob ${jobId} not found`);
    }

    // Idempotency guard: skip terminal-state jobs
    if (
      job.status === "COMPLETED" ||
      job.status === "FAILED" ||
      job.status === "CANCELLED"
    ) {
      logger.info("[url] Job already in terminal state, skipping", {
        jobId,
        status: job.status,
      });
      return;
    }

    userId = job.createdBy;

    // ---- Step 2: Extract source URL from job.result ----
    const jobResult = job.result as Record<string, unknown> | null;
    sourceUrl = jobResult?.sourceUrl as string | undefined;
    if (!sourceUrl) {
      await failOcrJob(jobId, "No source URL found in job metadata");
      await autoApproveOnFail(jobId, "No source URL found in job metadata");
      return;
    }

    // ---- Step 3: Start job ----
    await startOcrJob(jobId, 1);
    await updateJobProgress(jobId, {
      processedPages: 0,
      progress: 5,
      currentPage: 1,
    });

    // ---- Step 4: Fetch and extract content ----
    const fetchResult = await fetchUrlToMarkdown(sourceUrl);

    // ---- Step 5: Credibility scoring ----
    const credibilityResult = computeCredibilityScore(sourceUrl, {
      title: fetchResult.title,
      byline: fetchResult.byline,
      siteName: fetchResult.siteName ?? undefined,
      contentLength: fetchResult.length,
    });

    // ---- Step 6: Compute content hash ----
    const contentHash = crypto
      .createHash("sha256")
      .update(fetchResult.markdown, "utf-8")
      .digest("hex");

    // ---- Step 7: Write to raw/ (file-first ordering) ----
    const rawDir = path.resolve(ARCHIVES_BASE, job.archiveId, "raw_sources");
    await fs.mkdir(rawDir, { recursive: true });

    const hashPrefix = contentHash.substring(0, 12);
    const timestamp = Date.now();
    const filename = `url-${hashPrefix}-${timestamp}.md`;
    const relPath = `raw_sources/${filename}`;
    validateArchivePath(
      path.resolve(ARCHIVES_BASE, job.archiveId),
      relPath,
    );
    const filePath = path.resolve(ARCHIVES_BASE, job.archiveId, relPath);

    // ---- Step 8: Build metadata frontmatter (YAML, properly escaped) ----
    const fetchedAt = new Date().toISOString();
    const esc = (s: string) => s.replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const metadataBlock = `---
sourceUrl: "${esc(sourceUrl)}"
fetchedAt: "${fetchedAt}"
title: "${esc(fetchResult.title)}"
siteName: "${esc(fetchResult.siteName || "")}"
byline: "${esc(fetchResult.byline || "")}"
credibilityScore: ${credibilityResult.score}
credibilityExplanation: "${esc(credibilityResult.explanation)}"
contentHash: "${contentHash}"
contentLength: ${fetchResult.length}
---`;

    const fullContent = metadataBlock + "\n\n" + fetchResult.markdown;

    // ---- Step 9: Write file ----
    await fs.writeFile(filePath, fullContent, "utf-8");

    // ---- Step 10: Complete job with full result (single atomic write) ----
    await completeOcrJob(
      jobId,
      {
        totalPages: 1,
        qualityScore: credibilityResult.score,
        totalTokens: 0,
        totalDurationMs: 0,
        hasUnverified: true, // URL content is auto-extracted — treat as unverified by default
      },
      {
        pageResults: [
          {
            pageNumber: 1,
            markdown: fetchResult.markdown,
            tokensUsed: 0,
            durationMs: 0,
          },
        ],
        sourceUrl,
        contentHash,
        credibilityScore: credibilityResult,
        extractedTitle: fetchResult.title,
        siteName: fetchResult.siteName,
        fileName: filename,
      }
    );

    // ---- Step 10b: 71-02 Q4 auto-approve hook (URL draft KB leg) ----
    // Same pattern as ocrPipeline.ts: flip AIJ → COMPLETED and create the
    // ArchivePage from the fetched markdown. No-op if no AIJ is linked to
    // this OcrJob (standalone urlIngestion flow preserved).
    await autoApproveOnComplete(jobId, job.archiveId, userId, {
      pageResults: [
        {
          pageNumber: 1,
          markdown: fetchResult.markdown,
          tokensUsed: 0,
          durationMs: 0,
        },
      ],
      sourceUrl,
      contentHash,
      credibilityScore: credibilityResult,
      extractedTitle: fetchResult.title,
      siteName: fetchResult.siteName,
      fileName: filename,
    });

    // ---- Step 11: Fire-and-forget event log ----
    logEvent("ocr_job", jobId, "job.completed", userId, {
      archiveId: job.archiveId,
      sourceUrl,
      credibilityScore: credibilityResult.score,
      contentHash,
      contentLength: fetchResult.length,
    }).catch((err: Error) =>
      logger.error("[url] Failed to log completion event", {
        jobId,
        error: err.message,
      }),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // ---- Catastrophic failure (outer try/catch) ----
    logger.error("[url] Pipeline failed", {
      jobId,
      error: message,
    });

    try {
      await failOcrJob(jobId, message);
    } catch (failErr: unknown) {
      const failMessage = failErr instanceof Error ? failErr.message : String(failErr);
      logger.error("[url] Failed to mark job as FAILED", {
        jobId,
        error: failMessage,
      });
    }

    // 71-02 Q4 auto-approve hook (URL draft KB leg failure path).
    await autoApproveOnFail(jobId, message);

    // Fire-and-forget event log for failure
    logEvent("ocr_job", jobId, "job.failed", userId, {
      archiveId: undefined,
      sourceUrl,
      error: message,
    }).catch((logErr: Error) =>
      logger.error("[url] Failed to log failure event", {
        jobId,
        error: logErr.message,
      }),
    );
  }
}

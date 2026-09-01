// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ocrPipeline.ts — PDF-to-Markdown Bree job handler (PUBLIC FACADE)
 *
 * MOD-03 (Phase 88): the pipeline body was surgically split into
 * `./ocrStages.ts` (single stage-grouped module — D-05 — with 3 pipeline
 * phase groups: setup / ocr / finalize). This file remains a thin facade
 * (D-03) preserving the byte-identical public surface:
 *   - `processOcrJob(jobId)` delegates to `runOcrPipeline`
 *   - `autoApproveOnComplete(jobId, archiveId, userId, fullResult)` delegates
 *     to `finalizeAutoApproveOnComplete`
 *   - `autoApproveOnFail(jobId, errorMessage)` delegates to
 *     `finalizeAutoApproveOnFail`
 *
 * OCR callers (`ocrJobService.ts`, OCR routes) keep their import path
 * `../ocr/ocrPipeline` unchanged.
 *
 * Bree integration:
 *   - Exported async function signature: (jobId: string) => Promise<void>
 *   - Called via Bree's path() dynamic import pattern (see archiveConsistencyService.ts:225-244)
 *   - Survives server restarts: reads OcrJob.processedPages to resume from checkpoint
 */

import {
  runOcrPipeline,
  finalizeAutoApproveOnComplete,
  finalizeAutoApproveOnFail,
} from "./ocrStages";

/**
 * Process a single OcrJob from PENDING to COMPLETED (or FAILED).
 *
 * Thin wrapper delegating to `runOcrPipeline` (ocrStages.ts). Signature is
 * byte-identical to the pre-split implementation.
 */
export async function processOcrJob(jobId: string): Promise<void> {
  return runOcrPipeline(jobId);
}

/**
 * 71-02 Q4 event-driven auto-approve hook. Called after `completeOcrJob`.
 * Thin wrapper delegating to `finalizeAutoApproveOnComplete` (ocrStages.ts).
 */
export async function autoApproveOnComplete(
  jobId: string,
  archiveId: string,
  userId: string | null,
  fullResult?: Record<string, unknown>,
): Promise<void> {
  return finalizeAutoApproveOnComplete(jobId, archiveId, userId, fullResult);
}

/**
 * 71-02 Q4 event-driven hook. Called after `failOcrJob`.
 * Thin wrapper delegating to `finalizeAutoApproveOnFail` (ocrStages.ts).
 */
export async function autoApproveOnFail(
  jobId: string,
  errorMessage: string,
): Promise<void> {
  return finalizeAutoApproveOnFail(jobId, errorMessage);
}
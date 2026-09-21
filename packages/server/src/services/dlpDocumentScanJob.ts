// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * pg-boss consumers for the document DLP scan (Phase 192 plan 02 Task 2 —
 * D-01) and the legacy-corpus backfill (D-12).
 *
 * The FIRST one-shot send/work consumers in the repo (prior consumers are
 * cron-only). Mirrors the uploadDraftReaperJob boot shape: getBoss
 * null-guard (graceful degradation, NO fallback timer), createQueue before
 * work, for...of Job[] iteration, catch-and-resolve discipline.
 *
 * Pitfall 6 (RESEARCH): the default expireInSeconds 900s would RETRY a
 * still-running scan (large doc + NER + local reembed can exceed 15 min —
 * the AI-ACT.pdf incident) → both queues raise it to 3600.
 *
 * Rate-limit separation (D-12): the backfill queue runs localConcurrency 1
 * (BELOW the live scan's 2) so a backfill burst can never starve the
 * embedding backend the way unbounded concurrency would.
 */
import { logger } from "../utils/logger";
import { getBoss, createQueue, send } from "./jobQueue";
import { scanDocument, parseScanJobPayload } from "./dlpDocumentService";
import { dlpScanJobPayloadSchema } from "@simmetric-chat/shared";

/** Live-scan queue (charset-safe: underscores, not colons). */
export const DLP_SCAN_QUEUE_NAME = "dlp_document_scan";
/** Backfill queue — separate queue = independent concurrency (rate limit). */
export const DLP_BACKFILL_QUEUE_NAME = "dlp_backfill";

const SCAN_QUEUE_OPTIONS = {
  // Pitfall 6: must exceed the worst-case scan+reembed wall time.
  expireInSeconds: 3600,
  retryLimit: 3,
  retryBackoff: true,
  retryDelayMax: 300,
} as const;

const BACKFILL_QUEUE_OPTIONS = {
  expireInSeconds: 3600,
  retryLimit: 3,
  retryBackoff: true,
  // Backfill is patient — longer backoff cap than the live scan.
  retryDelayMax: 600,
} as const;

/**
 * The work-handler body for ONE scan job (shared by the live consumer).
 * Payload is validated against the shared schema (T-192-11): a forged
 * payload degrades to a no-op skip, never a cross-org write (scanDocument
 * itself re-reads the document through the org-asserted scoped findFirst).
 * Per-job errors mark dlpScanState="failed" + log — NEVER re-thrown
 * (no pg-boss retry storm; T-192-10 catch-and-resolve discipline).
 */
async function processScanJob(data: unknown): Promise<void> {
  const payload = parseScanJobPayload(data);
  if (!payload) {
    // T-192-11: forged/unrecognizable payload → no-op skip.
    logger.warn("[dlp-scan] job payload failed schema validation — skipping (no-op)");
    return;
  }
  try {
    await scanDocument(payload.documentId);
  } catch (err: unknown) {
    // scanDocument already marked dlpScanState="failed"; log + resolve.
    logger.error("[dlp-scan] job failed (marked failed, not re-thrown)", {
      documentId: payload.documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Register the live-scan consumer (D-01). Called at boot AFTER startJobQueue.
 * Queue options sized for long scans (Pitfall 6); batchSize 1 (one document
 * per fetch) + localConcurrency 2 (two parallel scans max per node).
 */
export async function initDlpDocumentScanScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    // D-02 graceful degradation: pg-boss unavailable → scan offline. No
    // fallback timer, no process.exit — REST/SSE work normally.
    logger.warn("[dlp-scan] pg-boss unavailable — document scan offline (D-02)");
    return;
  }
  // Pitfall 1: the queue MUST exist before work/send references it.
  await createQueue(DLP_SCAN_QUEUE_NAME, SCAN_QUEUE_OPTIONS);
  // Pitfall 2: the handler receives Job[] — iterate with for...of.
  // pg-boss 12.29 signature: work(name, OPTIONS, handler) — options are the
  // SECOND argument (the pre-12.29 work(name, handler, opts) shape is gone;
  // verified against manager.d.ts this session).
  await boss.work(
    DLP_SCAN_QUEUE_NAME,
    { batchSize: 1, localConcurrency: 2 },
    async (jobs) => {
      for (const job of jobs) {
        // Per-JOB toggle re-read (uploadDraftReaper precedent): the
        // workspace toggle is read INSIDE scanDocument's scoped read per
        // consume — never cached at boot.
        await processScanJob(job.data);
      }
    },
  );
  logger.info(
    `[dlp-scan] consumer registered (queue ${DLP_SCAN_QUEUE_NAME}, batchSize 1, localConcurrency 2, expireInSeconds 3600)`,
  );
}

/**
 * Enqueue a scan for ONE completed document (the upload-completion hook in
 * documents.ts — wired in plan 04). Payload shape pinned by the shared
 * dlpScanJobPayloadSchema (T-192-11). getBoss() null → warn + return
 * (graceful degradation, no fallback timer).
 */
export async function enqueueDlpScan(
  documentId: string,
  workspaceId: string,
  organizationId: string,
): Promise<string | null> {
  const payload = dlpScanJobPayloadSchema.safeParse({ documentId, workspaceId, organizationId });
  if (!payload.success) {
    logger.error("[dlp-scan] enqueue payload invalid — NOT sent", { documentId });
    return null;
  }
  const boss = getBoss();
  if (!boss) {
    logger.warn("[dlp-scan] pg-boss unavailable — scan enqueue dropped (graceful, D-02)", {
      documentId,
    });
    return null;
  }
  return send(DLP_SCAN_QUEUE_NAME, payload.data);
}

/**
 * D-12: the backfill work handler runs the SAME scanDocument sequence with
 * the dlpScannedAt marker check FIRST (scanDocument skips already-scanned
 * docs internally — the idempotency marker is the truth, D-12).
 *
 * OWNERSHIP (plan-check revision): count/enqueue eligibility
 * (enqueueDlpBackfillBatch + the eligibility count query) lives in plan 06's
 * dlpBackfillService.ts ONLY — this module is the CONSUMER (init + work
 * handler + marker skip); no duplicate enqueue/count function here.
 */
export async function initDlpBackfillScheduler(): Promise<void> {
  const boss = getBoss();
  if (!boss) {
    logger.warn("[dlp-backfill] pg-boss unavailable — backfill offline (D-02)");
    return;
  }
  await createQueue(DLP_BACKFILL_QUEUE_NAME, BACKFILL_QUEUE_OPTIONS);
  // localConcurrency 1 — the rate limit IS the queue concurrency separation
  // (protects the embedding backend; D-12). No startAfter staggering.
  // pg-boss 12.29 signature: work(name, OPTIONS, handler).
  await boss.work(
    DLP_BACKFILL_QUEUE_NAME,
    { batchSize: 1, localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        // Per-job error → dlpScanState="failed" (inside scanDocument) +
        // continue with the NEXT job — never re-throw.
        await processScanJob(job.data);
      }
    },
  );
  logger.info(
    `[dlp-backfill] consumer registered (queue ${DLP_BACKFILL_QUEUE_NAME}, batchSize 1, localConcurrency 1, expireInSeconds 3600)`,
  );
}
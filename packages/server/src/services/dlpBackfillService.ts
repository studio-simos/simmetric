// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * dlpBackfillService.ts — legacy-corpus backfill orchestration (Phase 192
 * plan 06 — DLP-06/D-12).
 *
 * OWNERSHIP (plan-check revision, binding): the ELIGIBILITY COUNT and the
 * ENQUEUE BATCH live here ONLY — the pg-boss consumer side (queue creation,
 * localConcurrency 1 rate limit, work handler) stays in
 * dlpDocumentScanJob.ts (plan 02 Task 2), which imports NOTHING from this
 * module. The `dlp_backfill` queue name is the shared seam — imported from
 * the consumer module so endpoint sends and consumer registration can never
 * drift apart.
 *
 * D-12 shape (research §Backfill Strategy):
 * - one pg-boss job PER DOCUMENT (retry granularity + per-doc idempotency),
 *   never a bulk single-query rewrite;
 * - idempotency marker = `Document.dlpScannedAt` (recommendation (b): the
 *   column is the marker — zero-PII docs legitimately have no entity rows,
 *   so entity-row existence cannot mark them done);
 * - re-running the endpoint re-enqueues ONLY docs lacking the marker
 *   (resumable across invocations);
 * - the rate limit IS the queue-level concurrency separation
 *   (dlp_backfill localConcurrency 1 < live scan 2) — no timestamp tricks;
 * - same-document race structurally excluded: eligibility filters
 *   status="completed" only, and a re-upload creates a NEW documentId.
 *
 * Eval gate (D-12 ordering / T-192-28): the admin endpoint REFUSES to
 * enqueue until the DLP-05 eval result (persisted by plan 05 under
 * `DLP_EVAL_LAST_RUN`) has passed — server-side, not UI-side, so a stale
 * client can never bypass the ordering.
 */
import prisma, { withSoftDelete } from "../utils/prisma";
import { logger } from "../utils/logger";
import { send } from "./jobQueue";
import { DLP_BACKFILL_QUEUE_NAME } from "./dlpDocumentScanJob";
import { scanDocument, parseScanJobPayload } from "./dlpDocumentService";
import { readEvalResult, DLP_EVAL_LAST_RUN_KEY } from "./dlpEvalService";
import {
  dlpScanJobPayloadSchema,
  type DlpScanJobPayload,
  type DlpBackfillResponse,
} from "@simmetric-chat/shared";

/**
 * Per-request send cap (must_haves): a large legacy corpus completes across
 * REPEATED endpoint invocations — each invocation enqueues at most 500 jobs
 * and the response's totalEligible says how many remain (the UI copy states
 * re-run safety). Ordered by createdAt asc, so invocations drain oldest-first.
 */
export const MAX_SENDS_PER_REQUEST = 500;

/** Send-slice size — one progress log line per slice (must_haves). */
const SEND_SLICE_SIZE = 50;

/**
 * Eligibility filter (D-12): soft-delete guard + completed-only + the
 * dlpScannedAt marker as the idempotency truth. status="completed" is the
 * same-document race guard (T-192-31): a re-upload creates a NEW documentId,
 * so a doc being re-ingested right now is never in the eligible set.
 */
export function backfillEligibilityWhere(organizationId?: string): Record<string, unknown> {
  const where: Record<string, unknown> = {
    deletedAt: null,
    status: "completed",
    dlpScannedAt: null,
  };
  if (organizationId) {
    where.organizationId = organizationId;
  }
  return where;
}

/** Count the legacy documents still lacking the dlpScannedAt marker. */
export async function countEligibleDocuments(organizationId?: string): Promise<number> {
  return prisma.document.count({ where: backfillEligibilityWhere(organizationId) });
}

/**
 * Assert the DLP-05 eval gate (D-12 ordering, T-192-28): the last persisted
 * eval run must exist AND have passed. Absent/never-run/unparseable/failed
 → false — the endpoint turns that into 409 { gate: "eval-not-passed" }.
 * Server-side enforcement, never UI-side (a stale client cannot bypass).
 */
export async function assertEvalGatePassed(): Promise<boolean> {
  const row = await prisma.systemConfig.findUnique({ where: { key: DLP_EVAL_LAST_RUN_KEY } });
  const result = readEvalResult(row?.value ?? null) as { passed?: unknown } | null;
  return result?.passed === true;
}

/**
 * Resolve the eligible batch and send ONE dlp_backfill job per document
 * (slices of 50 with a progress log line each). Response shape is the shared
 * dlpBackfillResponseSchema; invariant: enqueued + skipped + errors.length
 * === totalEligible.
 *
 * Zero eligible → the NO-OP SUCCESS arm (probe edge: empty): enqueued 0,
 * totalEligible 0, empty errors — never an error (the UI empty state renders
 * from this response).
 */
export async function enqueueDlpBackfillBatch(organizationId?: string): Promise<DlpBackfillResponse> {
  const eligible = await prisma.document.findMany({
    where: backfillEligibilityWhere(organizationId),
    select: { id: true, workspaceId: true, organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  const totalEligible = eligible.length;
  const errors: string[] = [];
  let enqueued = 0;

  if (totalEligible === 0) {
    logger.info("[dlp-backfill] zero eligible documents — no-op success (D-12)");
    return { enqueued: 0, skipped: 0, totalEligible: 0, errors: [] };
  }

  // Cap per request: the remainder stays eligible (dlpScannedAt still null)
  // and a repeated invocation drains the next slice — resumable by design.
  const batch = eligible.slice(0, MAX_SENDS_PER_REQUEST);

  for (let i = 0; i < batch.length; i += SEND_SLICE_SIZE) {
    const slice = batch.slice(i, i + SEND_SLICE_SIZE);
    for (const doc of slice) {
      const payload = dlpScanJobPayloadSchema.safeParse({
        documentId: doc.id,
        workspaceId: doc.workspaceId,
        organizationId: doc.organizationId,
      });
      if (!payload.success) {
        // Unreachable for a prisma uuid select — kept as the schema-contract
        // guard (T-192-11): an invalid payload is NEVER sent.
        errors.push(`Document ${doc.id}: payload failed dlpScanJobPayloadSchema`);
        continue;
      }
      try {
        const jobId = await send(DLP_BACKFILL_QUEUE_NAME, payload.data);
        if (jobId) {
          enqueued += 1;
        } else {
          errors.push(`Document ${doc.id}: queue send returned no job id`);
        }
      } catch (err: unknown) {
        errors.push(`Document ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger.info(
      `[dlp-backfill] enqueue progress: ${Math.min(i + SEND_SLICE_SIZE, batch.length)}/${batch.length} sent (totalEligible ${totalEligible})`,
    );
  }

  // Deferred-by-cap remainder + failed sends both land in `skipped` — they
  // are exactly the eligible docs this invocation did NOT enqueue.
  const skipped = totalEligible - enqueued - errors.length;
  logger.info(
    `[dlp-backfill] batch complete: enqueued ${enqueued}, skipped ${skipped}, totalEligible ${totalEligible}, errors ${errors.length}`,
  );
  return { enqueued, skipped, totalEligible, errors };
}

/** Outcome of one per-document backfill job body. */
export type BackfillDocumentOutcome = "processed" | "skipped" | "invalid";

/**
 * The per-document work body (D-12): payload schema validation → org-asserted
 * scoped re-read → dlpScannedAt marker check FIRST → delegate to plan 02's
 * scanDocument (the SAME masking sequence as new uploads: scan → mask → FTS
 * rewrite → reembed masked text → encrypted entity rows → markers).
 *
 * The integration twin (dlpBackfill.integration.test.ts) drives this directly
 * — the queue transport is unit-tested in dlpDocumentScan.test.ts; the twin
 * proves the DATA convergence. The committed consumer (dlpDocumentScanJob)
 * routes its dlp_backfill arm through scanDocument, whose internal marker
 * check is the same idempotency truth — the belt here is the tenancy assert
 * + the explicit skip accounting (T-192-29: payload ids MUST match the row).
 */
export async function runBackfillDocument(jobData: unknown): Promise<BackfillDocumentOutcome> {
  const payload: DlpScanJobPayload | null = parseScanJobPayload(jobData);
  if (!payload) {
    logger.warn("[dlp-backfill] job payload failed schema validation — skipping (no-op)");
    return "invalid";
  }

  // Org-asserted scoped read (T-192-29): withSoftDelete + deletedAt: null —
  // a soft-deleted doc (purge racing the backfill) skips, never rewrites.
  const doc = await prisma.document.findFirst({
    where: withSoftDelete({ id: payload.documentId, deletedAt: null }),
    select: { id: true, workspaceId: true, organizationId: true, dlpScannedAt: true },
  });
  if (!doc) {
    logger.info(`[dlp-backfill] Document ${payload.documentId} not found (or deleted) — skipped`);
    return "skipped";
  }

  // Tenancy assert: the queue payload's ids MUST match the stored row — a
  // mismatch means the payload was forged or the row moved orgs; skip.
  if (doc.workspaceId !== payload.workspaceId || doc.organizationId !== payload.organizationId) {
    logger.warn(`[dlp-backfill] Document ${doc.id} payload/row tenancy mismatch — skipped`);
    return "skipped";
  }

  // Marker check FIRST (D-12 idempotency): scanDocument re-checks the marker
  // internally, but the explicit arm keeps skip accounting honest without
  // touching any scan machinery.
  if (doc.dlpScannedAt) {
    logger.info(`[dlp-backfill] Document ${doc.id} already scanned (dlpScannedAt set) — skipped`);
    return "skipped";
  }

  // Delegate to the plan 02 sequence. Note: docs in toggle-OFF workspaces are
  // skipped by scanDocument's workspace-toggle guard — the admin flips the
  // per-workspace toggle to include them (same rule as live scans).
  await scanDocument(doc.id);
  return "processed";
}
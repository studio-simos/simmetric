// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import {
  copyToArchiveRequestSchema,
  copyToArchiveBatchRequestSchema,
  archivePageParseCallbackSchema,
} from "@simmetric-chat/shared";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { isAdmin } from "../utils/auth";
import prisma from "../utils/prisma";
import {
  dispatchCopyDocToArchive,
  handleArchiveImportCallback,
  assertDocumentReadAccess,
} from "../services/archiveImportService";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Constant-time comparison of the X-Collector-Secret header against the
 * configured secret (T-DRD-02). Byte-identical discipline to the other two
 * collector-secret sites — routes/documents.ts secretEquals (WR-04) and the
 * collector's own requireCollectorSecret (ingest.ts): one pattern, three
 * sites. String `!==` short-circuits on the first differing byte, leaking
 * the secret length/prefix via timing.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * POST /:archiveId/copy-from-doc — KB-05 copy document to archive.
 *
 * Body is either `{ documentId }` (single) or `{ documentIds: [] }` (batch,
 * D-04b). Both paths enforce `archive:write` via requirePermission AND
 * `document:read` on each source document via assertDocumentReadAccess
 * (B1 IDOR fix, T-64-18) — server-side check, do not trust client claims.
 * Batch fails closed: if ANY documentId is inaccessible, the whole batch is
 * 403'd with no partial dispatch (prevents an attacker probing which docIds
 * in a batch are readable).
 */
router.post(
  "/:archiveId/copy-from-doc",
  authMiddleware,
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = req.params.archiveId as string;
      if (!UUID_RE.test(archiveId)) {
        res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
        return;
      }

      // Detect single vs batch by the presence of `documentIds` array.
      const isBatch = Array.isArray(req.body?.documentIds);
      let documentIds: string[];
      if (isBatch) {
        const parsed = copyToArchiveBatchRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid request body",
            details: parsed.error.flatten().fieldErrors,
          });
          return;
        }
        documentIds = parsed.data.documentIds;
      } else {
        const parsed = copyToArchiveRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid request body",
            details: parsed.error.flatten().fieldErrors,
          });
          return;
        }
        documentIds = [parsed.data.documentId];
      }

      // B1 IDOR fix (D-04, T-64-18): verify document:read on EVERY source
      // document BEFORE any dispatch. Fail-closed — if ANY documentId is
      // inaccessible, 403 the whole request with no partial dispatch. This
      // mirrors the Phase 61 DOC-01 pattern (documents.ts:380-393) and
      // applies to ALL users including admins.
      for (const docId of documentIds) {
        try {
          await assertDocumentReadAccess(docId, req.userId!);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith("Document not found")) {
            res.status(404).json({ error: message });
            return;
          }
          if (isBatch) {
            res
              .status(403)
              .json({ error: "Access denied to document " + docId });
            return;
          }
          res.status(403).json({ error: "Access denied to this document" });
          return;
        }
      }

      // All access checks passed — dispatch each job.
      const jobs: { jobId: string; documentId: string }[] = [];
      for (const docId of documentIds) {
        const { jobId } = await dispatchCopyDocToArchive({
          archiveId,
          documentId: docId,
          userId: req.userId!,
        });
        jobs.push({ jobId, documentId: docId });
      }

      res.status(202).json(
        isBatch
          ? { jobs, status: "PROCESSING" }
          : { jobId: jobs[0]!.jobId, status: "PROCESSING" },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[archiveImport] copy-from-doc error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * GET /import/:jobId — async job status endpoint (T-duu-01).
 *
 * Returns the current state of an ArchiveImportJob so the frontend can poll
 * until the page actually exists (the dispatch/callback pipeline is async:
 * POST copy-from-doc / upload returns 202 immediately, and the ArchivePage is
 * only created when the collector calls back PUT /import/:jobId/callback).
 *
 * Ownership: `job.createdBy === req.userId` OR `isAdmin(req.user)` (mirrors
 * the archiveExport.ts ownership pattern). 403 otherwise — prevents a user
 * from enumerating other users' import jobs and learning their titles/errors
 * (T-duu-01 information-disclosure threat). Read-only: archive:read is
 * sufficient; the endpoint never returns page content, only job metadata.
 *
 * Response (200): `{ id, archiveId, status, result, error }` — all five
 * fields always present (null when absent) so the frontend can destructure
 * unconditionally.
 */
router.get(
  "/import/:jobId",
  authMiddleware,
  requirePermission("archive:read"),
  async (req: Request, res: Response) => {
    try {
      const jobId = req.params.jobId as string;
      if (!UUID_RE.test(jobId)) {
        res.status(400).json({ error: "Invalid job ID: must be a valid UUID" });
        return;
      }

      const job = await prisma.archiveImportJob.findUnique({
        where: { id: jobId },
      });
      if (!job) {
        res.status(404).json({ error: "Import job not found" });
        return;
      }

      const isOwner = job.createdBy === req.userId;
      const admin = isAdmin(req.user);
      if (!isOwner && !admin) {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }

      res.status(200).json({
        id: job.id,
        archiveId: job.archiveId,
        status: job.status,
        result: job.result ?? null,
        error: job.error ?? null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[archiveImport] status error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * PUT /import/:jobId/callback — collector parse-result callback.
 *
 * Authenticated via X-Collector-Secret (T-64-21). The collector is the only
 * legitimate caller; any other client reaching this endpoint must be rejected
 * with 401. The body is validated by archivePageParseCallbackSchema. On
 * "completed" the service creates an ArchivePage via createPage; on "failed"
 * the job is flipped to FAILED. The route never trusts the callback's claim
 * of which archiveId the job belongs to — it looks up the ArchiveImportJob by
 * jobId and uses the stored archiveId (defense against a collector that
 * might be coerced into writing to a different archive).
 */
router.put(
  "/import/:jobId/callback",
  async (req: Request, res: Response) => {
    try {
      // T-64-21: collector-secret auth. The callback now uses the same
      // constant-time discipline as routes/documents.ts secretEquals (WR-04)
      // and the collector's requireCollectorSecret (ingest.ts) — one
      // timing-safe pattern across all three collector-secret sites.
      const env = getEnv();
      const presented = String(req.headers["x-collector-secret"] ?? "");
      if (!secretEquals(presented, env.COLLECTOR_SECRET)) {
        res.status(401).json({ error: "Invalid collector secret" });
        return;
      }

      const jobId = req.params.jobId as string;
      if (!UUID_RE.test(jobId)) {
        res.status(400).json({ error: "Invalid job ID: must be a valid UUID" });
        return;
      }

      const parsed = archivePageParseCallbackSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid callback body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      await handleArchiveImportCallback(jobId, parsed.data);
      res.json({ ok: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[archiveImport] callback error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { assertNonAdminUploadAllowed } from "../middleware/uploadGate";
import prisma, { withSoftDelete } from "../utils/prisma";
import { getEnv } from "../config/env";
import { logEvent } from "../services/eventLogService";
import { getSetting } from "../services/systemConfigService";
import { extractTextFromPdf, cleanupOcrTextFile } from "../services/ragOcrService";
import { logger } from "../utils/logger";
import { getUniqueFilePath, isDraftsPath } from "../utils/fileUtils";
import { IngestStatusCallbackSchema, sanitizeFileName, bulkDeleteDocumentsSchema } from "@simmetric-chat/shared";
import { z } from "zod";
import { isAdmin } from "../utils/auth";
import { Prisma } from "@prisma/client";
import { MULTI_CONFIG_TSVECTOR } from "../services/ftsService";

const UPLOADS_DIR = "storage/uploads/";

/**
 * WR-01: best-effort unlink of a multer upload that landed on disk before the
 * authorization / workspace-existence checks ran. The middleware order is
 * `uploadSingle` → `requirePermission` → handler, so multer writes the file to
 * UPLOADS_DIR before `requirePermission` executes. Any 403 / 404 path inside
 * the handler that returns without creating a Document row would orphan the
 * file on disk; repeated requests can fill the disk (denial-of-service from
 * any authenticated low-privilege account). Inline `try/catch` — cleanup is
 * best-effort and must never mask the real rejection with a throw.
 */
function unlinkUploadIfPresent(req: Request): void {
  if (req.file?.path) {
    try { fs.unlinkSync(req.file.path); } catch { /* best-effort */ }
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const uniquePath = getUniqueFilePath(UPLOADS_DIR, file.originalname);
    cb(null, path.basename(uniquePath));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (_req, file, cb) => {
    const allowedMimes = [
      "application/pdf",
      "text/markdown",
      "text/plain",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    if (allowedMimes.includes(file.mimetype) || file.originalname.endsWith(".md") || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const router = Router();

/**
 * Multer wrapper (T-61-04): intercepts MulterError BEFORE the route handler so
 * oversized files get a clean 413 response instead of falling through to the
 * global error handler as 500. Without this wrapper, Express 5 passes the
 * error to next() which hits the catch-all 500 handler — clients see a
 * generic 500 instead of a meaningful 413.
 */
function uploadSingle(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "File too large", limit: "100MB" });
      }
      if (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
      next();
    });
  };
}

/**
 * Constant-time comparison of the X-Collector-Secret header against the
 * configured secret (WR-04). String `!==` short-circuits on the first
 * differing byte, leaking the secret length/prefix via timing. The status
 * callback accepts terminal status updates from the collector, so the shared
 * secret follows the same timing-safe discipline already used for API keys.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// PUT /api/documents/:documentId/status — internal callback for collector to update status
// This route is NOT protected by authMiddleware; it uses a shared secret instead.
router.put("/:documentId/status", async (req: Request, res: Response) => {
  try {
    const secret = String(req.headers["x-collector-secret"] ?? "");
    if (!secretEquals(secret, getEnv().COLLECTOR_SECRET)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Consumer-side contract validation (T-60-06). Zod failure is a hard
    // contract bug, not a transient error — no retry. Existing ad-hoc enum
    // check is superseded by the shared schema.
    const parsed = IngestStatusCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn("[documents] contract violation (consumer)", {
        issues: parsed.error.flatten().fieldErrors,
      });
      res.status(400).json({
        error: "Invalid ingest status callback",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { status, chunkCount, statusMessage } = parsed.data;

    const updateData: Prisma.DocumentUpdateInput = { status };
    if (typeof chunkCount === "number") updateData.chunkCount = chunkCount;
    if (statusMessage) updateData.statusMessage = statusMessage;

    const document = await prisma.document.update({
      where: { id: req.params.documentId as string },
      data: updateData,
    });

    // Terminal-status source-file cleanup. TWO contracts in one block
    // (quick 260829-jv7 / D-01):
    //
    //   1. Direct uploads (T-69-07): the filePath is the multer tmp path
    //      under storage/uploads/ — terminal cleanup unlinks it as before
    //      (best-effort, existence-checked, semantics unchanged).
    //
    //   2. Draft-dispatched legs: the filePath is the STAGED draft file
    //      under storage/uploads/drafts/. Files there are owned SOLELY by
    //      the upload-draft lifecycle — the 24h reaper (uploadDraftReaperJob,
    //      A5 prefix guard), the DELETE /api/uploads/:id route (A5 guard),
    //      and the /retry+/assign source-file guards. Every retry creates a
    //      NEW Document row with the SAME drafts path, so a sibling's
    //      terminal callback here would erase the file under all others
    //      (incident d6ef3403) and make retry permanently unworkable.
    //      Suppression is logged at info level (observability).
    if (status === "completed" || status === "failed") {
      if (document.filePath && isDraftsPath(document.filePath)) {
        logger.info(
          "[documents] terminal status callback suppressed unlink of draft-owned staged file (draft-file lifecycle invariant, 260829-jv7 D-01)",
          { documentId: document.id, filePath: document.filePath },
        );
      } else {
        try {
          if (document.filePath && fs.existsSync(document.filePath)) {
            fs.unlinkSync(document.filePath);
          }
        } catch {
          // File cleanup is best-effort
        }
      }
    }

    res.json(document);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.use(authMiddleware);

/**
 * @openapi
 * /documents:
 *   get:
 *     tags: [Documents]
 *     summary: List documents accessible to the current user
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: workspaceId, in: query, schema: { type: string }, description: Filter by workspace }
 *     responses:
 *       200: { description: Array of documents }
 *       500: { description: Server error }
 */
// GET /api/documents — list all documents accessible to user
router.get("/", async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;

    const where: Prisma.DocumentWhereInput = { deletedAt: null };

    if (workspaceId) {
      where.workspaceId = workspaceId;
    }

    // WR-04 (D-04 consistency): the workspace-access OR filter applies to ALL
    // users including admins — same gate as GET /:id and POST /upload. The
    // previous `if (!admin)` guard let admins list documents across every
    // workspace boundary, which is inconsistent with the per-document 403 they
    // get on GET /:id and leaks document existence/metadata for workspaces the
    // admin has no access to.
    where.OR = [
      { workspace: { project: { createdBy: req.userId! } } },
      { workspace: { accessGrants: { some: { userId: req.userId! } } } },
      { workspace: { project: { accessGrants: { some: { userId: req.userId! } } } } },
    ];

    const documents = await prisma.document.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    res.json(documents);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /documents/upload:
 *   post:
 *     tags: [Documents]
 *     summary: Upload a document to a workspace
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary, description: PDF, MD, TXT, CSV, DOCX, or XLSX (max 100MB) }
 *               workspaceId: { type: string, description: Target workspace ID }
 *               embeddingModel: { type: string, example: "Xenova/all-MiniLM-L6-v2" }
 *     responses:
 *       201: { description: Document created and queued for processing }
 *       400: { description: No file or unsupported type }
 *       403: { description: Missing document:write permission }
 */
// POST /api/documents/upload — upload a document and forward to collector
router.post("/upload", uploadSingle("file"), requirePermission("document:write"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const workspaceId = req.body.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: "workspaceId is required" });
      return;
    }

    // IN-03: validate workspaceId as a UUID before the Prisma lookup. Prisma
    // would 404 on non-UUID input anyway, but the shared-schema convention is
    // to validate at the API boundary and return 400 with `details` so the
    // caller sees a clear validation error instead of an ambiguous 404.
    const wsIdResult = z.string().uuid("Invalid workspace ID").safeParse(workspaceId);
    if (!wsIdResult.success) {
      // WR-01: multer already wrote the file; clean it up before rejecting.
      unlinkUploadIfPresent(req);
      res.status(400).json({
        error: "Invalid workspaceId",
        details: wsIdResult.error.flatten().formErrors,
      });
      return;
    }

    // Read embedding model from system config
    const modelSetting = await getSetting("EMBEDDING_MODEL");
    const embeddingModel = modelSetting.value;

    if (!embeddingModel) {
      res.status(400).json({ error: "Embedding model not configured. Please set an embedding model in Settings > LLM & Embedding." });
      return;
    }

    // Layered permission check (D-04): admin requires workspace access, bypasses
    // only the allowMemberUploads toggle. Non-admin requires both workspace access
    // AND the toggle to be enabled.
    const admin = isAdmin(req.user);

    // Workspace existence check applies to everyone (prevents FK violation on bad workspaceId)
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      include: { project: true },
    });
    if (!workspace) {
      // WR-01: multer already wrote the file; clean it up before rejecting so
      // repeated bad-workspaceId requests don't accumulate orphans on disk.
      unlinkUploadIfPresent(req);
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    // D-04: workspace access check applies to ALL users (admin included).
    // Admin does NOT bypass workspace access for document uploads.
    const isProjectOwner = workspace.project?.createdBy === req.userId;
    const hasWorkspaceAccess = await prisma.workspaceAccess.findFirst({
      where: { userId: req.userId!, workspaceId },
    });
    const hasProjectAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: workspace.projectId },
    });
    if (!isProjectOwner && !hasWorkspaceAccess && !hasProjectAccess) {
      // WR-01: clean up the multer upload before rejecting.
      unlinkUploadIfPresent(req);
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }

    // D-04 (Phase 70): gate extracted to assertNonAdminUploadAllowed helper.
    // OR-semantics: ALLOW_NON_ADMIN_UPLOAD (global) || workspace.allowMemberUploads.
    // Admin bypasses the toggle but NOT workspace access (checked above).
    // WR-01: unlinkUploadIfPresent preserved BEFORE the 403 — multer already
    // wrote the file to UPLOADS_DIR; without cleanup repeated rejections fill
    // the disk (Pitfall 4, T-69-07).
    if (!(await assertNonAdminUploadAllowed(req, workspace, admin))) {
      // WR-01: clean up the multer upload before rejecting.
      unlinkUploadIfPresent(req);
      res.status(403).json({ error: "Uploads are restricted to admins in this workspace" });
      return;
    }

    // quick 260808-vzm: sanitize the client-supplied filename ONCE and use
    // it everywhere — docType detection, the stored Document.name, and the
    // name forwarded to the collector (so vector metadata and OCR titles
    // see the same sanitized name). The multer disk filename already routes
    // through getUniqueFilePath -> sanitizeFileName.
    const safeName = sanitizeFileName(req.file.originalname);

    // Determine document type from file extension
    const ext = path.extname(safeName).toLowerCase().replace(".", "");
    const typeMap: Record<string, string> = {
      pdf: "pdf",
      md: "md",
      txt: "txt",
      csv: "csv",
      docx: "docx",
      xlsx: "xlsx",
    };
    const docType = typeMap[ext] || "txt";

    // Create document record with pending status
    const cacheKey = `${req.file.filename}-${Date.now()}`;
    const document = await prisma.document.create({
      data: {
        workspaceId,
        name: safeName,
        type: docType,
        filePath: req.file.path,
        cacheKey,
        chunkCount: 0,
        embeddingModel,
        status: "pending",
        fileSize: req.file.size,
      },
    });

    // Read OCR model from system config (global default)
    const ocrModelSetting = await getSetting("OCR_DEFAULT_MODEL");
    const ocrModel = ocrModelSetting.value || "glm-ocr:latest";

    // Forward to collector for processing (async — don't block the response)
    // WR-03: defensive `.catch()` at the call site. forwardToCollector is
    // fire-and-forget (no await); its body is wrapped in try/catch, but if a
    // future edit introduces an await before the try, or if logger.error /
    // fs.existsSync throws synchronously inside the catch, the rejection
    // becomes an unhandled promise rejection that under Node ≥24's default
    // `--unhandled-rejections=throw` can crash the server process.
    void forwardToCollector(document.id, req.file.path, safeName, workspaceId, workspace.name, embeddingModel, docType, ocrModel)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error("[documents] forwardToCollector unhandled", { error: msg });
      });

    await logEvent("document", document.id, "upload", req.userId!);

    res.status(201).json(document);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/documents/:documentId — get document details with status
router.get("/:documentId", async (req: Request, res: Response) => {
  try {
    const document = await prisma.document.findFirst({
      where: withSoftDelete({ id: req.params.documentId as string, deletedAt: null }),
      include: { chunks: true, workspace: { include: { project: true } } },
    });

    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // D-04 (T-61-01): workspace access check applies to ALL users including admins.
    // Unlike rbac.ts requireWorkspaceAccess (where admin bypasses), the documents
    // route applies the semantic variation: admin requires workspace access here.
    const isProjectOwner = document.workspace?.project?.createdBy === req.userId;
    const hasWorkspaceAccess = await prisma.workspaceAccess.findFirst({
      where: { userId: req.userId!, workspaceId: document.workspaceId },
    });
    const hasProjectAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: document.workspace?.projectId },
    });
    if (!isProjectOwner && !hasWorkspaceAccess && !hasProjectAccess) {
      res.status(403).json({ error: "Access denied to this document" });
      return;
    }

    res.json(document);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/documents/:documentId/text — concatenated chunk text (DOC-01)
// Returns { text, length, name, type, status } — NEVER exposes filePath.
// IDOR/soft-delete gate mirrors GET /:documentId exactly (D-04: admin does NOT bypass).
router.get("/:documentId/text", async (req: Request, res: Response) => {
  try {
    const document = await prisma.document.findFirst({
      where: withSoftDelete({ id: req.params.documentId as string, deletedAt: null }),
      include: { chunks: true, workspace: { include: { project: true } } },
    });

    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // D-04 (T-78-01): workspace access check applies to ALL users including admins.
    const isProjectOwner = document.workspace?.project?.createdBy === req.userId;
    const hasWorkspaceAccess = await prisma.workspaceAccess.findFirst({
      where: { userId: req.userId!, workspaceId: document.workspaceId },
    });
    const hasProjectAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: document.workspace?.projectId },
    });
    if (!isProjectOwner && !hasWorkspaceAccess && !hasProjectAccess) {
      res.status(403).json({ error: "Access denied to this document" });
      return;
    }

    // chunkIndex is NOT a Prisma column — encoded in chunk.id as `${documentId}-${chunkIndex}`.
    // Sort client-side by parsing the trailing index segment.
    const sortedChunks = [...document.chunks].sort((a, b) => {
      const idxA = parseInt(a.id.split("-").pop()!, 10);
      const idxB = parseInt(b.id.split("-").pop()!, 10);
      return idxA - idxB;
    });
    const text = sortedChunks.map((c) => c.chunkText).join("\n\n");
    res.json({
      text,
      length: text.length,
      name: document.name,
      type: document.type,
      status: document.status,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/documents/bulk-delete — soft-delete up to 500 documents in ONE request
// (Quick 260815-gak). Replaces the N+1 sequential DELETE loop in DocumentsPage
// that exhausted the production rate-limiter bucket (200 req/min/IP) and
// surfaced as auth-like error states. Mirrors the single DELETE /:documentId
// route's access check (CR-01 D-04, applies to admins), $transaction
// soft-delete + chunk hard-delete, and fire-and-forget collector cleanup.
// Returns { deleted, failed } — partial success is normal (inaccessible or
// missing docs appear in failed[]).
router.post("/bulk-delete", requirePermission("document:delete"), async (req: Request, res: Response) => {
  try {
    const parsed = bulkDeleteDocumentsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
      return;
    }
    const { documentIds } = parsed.data;

    // Fetch all candidate docs in ONE query. Soft-delete-aware: already-deleted
    // docs are excluded (so a repeat bulk-delete reports them as "not found").
    // CR-01: include workspace+project for the D-04 access check below.
    const docs = await prisma.document.findMany({
      where: withSoftDelete({ id: { in: documentIds }, deletedAt: null }),
      select: { id: true, workspaceId: true, workspace: { include: { project: true } } },
    });
    const docMap = new Map(docs.map((d) => [d.id, d]));

    const failed: Array<{ id: string; error: string }> = [];
    const toDelete: typeof docs = [];

    // Per-document access check — CR-01 D-04 applies to ALL users including
    // admins (same gate as the single DELETE /:documentId route). Without this,
    // any document:delete holder could soft-delete documents in workspaces they
    // have no access to.
    for (const id of documentIds) {
      const doc = docMap.get(id);
      if (!doc) {
        failed.push({ id, error: "Document not found" });
        continue;
      }
      const isProjectOwner = doc.workspace?.project?.createdBy === req.userId;
      const hasWorkspaceAccess = await prisma.workspaceAccess.findFirst({
        where: { userId: req.userId!, workspaceId: doc.workspaceId },
      });
      const hasProjectAccess = await prisma.projectAccess.findFirst({
        where: { userId: req.userId!, projectId: doc.workspace?.projectId },
      });
      if (!isProjectOwner && !hasWorkspaceAccess && !hasProjectAccess) {
        failed.push({ id, error: "Access denied to this document" });
        continue;
      }
      toDelete.push(doc);
    }

    // D-07: hard-delete document_chunks in the same transaction as the
    // soft-delete. Prisma's onDelete: Cascade does NOT fire on soft-delete
    // (only on hard delete), so we must explicitly deleteMany the chunk rows
    // here — otherwise they become orphans that still surface in FTS.
    if (toDelete.length > 0) {
      const txOps: Prisma.PrismaPromise<unknown>[] = [];
      for (const doc of toDelete) {
        txOps.push(
          prisma.document.update({
            where: { id: doc.id },
            data: { deletedAt: new Date() },
          }),
        );
        txOps.push(
          prisma.documentChunk.deleteMany({
            where: { documentId: doc.id },
          }),
        );
      }
      await prisma.$transaction(txOps);

      for (const doc of toDelete) {
        await logEvent("document", doc.id, "delete", req.userId!);
      }

      // Fire-and-forget collector vector cleanup per deleted doc. The
      // soft-delete above hides the document from FTS, but the vector half of
      // hybridSearch calls the collector directly (no deletedAt awareness).
      // Fire-and-forget so the response is not blocked; on 2xx mark
      // vectorCleanupAt so the retry job (runVectorCleanupCycle) knows the
      // purge succeeded. On non-2xx, leave vectorCleanupAt null so the retry
      // job picks it up on the next cycle.
      const env = getEnv();
      for (const doc of toDelete) {
        // Pass workspaceName so the collector's buildCollectionName() resolves
        // the SAME collection used at ingest time (ws_<sanitizedName>_<shortId>).
        const purgeUrl = `${env.COLLECTOR_URL}/api/ingest/${encodeURIComponent(doc.id)}?workspaceId=${encodeURIComponent(doc.workspaceId)}&workspaceName=${encodeURIComponent(doc.workspace?.name ?? "")}`;
        // WR-03: 30s AbortController so a hung collector can't leak the socket.
        const purgeController = new AbortController();
        const purgeTimeoutId = setTimeout(() => purgeController.abort(), 30_000);
        void fetch(purgeUrl, {
          method: "DELETE",
          headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
          signal: purgeController.signal,
        })
          .then(async (resp) => {
            clearTimeout(purgeTimeoutId);
            if (resp.ok) {
              await prisma.document.update({
                where: { id: doc.id },
                data: { vectorCleanupAt: new Date() },
              });
            } else {
              logger.warn("[documents] bulk vector cleanup non-2xx", {
                documentId: doc.id,
                status: resp.status,
              });
            }
          })
          .catch((e: unknown) => {
            clearTimeout(purgeTimeoutId);
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn("[documents] bulk vector cleanup failed", { documentId: doc.id, error: msg });
          });
      }
    }

    const deleted = toDelete.map((d) => d.id);
    res.json({ deleted, failed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// DELETE /api/documents/:documentId — soft-delete a document
router.delete("/:documentId", requirePermission("document:delete"), async (req: Request, res: Response) => {
  try {
    // Fetch the document first so we know its workspaceId for the best-effort
    // vector cleanup below (the collector DELETE needs it to target the right
    // LanceDB table). Soft-delete-aware: a doc already soft-deleted is 404.
    // CR-01: include workspace+project for the D-04 access check below.
    const document = await prisma.document.findFirst({
      where: withSoftDelete({ id: req.params.documentId as string, deletedAt: null }),
      select: { id: true, workspaceId: true, workspace: { include: { project: true } } },
    });
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // CR-01 (D-04 regression): workspace access check applies to ALL users
    // including admins — same gate as GET /:id and POST /upload. Without this,
    // any `document:delete` holder (admin included) could soft-delete documents
    // in workspaces they have no access to, contradicting the D-04 policy the
    // phase enforces for read and upload.
    const isProjectOwner = document.workspace?.project?.createdBy === req.userId;
    const hasWorkspaceAccess = await prisma.workspaceAccess.findFirst({
      where: { userId: req.userId!, workspaceId: document.workspaceId },
    });
    const hasProjectAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: document.workspace?.projectId },
    });
    if (!isProjectOwner && !hasWorkspaceAccess && !hasProjectAccess) {
      res.status(403).json({ error: "Access denied to this document" });
      return;
    }

    // D-07: hard-delete document_chunks in the same transaction as the
    // soft-delete. Prisma's onDelete: Cascade does NOT fire on soft-delete
    // (it only fires on hard delete), so we must explicitly deleteMany the
    // chunk rows here — otherwise they become orphans that still surface in
    // FTS (Pitfall 5). vectorCleanupAt stays null (pending collector purge).
    await prisma.$transaction([
      prisma.document.update({
        where: { id: document.id },
        data: { deletedAt: new Date() },
      }),
      prisma.documentChunk.deleteMany({
        where: { documentId: document.id },
      }),
    ]);

    await logEvent("document", document.id, "delete", req.userId!);

    // WR-01 + D-08: best-effort vector cleanup. The soft-delete above hides
    // the document from FTS (ftsService filters `d."deletedAt" IS NULL`), but
    // the vector half of hybridSearch calls the collector directly, which has
    // no knowledge of `deletedAt`. Fire-and-forget a collector DELETE so the
    // chunks are purged from LanceDB/Qdrant too — must NOT block the DELETE
    // response. On 2xx, mark vectorCleanupAt so the retry job
    // (runVectorCleanupCycle) knows the purge succeeded. On non-2xx, leave
    // vectorCleanupAt null so the retry job picks it up on the next cycle.
    const env = getEnv();
    // Pass workspaceName so the collector's buildCollectionName() resolves the
    // SAME collection used at ingest time (ws_<sanitizedName>_<shortId>). Without
    // it, the collector falls back to ws_<fullUuid> — a collection that was never
    // written to — and the purge 404s on Qdrant, leaving vectors orphaned.
    const purgeUrl = `${env.COLLECTOR_URL}/api/ingest/${encodeURIComponent(document.id)}?workspaceId=${encodeURIComponent(document.workspaceId)}&workspaceName=${encodeURIComponent(document.workspace?.name ?? "")}`;
    // WR-03: 30s AbortController so a hung collector (TCP accept, no response)
    // can't leak the socket indefinitely. The fire-and-forget chain clears the
    // timeout inside `.then`/`.catch` so the timer never outlives the request.
    const purgeController = new AbortController();
    const purgeTimeoutId = setTimeout(() => purgeController.abort(), 30_000);
    void fetch(purgeUrl, {
      method: "DELETE",
      headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
      signal: purgeController.signal,
    })
      .then(async (resp) => {
        clearTimeout(purgeTimeoutId);
        if (resp.ok) {
          await prisma.document.update({
            where: { id: document.id },
            data: { vectorCleanupAt: new Date() },
          });
        } else {
          logger.warn("[documents] vector cleanup non-2xx", {
            documentId: document.id,
            status: resp.status,
          });
        }
      })
      .catch((e: unknown) => {
        clearTimeout(purgeTimeoutId);
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn("[documents] vector cleanup failed", { documentId: document.id, error: msg });
      });

    res.json({ message: "Document deleted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * OCR routing decision tree (D-03/D-04/D-07/D-08).
 *
 * Replaces the legacy `"eng"` sentinel at documents.ts:333 with a
 * config-driven decision tree. The server reads two SystemConfig keys
 * (OCR_ENABLED, OCR_PRECHECK_CHARS) and, combined with the pdf-parse
 * pre-check text length and the configured vision model, determines the
 * `ocrMode` signal forwarded to the collector. The collector-side OCR
 * fallback was removed in Phase 66.1 (ING-07); OCR is now unified on the
 * server-side vision path.
 *
 * Modes:
 *   - "skip"      — D-04 graceful degradation: text-only, ocrSkipped status
 *   - "text-only" — pdf-parse extracted enough text; skip vision OCR
 *   - "vision"    — server-side vision OCR path (existing ragOcrService)
 */
export interface OcrRoutingInput {
  ocrEnabled: string;
  precheckThreshold: number;
  ocrModel: string;
  pdfTextLength: number;
}

export interface OcrRoutingResult {
  ocrMode: "skip" | "text-only" | "vision";
  ocrSkipped?: string;
}

export function resolveOcrRouting(input: OcrRoutingInput): OcrRoutingResult {
  const { ocrEnabled, precheckThreshold, ocrModel, pdfTextLength } = input;

  // D-07: OCR_DISABLED — skip entirely
  if (ocrEnabled !== "true") {
    return { ocrMode: "skip", ocrSkipped: "OCR skipped: disabled by config" };
  }

  // D-08: pdf-parse pre-check — text PDFs skip vision OCR
  if (pdfTextLength > precheckThreshold) {
    return { ocrMode: "text-only" };
  }

  // Vision model available (any non-empty model is a vision model now that
  // the legacy sentinel has been removed — ING-07).
  const hasVisionModel = Boolean(ocrModel);
  if (hasVisionModel) {
    return { ocrMode: "vision" };
  }

  // D-04: graceful degradation — no vision model → text-only + ocrSkipped
  return { ocrMode: "skip", ocrSkipped: "OCR skipped: no vision model" };
}

/**
 * Extract text from a PDF using pdfjs-dist for the pre-check (D-08).
 * Returns the concatenated text of all pages (up to MAX_PRECHECK_PAGES).
 * This is a lightweight extraction — no rendering, no OCR. Used only to
 * decide whether vision OCR is needed.
 */
const MAX_PRECHECK_PAGES = 50;

async function extractPdfTextFirstPass(pdfPath: string): Promise<string> {
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfDoc = await pdfjsLib
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableAutoFetch: true,
      disableStream: true,
    })
    .promise;

  const totalPages = Math.min(pdfDoc.numPages, MAX_PRECHECK_PAGES);
  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pageTexts.push(pageText);
    } catch {
      // Skip pages that fail text extraction
    }
  }

  return pageTexts.join("\n").trim();
}

/**
 * Write extracted text to a temporary .txt file and return the path.
 * Used when vision OCR is skipped (text-only or D-04 degradation).
 */
function writeTempTextFile(text: string): string {
  const tmpPath = path.join(os.tmpdir(), `ocr-text-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, text, "utf-8");
  return tmpPath;
}

/**
 * Forward document to collector for async processing.
 * For PDFs with a vision OCR model configured, performs server-side OCR
 * first and sends the extracted text as a .txt file.
 * Updates status to "processing" on send, "failed" on error.
 *
 * INT-01 reuse: this function is also imported by
 * `packages/server/src/services/uploadDraftService.ts` (Phase 69) for the
 * unified-upload RAG leg (`dispatchRagLeg`). The signature, body, OCR
 * routing (text-only/vision/skip), multipart form-data construction,
 * `X-Collector-Secret` header, and status-update side effects MUST stay
 * byte-identical — the collector contract (IngestUploadBodySchema /
 * IngestStatusCallbackSchema in `packages/shared/src/schemas/ingest.schema.ts`)
 * depends on the exact multipart shape. Additive export only; do not edit
 * the body when extending the upload pipeline.
 *
 * 260829-fty: the trailing `options` parameter is the ONLY signature change.
 * Failure-time source-file cleanup is now caller-opt-out so the unified-upload
 * RAG leg can hand over a DRAFT-OWNED staged file
 * (storage/uploads/drafts/…) without the failure handler destroying it —
 * the WR-02 unlink was designed for the direct-upload multer tmp path.
 * Draft files are owned by uploadDraftReaperJob (A5 prefix guard) + the
 * DELETE route per the draft-file lifecycle invariant; only they may remove
 * them.
 */
export async function forwardToCollector(
  documentId: string,
  filePath: string,
  originalName: string,
  workspaceId: string,
  workspaceName: string,
  embeddingModel: string,
  docType: string,
  ocrModel: string,
  options?: { deleteSourceOnFailure?: boolean },
) {
  // delete flag defaults to TRUE — the direct-upload caller (documents.ts
  // upload route, no options) keeps the exact WR-02 cleanup behavior; only
  // an explicit { deleteSourceOnFailure: false } opts out (draft call path).
  const deleteSourceOnFailure = options?.deleteSourceOnFailure !== false;
  const env = getEnv();
  // Hoisted so the catch block can clean up a temp OCR text file (WR-02) even
  // when the failure occurs after the OCR routing chose a text-only / skip /
  // vision-success path that swapped `uploadFilePath` away from `filePath`.
  let uploadFilePath = filePath;

  try {
    // Update status to processing
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "processing" },
    });

    let uploadOriginalName = originalName;
    let uploadDocType = docType;
    let ocrSkipped: string | undefined;
    let collectorOcrMode: string | undefined;

    // OCR routing decision tree (D-03/D-04/D-07/D-08) — replaces "eng" sentinel
    if (docType === "pdf") {
      const ocrEnabled = (await getSetting("OCR_ENABLED")).value;
      const precheckThreshold = Number((await getSetting("OCR_PRECHECK_CHARS")).value || "200");

      // Pre-check: extract text via pdfjs-dist to determine if vision OCR is needed
      let pdfTextLength = 0;
      let pdfText = "";
      try {
        pdfText = await extractPdfTextFirstPass(filePath);
        pdfTextLength = pdfText.length;
      } catch (precheckErr: unknown) {
        const msg = precheckErr instanceof Error ? precheckErr.message : String(precheckErr);
        logger.warn(`[documents] PDF pre-check failed for ${originalName}, proceeding with OCR routing`, { error: msg });
      }

      const routing = resolveOcrRouting({
        ocrEnabled,
        precheckThreshold,
        ocrModel,
        pdfTextLength,
      });

      ocrSkipped = routing.ocrSkipped;

      switch (routing.ocrMode) {
        case "text-only": {
          // pdf-parse extracted enough text — skip vision OCR, ingest text-only
          uploadFilePath = writeTempTextFile(pdfText);
          uploadOriginalName = originalName.replace(/\.pdf$/i, ".txt");
          uploadDocType = "txt";
          collectorOcrMode = "skip"; // text already extracted, collector skips OCR
          logger.info(`[documents] PDF "${originalName}" has ${pdfTextLength} chars (>${precheckThreshold}), skipping vision OCR — text-only ingestion`);
          break;
        }
        case "vision": {
          // Vision OCR path (existing) — server-side ragOcrService
          try {
            logger.info(`[documents] Running vision OCR for ${originalName} with model ${ocrModel}`);
            const ocrResult = await extractTextFromPdf(filePath, ocrModel);
            uploadFilePath = ocrResult.textFilePath;
            uploadOriginalName = originalName.replace(/\.pdf$/i, ".txt");
            uploadDocType = "txt";
            collectorOcrMode = "skip"; // vision OCR done server-side, collector skips OCR
            logger.info(`[documents] Vision OCR complete: ${ocrResult.pageCount} pages, ${ocrResult.totalTokens} tokens`);
          } catch (ocrErr: unknown) {
            const message = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
            logger.error(`[documents] Vision OCR failed, falling back to PDF ingestion`, {
              originalName,
              error: message,
            });
            // D-04: salvage any precheck text (pdfText) the server already
            // extracted, so it is not silently lost. Surface the vision-OCR
            // failure via ocrSkipped so the user sees a statusMessage instead
            // of a silently-completed 0-chunk document (CR-01 fix).
            if (pdfTextLength > 0) {
              uploadFilePath = writeTempTextFile(pdfText);
              uploadOriginalName = originalName.replace(/\.pdf$/i, ".txt");
              uploadDocType = "txt";
            }
            ocrSkipped = `Vision OCR failed: ${message}`;
            collectorOcrMode = "skip";
          }
          break;
        }
        case "skip": {
          // D-04 graceful degradation — text-only with ocrSkipped status
          if (pdfTextLength > 0) {
            uploadFilePath = writeTempTextFile(pdfText);
            uploadOriginalName = originalName.replace(/\.pdf$/i, ".txt");
            uploadDocType = "txt";
          }
          collectorOcrMode = "skip";
          logger.warn(`[documents] PDF "${originalName}" OCR skipped: ${ocrSkipped ?? "no vision model"} — text-only ingestion (D-04)`);
          break;
        }
      }
    }

    const fileBuffer = fs.readFileSync(uploadFilePath);
    const blob = new Blob([fileBuffer]);
    const formData = new FormData();
    formData.append("file", blob, uploadOriginalName);
    formData.append("documentId", documentId);
    formData.append("workspaceId", workspaceId);
    formData.append("workspaceName", workspaceName);
    formData.append("embeddingModel", embeddingModel);
    formData.append("docType", uploadDocType);
    // Forward the ocrMode signal to the collector for routing (D-03/D-04)
    if (collectorOcrMode) {
      formData.append("ocrMode", collectorOcrMode);
    }
    if (ocrSkipped) {
      formData.append("ocrSkipped", ocrSkipped);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300_000);

    const response = await fetch(`${env.COLLECTOR_URL}/api/ingest`, {
      method: "POST",
      body: formData,
      signal: controller.signal,
      headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
    });
    clearTimeout(timeoutId);

    // Clean up temp OCR text file if we created one
    if (uploadFilePath !== filePath) {
      await cleanupOcrTextFile(uploadFilePath);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(
        `Collector error (${response.status}): ${errorData.error}${errorData.details ? ` — ${errorData.details}` : ""}`,
      );
    }

    const result = (await response.json()) as {
      chunkCount?: number;
      chunks?: { chunkIndex: number; chunkText: string; paragraph?: number; charStart?: number; charEnd?: number }[];
    };
    const chunkCount = result.chunkCount ?? 0;

    // Save chunks to PostgreSQL for FTS (full-text search via tsvector)
    if (result.chunks && result.chunks.length > 0) {
      try {
        // Delete existing chunks for this document (in case of re-processing)
        await prisma.$executeRaw`DELETE FROM "document_chunks" WHERE "documentId" = ${documentId}`;

        // RAG-04 (D-07/D-08): batched `unnest` INSERT replacing the one-by-one
        // loop (N round-trips -> N/500). Five array params per batch, fixed
        // regardless of batch size, so PostgreSQL's 65535-param limit is
        // respected by construction. Wave 0 spike (helpers/unnestSpike.ts)
        // confirmed Prisma 7.8 binds a JS array as a single text[] param when
        // the placeholder is cast ::text[]. `metadata` is String @db.Text
        // (Landmine L1) — NO ::jsonb cast; the array holds JSON.stringify
        // strings verbatim, byte-equal to the prior one-by-one loop.
        // `createdAt = NOW()` evaluates once per statement (sub-ms difference
        // from the prior per-row NOW(), accepted per D-07).
        // Bug A alignment preserved: embeddingId === chunkId (`${documentId}-${chunkIndex}`).
        const FTS_BATCH_SIZE = 500;
        for (let i = 0; i < result.chunks.length; i += FTS_BATCH_SIZE) {
          const batch = result.chunks.slice(i, i + FTS_BATCH_SIZE);
          const ids = batch.map((c) => `${documentId}-${c.chunkIndex}`);
          const docIds = batch.map(() => documentId);
          const texts = batch.map((c) => c.chunkText);
          const metas = batch.map((c) =>
            JSON.stringify({ paragraph: c.paragraph, charStart: c.charStart, charEnd: c.charEnd }),
          );
          const embIds = ids; // Bug A alignment preserved (embeddingId === chunkId)
          await prisma.$queryRaw`
            INSERT INTO "document_chunks" ("id", "documentId", "chunkText", "metadata", "embeddingId", "searchVector", "searchVectorMulti", "createdAt")
            SELECT t.id, t.documentId, t.chunkText, t.metadata, t.embeddingId,
                   to_tsvector('english', t.chunkText),
                   (SELECT ${Prisma.raw(MULTI_CONFIG_TSVECTOR)} FROM (SELECT t.chunkText::text AS t) AS t),
                   NOW()
            FROM unnest(
              ${ids}::text[],
              ${docIds}::text[],
              ${texts}::text[],
              ${metas}::text[],
              ${embIds}::text[]
            ) AS t(id, documentId, chunkText, metadata, embeddingId)
          `;
        }
        logger.info(`[documents] Saved ${result.chunks.length} chunks to PostgreSQL FTS for document ${documentId}`);
      } catch (ftsErr: unknown) {
  const message = ftsErr instanceof Error ? ftsErr.message : String(ftsErr);
        logger.error(`[documents] Failed to save chunks to PostgreSQL FTS for document ${documentId}: ${message}`);
        // Non-blocking: vector search still works even if FTS insert fails
      }
    }

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "completed", chunkCount },
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[documents] Collector processing failed:", { error: message });

    // Update status to failed
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "failed", statusMessage: message || "Collector processing failed" },
    }).catch(() => {}); // Don't crash if document was deleted in the meantime

    // Clean up temp file on failure (WR-02): clean BOTH the original multer
    // upload (`filePath`) AND any temp OCR text file we created
    // (`uploadFilePath`). Previously only `filePath` was cleaned here, so a
    // collector fetch failure after a text-only / skip / vision-success OCR
    // routing orphaned the temp text file in os.tmpdir() indefinitely.
    //
    // 260829-fty: the source-file unlink is now gated on deleteSourceOnFailure
    // (default true = direct-upload back-compat). When the caller opted out
    // (dispatchRagLeg — draft-owned staged file), the file is left in place:
    // draft files are owned by uploadDraftReaperJob (A5 prefix guard) + the
    // DELETE route, per the draft-file lifecycle invariant. The temp OCR
    // text-file cleanup below stays UNCONDITIONAL — that file is
    // server-created in os.tmpdir() and always safe to delete.
    try {
      if (deleteSourceOnFailure && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
    if (uploadFilePath && uploadFilePath !== filePath) {
      try { await cleanupOcrTextFile(uploadFilePath); } catch { /* ignore */ }
    }
  }
}

export default router;
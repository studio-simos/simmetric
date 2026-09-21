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
import { tenantContextMiddleware } from "../middleware/tenantContext";
// Phase 189 (D-13, Plan 04 gate swap): the graded write gate is ENFORCED
// (bypassAdmin:false — D-04 upload normalization, Pitfall 2; the binary gate
// on this route retired with the flip). The INLINE D-04 checks on the
// document READ routes (GET /:documentId, /text, bulk-delete loop, DELETE)
// KEEP their inline access checks as the gate in BOTH modes (Plan 02's
// read-half deviation).
import { requirePermission, requireWorkspaceWriteAccess } from "../middleware/rbac";
import { assertNonAdminUploadAllowed } from "../middleware/uploadGate";
import prisma, { withSoftDelete } from "../utils/prisma";
import { getEnv } from "../config/env";
import { logEvent } from "../services/eventLogService";
import { getSetting } from "../services/systemConfigService";
import { extractTextFromPdf, cleanupOcrTextFile } from "../services/ragOcrService";
import { logger } from "../utils/logger";
import { getUniqueFilePath, isDraftsPath, isDraftStorageKey } from "../utils/fileUtils";
import { getPdfStandardFontDataUrl } from "../utils/pdfjsFonts";
import { describeFetchFailureCause } from "../utils/fetchDiagnostics";
import { collectorDispatchAgent } from "../utils/collectorDispatchAgent";
import { getStorageProvider } from "../services/storageProvider";
import { IngestStatusCallbackSchema, sanitizeFileName, bulkDeleteDocumentsSchema } from "@simmetric-chat/shared";
// Phase 192 (D-10): preview unmask query contract + entity-map re-composition.
import { dlpUnmaskQuerySchema } from "@simmetric-chat/shared";
import { buildRecompositionMap, buildPlaceholderRegex } from "../services/dlpEntityService";
import { resolveWorkspaceRole } from "../middleware/rbac";
import { getEffectivePermissions } from "../utils/auth";
import { z } from "zod";
import { isAdmin } from "../utils/auth";
import { Prisma } from "@prisma/client";
import { MULTI_CONFIG_TSVECTOR } from "../services/ftsService";

/**
 * Strip NUL bytes from text destined for a Postgres text/tsvector column
 * (2026-09-21 AI-ACT.pdf incident). pdfjs/pdf-parse emit U+0000 for glyphs
 * certain PDF font encodings cannot map; PostgreSQL rejects 0x00 with
 * SQLSTATE 22021 (`invalid byte sequence for encoding "UTF8": 0x00`) and the
 * non-blocking FTS insert failure left the document "completed" with ZERO
 * document_chunks rows → viewer "No extracted text" + FTS silently blind.
 * The collector now strips at parse time (parser.ts stripNulCharacters);
 * these server-side call sites are defense-in-depth for the precheck text
 * path (writeTempTextFile) and any chunk text crossing raw SQL.
 */
function stripNul(text: string): string {
  return text.replaceAll("\u0000", "");
}

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
//
// Phase 185 (D-05/D-08, T-185-08 — BYPASS SURFACE, citeable in the org-b
// suite): the collector is a service-to-service caller with NO principal —
// the request never passes a tenant slot, so no ALS store exists. Setting
// req.tenantBypass = true inside the secret-pass branch makes the bypass
// intent EXPLICIT and citeable: any downstream route slot added later runs
// the bypass arm of tenantContextMiddleware, and the absent-store +
// extension-skip semantics (185-01 spike probe 9) keep the collector-driven
// updateMany flow unscoped. Contract byte-identical: no new status codes,
// no new response fields.
router.put("/:documentId/status", async (req: Request, res: Response) => {
  try {
    const secret = String(req.headers["x-collector-secret"] ?? "");
    if (!secretEquals(secret, getEnv().COLLECTOR_SECRET)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // D-05 bypass sentinel (see block comment above) — set ONLY after the
    // constant-time secret compare passes (never on open routes, T-185-08).
    req.tenantBypass = true;

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

    // quick 260918-p3h (T-P3H-04, race guard): a cancellation beats a racing
    // collector terminal callback — re-read the row FIRST and refuse
    // completed/failed over a CANCELLED row. Return 200 with the row
    // UNCHANGED (the collector treats the callback as delivered; no retry
    // storm) and skip the terminal cleanup block entirely.
    const current = await prisma.document.findUnique({
      where: { id: req.params.documentId as string },
      select: { id: true, status: true },
    });
    if (current?.status === "cancelled" && (status === "completed" || status === "failed")) {
      logger.info("[documents] terminal callback suppressed: document already cancelled", {
        documentId: req.params.documentId,
        incomingStatus: status,
      });
      res.json(current);
      return;
    }

    // quick 260918-p3h (D-2): additive progress notify — the collector PUTs
    // status "processing" with a progress % between ingest boundaries. The
    // write is idempotent with the row it races (row is already "processing").
    // Terminal statuses keep the exact legacy write path below.
    const isProgressNotify = status === "processing" && typeof parsed.data.progress === "number";

    const updateData: Prisma.DocumentUpdateInput = { status };
    if (typeof chunkCount === "number") updateData.chunkCount = chunkCount;
    if (statusMessage) updateData.statusMessage = statusMessage;
    if (typeof parsed.data.progress === "number") updateData.progress = parsed.data.progress;

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
    //
    //   Phase 184 (SAAS-03 D-08): the guard branches on the row's storageKey
    //   via isDraftStorageKey (trailing-sep new-layout arm + isDraftsPath
    //   legacy delegation) and the cleanup arm deletes through the provider
    //   (provider.delete(storageKey) — LocalFS legacy keys resolve
    //   byte-identically to today's unlink). Rows with a null storageKey
    //   (belt-and-braces for any pre-backfill row) keep the exact
    //   fs.existsSync+unlinkSync shape. The d6ef3403 invariant is preserved:
    //   draft-owned keys are NEVER deleted here.
    if (!isProgressNotify && (status === "completed" || status === "failed")) {
      if (document.storageKey && isDraftStorageKey(document.storageKey)) {
        logger.info(
          "[documents] terminal status callback suppressed unlink of draft-owned storage key (draft-file lifecycle invariant, 260829-jv7 D-01)",
          { documentId: document.id, storageKey: document.storageKey },
        );
      } else if (document.storageKey) {
        try {
          await (await getStorageProvider(document.organizationId ?? undefined)).delete(document.storageKey);
        } catch {
          // File cleanup is best-effort
        }
      } else if (document.filePath && isDraftsPath(document.filePath)) {
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

// GET /api/documents/:documentId/status — collector-secret-authed cancellation
// poll (quick 260918-p3h, T-P3H-01). Same posture as the sibling PUT above:
// constant-time secretEquals + req.tenantBypass inside the secret-pass branch.
// The collector polls this between work units (phases / embed slices) to
// observe a user cancellation. Response is LIMITED to { status, progress } —
// never name/filePath/storageKey/secrets. Defined BEFORE router.use
// (authMiddleware) exactly like the PUT.
router.get("/:documentId/status", async (req: Request, res: Response) => {
  try {
    const secret = String(req.headers["x-collector-secret"] ?? "");
    if (!secretEquals(secret, getEnv().COLLECTOR_SECRET)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // D-05 bypass sentinel — set ONLY after the constant-time secret compare
    // passes (same discipline as the PUT callback, T-185-08).
    req.tenantBypass = true;

    // T-P3H-01: minimal projection — run-state only.
    const document = await prisma.document.findUnique({
      where: { id: req.params.documentId as string },
      select: { status: true, progress: true },
    });
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json({ status: document.status, progress: document.progress });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

router.use(authMiddleware);
// Phase 185 (D-09): chain order auth → tenant → permission. The tenant
// middleware resolves req.organizationId (D-01 membership lookup) and opens
// the ALS tenant run before any rbac/license gate.
router.use(tenantContextMiddleware);

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

    // Phase 192 plan 10 (Gap 3 — UI-SPEC surface 3): one query arm maps the
    // DlpEntity relation count onto each served row as dlpEntityCount — no
    // per-row client fan-out, no N+1. COUNT ONLY (no-PII discipline): entity
    // VALUES/classes never cross this route; unscanned legacy docs
    // legitimately report 0 (the chip renders nothing — dlpChip keys on
    // dlpScanState first). The Prisma _count wrapper is stripped before
    // res.json; the response stays additive (an extra field per row).
    const documents = await prisma.document.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { dlpEntities: true },
        },
      },
    });
    res.json(
      documents.map(({ _count, ...doc }) => ({
        ...doc,
        dlpEntityCount: _count.dlpEntities,
      })),
    );
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
router.post("/upload", uploadSingle("file"), requirePermission("document:write"), requireWorkspaceWriteAccess({ bypassAdmin: false }), async (req: Request, res: Response) => {
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
    // Phase 184 (SAAS-03, D-05): provider key — prefix derived ONLY from the
    // row's workspace.organizationId (row's-org rule, T-184-01: never client
    // input; TenantContext does not exist until Phase 185). filePath stays
    // (additive policy); new-layout key lands in the same create (no @default
    // on the column — write sites set it explicitly).
    const storageKey = `${workspace.organizationId}/uploads/${crypto.randomUUID()}-${safeName}`;
    const document = await prisma.document.create({
      data: {
        workspaceId,
        name: safeName,
        type: docType,
        filePath: req.file.path,
        storageKey,
        cacheKey,
        chunkCount: 0,
        embeddingModel,
        status: "pending",
        fileSize: req.file.size,
      },
    });

    // Phase 184 (SAAS-03, T-184-06): put AFTER the row lands — an interrupted
    // put leaves a recoverable pending/failed row (never corrupt), and a
    // retry writing the SAME key overwrites idempotently (LocalFSProvider
    // copyFileSync semantics). The multer tmp is an ingress buffer, not
    // storage: it is unlinked best-effort once the bytes are in the provider
    // (WR-01/WR-02 keep guarding the pre-row rejection paths — D-08).
    const provider = await getStorageProvider(workspace.organizationId);
    await provider.put(req.file.path, storageKey);
    try {
      fs.unlinkSync(req.file.path);
    } catch {
      // Best-effort ingress cleanup — the tmp is a buffer, never storage.
    }

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
    void forwardToCollector(document.id, req.file.path, safeName, workspaceId, workspace.name, embeddingModel, docType, ocrModel, {
      storageKey,
      organizationId: workspace.organizationId,
    })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error("[documents] forwardToCollector unhandled", { error: msg });
      });

    await logEvent("document", document.id, "upload", req.userId!);

    res.status(201).json(document);
  } catch (err: unknown) {
    // Phase 184 (T-184-06): an interrupted upload (provider.put throw after
    // the DB row) must not leave a dangling multer tmp — the ingress buffer
    // is cleaned here so the only durable residue is the recoverable
    // pending row. WR-01 semantics: best-effort, never masks the 500.
    unlinkUploadIfPresent(req);
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
//
// Phase 192 (D-10): server-side redaction by default — the joined text is
// the chunkText AS STORED (masked post-scan, structural inheritance). The
// ?unmask=true opt-in arm re-composes placeholders from the DlpEntity map
// (decrypt via buildRecompositionMap) ONLY for callers passing the D-04
// access gate AND holding dlp:unmask via the Phase 189 single resolver
// (resolveWorkspaceRole) in a workspace with the DLP toggle on. The entity
// map loads ONLY after the access gate passes (cost + leak discipline).
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

    // Phase 192 (D-10): parse the unmask opt-in — strict literal-union
    // schema (only "true"/"false" case-insensitive; ?unmask=banana is a
    // 400, never a silent unmask attempt — T-192-21). The access gate has
    // already passed above.
    const unmaskQuery = dlpUnmaskQuerySchema.safeParse(req.query);
    let unmaskRequested = false;
    if (!unmaskQuery.success) {
      res.status(400).json({ error: "Invalid query parameter", details: unmaskQuery.error.flatten().fieldErrors });
      return;
    }
    unmaskRequested = unmaskQuery.data.unmask === true;

    let text = sortedChunks.map((c) => c.chunkText).join("\n\n");

    if (unmaskRequested) {
      // Unmask arm — the workspace toggle gates the whole DLP surface
      // (toggle-off → masked text, never an error: the server enforces,
      // the UI hides — UI-SPEC rule). resolveWorkspaceRole is the Phase 189
      // single-resolver contract (admin bypass rides its admin arm; never
      // a parallel role check — role resolution happens ONLY through the
      // resolver, never a direct access-row read here).
      const ws = await prisma.workspace.findUnique({
        where: { id: document.workspaceId },
        select: { dlpDocumentScanEnabled: true },
      });
      if (ws?.dlpDocumentScanEnabled) {
        const role = await resolveWorkspaceRole(req.userId!, document.workspaceId, req.user);
        if (role) {
          const perms = getEffectivePermissions(req.user);
          if (perms.includes("dlp:unmask")) {
            // Permission held — load the entity map (ONLY now, post-gate)
            // and re-substitute per chunk. Unresolvable placeholders stay
            // literal (partial unmask, never an error).
            const map = await buildRecompositionMap([document.id]);
            if (map.size > 0) {
              text = sortedChunks
                .map((c) => {
                  let chunkText = c.chunkText;
                  for (const [placeholder, original] of map) {
                    if (!chunkText.includes(placeholder.slice(1, -1))) continue;
                    chunkText = chunkText.replace(buildPlaceholderRegex(placeholder), original);
                  }
                  return chunkText;
                })
                .join("\n\n");
            }
          }
        }
      }
      // Any unmask-miss arm (toggle off / no role / no permission) falls
      // through with the MASKED text — a 200 with masked content, never a
      // 4xx oracle distinguishing entitlement from content.
    }

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

// POST /api/documents/:documentId/cancel — cooperative per-document
// cancellation while ingestion is running (quick 260918-p3h, T-P3H-02).
//
// Access posture mirrors the DELETE route above (CR-01 D-04): findFirst
// deletedAt:null + the workspace-access OR filter applied to ALL users
// including admins. Permission: document:write (NOT document:delete — the
// cancel is a write-shaped lifecycle action available to editors, matching
// the PEND-01 rationale for the draft DELETE route).
//
// Cooperative: the endpoint flips the row to "cancelled"(+cancelledAt); the
// collector observes it on its next status poll between work units and
// terminates. The race guards (PUT callback + forwardToCollector) keep the
// row cancelled when a completing ingest races the flip (T-P3H-04).
router.post("/:documentId/cancel", requirePermission("document:write"), async (req: Request, res: Response) => {
  try {
    const document = await prisma.document.findFirst({
      where: withSoftDelete({ id: req.params.documentId as string, deletedAt: null }),
      select: { id: true, status: true, workspaceId: true, workspace: { include: { project: true } } },
    });
    if (!document) {
      res.status(404).json({ error: "Document not found" });
      return;
    }

    // CR-01 D-04: workspace access check applies to ALL users including
    // admins — same gate as the DELETE route above (IDOR posture T-P3H-02).
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

    // Only in-flight rows are cancellable — completed/failed/cancelled rows
    // get a 409 so a stale UI cannot flip a settled row.
    if (document.status !== "pending" && document.status !== "processing") {
      res.status(409).json({ error: "Document is not processing" });
      return;
    }

    await prisma.document.update({
      where: { id: document.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        statusMessage: "Cancelled by user",
      },
    });

    // T-P3H-06: who cancelled? — same logEvent discipline as DELETE.
    await logEvent("document", document.id, "document.cancelled", req.userId!);

    logger.info("[documents] Document cancelled by user", {
      documentId: document.id,
      userId: req.userId,
    });
    res.json({ id: document.id, status: "cancelled" });
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
      standardFontDataUrl: getPdfStandardFontDataUrl(),
    })
    .promise;
  return runPdfPrecheck(pdfDoc);
}

/**
 * Phase 184 (SAAS-03, D-06): provider-key variant of the pre-check — reads
 * the pdf bytes via provider.get(storageKey) instead of fs.readFileSync.
 * pdfjs already consumes { data: Uint8Array } (the shape used above), so the
 * Buffer arrives unchanged; only the byte source branches (Pitfall 2 — the
 * multer tmp is gone after put).
 */
async function extractPdfTextFirstPassFromBuffer(pdfBuffer: Buffer): Promise<string> {
  const pdfDoc = await pdfjsLib
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableAutoFetch: true,
      disableStream: true,
      standardFontDataUrl: getPdfStandardFontDataUrl(),
    })
    .promise;
  return runPdfPrecheck(pdfDoc);
}

async function runPdfPrecheck(pdfDoc: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>): Promise<string> {
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
 * Phase 184 (D-06): materialize a provider-read Buffer into an os.tmpdir()
 * file for consumers whose contract is an fs path (extractTextFromPdf /
 * ragOcrService — unchanged this phase). The caller owns the unlink.
 */
function writeSourceBufferToTemp(buffer: Buffer, originalName: string): string {
  const ext = path.extname(originalName) || ".bin";
  const tmpPath = path.join(os.tmpdir(), `storage-src-${Date.now()}-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(tmpPath, buffer);
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
  options?: {
    deleteSourceOnFailure?: boolean;
    /** Phase 184 (SAAS-03 D-06): row-carried provider key — reads branch to provider.get when present. */
    storageKey?: string | null;
    /** Row's org for provider resolution (row's-org rule — never client input). */
    organizationId?: string;
  },
) {
  // delete flag defaults to TRUE — the direct-upload caller (documents.ts
  // upload route, no options) keeps the exact WR-02 cleanup behavior; only
  // an explicit { deleteSourceOnFailure: false } opts out (draft call path).
  const deleteSourceOnFailure = options?.deleteSourceOnFailure !== false;
  // Phase 184 (D-06): when the row carries a storageKey, every source read
  // (pdf pre-check, vision OCR, FormData blob) branches to provider.get —
  // the multer tmp was unlinked after put, so reading the old path would
  // ENOENT on new-layout rows (Pitfall 2). When absent (legacy rows /
  // pre-backfill), the fs.readFileSync arms stay byte-identical.
  const sourceKey = options?.storageKey ?? null;
  const sourceOrgId = options?.organizationId;
  const env = getEnv();
  // Hoisted so the catch block can clean up a temp OCR text file (WR-02) even
  // when the failure occurs after the OCR routing chose a text-only / skip /
  // vision-success path that swapped `uploadFilePath` away from `filePath`.
  let uploadFilePath = filePath;

  try {
    // Update status to processing — GUARDED (quick 260918-p3h, T-P3H-04 arm
    // a): updateMany keyed on the still-"pending" status. When count === 0
    // the row is already cancelled (or deleted) — a cancel-before-dispatch
    // race — so log and RETURN without dispatching to the collector.
    const processingClaim = await prisma.document.updateMany({
      where: { id: documentId, status: "pending" },
      data: { status: "processing" },
    });
    if (processingClaim.count === 0) {
      logger.info(
        `[documents] Skipping collector dispatch: document ${documentId} is no longer pending (cancelled or deleted)`,
      );
      return;
    }

    let uploadOriginalName = originalName;
    let uploadDocType = docType;
    let ocrSkipped: string | undefined;
    let collectorOcrMode: string | undefined;
    // Phase 184 (D-06): the source bytes when a storageKey is present — read
    // ONCE via the provider and reused by the pdf pre-check, the vision OCR
    // materialization, and the FormData blob (memory profile unchanged — the
    // code already buffers whole files).
    let sourceBuffer: Buffer | null = null;
    if (sourceKey) {
      const provider = await getStorageProvider(sourceOrgId);
      sourceBuffer = await provider.get(sourceKey);
    }

    // OCR routing decision tree (D-03/D-04/D-07/D-08) — replaces "eng" sentinel
    if (docType === "pdf") {
      const ocrEnabled = (await getSetting("OCR_ENABLED")).value;
      const precheckThreshold = Number((await getSetting("OCR_PRECHECK_CHARS")).value || "200");

      // Pre-check: extract text via pdfjs-dist to determine if vision OCR is needed
      let pdfTextLength = 0;
      let pdfText = "";
      try {
        // D-06 branch: provider-read Buffer when the row is key-carrying;
        // legacy fs.readFileSync arm byte-identical when absent.
        if (sourceBuffer) {
          pdfText = await extractPdfTextFirstPassFromBuffer(sourceBuffer);
        } else {
          pdfText = await extractPdfTextFirstPass(filePath);
        }
        // NUL-byte sanitize (0x00) before the text is written to the temp
        // .txt file and forwarded to the collector (mirrors parser.ts).
        pdfText = stripNul(pdfText);
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
            // D-06 branch: when the source is a provider key, materialize the
            // provider-read Buffer into an os.tmpdir() file so
            // extractTextFromPdf keeps its fs-path contract unchanged
            // (ragOcrService untouched); the temp is unlinked in a finally.
            if (sourceBuffer) {
              const ocrInputPath = writeSourceBufferToTemp(sourceBuffer, originalName);
              try {
                const ocrResult = await extractTextFromPdf(ocrInputPath, ocrModel);
                uploadFilePath = ocrResult.textFilePath;
                uploadOriginalName = originalName.replace(/\.pdf$/i, ".txt");
                uploadDocType = "txt";
                collectorOcrMode = "skip"; // vision OCR done server-side, collector skips OCR
                logger.info(`[documents] Vision OCR complete: ${ocrResult.pageCount} pages, ${ocrResult.totalTokens} tokens`);
              } finally {
                try { fs.unlinkSync(ocrInputPath); } catch { /* best-effort */ }
              }
            } else {
              const ocrResult = await extractTextFromPdf(filePath, ocrModel);
              uploadFilePath = ocrResult.textFilePath;
              uploadOriginalName = originalName.replace(/\.pdf$/i, ".txt");
              uploadDocType = "txt";
              collectorOcrMode = "skip"; // vision OCR done server-side, collector skips OCR
              logger.info(`[documents] Vision OCR complete: ${ocrResult.pageCount} pages, ${ocrResult.totalTokens} tokens`);
            }
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

    // D-06 branch: provider-read Buffer → Blob when the row is key-carrying
    // (the collector multipart + X-Collector-Secret contract is untouched —
    // the bytes arrive the same way they always have); legacy
    // fs.readFileSync arm byte-identical when absent.
    const fileBuffer = sourceBuffer ?? fs.readFileSync(uploadFilePath);
    const blob = new Blob([fileBuffer as unknown as BlobPart]);
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

    // quick 260918-gxs + 260918-p3h (D-1): the ingest wait cap is an
    // operator OPT-IN. UNSET = no cap (the dispatch runs unbounded — large
    // local CPU embeddings legitimately exceed any fixed limit; the cancel
    // endpoints are the relief valve). When the operator DOES configure the
    // key, the AbortController + the operator-actionable timeout message and
    // the k8n connection diagnostics keep working exactly as before.
    const ingestTimeoutMs = env.COLLECTOR_INGEST_TIMEOUT_MS;
    const capConfigured = typeof ingestTimeoutMs === "number" && ingestTimeoutMs > 0;
    const controller = new AbortController();
    const timeoutId = capConfigured ? setTimeout(() => controller.abort(), ingestTimeoutMs) : null;

    // globalThis.Response: the file-scope `Response` is Express's handler type
    let response: globalThis.Response;
    try {
      logger.info(
        `[documents] Dispatching to collector: id=${documentId} name="${originalName}" bytes=${fileBuffer.length} timeoutMs=${capConfigured ? ingestTimeoutMs : "unlimited"}`,
      );
      const dispatchInit = {
        method: "POST",
        body: formData,
        ...(capConfigured ? { signal: controller.signal } : {}),
        headers: { "X-Collector-Secret": env.COLLECTOR_SECRET },
        // quick 260918-j9m: bypass undici's global 300s headersTimeout — the
        // collector answers only after the full parse→chunk→embed pipeline,
        // which legitimately exceeds 5 min for large local-embedded PDFs.
        // D-1's "unbounded unless COLLECTOR_INGEST_TIMEOUT_MS" intent must
        // hold at the transport layer too; keepAlive still surfaces a dead
        // collector as ECONNRESET/UND_ERR_SOCKET.
        dispatcher: collectorDispatchAgent,
      } as unknown as Parameters<typeof fetch>[1];
      response = await fetch(`${env.COLLECTOR_URL}/api/ingest`, dispatchInit);
    } catch (fetchErr: unknown) {
      if (controller.signal.aborted) {
        const cappedTimeoutMs = ingestTimeoutMs as number;
        throw new Error(
          `Collector ingest timed out after ${Math.round(cappedTimeoutMs / 1000)}s — raise COLLECTOR_INGEST_TIMEOUT_MS or retry the document from its upload draft`,
          { cause: fetchErr },
        );
      }
      // quick 260918-k8n: undici surfaces connection-level failures as a
      // bare TypeError("fetch failed") — the real reason (ECONNREFUSED,
      // ENOTFOUND, …) rides the `cause` chain this log line used to drop.
      // Enrich the server log with the cause + a COLLECTOR_URL reachability
      // hint (mirrors the timeout-hint style above); the rethrow below stays
      // untouched so the outer catch persists the SAME raw message into
      // statusMessage as before (no URL/secret reaches the user).
      const causeDetail = describeFetchFailureCause(fetchErr);
      if (causeDetail) {
        logger.error(
          `[documents] Collector fetch failed before response (connection error: ${causeDetail}) — check the collector service is running and that COLLECTOR_URL (${env.COLLECTOR_URL}) is reachable from this container`,
        );
      }
      throw fetchErr;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }

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
      status?: string;
    };

    // quick 260918-p3h (T-P3H-04 arm b): the collector returns
    // { status: "cancelled" } when the ingest was aborted mid-flight. Return
    // early — NO completed write, NO FTS chunk writes (the collector already
    // skipped the vector write; the row stays "cancelled").
    if (result.status === "cancelled") {
      logger.info(
        `[documents] Collector reports document ${documentId} was cancelled mid-ingest — skipping completion write`,
      );
      return;
    }

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
        //
        // $queryRaw-site disposition (T-185-10 register, 185-05 CR-04): raw
        // SQL bypasses the tenantScope extension by construction. This write
        // path is reachable only AFTER the route's document org assertion /
        // scoped findFirst resolved the document (the chunk write targets
        // `${documentId}` proven same-org upstream; the DELETE above is
        // keyed by the same documentId). archiveSearch.ts's read site
        // carries the matching disposition.
        const FTS_BATCH_SIZE = 500;
        for (let i = 0; i < result.chunks.length; i += FTS_BATCH_SIZE) {
          const batch = result.chunks.slice(i, i + FTS_BATCH_SIZE);
          const ids = batch.map((c) => `${documentId}-${c.chunkIndex}`);
          const docIds = batch.map(() => documentId);
          const texts = batch.map((c) => stripNul(c.chunkText));
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

    // Phase 192 (D-01): async post-ingest DLP scan — enqueue AFTER completion
    // so upload latency stays bounded; the scan consumes the extracted text +
    // collector chunks. The workspace toggle is read HERE (first gate; the
    // consumer re-reads it per job). Fire-and-forget with .catch — an enqueue
    // failure NEVER fails the ingest response (the document is complete
    // regardless). Toggle off (default) → no enqueue, no DLP surface.
    try {
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { dlpDocumentScanEnabled: true },
      });
      if (ws?.dlpDocumentScanEnabled) {
        const { enqueueDlpScan } = await import("../services/dlpDocumentScanJob");
        const docRow = await prisma.document.findUnique({
          where: { id: documentId },
          select: { organizationId: true },
        });
        if (docRow) {
          void enqueueDlpScan(documentId, workspaceId, docRow.organizationId).catch(
            (enqueueErr: unknown) => {
              logger.error("[documents] DLP scan enqueue failed (non-blocking)", {
                documentId,
                error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
              });
            },
          );
        }
      }
    } catch (dlpHookErr: unknown) {
      // Non-blocking by construction: any toggle-read failure only costs the
      // scan for this document — the ingest response is already written.
      logger.error("[documents] DLP enqueue hook failed (non-blocking)", {
        documentId,
        error: dlpHookErr instanceof Error ? dlpHookErr.message : String(dlpHookErr),
      });
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[documents] Collector processing failed:", { error: message });

    // quick 260918-p3h (T-P3H-04 arm c, race guard): re-read the row BEFORE
    // the failed write — if a user cancellation flipped it while the dispatch
    // was in flight, preserve "cancelled" (no failed write, no statusMessage
    // overwrite). Everything else keeps the exact legacy semantics.
    try {
      const currentStatus = await prisma.document.findUnique({
        where: { id: documentId },
        select: { status: true },
      });
      if (currentStatus?.status === "cancelled") {
        logger.info(
          `[documents] Failure path suppressed: document ${documentId} already cancelled — preserving cancelled status`,
        );
        return;
      }
    } catch (readErr: unknown) {
      const readMessage = readErr instanceof Error ? readErr.message : String(readErr);
      logger.warn(`[documents] Could not re-read document status before failed write: ${readMessage}`);
    }

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
    //
    // Phase 184 (D-06, Pitfall 1): when the row carries a storageKey, the
    // failure cleanup deletes through the PROVIDER (provider.delete) — a
    // plain existsSync(filePath) would silently be false on S3-backed rows
    // (tmp unlinked post-put) and the object would leak in the tenant
    // bucket. Draft legs pass deleteSourceOnFailure: false and stay
    // untouched; legacy rows (null storageKey) keep the exact
    // existsSync+unlink shape.
    try {
      if (sourceKey && deleteSourceOnFailure) {
        await (await getStorageProvider(sourceOrgId)).delete(sourceKey);
      } else if (!sourceKey && deleteSourceOnFailure && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch { /* ignore */ }
    if (uploadFilePath && uploadFilePath !== filePath) {
      try { await cleanupOcrTextFile(uploadFilePath); } catch { /* ignore */ }
    }
  }
}

export default router;
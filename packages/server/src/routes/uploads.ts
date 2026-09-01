// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 69 — Unified Upload route surface.
 *
 * Three routes:
 *   POST /api/uploads           — stage a file as an UploadDraft
 *                                 (parseStatus=uploaded, no Document row)
 *   POST /api/uploads/:id/assign — Promise.allSettled fan-out to RAG/KB
 *   GET  /api/uploads/pending    — list unassigned drafts (IDOR-scoped)
 *
 * `filePath` is NEVER returned in any response body (D-06, T-69-e). The
 * stage handler reuses the `unlinkUploadIfPresent` orphan-cleanup
 * pattern from `documents.ts:33` on every 400/403/404/500 path
 * (Pitfall 1, T-69-07) so repeated rejections cannot fill the disk.
 *
 * `DRAFTS_DIR` is a relative path ("storage/uploads/drafts") resolved
 * against `process.cwd()` — it mirrors the `UPLOADS_DIR = "storage/uploads/"`
 * precedent in `documents.ts:21`. `STORAGE_PATH` is intentionally NOT
 * consulted: it is not present in the `env.ts` Zod schema, so relying on
 * it would throw at runtime (B1 fix in RESEARCH.md).
 *
 * The router is exported as default; Plan 02 mounts it in `index.ts`
 * alongside the other `/api/*` routes and initialises the reaper there.
 */
import path from "path";
import fs from "fs";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { assertNonAdminUploadAllowed } from "../middleware/uploadGate";
import { assertArchiveAccess } from "../middleware/archiveAccess";
import prisma from "../utils/prisma";
import { getSetting } from "../services/systemConfigService";
import { getUniqueFilePath } from "../utils/fileUtils";
import { isAdmin } from "../utils/auth";
import { createUploadDraftSchema, createUploadDraftUrlSchema, assignDraftSchema, renameUploadSchema, sanitizeFileName } from "@simmetric-chat/shared";
import {
  dispatchUploadDraft,
  dispatchKbLegUrl,
  enrichDraftWithLegStatus,
  tryRestoreDraftFromOcrCopy,
  RAG_TERMINAL,
  KB_TERMINAL,
} from "../services/uploadDraftService";
import { logger } from "../utils/logger";

/**
 * Best-effort unlink of a multer upload that landed on disk before the
 * authorization / workspace-existence checks ran (Pitfall 1, T-69-07).
 * Mirrors `unlinkUploadIfPresent` in `documents.ts:33-37` — kept local to
 * avoid widening the additive export surface of `documents.ts`. The
 * middleware order is `upload.single("file")` → `requirePermission` →
 * handler, so multer writes the file to DRAFTS_DIR before any rejection
 * runs; repeated rejections can otherwise fill the disk.
 */
function unlinkUploadIfPresent(req: Request): void {
  if (req.file?.path) {
    try {
      fs.unlinkSync(req.file.path);
    } catch {
      /* best-effort — never mask the real rejection */
    }
  }
}

// DRAFTS_DIR mirrors documents.ts:21 UPLOADS_DIR = "storage/uploads/" — a
// relative path resolved against process.cwd(). STORAGE_PATH is NOT in the
// env.ts Zod schema, so a hardcoded relative path matches the codebase
// convention and avoids the B1 pitfall (RESEARCH.md).
const DRAFTS_DIR = "storage/uploads/drafts";
fs.mkdirSync(DRAFTS_DIR, { recursive: true });

// D-01 / T-76-02: A5 prefix guard for DELETE /:id best-effort unlink. Mirrors
// uploadDraftReaperJob.ts:110 — the trailing path.sep prevents a
// `drafts-evil` sibling-prefix match (Pitfall 5). URL drafts and traversal
// payloads are rejected naturally by the guard (NO mimeType special-case
// per Pitfall 3). STORAGE_PATH is NOT consulted (B1 fix — not in env.ts Zod).
const DRAFTS_BASE = path.resolve("storage/uploads/drafts") + path.sep;

// D-69-06 rule 1: images can only be assigned to the KB leg, never RAG.
// Kept local to mirror archiveImport.ts:47-52 (do NOT import from a sibling
// route file — that creates a cross-route cycle). Must stay in sync with
// archiveImport.ts when the KB MIME set changes.
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
]);

// D-69-06 rule 2 (Q1 correction): KB leg accepts the MIME in
// ALLOWED_ARCHIVE_MIME (archiveImport.ts:47-52) — plus the OCR-eligible set
// below. Must stay in sync with archiveImport.ts:47-52.
// quick 260829-xxx: text/plain + text/csv added (txt/csv→KB gap closed ahead
// of v0.13) — the collector's parse-only /api/ingest/archive-page endpoint
// already parses both (parseFile handles "txt" via parseText and "csv" via
// parseCsv, and its multer fileFilter already allows .txt/.csv), so the KB
// pipeline needed only this whitelist entry + the frontend mirror in
// UploadDestinationChooser.tsx (KB_ARCHIVE_MIME).
const ALLOWED_ARCHIVE_MIME = new Set([
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

// 71-02 D-13/D-14: KB leg now also accepts PDF + 4 image MIME via the OCR
// pipeline (dispatchKbLeg OCR branch → createOcrJob → auto-approve hook).
// The union of ALLOWED_ARCHIVE_MIME and KB_OCR_MIME is the full KB-eligible
// set at the assign route. Must stay in sync with `KB_OCR_IMAGE_MIME` in
// uploadDraftService.ts (single source of truth: `isOcrEligible`).
const KB_OCR_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
]);

function isKbEligible(mimeType: string): boolean {
  return ALLOWED_ARCHIVE_MIME.has(mimeType) || KB_OCR_MIME.has(mimeType);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DRAFTS_DIR),
  filename: (_req, file, cb) => {
    const uniquePath = getUniqueFilePath(DRAFTS_DIR, file.originalname);
    cb(null, path.basename(uniquePath));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB — matches createUploadDraftSchema
});

const router = Router();

/**
 * Workspace access check (D-69-08 base — admin included, no OR-toggle;
 * Phase 70 PRM-02 adds the allowMemberUploads path via the
 * `assertNonAdminUploadAllowed` helper invoked by the stage route).
 * Mirrors documents.ts:288-302 exactly: admin does NOT bypass workspace
 * access for upload staging (D-07 semantic variation). Returns the
 * workspace row (with `project` joined and `allowMemberUploads` scalar)
 * on success, or null on miss/forbidden.
 *
 * Side effects: writes the HTTP response (404/403) on failure. The
 * caller is responsible for any `unlinkUploadIfPresent(req)` cleanup
 * before returning.
 */
async function assertWorkspaceAccess(
  req: Request,
  res: Response,
  workspaceId: string,
): Promise<{ id: string; projectId: string; project?: { createdBy: string | null }; allowMemberUploads: boolean } | null> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    include: { project: true },
  });
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  const isProjectOwner = workspace.project?.createdBy === req.userId;
  const hasWorkspaceAccess = await prisma.workspaceAccess.findFirst({
    where: { userId: req.userId!, workspaceId: workspace.id },
  });
  const hasProjectAccess = await prisma.projectAccess.findFirst({
    where: { userId: req.userId!, projectId: workspace.projectId },
  });
  if (!isProjectOwner && !hasWorkspaceAccess && !hasProjectAccess) {
    res.status(403).json({ error: "Access denied to this workspace" });
    return null;
  }
  return workspace;
}

/**
 * Response serializers for UploadDraft — D-06 / T-69-e filePath hardening.
 *
 * `filePath` is a server-absolute path to a staged file on disk; leaking it
 * would expose the server filesystem layout. Each serializer projects a draft
 * onto an EXPLICIT allow-list of response fields. `filePath` is never
 * referenced, so future response shapes cannot accidentally re-include it —
 * the previous per-handler object literals relied on each handler remembering
 * to omit the field. The three variants mirror the three distinct response
 * shapes (stage / assign / pending); behavior is identical to the inlined
 * literals they replace.
 */
function serializeDraftStage(d: {
  id: string;
  parseStatus: string;
  expiresAt: Date;
  originalName: string;
  fileSize: number;
  mimeType: string;
}) {
  return {
    id: d.id,
    parseStatus: d.parseStatus,
    expiresAt: d.expiresAt,
    originalName: d.originalName,
    fileSize: d.fileSize,
    mimeType: d.mimeType,
  };
}

function serializeDraftAssign(
  d: { id: string },
  result: {
    parseStatus: string;
    ragResult: { status: string } | null;
    kbResult: { status: string } | null;
  },
) {
  return {
    id: d.id,
    parseStatus: result.parseStatus,
    ragResult: result.ragResult?.status ?? null,
    kbResult: result.kbResult?.status ?? null,
  };
}

function serializeDraftPending(d: {
  id: string;
  parseStatus: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  expiresAt: Date;
  ragStatus: string | null;
  kbStatus: string | null;
  ragEnabled: boolean;
  kbEnabled: boolean;
  assignedArchiveId: string | null;
}) {
  return {
    id: d.id,
    parseStatus: d.parseStatus,
    originalName: d.originalName,
    fileSize: d.fileSize,
    mimeType: d.mimeType,
    expiresAt: d.expiresAt,
    ragStatus: d.ragStatus,
    kbStatus: d.kbStatus,
    ragEnabled: d.ragEnabled,
    kbEnabled: d.kbEnabled,
    assignedArchiveId: d.assignedArchiveId,
  };
}

/**
 * POST /api/uploads — stage a draft.
 *
 * Multer writes the file to DRAFTS_DIR before the handler runs (same
 * middleware order as documents.ts:232). `unlinkUploadIfPresent(req)`
 * on every rejection path prevents orphan accumulation (T-69-07).
 *
 * `expiresAt` uses a NaN-safe fallback to 30 days (Pitfall 7, C2): a
 * corrupted `upload_draft_retention_days` config value cannot produce
 * an `Invalid Date` that Prisma would reject.
 */
router.post(
  "/",
  authMiddleware,
  requirePermission("document:write"),
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      // 71-02 D-17: URL stage body branch. When `req.body.sourceType === "url"`,
      // no file is attached — multer's `upload.single("file")` is a no-op for
      // non-multipart requests and `req.body` is populated by the global
      // express.json() middleware. Validate with the SEPARATE
      // `createUploadDraftUrlSchema` (do NOT weaken the multipart schema).
      // URL drafts are stored in existing UploadDraft columns: filePath=<url>,
      // mimeType="text/url" sentinel, originalName=<url>, fileSize=0.
      // The KB leg is dispatched immediately (no "unassigned" state for URLs —
      // the destination is implicit: KB only, no RAG).
      if (req.body?.sourceType === "url") {
        const parsed = createUploadDraftUrlSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid URL stage body",
            details: parsed.error.flatten().fieldErrors,
          });
          return;
        }

        const workspace = await assertWorkspaceAccess(req, res, parsed.data.workspaceId);
        if (!workspace) {
          return;
        }

        if (!(await assertNonAdminUploadAllowed(req, workspace, isAdmin(req.user)))) {
          res.status(403).json({ error: "Uploads are restricted to admins in this workspace" });
          return;
        }

        // D-06a: archive-ownership fail-closed (same check as the assign route).
        // URL drafts are KB-only — the archiveId is in the stage body, not the
        // assign body. 404 (missing/soft-deleted) vs 403 (exists, not owned).
        const access = await assertArchiveAccess(parsed.data.archiveId, req.userId!, req.user);
        if (!access.ok) {
          if (access.reason === "missing") {
            res.status(404).json({ error: "Archive not found" });
          } else {
            res.status(403).json({ error: "Access denied to this archive" });
          }
          return;
        }

        const retention = await getSetting("upload_draft_retention_days");
        const days = parseInt(retention.value, 10);
        const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
        const expiresAt = new Date(Date.now() + safeDays * 86400000);

        // Sentinel fields: filePath=<url>, mimeType="text/url", originalName=<url>,
        // fileSize=0. No file on disk — the URL OcrJob fetches content at
        // processing time. draftMimeTypeSchema 12-enum is UNCHANGED — "text/url"
        // is a sentinel stored directly, not validated through the enum.
        // KB leg is dispatched immediately — kbEnabled=true, assignedArchiveId
        // set, parseStatus="assigned" (no "unassigned" state for URL drafts).
        // ragEnabled stays false (URL drafts are KB-only by design).
        const draft = await prisma.uploadDraft.create({
          data: {
            uploadedBy: req.userId!,
            workspaceId: parsed.data.workspaceId,
            filePath: parsed.data.url,
            originalName: parsed.data.url,
            fileSize: 0,
            mimeType: "text/url",
            expiresAt,
            kbEnabled: true,
            ragEnabled: false,
            assignedArchiveId: parsed.data.archiveId,
            parseStatus: "assigned",
          },
        });

        // Dispatch the KB leg via the URL OcrJob pipeline (no file read).
        // The AIJ is created inside dispatchKbLegUrl; the auto-approve hook in
        // urlPipeline.ts flips it to COMPLETED when the URL OcrJob terminates.
        await dispatchKbLegUrl(draft, parsed.data.archiveId, parsed.data.url, parsed.data.ocrMode);

        res.status(201).json({
          id: draft.id,
          parseStatus: draft.parseStatus,
          expiresAt: draft.expiresAt,
          originalName: draft.originalName,
          fileSize: draft.fileSize,
          mimeType: draft.mimeType,
        });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }

      const parsed = createUploadDraftSchema.safeParse({
        workspaceId: req.body.workspaceId,
        originalName: req.body.originalName ?? req.file.originalname,
        fileSize: req.body.fileSize ? Number(req.body.fileSize) : req.file.size,
        mimeType: req.body.mimeType ?? req.file.mimetype,
      });
      if (!parsed.success) {
        unlinkUploadIfPresent(req);
        res.status(400).json({
          error: "Invalid metadata",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const workspace = await assertWorkspaceAccess(req, res, parsed.data.workspaceId);
      if (!workspace) {
        // assertWorkspaceAccess already wrote 404/403 with the right body.
        unlinkUploadIfPresent(req);
        return;
      }

      // Phase 70 PRM-02 / D-02: toggle OR gate (global ALLOW_NON_ADMIN_UPLOAD
      // || workspace.allowMemberUploads). Admin bypasses the toggle only.
      // WR-01: unlinkUploadIfPresent BEFORE the 403 — multer already wrote the
      // file to DRAFTS_DIR; without cleanup repeated rejections fill the disk.
      if (!(await assertNonAdminUploadAllowed(req, workspace, isAdmin(req.user)))) {
        unlinkUploadIfPresent(req);
        res.status(403).json({ error: "Uploads are restricted to admins in this workspace" });
        return;
      }

      // Pitfall 7 / C2: NaN-safe retention. A corrupted SystemConfig row
      // (e.g. "abc") yields NaN via parseInt; fall back to 30 days.
      const retention = await getSetting("upload_draft_retention_days");
      const days = parseInt(retention.value, 10);
      const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
      const expiresAt = new Date(Date.now() + safeDays * 86400000);

      const draft = await prisma.uploadDraft.create({
        data: {
          uploadedBy: req.userId!,
          workspaceId: parsed.data.workspaceId,
          filePath: req.file.path,
          // quick 260808-vzm: sanitize the staged name so the stored
          // originalName matches the sanitized disk filename and the name
          // shown in the UI. The URL branch (sourceType === "url") stores a
          // URL sentinel and is intentionally NOT sanitized (T-05 accept).
          originalName: sanitizeFileName(parsed.data.originalName),
          fileSize: parsed.data.fileSize,
          mimeType: parsed.data.mimeType,
          expiresAt,
          // Prisma defaults: ragEnabled=false, kbEnabled=false,
          // parseStatus="uploaded", ragJobId/kbJobId=null,
          // assignedArchiveId=null
        },
      });

      // D-06 / T-69-e: NEVER include filePath in a response body.
      res.status(201).json(serializeDraftStage(draft));
    } catch (err: unknown) {
      unlinkUploadIfPresent(req);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  },
);

/**
 * POST /api/uploads/:id/assign — fan-out dispatch.
 *
 * Pitfall 8: `requirePermission` is invoked with an array of both
 * `document:write` and `archive:write` (`.every()` semantics). A user
 * with only `document:write` cannot call assign even with
 * `{rag:true, kb:false}` — defense-in-depth, more conservative than a
 * body-conditional check.
 *
 * D-69-06 MIME restriction (both rules) is enforced BEFORE any dispatch:
 *   - image + rag=true → 400
 *   - kb=true + mimeType outside ALLOWED_ARCHIVE_MIME → 400 (Q1 correction)
 *
 * The dispatch response only reports the per-leg settle status. The
 * client polls GET /api/uploads/pending for derived terminal state.
 */
router.post(
  "/:id/assign",
  authMiddleware,
  requirePermission(["document:write", "archive:write"]),
  async (req: Request, res: Response) => {
    try {
      const parsed = assignDraftSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid assign body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      if (parsed.data.kb === true && !parsed.data.archiveId) {
        res.status(400).json({ error: "archiveId is required when kb is true" });
        return;
      }

      const draft = await prisma.uploadDraft.findUnique({
        where: { id: req.params.id as string },
      });
      if (!draft || draft.deletedAt !== null) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      // IDOR scope (D-69-08 base): the owner may assign directly; any
      // other caller must pass the same workspace-access check as the
      // stage route. Phase 70 D-07: admin non-bypass workspace access via
      // the local assertWorkspaceAccess (mirror documents.ts:381 semantic
      // variation — diverges from rbac.ts:requireWorkspaceAccess:117 which
      // bypasses admin). D-06 archive-ownership applied below when kb=true.
      if (draft.uploadedBy !== req.userId) {
        const workspace = await assertWorkspaceAccess(req, res, draft.workspaceId);
        if (!workspace) {
          // assertWorkspaceAccess wrote 404/403.
          return;
        }
      }

      // Idempotent re-assign blocked at terminal state (D-69-05).
      // EXCEPTION: if the draft reached "done" but one leg actually FAILED,
      // allow re-assignment so the user can retry the failed leg. Old drafts
      // that were marked "done" before the failure-aware fix (c9acdfb9) are
      // unblocked too — enrichDraftWithLegStatus is called to check the
      // actual leg statuses.
      if (draft.parseStatus === "done") {
        const enriched = await enrichDraftWithLegStatus(draft);
        const ragFailed = draft.ragEnabled && enriched.ragStatus === "failed";
        const kbFailed = draft.kbEnabled && enriched.kbStatus === "FAILED";
        if (!ragFailed && !kbFailed) {
          res.status(409).json({ error: "Draft already finalized" });
          return;
        }
        // Fall through — allow re-assignment of the failed leg(s).
        // Reset parseStatus to "assigned" so the draft is re-processed.
        await prisma.uploadDraft.update({
          where: { id: draft.id },
          data: { parseStatus: "assigned" },
        });
      }

      // D-69-06 rule 1: image + rag → 400 (before any dispatch).
      if (parsed.data.rag === true && IMAGE_MIME_TYPES.has(draft.mimeType)) {
        res.status(400).json({
          error: "Images can only be assigned to Knowledge Base, not RAG",
          details: { mimeType: draft.mimeType, rag: true },
        });
        return;
      }

      // 71-02 D-13/D-14: KB accepts .md/.txt/.csv/.xlsx/.docx/.pptx (collector
      // parse — txt/csv since quick 260829-xxx) AND PDF + 4 image MIME (OCR
      // pipeline via dispatchKbLeg OCR branch). The URL sentinel "text/url" is
      // also KB-eligible — URL drafts are pre-dispatched at stage time, so the
      // assign route never sees one with kb=false. Defense-in-depth: reject
      // any other MIME.
      if (parsed.data.kb === true && !isKbEligible(draft.mimeType) && draft.mimeType !== "text/url") {
        res.status(400).json({
          error: "Knowledge Base accepts only .md, .txt, .csv, .xlsx, .docx, .pptx, PDF, and images (PNG/JPEG/WEBP/TIFF)",
          details: { mimeType: draft.mimeType, kb: true },
        });
        return;
      }

      // 260814-wxr: draft source file existence fail-fast. DELETE /:id and
      // the 24h reaper remove storage/uploads/drafts/<file> while the DB row
      // stays assignable — before this guard, a stale draft was accepted and
      // the KB leg failed ~30s later in the OCR scheduler ("Draft source
      // file not found"), silent at the UI click. Cheap fs check runs BEFORE
      // the DB archive-access round-trip below (existing "cheap checks
      // first" pattern). Scoped to the KB leg only: kb=false (RAG) is out
      // of scope, and text/url drafts have NO disk file (filePath is a URL)
      // so existsSync(path.resolve(url)) would false-positive. D-06 /
      // T-76-04: the raw path is never echoed back.
      //
      // 260829-jv7 (D-02): before failing, attempt to restore the staged
      // file from the KB leg's persistent OCR copy
      // (storage/ocr-sources/<draftId>_<originalName>). On success the flow
      // proceeds; on failure the 400 below stays byte-identical.
      if (
        parsed.data.kb === true &&
        draft.mimeType !== "text/url" &&
        !fs.existsSync(path.resolve(draft.filePath))
      ) {
        if (tryRestoreDraftFromOcrCopy(draft)) {
          logger.info("[uploads] assign: draft source file restored from persistent OCR copy", {
            draftId: draft.id,
          });
        } else {
          logger.warn("[uploads] assign blocked: draft source file missing", {
            draftId: draft.id,
          });
          res.status(400).json({
            error: "Draft source file no longer exists on disk — re-upload the file to assign it",
            details: { draftId: draft.id },
          });
          return;
        }
      }

      // Phase 70 D-06: archive-ownership fail-closed when destination includes
      // KB. `archiveId` is NEVER trusted from the body alone — re-verified via
      // prisma.archive.findUnique. Archive is a GLOBAL entity (no workspaceId),
      // ownership = createdBy === userId OR isAdmin (D-06a admin bypass).
      // 404 (missing/soft-deleted) vs 403 (exists, not owned) via the reason
      // enum — no second findUnique round-trip needed.
      if (parsed.data.kb === true && parsed.data.archiveId) {
        const access = await assertArchiveAccess(parsed.data.archiveId, req.userId!, req.user);
        if (!access.ok) {
          if (access.reason === "missing") {
            res.status(404).json({ error: "Archive not found" });
          } else {
            res.status(403).json({ error: "Access denied to this archive" });
          }
          return;
        }
      }

      const result = await dispatchUploadDraft(draft, parsed.data);

      // D-06 / T-69-e: omit filePath and the soft FK ids. The client
      // polls pending for derived per-leg status.
      res.status(200).json(serializeDraftAssign(draft, result));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  },
);

/**
 * POST /api/uploads/:id/retry — re-dispatch RAG and/or KB legs WITHOUT the
 * terminal-state 409 gate that /:id/apply applies (D-01). Accepts the same
 * assignDraftSchema body as /assign (D-05) and reuses dispatchUploadDraft +
 * the same validation chain (MIME, archive-ownership, source-file, IDOR).
 *
 * KEY DIFFERENCE from /assign: the `parseStatus === "done"` → 409 gate is
 * OMITTED — retry is allowed on every parseStatus. Before dispatch:
 *   - RAG retry soft-deletes the old Document (deletedAt = now) when the
 *     draft has an existing ragJobId, so dispatchRagLeg creates a fresh
 *     row instead of accumulating duplicates (D-06). The soft-delete is
 *     best-effort: a missing old Document (already gone) is logged and
 *     does NOT block the retry.
 *   - parseStatus is reset to "assigned" so enrichDraftWithLegStatus can
 *     re-derive terminal "done" after the new legs settle.
 * KB retry does NOT touch the old kbJobId — dispatchKbLeg overwrites it
 * with the new AIJ id (D-06, no dedup).
 */
router.post(
  "/:id/retry",
  authMiddleware,
  requirePermission(["document:write", "archive:write"]),
  async (req: Request, res: Response) => {
    try {
      const parsed = assignDraftSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid retry body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      if (parsed.data.kb === true && !parsed.data.archiveId) {
        res.status(400).json({ error: "archiveId is required when kb is true" });
        return;
      }

      const draft = await prisma.uploadDraft.findUnique({
        where: { id: req.params.id as string },
      });
      if (!draft || draft.deletedAt !== null) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      // IDOR scope — mirror /assign exactly (D-69-08 base, admin non-bypass).
      if (draft.uploadedBy !== req.userId) {
        const workspace = await assertWorkspaceAccess(req, res, draft.workspaceId);
        if (!workspace) {
          return;
        }
      }

      // D-01: NO parseStatus === "done" 409 gate — retry allowed on every status.
      // D-69-06 rule 1: image + rag → 400 (mirror /assign).
      if (parsed.data.rag === true && IMAGE_MIME_TYPES.has(draft.mimeType)) {
        res.status(400).json({
          error: "Images can only be assigned to Knowledge Base, not RAG",
          details: { mimeType: draft.mimeType, rag: true },
        });
        return;
      }

      // 71-02 D-13/D-14: KB MIME restriction (mirror /assign).
      if (parsed.data.kb === true && !isKbEligible(draft.mimeType) && draft.mimeType !== "text/url") {
        res.status(400).json({
          error: "Knowledge Base accepts only .md, .txt, .csv, .xlsx, .docx, .pptx, PDF, and images (PNG/JPEG/WEBP/TIFF)",
          details: { mimeType: draft.mimeType, kb: true },
        });
        return;
      }

      // 260814-wxr: source-file-exists guard (mirrors /assign). Originally
      // KB-leg-only; 260829-fty extends it to RAG retries — a RAG retry of a
      // draft whose staged file was already deleted returned 200
      // (Promise.allSettled per-leg isolation) and the collector leg then
      // failed with ENOENT, a false success the user could never recover
      // from. /assign is deliberately unchanged: its rag-only path is
      // out of the 260814-wxr scope decision, regression-pinned by
      // uploads.test.ts:1722 ("kb=false rag=true ... guard inert").
      //
      // 260829-jv7 (D-02): before failing, attempt to restore the staged
      // file from the KB leg's persistent OCR copy
      // (storage/ocr-sources/<draftId>_<originalName>). On success the flow
      // proceeds; on failure the 400 below stays byte-identical.
      if (
        (parsed.data.rag === true || parsed.data.kb === true) &&
        draft.mimeType !== "text/url" &&
        !fs.existsSync(path.resolve(draft.filePath))
      ) {
        if (tryRestoreDraftFromOcrCopy(draft)) {
          logger.info("[uploads] retry: draft source file restored from persistent OCR copy", {
            draftId: draft.id,
          });
        } else {
          logger.warn("[uploads] retry blocked: draft source file missing", {
            draftId: draft.id,
          });
          res.status(400).json({
            error: "Draft source file no longer exists on disk — re-upload the file to assign it",
            details: { draftId: draft.id },
          });
          return;
        }
      }

      // Phase 70 D-06: archive-ownership fail-closed when kb=true (mirror /assign).
      if (parsed.data.kb === true && parsed.data.archiveId) {
        const access = await assertArchiveAccess(parsed.data.archiveId, req.userId!, req.user);
        if (!access.ok) {
          if (access.reason === "missing") {
            res.status(404).json({ error: "Archive not found" });
          } else {
            res.status(403).json({ error: "Access denied to this archive" });
          }
          return;
        }
      }

      // D-06: RAG retry soft-deletes the old Document (deletedAt = now) BEFORE
      // dispatch so dispatchRagLeg creates a fresh row instead of a duplicate.
      // Best-effort: a missing/already-deleted old Document is logged and does
      // NOT block the retry. Direct deletedAt write mirrors the soft-delete
      // norm in AGENTS.md (withSoftDelete is not needed here).
      if (parsed.data.rag === true && draft.ragJobId) {
        try {
          await prisma.document.update({
            where: { id: draft.ragJobId },
            data: { deletedAt: new Date() },
          });
        } catch (err: unknown) {
          logger.warn("[uploads] retry: old Document soft-delete failed (non-blocking)", {
            draftId: draft.id,
            ragJobId: draft.ragJobId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Reset parseStatus to "assigned" BEFORE dispatch so
      // enrichDraftWithLegStatus can re-derive terminal "done" after the new
      // legs settle. KB retry does NOT touch the old kbJobId — dispatchKbLeg
      // overwrites it with the new AIJ id (D-06).
      await prisma.uploadDraft.update({
        where: { id: draft.id },
        data: { parseStatus: "assigned" },
      });

      const result = await dispatchUploadDraft(draft, parsed.data);

      res.status(200).json(serializeDraftAssign(draft, result));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  },
);

/**
 * GET /api/uploads/pending — List workspace upload drafts across the full
 * lifecycle (unassigned + in-flight + done) for the PendingDocsPanel.
 * Client-side filters split by parseStatus.
 *
 * IDOR scope (D-69-08 base, preserved byte-for-byte): drafts are scoped to
 * `uploadedBy: req.userId` AND the caller must have workspace access. The
 * broadened where clause (no `ragEnabled`/`kbEnabled`/`parseStatus` filter
 * — Phase 71-06 CR-01/CR-02 closure) returns drafts in every parseStatus
 * state so the PendingDocsPanel can populate the "To assign / In progress /
 * Completed" chips via client-side predicates (`isUnassigned`/`isInFlight`/
 * `isDone` in PendingDocsPanel.tsx:141-154). Soft-deleted drafts are excluded.
 *
 * Each draft is enriched via `enrichDraftWithLegStatus` to centralise the
 * per-leg status derivation logic and to lazily flip `parseStatus` to
 * "done" when both requested legs reach a terminal state.
 *
 * Response shape (Phase 71-06 WR-03/WR-05 closure): the three operational
 * flags `ragEnabled`/`kbEnabled`/`assignedArchiveId` are included so the
 * frontend can render the per-leg badges, the "Assigned to" live label
 * (D-05), and the Retry-KB guard (D-08) without a second round-trip.
 * `filePath` is NEVER exposed (D-06 / T-69-e).
 */
router.get(
  "/pending",
  authMiddleware,
  requirePermission("document:read"),
  async (req: Request, res: Response) => {
    try {
      const workspaceId = req.query.workspaceId;
      if (typeof workspaceId !== "string" || !workspaceId) {
        res.status(400).json({ error: "workspaceId query param is required" });
        return;
      }

      const workspace = await assertWorkspaceAccess(req, res, workspaceId);
      if (!workspace) {
        return;
      }

      // Phase 71-06 CR-01/CR-02: the previous `ragEnabled: false,
      // kbEnabled: false, parseStatus: "uploaded"` filter restricted the
      // result set to unassigned drafts only, hiding in-flight (assigned)
      // and completed (done) drafts from the PendingDocsPanel. The chip
      // filters are client-side; the server just returns every non-deleted
      // draft owned by the caller in this workspace.
      const drafts = await prisma.uploadDraft.findMany({
        where: {
          deletedAt: null,
          workspaceId,
          uploadedBy: req.userId!,
        },
        orderBy: { createdAt: "desc" },
      });

      const enriched = await Promise.all(drafts.map((d) => enrichDraftWithLegStatus(d)));

      // D-06 / T-69-e: omit filePath from every response object.
      // Phase 71-06 WR-03/WR-05: include ragEnabled/kbEnabled/assignedArchiveId
      // so the frontend can render badges + retry guard without a second fetch.
      res.status(200).json(enriched.map((d) => serializeDraftPending(d)));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  },
);

/**
 * DELETE /api/uploads/:id — soft-delete an owner's draft (PEND-01).
 *
 * D-01: soft-delete (deletedAt = now) FIRST, then best-effort unlink the
 * on-disk file. A failed unlink does not roll back the soft-delete — the
 * row is already marked and won't be re-selectable (reaper ordering, T-69-05e).
 * The produced Document/archive is NOT touched (Invariant 2).
 *
 * D-02 (260829-h0n): in-flight drafts are NOT deletable — returns 409, but
 * "in-flight" now means: parseStatus "assigned" AND some ENABLED leg
 * non-terminal (derived with the SAME formula enrichDraftWithLegStatus uses
 * for ragDone/kbDone, importing the exported RAG_TERMINAL/KB_TERMINAL sets —
 * the single source of truth for leg terminality, no inline literals). A
 * failed-terminal draft (all enabled legs completed or failed) IS deletable:
 * the old `parseStatus === "assigned"` proxy 409'd genuinely dead drafts
 * (e.g. ragStatus "failed", kbEnabled false) that can only be cleared by
 * deleting. Deleting is soft-delete-only — the produced Document/archive is
 * NOT touched, and the retry path (assign route) is unaffected because the
 * enrichment return shape is unchanged (serializeDraftPending + /assign
 * route unaffected).
 *
 * D-08: owner-only IDOR — 404 hides existence (NOT 403). NO
 * assertWorkspaceAccess fallback (the pending panel is personal, owner-only).
 * Permission: document:write (NOT document:delete — Pitfall 6: document:delete
 * is admin-only and would break PEND-01 for the User role).
 *
 * T-76-02: A5 prefix guard on fs.unlinkSync — path.resolve(draft.filePath)
 * must start with DRAFTS_BASE. URL drafts (filePath="https://...") and
 * traversal payloads ("../../etc/passwd") are rejected naturally by the
 * guard — NO mimeType special-case (Pitfall 3).
 *
 * Response: { message } — no filePath key (T-76-04 / D-06 hardening).
 */
router.delete("/:id", authMiddleware, requirePermission("document:write"), async (req: Request, res: Response) => {
    try {
      const draft = await prisma.uploadDraft.findUnique({
        where: { id: req.params.id as string },
      });
      // 404 hides existence for missing, soft-deleted, AND non-owner (D-08).
      if (!draft || draft.deletedAt !== null) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      if (draft.uploadedBy !== req.userId) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      // D-02 (260829-h0n): in-flight gate is failure-aware. In-flight =
      // parseStatus "assigned" AND some ENABLED leg non-terminal, derived
      // with the SAME formula enrichDraftWithLegStatus uses for
      // ragDone/kbDone: a disabled leg never blocks, an enabled leg with a
      // status in the exported terminal set is finished, an enabled leg with
      // a null status has NOT finished. A failed-terminal draft is DELETABLE
      // (soft-delete only; the produced Document is untouched) — delete is
      // the user's explicit choice over retry, and the retry path operates
      // on a live draft so there is no conflict. Terminal sets come from the
      // service (single source of truth) — do NOT hand-roll them inline.
      const enriched = await enrichDraftWithLegStatus(draft);
      const ragDone = !draft.ragEnabled || (enriched.ragStatus !== null && RAG_TERMINAL.has(enriched.ragStatus));
      const kbDone = !draft.kbEnabled || (enriched.kbStatus !== null && KB_TERMINAL.has(enriched.kbStatus));
      if (enriched.parseStatus === "assigned" && !(ragDone && kbDone)) {
        res.status(409).json({
          error: "Draft is in-flight; wait for processing to finish before deleting",
        });
        return;
      }
      // D-01: soft-delete FIRST (reaper ordering — row unselectable even if
      // the unlink below fails).
      await prisma.uploadDraft.update({
        where: { id: draft.id },
        data: { deletedAt: new Date() },
      });
      // D-01 / T-76-02: A5 prefix guard + best-effort unlink. URL drafts and
      // traversal payloads are skipped naturally (NO mimeType special-case).
      const resolved = path.resolve(draft.filePath);
      if (resolved.startsWith(DRAFTS_BASE)) {
        try {
          fs.unlinkSync(resolved);
        } catch (err) {
          logger.warn("[uploads] delete unlink failed (best-effort)", {
            draftId: draft.id,
            error: (err as Error).message,
          });
        }
      }
      // T-76-04 / D-06: NEVER include filePath.
      res.json({ message: "Draft deleted" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  },
);

/**
 * PATCH /api/uploads/:id — rename an owner's draft (PEND-03).
 *
 * D-07: rename is non-destructive and allowed in EVERY parseStatus state
 * (unassigned, in-flight, done) — it changes only the display name of the
 * staging record. The produced Document/archive is NOT renamed. Validated
 * via renameUploadSchema (1-500 char, empty rejected, no uniqueness).
 *
 * D-08: owner-only IDOR — 404 hides existence (NOT 403). NO
 * assertWorkspaceAccess fallback. Permission: document:write.
 *
 * Response: minimal { id, originalName } — no filePath key (T-76-04 / D-06).
 * Do NOT spread the raw Prisma draft or call a serializer that includes
 * filePath (Pitfall 4).
 */
router.patch("/:id", authMiddleware, requirePermission("document:write"), async (req: Request, res: Response) => {
    try {
      const parsed = renameUploadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      const draft = await prisma.uploadDraft.findUnique({
        where: { id: req.params.id as string },
      });
      // 404 hides existence for missing, soft-deleted, AND non-owner (D-08).
      if (!draft || draft.deletedAt !== null) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      if (draft.uploadedBy !== req.userId) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      // D-07: rename allowed in every state — NO in-flight gate on rename.
      const updated = await prisma.uploadDraft.update({
        where: { id: draft.id },
        data: { originalName: parsed.data.originalName },
      });
      // T-76-04 / D-06: minimal response — NEVER include filePath (Pitfall 4).
      res.json({ id: updated.id, originalName: updated.originalName });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  },
);

export default router;
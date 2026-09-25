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
import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
// Phase 189 (D-13, Plan 04 gate swap): graded write middleware ENFORCED
// (bypassAdmin:false — D-04 upload normalization, Pitfall 2) on the STAGE
// routes (chain mount AFTER multer — CR-01: multer must parse the multipart
// body before the gate reads req.body.workspaceId). The local
// assertWorkspaceAccess helper (inline D-04 check) stays as the
// admin-does-not-bypass + upload-toggle arm (documents.ts semantic variation);
// the graded gate is the enforcement boundary. Draft-scoped routes (/assign,
// /retry, /pending) resolve the graded decision IN-HANDLER via
// shadowResolveWorkspaceWrite after the draft supplies the workspaceId —
// same contract, now enforced (name kept historical).
import { requirePermission, requireWorkspaceWriteAccess, resolveWorkspaceRole } from "../middleware/rbac";
import { assertNonAdminUploadAllowed } from "../middleware/uploadGate";
import { assertArchiveAccess } from "../middleware/archiveAccess";
import prisma from "../utils/prisma";
import { getSetting } from "../services/systemConfigService";
// Phase 207 (CLOUD-04, D-15): storage quota gates on the upload path —
// declared-size pre-check (advisory, fail-fast) + post-upload actual-size
// re-check INSIDE the row-persist transaction (T-207-07 race guard).
import { checkStorageQuota, QuotaError } from "../services/quotaService";
import { getStorageProvider } from "../services/storageProvider";
import { getUniqueFilePath, isDraftStorageKey } from "../utils/fileUtils";
import { isAdmin } from "../utils/auth";
import { createUploadDraftSchema, createUploadDraftUrlSchema, assignDraftSchema, cancelDraftLegSchema, renameUploadSchema, sanitizeFileName } from "@simmetric-chat/shared";
import {
  dispatchUploadDraft,
  dispatchKbLegUrl,
  enrichDraftWithLegStatus,
  tryRestoreDraftFromOcrCopy,
  cancelOcrJob,
  RAG_TERMINAL,
  KB_TERMINAL,
} from "../services/uploadDraftService";
import { logEvent } from "../services/eventLogService";
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
): Promise<{ id: string; organizationId: string; projectId: string; project?: { createdBy: string | null }; allowMemberUploads: boolean } | null> {
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
 * Phase 189 (D-11/D-13, additively-mounted contract): the graded write
 * decision for DRAFT-SCOPED upload routes (/assign, /retry, /pending) —
 * the workspaceId is only known after the draft row loads, so the graded
 * middleware cannot be chain-mounted there. This helper mirrors
 * requireWorkspaceWriteAccess({ bypassAdmin: false }) EXACTLY: resolve the
 * role once, expose req.workspaceRole. Post-flip (Plan 04) the flag
 * persisted "true", so this helper IS the enforcement gate for the
 * draft-scoped routes: null → 403 "Access denied to this workspace"
 * (D-04 byte shape — bypassAdmin:false), owner/editor → next, else 403.
 * The name stays (historical); it is the enforced gate, not a shadow.
 * Pitfall 9: no caching — per-request resolution IS the revocation contract.
 */
async function shadowResolveWorkspaceWrite(
  req: Request,
  res: Response,
  workspaceId: string,
): Promise<boolean> {
  const flagEntry = await getSetting("WORKSPACE_ROLE_ENFORCEMENT");
  const enforced = flagEntry.value === "true";
  const role = await resolveWorkspaceRole(req.userId!, workspaceId, req.user);
  (req as Request & { workspaceRole?: unknown }).workspaceRole = role;
  if (!enforced) {
    // 260919: debug level — shadow fires per-request; info flooded prod logs.
    logger.debug("[workspace-access] shadow decision", {
      userId: req.userId,
      workspaceId,
      role,
      middleware: "uploads.draftScopedWrite",
    });
    return true; // shadow — never deny; the inline D-04 gate decides
  }
  if (role === null) {
    // bypassAdmin:false normalization — D-04 byte shape (NOT 404).
    res.status(403).json({ error: "Access denied to this workspace" });
    return false;
  }
  if (isAdmin(req.user)) {
    // Admin's underlying grant (skipAdminBypass re-resolution).
    const underlying = await resolveWorkspaceRole(req.userId!, workspaceId, req.user, {
      skipAdminBypass: true,
    });
    (req as Request & { workspaceRole?: unknown }).workspaceRole = underlying;
    if (underlying === null) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return false;
    }
    return true; // admin's editor/owner grant passes the editor gate
  }
  return role === "owner" || role === "editor";
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
  ragProgress?: number | null;
  kbProgress?: number | null;
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
    ragProgress: d.ragProgress ?? null,
    kbProgress: d.kbProgress ?? null,
    ragEnabled: d.ragEnabled,
    kbEnabled: d.kbEnabled,
    assignedArchiveId: d.assignedArchiveId,
  };
}

/**
 * POST /api/uploads — stage a draft.
 *
 * 189-REVIEW CR-01: multer parses the multipart payload BEFORE the graded
 * gate — `req.body.workspaceId` only exists after `upload.single("file")`
 * runs (express.json() never gates multipart), so the previous order
 * (gate → multer) 400'd EVERY staging request with "Workspace ID required"
 * in both shadow and enforced mode. Chain order now mirrors
 * documents.ts /upload: auth → tenant → permission → multer → graded gate
 * → handler. `unlinkUploadIfPresent(req)` on every rejection path prevents
 * orphan accumulation (T-69-07) — multer writing the tmp before the deny is
 * the same trade-off documents.ts /upload already accepts.
 *
 * `expiresAt` uses a NaN-safe fallback to 30 days (Pitfall 7, C2): a
 * corrupted `upload_draft_retention_days` config value cannot produce
 * an `Invalid Date` that Prisma would reject.
 */
router.post(
  "/",
  authMiddleware,
  // Phase 185 (D-09): tenant slot — auth → tenant → permission.
  tenantContextMiddleware,
  requirePermission("document:write"),
  // CR-01 fix: parse multipart FIRST (multer populates req.body.workspaceId),
  // THEN the graded write gate (189 D-13, Plan 04 gate swap; ENFORCED
  // bypassAdmin:false — D-04). The in-handler D-04 admin-does-not-bypass arm
  // below stays as the allowMemberUploads toggle gate.
  upload.single("file"),
  requireWorkspaceWriteAccess({ bypassAdmin: false }),
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
        //
        // Phase 184 (SAAS-03, D-05): the URL sentinel also becomes the
        // storageKey — the M6 backfill's path-as-key doctrine (key = filePath).
        // isDraftStorageKey(url) is false, so no terminal cleanup path ever
        // deletes it (matches today's A5-rejects-URL behavior through the
        // legacy-arm returning false).
        const draft = await prisma.uploadDraft.create({
          data: {
            uploadedBy: req.userId!,
            workspaceId: parsed.data.workspaceId,
            filePath: parsed.data.url,
            storageKey: parsed.data.url,
            originalName: parsed.data.url,
            fileSize: 0,
            mimeType: "text/url",
            expiresAt,
            kbEnabled: true,
            ragEnabled: false,
            assignedArchiveId: parsed.data.archiveId,
            parseStatus: "assigned",
            // CR-03 (185-05, D-04): explicit org stamp — the assign/retry/
            // PATCH/DELETE org assertions (uploads.ts:516+) 404 the org-b
            // user's OWN drafts when the row rides the schema @default.
            organizationId: req.organizationId!,
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

      // Phase 207 (CLOUD-04, D-15): PRE-upload declared-size check (advisory
      // arm — the multer-staged bytes are the truth; the binding gate is the
      // in-tx re-check below). Fail fast before provider work; the staged
      // file is cleaned on rejection (unlinkUploadIfPresent — the WR-01
      // disk-hygiene doctrine).
      try {
        await checkStorageQuota(prisma, req.userId!, parsed.data.fileSize);
      } catch (err: unknown) {
        if (err instanceof QuotaError) {
          unlinkUploadIfPresent(req);
          res.status(err.status).json(err.payload);
          return;
        }
        throw err;
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

      // Phase 184 (SAAS-03, D-05): provider key — prefix derived ONLY from the
      // workspace row's organizationId (row's-org rule, T-184-10: never client
      // input; TenantContext does not exist until Phase 185). filePath stays
      // byte-identical (additive policy); new-layout key lands in the same
      // create (no @default on the column — write sites set it explicitly).
      // The drafts subpath ({orgId}/uploads/drafts/…) is what the reaper's
      // isDraftStorageKey prefix-guard arm keys on.
      const storageKey = `${workspace.organizationId}/uploads/drafts/${crypto.randomUUID()}-${sanitizeFileName(parsed.data.originalName)}`;
      // Capture the multer-staged file: TS narrowing does not survive the
      // async tx closure below.
      const stagedFile = req.file;
      // Phase 207 (CLOUD-04, D-15): BINDING gate — the actual-size re-check
      // runs INSIDE the row-persist transaction so two parallel uploads
      // cannot both consume the same remaining bytes (T-207-07; the second
      // over-quota commit is rejected with the 409 storage family and its
      // staged tmp is removed by the handler's unlink path). QuotaError
      // propagates out of the transaction into the handler's catch → mapped
      // below (unlike the 500 arm).
      const draft = await prisma.$transaction(async (tx) => {
        await checkStorageQuota(tx, req.userId!, parsed.data.fileSize);
        return tx.uploadDraft.create({
          data: {
            uploadedBy: req.userId!,
            workspaceId: parsed.data.workspaceId,
            filePath: stagedFile.path,
            storageKey,
            // quick 260808-vzm: sanitize the staged name so the stored
            // originalName matches the sanitized disk filename and the name
            // shown in the UI. The URL branch (sourceType === "url") stores a
            // URL sentinel and is intentionally NOT sanitized (T-05 accept).
            originalName: sanitizeFileName(parsed.data.originalName),
            fileSize: parsed.data.fileSize,
            mimeType: parsed.data.mimeType,
            expiresAt,
            // CR-03 (185-05, D-04): explicit org stamp (file branch — same
            // org-assertion class as the URL branch above).
            organizationId: req.organizationId!,
            // Prisma defaults: ragEnabled=false, kbEnabled=false,
            // parseStatus="uploaded", ragJobId/kbJobId=null,
            // assignedArchiveId=null
          },
        });
      });

      // Phase 184 (SAAS-03, T-184-06 — mirrors the landed documents.ts seam-1
      // shape): put AFTER the row lands — an interrupted put leaves a
      // recoverable uploaded-status draft row (never corrupt), and a retry
      // writing the SAME key overwrites idempotently (LocalFSProvider
      // copyFileSync semantics). The multer tmp is an ingress buffer, not
      // storage: it is unlinked best-effort once the bytes are in the
      // provider (WR-01 keeps guarding the pre-row rejection paths — D-08).
      const provider = await getStorageProvider(workspace.organizationId);
      await provider.put(stagedFile.path, storageKey);
      try {
        fs.unlinkSync(stagedFile.path);
      } catch {
        // Best-effort ingress cleanup — the tmp is a buffer, never storage.
      }

      // D-06 / T-69-e: NEVER include filePath in a response body.
      res.status(201).json(serializeDraftStage(draft));
    } catch (err: unknown) {
      // Phase 207 (CLOUD-04, D-15): the binding in-tx storage gate throws the
      // 409 family — map BEFORE the generic 500 arm; the staged tmp is
      // removed by unlinkUploadIfPresent (bytes never retained on breach).
      if (err instanceof QuotaError) {
        unlinkUploadIfPresent(req);
        res.status(err.status).json(err.payload);
        return;
      }
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
  // Phase 185 (D-09): tenant slot — auth → tenant → permission.
  tenantContextMiddleware,
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
      // T-185-10 org assertion (Pitfall-2 grep-gate, option b): cross-org
      // draft hides as 404 (D-08 hide-existence), never 403.
      if (!draft || draft.deletedAt !== null || draft.organizationId !== req.organizationId) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      // Phase 189 (D-13, Plan 04): graded write decision — the flag persisted
      // "true", so this call IS the enforcement gate (D-04 byte shape on deny).
      // The in-handler assertWorkspaceAccess arm below stays for the
      // admin-does-not-bypass upload semantic (D-04) + the upload toggle.
      if (!(await shadowResolveWorkspaceWrite(req, res, draft.workspaceId))) {
        return; // enforced-mode deny already written (D-04 byte shape)
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
      // file not found"), silent at the UI click. Cheap check runs BEFORE
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
      //
      // Phase 184 (D-06, Pitfall 1): the existence probe branches on the
      // ROW's storageKey. New-layout rows (key set, not the legacy
      // "storage/" path-as-key layout) probe the PROVIDER — fs.existsSync on
      // an S3-backed row silently returns false (the tmp was unlinked after
      // put). The restore arm stays LocalFS-only (D-07): for new-layout rows
      // it returns false (S3-backed restore flagged Parte II), so the 400
      // stays byte-identical. Legacy rows (storageKey contains "storage/",
      // the M6 path-as-key backfill) keep the exact fs.existsSync shape —
      // zero delta.
      if (parsed.data.kb === true && draft.mimeType !== "text/url") {
        const isNewLayout = Boolean(draft.storageKey) && !draft.storageKey!.includes("storage/");
        const sourceMissing = isNewLayout
          ? !(await (await getStorageProvider(draft.organizationId)).exists(draft.storageKey!))
          : !fs.existsSync(path.resolve(draft.filePath));
        if (sourceMissing) {
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
  // Phase 185 (D-09): tenant slot — auth → tenant → permission.
  tenantContextMiddleware,
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
      // T-185-10 org assertion (Pitfall-2 grep-gate, option b): cross-org
      // draft hides as 404 (D-08 hide-existence), never 403.
      if (!draft || draft.deletedAt !== null || draft.organizationId !== req.organizationId) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      // Phase 189 (D-13, Plan 04): graded write gate ENFORCED (mirror /assign).
      if (!(await shadowResolveWorkspaceWrite(req, res, draft.workspaceId))) {
        return; // enforced-mode deny already written (D-04 byte shape)
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
      // 260829-jv7 (D-02): before failing, attempt to restore the staged
      // file from the KB leg's persistent OCR copy
      // (storage/ocr-sources/<draftId>_<originalName>). On success the flow
      // proceeds; on failure the 400 below stays byte-identical.
      //
      // Phase 184 (D-06, Pitfall 1): provider-branched existence probe —
      // same layout test as the /assign guard above (new-layout rows probe
      // provider.exists; legacy "storage/" rows keep fs.existsSync — zero
      // delta; the LocalFS-only restore arm is unchanged per D-07).
      if (
        (parsed.data.rag === true || parsed.data.kb === true) &&
        draft.mimeType !== "text/url"
      ) {
        const isNewLayout = Boolean(draft.storageKey) && !draft.storageKey!.includes("storage/");
        const sourceMissing = isNewLayout
          ? !(await (await getStorageProvider(draft.organizationId)).exists(draft.storageKey!))
          : !fs.existsSync(path.resolve(draft.filePath));
        if (sourceMissing) {
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
  // Phase 185 (D-09): tenant slot — auth → tenant → permission.
  tenantContextMiddleware,
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

      // Phase 189 (D-13, Plan 04): graded write gate ENFORCED (draft-panel route).
      if (!(await shadowResolveWorkspaceWrite(req, res, workspaceId))) {
        return; // enforced-mode deny already written (D-04 byte shape)
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
 * T-76-02 / Phase 184 (D-08): cleanup guard — NEW-LAYOUT storageKeys
 * ({orgId}/uploads/drafts/…, isDraftStorageKey new-layout arm) delete through
 * the provider; legacy rows (storageKey contains "storage/" or null — the
 * M6 path-as-key backfill) keep the A5 prefix guard on fs.unlinkSync —
 * path.resolve(draft.filePath) must start with DRAFTS_BASE. URL drafts
 * (filePath="https://...", storageKey = url) and traversal payloads are
 * rejected naturally by the guards — NO mimeType special-case (Pitfall 3).
 *
 * Response: { message } — no filePath key (T-76-04 / D-06 hardening).
 */
router.delete("/:id", authMiddleware, tenantContextMiddleware, requirePermission("document:write"), async (req: Request, res: Response) => {
    try {
      const draft = await prisma.uploadDraft.findUnique({
        where: { id: req.params.id as string },
      });
      // 404 hides existence for missing, soft-deleted, AND non-owner (D-08).
      if (!draft || draft.deletedAt !== null) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      // T-185-10 org assertion (Pitfall-2 grep-gate, option b): cross-org
      // draft hides as 404 (D-08 hide-existence), never 403.
      if (draft.organizationId !== req.organizationId) {
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
      // the cleanup below fails).
      await prisma.uploadDraft.update({
        where: { id: draft.id },
        data: { deletedAt: new Date() },
      });
      // D-01 / T-76-02 / Phase 184 (D-08): key-based cleanup contract. The
      // guard branches on the row's storageKey: NEW-LAYOUT keys (isDraftStorageKey
      // true via the {orgId}/uploads/drafts/ trailing-sep arm — the A5
      // sibling-prefix rule reborn in key space) delete through the provider
      // (row's-org rule — provider resolution via draft.organizationId),
      // best-effort try/catch-warn. LEGACY rows (backfilled storageKey = the
      // old path — always contains "storage/", or null storageKey) keep the
      // exact A5 resolve + fs.unlinkSync — byte-identical AND provider-correct
      // (legacy bytes are always on local disk per D-05: S3 tenants never
      // re-upload legacy rows, so their cleanup must never touch the bucket).
      // URL drafts: isDraftStorageKey(url) is false → no delete (unchanged;
      // NO mimeType special-case — Pitfall 3).
      const isNewLayoutKey =
        Boolean(draft.storageKey) &&
        isDraftStorageKey(draft.storageKey) &&
        !draft.storageKey!.includes("storage/");
      if (isNewLayoutKey) {
        try {
          await (await getStorageProvider(draft.organizationId)).delete(draft.storageKey!);
        } catch (err) {
          logger.warn("[uploads] delete provider cleanup failed (best-effort)", {
            draftId: draft.id,
            error: (err as Error).message,
          });
        }
      } else {
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
 * POST /api/uploads/:id/cancel — cancel the in-flight legs of a draft
 * (quick 260918-p3h, D-3 + T-P3H-02).
 *
 * Access posture mirrors DELETE /:id (D-08): owner-only IDOR — 404 hides
 * existence for missing / soft-deleted / cross-org / non-owner callers.
 * NO assertWorkspaceAccess fallback (the pending panel is personal,
 * owner-only). Permission: document:write (same PEND-01 rationale —
 * document:delete is admin-only and would break the User role).
 *
 * Body: cancelDraftLegSchema — { leg?: "rag" | "kb" }; leg omitted cancels
 * EVERY in-flight enabled leg. Cooperative: the endpoint only flips rows;
 * the collector's status poll / the OCR pipeline's per-page check stop the
 * actual work at the next unit-of-work boundary.
 *
 * For the KB leg the AIJ's result.ocrJobId drives a companion OcrJob flip
 * (PENDING/PROCESSING → CANCELLED) so the running pipeline's between-page
 * check trips. Response: { id, cancelled: string[] } — the legs actually
 * cancelled.
 */
router.post("/:id/cancel", authMiddleware, tenantContextMiddleware, requirePermission("document:write"), async (req: Request, res: Response) => {
    try {
      const parsed = cancelDraftLegSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      const targetLeg = parsed.data.leg;

      const draft = await prisma.uploadDraft.findUnique({
        where: { id: req.params.id as string },
      });
      // 404 hides existence for missing, soft-deleted, cross-org AND
      // non-owner (same D-08 posture as DELETE /:id above).
      if (!draft || draft.deletedAt !== null) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      if (draft.organizationId !== req.organizationId) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }
      if (draft.uploadedBy !== req.userId) {
        res.status(404).json({ error: "Draft not found" });
        return;
      }

      const cancelled: string[] = [];
      const now = new Date();

      // --- RAG leg ---
      if ((!targetLeg || targetLeg === "rag") && draft.ragEnabled && draft.ragJobId) {
        const doc = await prisma.document.findUnique({
          where: { id: draft.ragJobId },
          select: { status: true },
        });
        if (doc && (doc.status === "pending" || doc.status === "processing")) {
          await prisma.document.update({
            where: { id: draft.ragJobId },
            data: { status: "cancelled", cancelledAt: now, statusMessage: "Cancelled by user" },
          });
          cancelled.push("rag");
        }
      }

      // --- KB leg ---
      if ((!targetLeg || targetLeg === "kb") && draft.kbEnabled && draft.kbJobId) {
        const aij = await prisma.archiveImportJob.findUnique({
          where: { id: draft.kbJobId },
          select: { status: true, result: true },
        });
        if (aij && aij.status === "PROCESSING") {
          await prisma.archiveImportJob.update({
            where: { id: draft.kbJobId },
            data: { status: "CANCELLED", cancelledAt: now, error: "Cancelled by user" },
          });
          cancelled.push("kb");
          // Companion OcrJob flip: the OCR pipeline's between-page check
          // reads the OcrJob status (not the AIJ), so a running page loop
          // must see CANCELLED there. result.ocrJobId is seeded by
          // dispatchKbLeg for OCR MIME drafts.
          const ocrJobId = (aij.result as { ocrJobId?: string } | null)?.ocrJobId;
          if (typeof ocrJobId === "string" && ocrJobId) {
            await cancelOcrJob(ocrJobId, "Cancelled by user");
          }
        }
      }

      // T-P3H-06: who cancelled? — same logEvent discipline as DELETE.
      await logEvent("upload_draft", draft.id, "upload_draft.leg_cancelled", req.userId!, {
        legs: cancelled,
      });

      logger.info("[uploads] Draft legs cancelled", {
        draftId: draft.id,
        legs: cancelled,
        userId: req.userId,
      });
      res.json({ id: draft.id, cancelled });
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
router.patch("/:id", authMiddleware, tenantContextMiddleware, requirePermission("document:write"), async (req: Request, res: Response) => {
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
      // T-185-10 org assertion (Pitfall-2 grep-gate, option b): cross-org
      // draft hides as 404 (D-08 hide-existence), never 403.
      if (draft.organizationId !== req.organizationId) {
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
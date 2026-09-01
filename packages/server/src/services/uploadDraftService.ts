// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 69 — Unified Upload fan-out orchestrator.
 *
 * Composes the existing RAG leg (`forwardToCollector` from `documents.ts`,
 * INT-01 reuse — collector contract byte-identical) and the existing KB leg
 * (`dispatchUploadToArchive` from `archiveImportService.ts`, INT-02 reuse)
 * behind a `Promise.allSettled` fan-out so per-leg failure does not
 * invalidate the other leg (D-69-05).
 *
 * Soft FK on `UploadDraft` (`ragJobId` / `kbJobId`) are `String?` plain
 * (schema.prisma ~1030-1031), NOT Prisma `@relation` — per-leg status is
 * derived on-demand via manual `findUnique` lookup (D-69-03 corrected,
 * Pitfall 3). `parseStatus = "done"` is derived lazily in
 * `enrichDraftWithLegStatus` (Pitfall 6 — no callback-driven trigger).
 */
import fs from "fs";
import path from "path";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { forwardToCollector } from "../routes/documents";
import { dispatchUploadToArchive } from "./archiveImportService";
import { createOcrJob } from "./ocrJobService";
import { getSetting } from "./systemConfigService";
import { isDraftsPath } from "../utils/fileUtils";
import type { UploadDraft } from "@prisma/client";
import type { AssignDraftInput } from "@simmetric-chat/shared";

/**
 * Persistent OCR-copy directory (quick 260829-jv7 D-02): the KB leg writes
 * a fail-safe copy of the staged draft here before dispatching the OcrJob
 * (naming below at the copy line — `${draft.id}_${draft.originalName}`).
 * Hoisted to module scope so the /retry+/assign restore helper
 * (tryRestoreDraftFromOcrCopy) resolves the SAME directory the writer
 * uses. process.cwd()-relative, mirroring DRAFTS_DIR convention.
 */
const OCR_SOURCES_DIR = path.resolve(process.cwd(), "storage", "ocr-sources");

/**
 * Restore a staged draft file from the persistent OCR copy (quick
 * 260829-jv7 D-02, bonus recovery for the incident d6ef3403 class).
 *
 * Called by the /retry and /assign source-file guards (routes/uploads.ts)
 * BEFORE failing: when the staged file under storage/uploads/drafts/ is
 * gone (deleted by a pre-guard callback bug, an operator, etc.) but the
 * KB leg's persistent copy exists at
 * `OCR_SOURCES_DIR/<draft.id>_<draft.originalName>` — the exact naming
 * the dispatchKbLeg writer uses — the file is copied back and the
 * dispatch flow proceeds instead of a 400 fail-fast.
 *
 * Gates (defense-in-depth, T-JV7-02):
 *   - "text/url" drafts are a no-op (no disk artifacts by design)
 *   - the resolved draft.filePath MUST be a drafts path (isDraftsPath) —
 *     the restore never writes outside storage/uploads/drafts/
 *   - the copy source is a server-generated path (UUID draft id + the
 *     stage-time-sanitized originalName — sanitizeFileName at
 *     uploads.ts:409), so no traversal vector on the source side
 *     (T-JV7-03 residual risk accepted)
 *
 * Always returns a boolean — the whole body is guarded so it never
 * throws (the caller treats false as "restore impossible, keep the 400").
 */
export function tryRestoreDraftFromOcrCopy(
  draft: Pick<UploadDraft, "id" | "originalName" | "mimeType" | "filePath">,
): boolean {
  try {
    if (draft.mimeType === "text/url") {
      return false;
    }
    const target = path.resolve(draft.filePath);
    // isDraftsPath gate: restore writes ONLY inside storage/uploads/drafts/.
    if (!isDraftsPath(target)) {
      return false;
    }
    const copyPath = path.join(OCR_SOURCES_DIR, `${draft.id}_${draft.originalName}`);
    if (!fs.existsSync(copyPath)) {
      return false;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(copyPath, target);
    logger.info("[uploadDraftService] Restored staged draft from persistent OCR copy", {
      draftId: draft.id,
      filePath: draft.filePath,
      copyPath,
    });
    return true;
  } catch (err: unknown) {
    logger.warn("[uploadDraftService] OCR-copy restore failed", {
      draftId: draft.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * 71-02 D-13/D-14: OCR-eligible MIME set. PDF + 4 image MIME types dispatch
 * via createOcrJob (OcrJob with draft.filePath) instead of the collector
 * archive-page parse path. The OcrJob is processed asynchronously by the
 * initOcrPipelineScheduler (10s poll); the auto-approve hook in
 * ocrPipeline.ts flips the associated ArchiveImportJob to COMPLETED + creates
 * an ArchivePage when the OcrJob terminates (Q4 event-driven, Pitfall 5).
 */
const KB_OCR_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
]);

function isOcrEligible(mimeType: string): boolean {
  return mimeType === "application/pdf" || KB_OCR_IMAGE_MIME.has(mimeType);
}

/**
 * Map a draft's original file name to the `Document.type` enum used by
 * `forwardToCollector` (documents.ts:313-323). Mirrors the table in the
 * existing `/api/documents/upload` handler so the RAG leg feeds the
 * collector the same `docType` it would receive on a direct upload
 * (INT-01 byte-identical contract).
 */
function deriveDocType(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase().replace(".", "");
  const typeMap: Record<string, string> = {
    pdf: "pdf",
    md: "md",
    txt: "txt",
    csv: "csv",
    docx: "docx",
    xlsx: "xlsx",
  };
  return typeMap[ext] || "txt";
}

/**
 * RAG leg — reuses `forwardToCollector` (INT-01).
 *
 * 1. Resolve embedding model + ocr model defaults from SystemConfig (same
 *    sources as `documents.ts:262-263,342-343`).
 * 2. Create a `Document` row with `status: "pending"` mirroring the field
 *    set used by the existing upload route (documents.ts:327-338).
 * 3. `await forwardToCollector(...)` — the collector HTTP dispatch is
 *    fire-and-forget in the legacy upload path (void + .catch), but here
 *    we `await` because `Promise.allSettled` needs the leg's terminal
 *    state to record per-leg success/failure (D-69-05).
 * 4. Persist the soft FK `ragJobId = document.id` and `ragEnabled = true`
 *    on the draft.
 *
 * Re-throws on any error — `Promise.allSettled` in `dispatchUploadDraft`
 * isolates per-leg failure; do NOT swallow here.
 */
export async function dispatchRagLeg(draft: UploadDraft): Promise<{ ragJobId: string }> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: draft.workspaceId },
    select: { id: true, name: true },
  });
  if (!workspace) {
    throw new Error(`Workspace ${draft.workspaceId} not found for draft ${draft.id}`);
  }

  const modelSetting = await getSetting("EMBEDDING_MODEL");
  const embeddingModel = modelSetting.value || "Xenova/all-MiniLM-L6-v2";
  const ocrModelSetting = await getSetting("OCR_DEFAULT_MODEL");
  const ocrModel = ocrModelSetting.value || "glm-ocr:latest";
  const docType = deriveDocType(draft.originalName);

  // cacheKey mirrors documents.ts:326 — unique per upload attempt.
  const cacheKey = `${path.basename(draft.filePath)}-${Date.now()}`;
  const document = await prisma.document.create({
    data: {
      workspaceId: draft.workspaceId,
      name: draft.originalName,
      type: docType,
      filePath: draft.filePath,
      cacheKey,
      chunkCount: 0,
      embeddingModel,
      status: "pending",
      fileSize: draft.fileSize,
    },
  });

  // Await (unlike the legacy fire-and-forget call site at documents.ts:352)
  // so allSettled sees the leg's terminal state. forwardToCollector updates
  // Document.status to "processing" / "failed" internally.
  //
  // 260829-fty: `deleteSourceOnFailure: false` — the staged file is
  // DRAFT-OWNED (storage/uploads/drafts/<A5-prefix>); if the collector leg
  // fails, forwardToCollector's WR-02 cleanup must NOT unlink it, or every
  // future retry ENOENTs and even the manual re-upload/DELETE recovery
  // paths lose their evidence. Only the 24h reaper (uploadDraftReaperJob,
  // A5 prefix guard) and the DELETE route may remove draft files.
  await forwardToCollector(
    document.id,
    draft.filePath,
    draft.originalName,
    draft.workspaceId,
    workspace.name,
    embeddingModel,
    docType,
    ocrModel,
    { deleteSourceOnFailure: false },
  );

  await prisma.uploadDraft.update({
    where: { id: draft.id },
    data: { ragJobId: document.id, ragEnabled: true },
  });

  return { ragJobId: document.id };
}

/**
 * KB leg — 71-02 D-13/D-14: OCR-eligible MIME (PDF + 4 images) dispatch via
 * `createOcrJob` with `draft.filePath`; non-OCR MIME (.md/.xlsx/.docx/.pptx)
 * reuse `dispatchUploadToArchive` (INT-02, collector parse-only pipeline).
 *
 * **Pitfall 4 (AIJ-first):** An ArchiveImportJob row is created FIRST with
 * `status: "PROCESSING"` before any dispatch. `kbJobId` is set to `aij.id`
 * (NOT `ocrJob.id`) so `enrichDraftWithLegStatus` (which does
 * `prisma.archiveImportJob.findUnique({ where: { id: draft.kbJobId } })`)
 * resolves the correct row.
 *
 * **OCR branch:** `createOcrJob` is called with the 9th additive arg
 * `filePath = draft.filePath` (71-01 D-13). The OcrJob is dispatched
 * asynchronously by `initOcrPipelineScheduler` (10s poll) — do NOT await
 * `processOcrJob` here. The AIJ `result.ocrJobId` is populated after
 * `createOcrJob` returns so the auto-approve hook in `ocrPipeline.ts`
 * (`completeOcrJob`/`failOcrJob`) can find the AIJ via JSON path query on
 * `result.ocrJobId` (Q4 event-driven, Pitfall 5).
 *
 * **Non-OCR branch:** `fs.readFileSync(draft.filePath)` + `dispatchUploadToArchive`
 * with `preExistingJobId = aij.id` (WARNING 3.1 locked refactor — the collector
 * parse pipeline reuses the pre-created AIJ row instead of creating a duplicate).
 *
 * Re-throws on any error — `Promise.allSettled` handles isolation.
 */
export async function dispatchKbLeg(draft: UploadDraft, archiveId: string): Promise<{ kbJobId: string }> {
  const ocrEligible = isOcrEligible(draft.mimeType);

  // Pitfall 4: ALWAYS create the AIJ row first (status PROCESSING) so the
  // pipeline is observable even before the OcrJob/collector dispatch lands.
  // For OCR-eligible MIME, seed result.ocrJobId=null — updated to ocrJob.id
  // after createOcrJob returns (the auto-approve hook looks up AIJ by this
  // JSON path). For non-OCR MIME, result stays undefined (no OCR mapping).
  const aij = await prisma.archiveImportJob.create({
    data: {
      archiveId,
      documentId: null,
      status: "PROCESSING",
      sourceFileName: draft.originalName,
      createdBy: draft.uploadedBy,
      result: ocrEligible ? { ocrJobId: null } : undefined,
    },
  });

  if (ocrEligible) {
    // D-13/D-14: dispatch via OcrJob with draft.filePath (9th additive arg).
    // The OcrJob is picked up asynchronously by initOcrPipelineScheduler.
    //
    // BUG FIX (260814-wxr): the copy is now FAIL-FAST — ocrSourcePath is the
    // persistent copy ONLY. If the draft file has been deleted (DELETE route
    // unlink or the 24h reaper) before the KB leg runs, falling back to the
    // dead path would enqueue an OcrJob the scheduler fails ~10-30s later
    // ("Draft source file not found") — a silent failure at assign time.
    // Instead the pre-created AIJ row (Pitfall 4 AIJ-first) is flipped to
    // FAILED so enrichDraftWithLegStatus treats the leg as terminal and the
    // pending list shows the failure, then the error is re-thrown for
    // Promise.allSettled per-leg isolation.
    fs.mkdirSync(OCR_SOURCES_DIR, { recursive: true });
    const persistentPath = path.resolve(OCR_SOURCES_DIR, `${draft.id}_${draft.originalName}`);
    let ocrSourcePath: string;
    try {
      const fileBuffer = fs.readFileSync(draft.filePath);
      fs.writeFileSync(persistentPath, fileBuffer);
      ocrSourcePath = persistentPath;
      logger.info("[uploadDraftService] Copied draft to persistent OCR source", {
        draftId: draft.id,
        originalPath: draft.filePath,
        persistentPath,
      });
    } catch (copyErr: unknown) {
      const msg = copyErr instanceof Error ? copyErr.message : String(copyErr);
      const message = `Draft source file not found for draft ${draft.id} (path: ${draft.filePath}) — ${msg}`;
      await prisma.archiveImportJob.update({
        where: { id: aij.id },
        data: { status: "FAILED", error: message },
      });
      logger.warn("[uploadDraftService] Draft source file missing for OCR dispatch, AIJ FAILED", {
        draftId: draft.id,
        aijId: aij.id,
        error: msg,
      });
      throw new Error(message, { cause: copyErr });
    }

    const ocrJob = await createOcrJob(
      archiveId,
      "OCR",
      draft.uploadedBy,
      draft.originalName,
      undefined, // modelName — resolved by the pipeline from SystemConfig
      undefined, // sourceUrl — N/A for file OCR
      undefined, // ocrMode — default
      undefined, // customInstructions — default
      ocrSourcePath, // 9th arg: filePath (D-13, 71-01) — persistent copy
    );

    // Populate result.ocrJobId so the auto-approve hook can find this AIJ
    // when the OcrJob terminates (Q4 event-driven lookup).
    await prisma.archiveImportJob.update({
      where: { id: aij.id },
      data: { result: { ocrJobId: ocrJob.id } },
    });
  } else {
    // Non-OCR MIME: collector parse-only pipeline. Pass preExistingJobId so
    // dispatchUploadToArchive reuses the pre-created AIJ row (no duplicate).
    //
    // FAIL-FAST (260814-wxr): if the draft file was deleted before the KB
    // leg ran, a raw ENOENT would bubble up through Promise.allSettled with
    // no AIJ status update — the row would sit in PROCESSING limbo. Flip
    // the pre-created AIJ to FAILED with a clear reason, then re-throw.
    let fileBuffer: Buffer;
    try {
      fileBuffer = fs.readFileSync(draft.filePath);
    } catch (readErr: unknown) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      const message = `Draft source file not found for draft ${draft.id} (path: ${draft.filePath}) — ${msg}`;
      await prisma.archiveImportJob.update({
        where: { id: aij.id },
        data: { status: "FAILED", error: message },
      });
      logger.warn("[uploadDraftService] Draft source file missing for non-OCR KB dispatch, AIJ FAILED", {
        draftId: draft.id,
        aijId: aij.id,
        error: msg,
      });
      throw new Error(message, { cause: readErr });
    }
    await dispatchUploadToArchive({
      archiveId,
      userId: draft.uploadedBy,
      fileBuffer,
      fileName: draft.originalName,
      mimeType: draft.mimeType,
      preExistingJobId: aij.id,
    });
  }

  // Pitfall 4: kbJobId = aij.id (NOT ocrJob.id) — enrichDraftWithLegStatus
  // does prisma.archiveImportJob.findUnique on this id.
  await prisma.uploadDraft.update({
    where: { id: draft.id },
    data: {
      kbJobId: aij.id,
      kbEnabled: true,
      assignedArchiveId: archiveId,
    },
  });

  return { kbJobId: aij.id };
}

/**
 * 71-02 D-17: URL draft KB leg. Mirrors `dispatchKbLeg` but for URL drafts
 * stored with the `text/url` sentinel (filePath=<url>, mimeType="text/url",
 * originalName=<url>, fileSize=0). No file is read — the URL OcrJob is
 * dispatched via `createOcrJob(archiveId, "URL", ..., sourceUrl)` and picked
 * up by `processUrlJob` in `urlPipeline.ts`. The auto-approve hook fires
 * there (same `result.ocrJobId` lookup as the OCR branch) to flip the AIJ
 * to COMPLETED and create an ArchivePage from the fetched markdown.
 *
 * The URL draft is NOT yet persisted when this helper is called — the stage
 * route creates the UploadDraft row first, then invokes this helper. This
 * matches the multipart branch's order (draft row → dispatchKbLeg).
 */
export async function dispatchKbLegUrl(
  draft: UploadDraft,
  archiveId: string,
  sourceUrl: string,
  ocrMode?: string,
): Promise<{ kbJobId: string }> {
  // Pitfall 4: AIJ first (PROCESSING) so the leg is observable immediately.
  const aij = await prisma.archiveImportJob.create({
    data: {
      archiveId,
      documentId: null,
      status: "PROCESSING",
      sourceFileName: draft.originalName,
      createdBy: draft.uploadedBy,
      result: { ocrJobId: null },
    },
  });

  // D-17: dispatch URL OcrJob — processUrlJob fetches + extracts markdown.
  const ocrJob = await createOcrJob(
    archiveId,
    "URL",
    draft.uploadedBy,
    draft.originalName,
    undefined, // modelName — URL pipeline does not use OCR models
    sourceUrl, // sourceUrl — 6th arg
    ocrMode,   // ocrMode — optional passthrough
    undefined, // customInstructions
    undefined, // filePath — N/A for URL drafts
  );

  // Populate result.ocrJobId so the auto-approve hook in urlPipeline.ts can
  // find this AIJ when the URL OcrJob terminates (Q4 event-driven lookup).
  await prisma.archiveImportJob.update({
    where: { id: aij.id },
    data: { result: { ocrJobId: ocrJob.id } },
  });

  await prisma.uploadDraft.update({
    where: { id: draft.id },
    data: {
      kbJobId: aij.id,
      kbEnabled: true,
      assignedArchiveId: archiveId,
    },
  });

  return { kbJobId: aij.id };
}

/**
 * Fan-out orchestrator — `Promise.allSettled` of the requested legs
 * (D-69-05). Per-leg failure is isolated: a rejected thunk becomes a
 * `rejected` PromiseSettledResult, the other leg still completes and
 * persists its own soft FK.
 *
 * After `allSettled` resolves, persists `parseStatus = "assigned"` on
 * the draft. The "done" derivation is on-demand in
 * `enrichDraftWithLegStatus` (Pitfall 6 — no collector-callback hook).
 *
 * Defense-in-depth: throws early if `kb === true` but `archiveId` is
 * missing. Route validation should have caught this already; the guard
 * exists so a future caller cannot bypass the route layer.
 */
export async function dispatchUploadDraft(
  draft: UploadDraft,
  targets: AssignDraftInput,
): Promise<{
  ragResult: PromiseSettledResult<unknown> | null;
  kbResult: PromiseSettledResult<unknown> | null;
  parseStatus: "assigned";
}> {
  if (targets.kb === true && !targets.archiveId) {
    throw new Error("archiveId is required when kb is true");
  }

  // Map each requested leg to a stable key so the settled result is read
  // back by identity, NOT by positional index. A positional `results[0] /
  // results[1]` read is wrong when only one leg is enabled: e.g.
  // `{ rag: false, kb: true }` produces a single-element `tasks` array
  // whose sole result is the KB leg, but `results[0]` would be reported as
  // `ragResult` and `results[1]` (undefined) as `kbResult` (CR-01).
  const legTasks: Array<{ key: "rag" | "kb"; promise: Promise<unknown> }> = [];
  if (targets.rag === true) {
    legTasks.push({ key: "rag", promise: dispatchRagLeg(draft) });
  }
  if (targets.kb === true && targets.archiveId) {
    legTasks.push({ key: "kb", promise: dispatchKbLeg(draft, targets.archiveId) });
  }

  const results = await Promise.allSettled(legTasks.map((t) => t.promise));
  const settledByLeg: Partial<Record<"rag" | "kb", PromiseSettledResult<unknown>>> = {};
  legTasks.forEach((t, i) => {
    settledByLeg[t.key] = results[i];
  });

  await prisma.uploadDraft.update({
    where: { id: draft.id },
    data: { parseStatus: "assigned" },
  });

  return {
    ragResult: settledByLeg.rag ?? null,
    kbResult: settledByLeg.kb ?? null,
    parseStatus: "assigned",
  };
}

/**
 * Single source of truth for leg terminality (260829-h0n).
 *
 * Consumed by:
 *   - `enrichDraftWithLegStatus` (ragDone / kbDone derivation + promotion rule)
 *   - the DELETE /:id in-flight gate (`routes/uploads.ts`) — imports the
 *     exported sets instead of hand-rolling inline literals (documented
 *     anti-pattern)
 *   - tests pinning the gate behavior
 *
 * RAG_SUCCESS / KB_SUCCESS stay module-private: only the failure-aware
 * promotion rule uses them.
 *
 * RAG states mirror `Document.status` (lowercase), KB states mirror
 * `ArchiveImportJob.status` (uppercase).
 */
export const RAG_TERMINAL = new Set(["completed", "failed"]);
const RAG_SUCCESS = new Set(["completed"]);
export const KB_TERMINAL = new Set(["COMPLETED", "FAILED"]);
const KB_SUCCESS = new Set(["COMPLETED"]);

/**
 * Per-leg status derivation — manual `findUnique` lookup (D-69-03
 * corrected, Pitfall 3). `ragJobId` / `kbJobId` are `String?` plain, NOT
 * Prisma `@relation`, so a Prisma `include` of the related Document /
 * ArchiveImportJob is impossible without a migration that would violate
 * the Fase 68 freeze.
 *
 * `parseStatus = "done"` is derived on-demand here (Pitfall 6), not in
 * any collector callback:
 *   - RAG terminal states: `completed`, `failed` (Document.status).
 *   - KB terminal states:   `COMPLETED`, `FAILED` (ArchiveImportJob.status).
 *   - A leg that is not enabled (`ragEnabled=false` / `kbEnabled=false`)
 *     does not block `done` — only the requested legs must terminate.
 *
 * The `done` state is persisted lazily — only when the current
 * `draft.parseStatus !== "done"` — to avoid write storms on every poll.
 *
 * `ragStatus` / `kbStatus` are derived only, NEVER stored as columns
 * (D-69-03 — no redundant status duplication, no callback races).
 */
export async function enrichDraftWithLegStatus(
  draft: UploadDraft,
): Promise<UploadDraft & { ragStatus: string | null; kbStatus: string | null; parseStatus: string }> {
  const [ragDocument, kbJob] = await Promise.all([
    draft.ragJobId
      ? prisma.document.findUnique({
          where: { id: draft.ragJobId },
          select: { id: true, status: true },
        })
      : Promise.resolve(null),
    draft.kbJobId
      ? prisma.archiveImportJob.findUnique({
          where: { id: draft.kbJobId },
          select: { id: true, status: true },
        })
      : Promise.resolve(null),
  ]);

  const ragStatus = ragDocument?.status ?? null;
  const kbStatus = kbJob?.status ?? null;

  const ragDone = !draft.ragEnabled || (ragStatus !== null && RAG_TERMINAL.has(ragStatus));
  const kbDone = !draft.kbEnabled || (kbStatus !== null && KB_TERMINAL.has(kbStatus));

  // CR-02 guard: "done" is a terminal derivation ONLY for drafts that have
  // been dispatched. An unassigned draft (parseStatus "uploaded", both legs
  // still disabled) would otherwise satisfy `ragDone && kbDone` trivially
  // (both `!draft.ragEnabled` and `!draft.kbEnabled` are true) and be
  // promoted to "done" on the first GET /pending poll — which then excludes
  // it from the `parseStatus: "uploaded"` filter on the next poll, making
  // the pending list vanish. Requiring parseStatus === "assigned" means
  // only dispatched drafts (at least one leg enabled, parseStatus set to
  // "assigned" by dispatchUploadDraft) can reach "done".
  //
  // FAILURE-AWARE: "done" is set ONLY when both legs SUCCEEDED. If either
  // leg failed, the draft stays "assigned" so the user can retry the
  // failed leg via the assign route (otherwise the 409 "Draft already
  // finalized" gate blocks re-assignment and the user is stuck).
  const ragSucceeded = !draft.ragEnabled || (ragStatus !== null && RAG_SUCCESS.has(ragStatus));
  const kbSucceeded = !draft.kbEnabled || (kbStatus !== null && KB_SUCCESS.has(kbStatus));
  let parseStatus = draft.parseStatus;
  if (draft.parseStatus === "assigned" && ragDone && kbDone && ragSucceeded && kbSucceeded) {
    await prisma.uploadDraft.update({
      where: { id: draft.id },
      data: { parseStatus: "done" },
    });
    parseStatus = "done";
  }

  return { ...draft, ragStatus, kbStatus, parseStatus };
}
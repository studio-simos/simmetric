// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ocrStages.ts — OCR pipeline stage-grouped module (MOD-03 split)
 *
 * Surgical split of `ocrPipeline.ts` body (D-05 — ONE stage-grouped module,
 * NOT a directory of one file per stage). Three pipeline-phase groups:
 *
 *   1. Setup group   — runOcrSetupStage: Steps 1-3 (load+validate job,
 *                      locate PDF, buffer load + persist+unlink + hash + dedup
 *                      + modelConfig + image detection). The ENTIRE D-13
 *                      draft-source block (isDraftSource locate + persist+
 *                      unlink guard) stays together in THIS group
 *                      (RESEARCH Pitfall 4).
 *   2. OCR group     — runOcrStage: image branch (D-14 — bypass pdfjs) OR
 *                      PDF flow (load pdfjs + sequential page loop render →
 *                      OCR → guard → grounding → score → write → progress).
 *   3. Finalize group — runOcrFinalizeStage: Steps 6-10 (concatenate +
 *                      quality score + write concatenated + title extract +
 *                      complete + event log). Plus finalizeAutoApproveOnComplete
 *                      and finalizeAutoApproveOnFail (§80-180 of the original).
 *
 * Single entry `runOcrPipeline(jobId)` orchestrates the 3 groups.
 *
 * Sibling `ocr/` modules (pdfRenderer, ollamaVisionClient, modelRegistry,
 * hallucinationGuard, groundingCleanup, qualityScoring) are IMPORTED, NOT
 * re-implemented (RESEARCH Don't Hand-Roll). Public facade `ocrPipeline.ts`
 * keeps `processOcrJob`, `autoApproveOnComplete`, `autoApproveOnFail` as
 * thin wrappers delegating to this module (D-03).
 *
 * `truncateAtParagraph` is module-private at the top (serves BOTH the OCR
 * group image branch §509 AND the finalize group §877 — RESEARCH A3).
 */

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { logger } from "../utils/logger";
import { validateArchivePath } from "../utils/archivePath";
import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import {
  getOcrJob,
  startOcrJob,
  updateJobProgress,
  completeOcrJob,
  failOcrJob,
  parseOcrJobResult,
} from "../services/ocrJobService";
import { renderPageToPng } from "./pdfRenderer";
import { ocrPage } from "./ollamaVisionClient";
import { resolveModelConfig } from "./modelRegistry";
import { getSetting } from "../services/systemConfigService";
import { applyHallucinationGuard } from "./hallucinationGuard";
import { stripGroundingTags, sanitizeChatTokens } from "./groundingCleanup";
import {
  computePageQualityScore,
  computeDocumentQualityScore,
} from "./qualityScoring";

// ---------------------------------------------------------------------------
// Constants (module-private — §54-57 of the original)
// ---------------------------------------------------------------------------

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");
const UPLOADS_BASE = path.resolve(process.cwd(), "storage/uploads");
const MAX_CONCATENATED_LENGTH = 100_000;
const MAX_EMPTY_RETRIES = 1;

// ---------------------------------------------------------------------------
// Helpers (module-private — shared by OCR + Finalize groups, RESEARCH A3)
// ---------------------------------------------------------------------------

/**
 * Truncate markdown at the specified character limit, breaking at the nearest
 * paragraph boundary (double newline).
 */
function truncateAtParagraph(
  text: string,
  maxLength: number,
): string {
  if (text.length <= maxLength) return text;

  // Find the last paragraph break before the limit
  const slice = text.slice(0, maxLength);
  const lastBreak = slice.lastIndexOf("\n\n");
  if (lastBreak > maxLength * 0.5) {
    return slice.slice(0, lastBreak);
  }

  // Fallback: truncate at last newline
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0) {
    return slice.slice(0, lastNewline);
  }

  return slice;
}

// ---------------------------------------------------------------------------
// Inter-stage handoff types (D-10-style typed context-object)
// ---------------------------------------------------------------------------

type OcrJobLoaded = NonNullable<Awaited<ReturnType<typeof getOcrJob>>>;
type ModelConfig = ReturnType<typeof resolveModelConfig>;

interface SetupResult {
  job: OcrJobLoaded;
  pdfBuffer: Buffer;
  pdfPath: string;
  contentHash: string;
  isImage: boolean;
  modelConfig: ModelConfig;
  effectiveModelName: string;
  userId: string | null;
}

interface OcrResult {
  job: OcrJobLoaded;
  pageResults: Array<{
    pageNumber: number;
    markdown: string;
    imagePath?: string;
    tokensUsed: number;
    durationMs: number;
  }>;
  totalPages: number;
  totalTokens: number;
  totalDurationMs: number;
  hasUnverified: boolean;
  /** Pages whose markdown carries a [FAILED: marker (260829-lkq truthfulness) */
  failedPages: number;
  contentHash: string;
  modelConfig: ModelConfig;
  effectiveModelName: string;
  userId: string | null;
}

// ---------------------------------------------------------------------------
// Group 3 — Finalize helpers (§80-180 of the original, extracted here so
// ocrPipeline.ts facade can delegate)
// ---------------------------------------------------------------------------

/**
 * 71-02 Q4 event-driven auto-approve hook. Called after `completeOcrJob`.
 *
 * Looks up the associated ArchiveImportJob via a JSON path query on
 * `result.ocrJobId` (the AIJ row created by `dispatchKbLeg` in
 * `uploadDraftService.ts` — Pitfall 4 AIJ-first). If found, creates an
 * ArchivePage (reusing the ocr.ts:514 manual-approve logic:
 * `parseOcrJobResult` + `createPage` + `rebuildIndex`) and flips the AIJ
 * to `COMPLETED`. If NOT found, this is a standalone Archives OcrJob — the
 * hook is a no-op (manual approve flow preserved, Test 6).
 *
 * The hook wraps in try/catch — hook failure does NOT fail the OcrJob
 * (the OcrJob is already COMPLETED; the AIJ failure is recoverable via
 * retry). T-71-02-h: auto-approve is aligned with dispatchUploadToArchive
 * (parse-only, no approve step for md/xlsx/docx/pptx). The user explicitly
 * chose KB in the destination chooser — no silent auto-approve.
 */
export async function finalizeAutoApproveOnComplete(
  jobId: string,
  archiveId: string,
  userId: string | null,
  fullResult?: Record<string, unknown>,
): Promise<void> {
  try {
    const aij = await prisma.archiveImportJob.findFirst({
      where: { result: { path: ["ocrJobId"], equals: jobId } },
    });
    if (!aij) {
      // Standalone Archives OcrJob — manual approve flow preserved (Test 6).
      return;
    }

    // Fetch the OcrJob to get sourceFileName for title fallback
    const ocrJob = await prisma.ocrJob.findUnique({ where: { id: jobId } });

    const parsed = parseOcrJobResult(fullResult);
    const pageResults = parsed.pageResults || [];
    // 260814-wxr: mirror the dedup validity predicate (lines ~434-438) —
    // pages whose markdown is empty or starts with "[FAILED:" are NOT valid.
    // A COMPLETED OcrJob CAN still have zero valid pages (the dedup reprocess
    // branch below proves it: "Skipping dedup — existing job has no valid
    // pages, reprocessing"). Auto-approving such a result would silently
    // COMPLETE the AIJ while the wiki page was never extracted.
    const validPages = pageResults.filter(
      (p: { markdown?: string }) =>
        p.markdown && !String(p.markdown).startsWith("[FAILED:"),
    );
    if (validPages.length > 0) {
      const { createPage, rebuildIndex } = await import("../services/archivePageService");
      const title = parsed.extractedTitle
        || parsed.originalFileName?.replace(/\.[^.]+$/, "")
        || ocrJob?.sourceFileName?.replace(/\.[^.]+$/, "")
        || "OCR import";
      const content = validPages
        .map((pr: { pageNumber: number; markdown: string }) => `## Page ${pr.pageNumber}\n\n${pr.markdown}`)
        .join("\n\n---\n\n");
      await createPage(
        archiveId,
        { title, content, category: "entities" },
        userId || aij.createdBy,
      );
      await rebuildIndex(archiveId);
      logger.info("[ocr] Auto-approve: created ArchivePage from OcrJob", {
        jobId,
        archiveId,
        aijId: aij.id,
        title,
        pageCount: validPages.length,
      });

      await prisma.archiveImportJob.update({
        where: { id: aij.id },
        data: { status: "COMPLETED" },
      });

      // Push notification: OCR completed, wiki page created
      import("../routes/push")
        .then(({ sendPushNotification }) =>
          sendPushNotification(
            "Documento elaborato",
            `"${title}" è stato aggiunto al knowledge base (${validPages.length} pagine)`,
            userId || aij.createdBy,
            "/knowledge-base",
          ).catch(() => {}),
        )
        .catch(() => {});

      // Fire-and-forget synthesis trigger (matches the manual-approve route
      // at routes/ocr.ts:394-409 — auto-approve was missing this call, so
      // no SynthesisRun was ever created for auto-approve imports).
      import("../services/synthesisTriggerService")
        .then((m) =>
          m.onOcrJobCompleted(jobId, archiveId).catch((err: Error) =>
            logger.error("[synthesis] Trigger error (auto-approve)", {
              error: err.message,
              jobId,
              archiveId,
            }),
          ),
        )
        .catch((err: Error) =>
          logger.error("[synthesis] Failed to load trigger service", {
            error: err.message,
          }),
        );
    } else {
      // Zero valid pages — an empty OCR result is a FAILED AIJ, not a
      // COMPLETED one. Never create an empty ArchivePage (260814-wxr).
      logger.warn("[ocr] Auto-approve: no valid pages, AIJ FAILED", {
        jobId,
        archiveId,
        aijId: aij.id,
        totalPages: pageResults.length,
      });
      await prisma.archiveImportJob.update({
        where: { id: aij.id },
        data: {
          status: "FAILED",
          error: "OCR completed with no valid pages — not creating an empty archive page",
        },
      });

      // Push notification: OCR failed
      import("../routes/push")
        .then(({ sendPushNotification }) =>
          sendPushNotification(
            "Errore elaborazione documento",
            "L'OCR non ha prodotto pagine valide — riprova a caricare il documento",
            userId || aij.createdBy,
            "/uploads",
          ).catch(() => {}),
        )
        .catch(() => {});
    }
  } catch (err: unknown) {
    // Hook failure is non-fatal — the OcrJob is already COMPLETED.
    // The AIJ can be manually retried. T-71-02-mapping.
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[ocr] Auto-approve hook failed (non-fatal)", {
      jobId,
      archiveId,
      error: message,
    });
  }
}

/**
 * 71-02 Q4 event-driven hook. Called after `failOcrJob`.
 *
 * Flips the associated ArchiveImportJob to `FAILED` with the OcrJob error
 * message. No-op for standalone Archives OcrJobs (no AIJ — manual flow).
 */
export async function finalizeAutoApproveOnFail(
  jobId: string,
  errorMessage: string,
): Promise<void> {
  try {
    const aij = await prisma.archiveImportJob.findFirst({
      where: { result: { path: ["ocrJobId"], equals: jobId } },
    });
    if (!aij) {
      return;
    }

    await prisma.archiveImportJob.update({
      where: { id: aij.id },
      data: { status: "FAILED", error: errorMessage },
    });
    logger.info("[ocr] Auto-approve: flipped AIJ to FAILED", {
      jobId,
      aijId: aij.id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[ocr] AIJ fail hook failed (non-fatal)", {
      jobId,
      error: message,
    });
  }
}

// ---------------------------------------------------------------------------
// Group 1 — Setup stage (Steps 1-3, §219-460 of the original)
// ---------------------------------------------------------------------------

/**
 * Setup stage — load+validate job, locate PDF (draft/fallback/primary), load
 * buffer, persist-to-archive + unlink staging (non-draft only), compute hash,
 * dedup check, resolve model config, detect image branch.
 *
 * The ENTIRE D-13 draft-source block (isDraftSource declaration + locate +
 * persist+unlink guard) stays together in THIS function (RESEARCH Pitfall 4 —
 * do NOT split the locate from the guard).
 *
 * Returns `null` if the pipeline should short-circuit (terminal state,
 * missing source filename, file not found, or dedup hit). All early-return
 * side effects (failOcrJob/autoApproveOnFail/completeOcrJob/autoApproveOnComplete
 * /logEvent) are emitted before returning null, matching the original
 * processOcrJob control flow byte-for-byte.
 */
async function runOcrSetupStage(jobId: string): Promise<SetupResult | null> {
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
    logger.info("[ocr] Job already in terminal state, skipping", {
      jobId,
      status: job.status,
    });
    return null;
  }

  const userId = job.createdBy;

  // ---- Step 2: Locate the uploaded PDF file ----
  if (!job.sourceFileName) {
    await failOcrJob(jobId, "No source filename in job metadata");
    await finalizeAutoApproveOnFail(jobId, "No source filename in job metadata");
    return null;
  }

  // D-13: draft filePath lookup. If result.filePath is set (unified-upload KB leg),
  // use it directly and mark isDraftSource so the persist+unlink block is skipped
  // (Pitfall 2 — the draft file must survive for the RAG leg of a "both" fan-out).
  const resultMeta = parseOcrJobResult(job.result);
  const draftFilePath = resultMeta.filePath;
  const isDraftSource = Boolean(draftFilePath);

  // Try primary path (uploads staging directory) first, then fall back to
  // the persisted copy in the archive's source/ directory.
  const sourceDir = path.resolve(ARCHIVES_BASE, job.archiveId, "source");
  const primaryPath = path.resolve(UPLOADS_BASE, job.sourceFileName);
  const fallbackPath = path.resolve(sourceDir, job.sourceFileName);

  let pdfPath: string | null = null;
  if (isDraftSource && draftFilePath) {
    // Draft source: read directly from the draft filePath (storage/uploads/drafts/)
    pdfPath = path.resolve(draftFilePath);
    try {
      await fs.access(pdfPath);
    } catch {
      logger.error("[ocr] Draft filePath not accessible", {
        jobId,
        archiveId: job.archiveId,
        draftFilePath,
      });
      await failOcrJob(
        jobId,
        "Draft source file not found. It may have been reaped by the 24h cleanup.",
      );
      await finalizeAutoApproveOnFail(
        jobId,
        "Draft source file not found. It may have been reaped by the 24h cleanup.",
      );
      return null;
    }
    logger.info("[ocr] Using draft filePath as source (skip-unlink)", {
      jobId,
      archiveId: job.archiveId,
      draftFilePath,
    });
  } else {
    try {
      await fs.access(primaryPath);
      pdfPath = primaryPath;
    } catch {
      try {
        await fs.access(fallbackPath);
        pdfPath = fallbackPath;
        logger.info("[ocr] Using fallback PDF path", {
          jobId,
          archiveId: job.archiveId,
          fallbackPath,
        });
      } catch {
        logger.error("[ocr] PDF file not found at either path", {
          jobId,
          archiveId: job.archiveId,
          sourceFileName: job.sourceFileName,
          primaryPath,
          fallbackPath,
        });
        await failOcrJob(
          jobId,
          "Uploaded PDF file not found. It may have been deleted.",
        );
        await finalizeAutoApproveOnFail(
          jobId,
          "Uploaded PDF file not found. It may have been deleted.",
        );
        return null;
      }
    }
  }

  // ---- Step 3: Load source buffer, persist to archive (non-draft only), compute hash ----
  const pdfBuffer = await fs.readFile(pdfPath);

  // Persist a copy in the archive's source/ directory for durability.
  // This ensures the file survives even if storage/uploads/ is cleaned up.
  // D-13 Pitfall 2: skip persist+unlink for draft sources — the draft file
  // stays in storage/uploads/drafts/ for the RAG leg of a "both" fan-out.
  // Defense-in-depth path-prefix guard: only unlink within UPLOADS_BASE.
  if (
    !isDraftSource &&
    pdfPath === primaryPath &&
    pdfPath.startsWith(path.resolve(UPLOADS_BASE))
  ) {
    try {
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(fallbackPath, pdfBuffer);
      // Remove the original from the staging directory to prevent disk leak
      await fs.unlink(primaryPath);
      // Update pdfPath to the new location so subsequent rendering uses the correct file
      pdfPath = fallbackPath;
      logger.info("[ocr] PDF persisted to archive source directory", {
        jobId,
        archiveId: job.archiveId,
        sourcePath: fallbackPath,
      });
    } catch (persistErr: unknown) {
      const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      // Non-fatal: the pipeline can continue with the in-memory buffer.
      // The original file remains in uploads/ as a safety net.
      logger.warn("[ocr] Failed to persist PDF to archive, continuing with buffer", {
        jobId,
        archiveId: job.archiveId,
        error: msg,
      });
    }
  }
  const contentHash = crypto
    .createHash("sha256")
    .update(pdfBuffer)
    .digest("hex");

  // Persist contentHash to the indexed column for dedup queries
  await prisma.ocrJob.update({
    where: { id: jobId },
    data: { contentHash },
  });

  // Dedup check: skip if an identical COMPLETED job exists in the same archive
  const existingJob = await prisma.ocrJob.findFirst({
    where: {
      archiveId: job.archiveId,
      contentHash,
      status: "COMPLETED",
      id: { not: jobId },
    },
  });

  if (existingJob) {
    // Skip dedup if the existing job has no valid page results (all pages failed)
    const existingResult = parseOcrJobResult(existingJob.result);
    const pageResults = existingResult.pageResults as Array<{ markdown: string }> | undefined;
    const hasValidPages = pageResults?.some(
      (p) => p.markdown && !p.markdown.startsWith("[FAILED:")
    );

    if (!hasValidPages && pageResults && pageResults.length > 0) {
      logger.info("[ocr] Skipping dedup — existing job has no valid pages, reprocessing", {
        jobId,
        existingJobId: existingJob.id,
        contentHash,
        totalPages: existingJob.totalPages,
      });
      // Fall through to reprocess
    } else {
      logger.info("[ocr] Deduplicated — identical COMPLETED job found", {
        jobId,
        existingJobId: existingJob.id,
        contentHash,
      });

      await completeOcrJob(
        jobId,
        {
          totalPages: existingJob.totalPages ?? undefined,
          qualityScore: existingResult.qualityScore,
          totalTokens: existingResult.totalTokens,
          totalDurationMs: existingResult.totalDurationMs,
          hasUnverified: existingResult.hasUnverified,
        },
        existingJob.result as Record<string, unknown> ?? undefined
      );
      await finalizeAutoApproveOnComplete(
        jobId,
        job.archiveId,
        userId,
        existingJob.result as Record<string, unknown> ?? undefined,
      );

      // Fire-and-forget event log
      logEvent("ocr_job", jobId, "job.deduplicated", userId, {
        archiveId: job.archiveId,
        contentHash,
        dedupFromJobId: existingJob.id,
      }).catch((err: Error) =>
        logger.error("[ocr] Failed to log dedup event", {
          jobId,
          error: err.message,
        }),
      );

      return null;
    }
  }

  // Resolve model config for prompt template selection (needed for both image
  // branch and PDF pdfjs flow — resolved early so the image branch can use it).
  // When job.modelName is null (the common case — dispatchKbLeg passes
  // undefined), read OCR_DEFAULT_MODEL from SystemConfig instead of falling
  // back to a hardcoded "glm-ocr:latest".
  let effectiveModelName = job.modelName;
  if (!effectiveModelName) {
    try {
      const ocrModelSetting = await getSetting("OCR_DEFAULT_MODEL");
      effectiveModelName = ocrModelSetting.value || "glm-ocr:latest";
    } catch {
      effectiveModelName = "glm-ocr:latest";
    }
  }
  const modelConfig = resolveModelConfig(effectiveModelName);
  logger.info("[ocr] Resolved model config", {
    jobId,
    modelName: effectiveModelName,
    promptTemplate: modelConfig.promptTemplate,
  });

  // ---- D-14 Pitfall 3: Image branch detection (bypass pdfjs-dist) ----
  // If the source is an image (mimeType or extension), skip pdfjs entirely,
  // read the raw image buffer, and call ocrPage directly with a single page.
  // ocrPage accepts a generic Buffer (Q2 verified — case a, no sharp conversion).
  const ocrJobResult = job.result as Record<string, unknown> | null;
  const isImage =
    /^image\//.test(String(ocrJobResult?.mimeType ?? "")) ||
    /\.(png|jpe?g|webp|tiff?)$/i.test(job.sourceFileName ?? "");

  return {
    job,
    pdfBuffer,
    pdfPath,
    contentHash,
    isImage,
    modelConfig,
    effectiveModelName,
    userId,
  };
}

// ---------------------------------------------------------------------------
// Group 2 — OCR stage (image branch D-14 + PDF flow Steps 4-5, §460-870)
// ---------------------------------------------------------------------------

/**
 * OCR stage — runs the image branch (D-14: bypass pdfjs, call ocrPage directly
 * with image buffer) OR the PDF flow (load pdfjs + sequential page loop:
 * render → OCR → strip grounding → guard → retry empty → score → write →
 * progress).
 *
 * Image branch performs its own finalize (completeOcrJob + auto-approve +
 * logEvent + return) — matching the original short-circuit — and returns
 * `null` so the orchestrator skips the PDF finalize stage.
 *
 * PDF flow returns an `OcrResult` (pageResults + totals) for the Finalize
 * stage to consume.
 */
async function runOcrStage(setup: SetupResult): Promise<OcrResult | null> {
  const { job, pdfBuffer, pdfPath, contentHash, isImage, modelConfig, effectiveModelName, userId } = setup;
  const jobId = job.id;

  if (isImage) {
    logger.info("[ocr] Image source detected — bypassing pdfjs, calling ocrPage directly", {
      jobId,
      archiveId: job.archiveId,
      sourceFileName: job.sourceFileName,
    });

    const imageBuffer = pdfBuffer; // already read in Step 3
    const totalPages = 1;
    await startOcrJob(jobId, totalPages);

    let imageOcrResult: Awaited<ReturnType<typeof ocrPage>>;
    try {
      imageOcrResult = await ocrPage(
        imageBuffer,
        1,
        1,
        effectiveModelName,
        modelConfig,
        undefined,
        false,
        (job.ocrMode as "text" | "table" | "figure" | "generic" | undefined) ?? undefined,
        job.customInstructions ?? undefined,
      );
    } catch (ocrErr: unknown) {
      const message = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
      logger.error("[ocr] Image OCR failed", { jobId, error: message });
      await failOcrJob(jobId, `Image OCR failed: ${message}`);
      await finalizeAutoApproveOnFail(jobId, `Image OCR failed: ${message}`);
      return null;
    }

    // Strip grounding tags (DeepSeek OCR only) + hallucination guard
    let cleanMarkdown = imageOcrResult.markdown;
    if (modelConfig.promptTemplate === "deepseek-ocr") {
      cleanMarkdown = stripGroundingTags(imageOcrResult.markdown);
    }
    // Universal chat-template token sanitize pass (always-on, all templates)
    cleanMarkdown = sanitizeChatTokens(cleanMarkdown);
    const guardResult = applyHallucinationGuard(cleanMarkdown, 1, !!job.archiveId);

    const imagePageResult = {
      pageNumber: 1,
      markdown: guardResult.markdown,
      tokensUsed: imageOcrResult.tokensUsed,
      durationMs: imageOcrResult.durationMs,
    };

    // Update progress to 100%
    await updateJobProgress(jobId, {
      processedPages: 1,
      progress: 100,
      currentPage: 1,
    });

    // Concatenate (single page — just the one markdown, capped at 100K)
    let fullMarkdown = `## Page 1\n\n${imagePageResult.markdown}`;
    if (fullMarkdown.length > MAX_CONCATENATED_LENGTH) {
      fullMarkdown = truncateAtParagraph(fullMarkdown, MAX_CONCATENATED_LENGTH);
    }

    const imageQualityScore = computeDocumentQualityScore(
      [{ score: 4, pageNumber: 1 }],
      imageOcrResult.durationMs,
      imageOcrResult.tokensUsed,
    );

    // Write concatenated file (same as PDF flow)
    const rawDir = path.resolve(ARCHIVES_BASE, job.archiveId, "raw_sources");
    await fs.mkdir(rawDir, { recursive: true });
    const concatRelPath = "raw_sources/concatenated.md";
    validateArchivePath(
      path.resolve(ARCHIVES_BASE, job.archiveId),
      concatRelPath,
    );
    const concatPath = path.resolve(
      ARCHIVES_BASE,
      job.archiveId,
      concatRelPath,
    );
    await fs.writeFile(concatPath, fullMarkdown, "utf-8");

    await completeOcrJob(
      jobId,
      {
        totalPages: 1,
        qualityScore: imageQualityScore.overall,
        totalTokens: imageOcrResult.tokensUsed,
        totalDurationMs: imageOcrResult.durationMs,
        hasUnverified: guardResult.hasUnverified,
      },
      {
        pageResults: [imagePageResult],
        contentHash,
        qualityScoreDetail: imageQualityScore,
        extractedTitle: undefined,
      },
    );
    await finalizeAutoApproveOnComplete(jobId, job.archiveId, userId, {
      pageResults: [imagePageResult],
      contentHash,
      qualityScoreDetail: imageQualityScore,
      extractedTitle: undefined,
    });

    logEvent("ocr_job", jobId, "job.completed", userId, {
      archiveId: job.archiveId,
      totalPages: 1,
      totalTokens: imageOcrResult.tokensUsed,
      totalDurationMs: imageOcrResult.durationMs,
      hasUnverified: guardResult.hasUnverified,
      modelName: effectiveModelName,
      sourceKind: "image",
    }).catch((err: Error) =>
      logger.error("[ocr] Failed to log image completion event", {
        jobId,
        error: err.message,
      }),
    );

    return null; // Image branch complete — skip PDF finalize stage
  }

  // ---- Step 4: Load PDF document ----
  const pdfDoc = await pdfjsLib
    .getDocument({
      data: new Uint8Array(pdfBuffer),
      disableAutoFetch: true,
      disableStream: true,
    })
    .promise;

  const totalPages = pdfDoc.numPages;
  await startOcrJob(jobId, totalPages);

  // ---- Step 5: Sequential page loop (D-07) ----
  const pageResults: Array<{
    pageNumber: number;
    markdown: string;
    imagePath?: string;
    tokensUsed: number;
    durationMs: number;
  }> = [];

  let totalTokens = 0;
  let totalDurationMs = 0;
  let hasUnverified = false;
  // 260829-lkq: pages that end with a [FAILED: marker — surfaced in the job
  // summary payload so the "[ocr] Job completed" log and the stored result
  // JSON are truthful about page health (a COMPLETED job can still contain
  // failed pages; zero tokens + qualityScore floor alone are ambiguous).
  let failedPages = 0;

  for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
    logger.info("[ocr] Processing page", {
      jobId,
      page: currentPage,
      totalPages,
    });

    try {
      // ---- 5a. Render ----
      let pngBuffer: Buffer;
      try {
        pngBuffer = await renderPageToPng(pdfPath, currentPage, 2.0);
      } catch (renderErr: unknown) {
  const message = renderErr instanceof Error ? renderErr.message : String(renderErr);
        logger.error("[ocr] Page rendering failed", {
          jobId,
          page: currentPage,
          error: message,
        });
        pageResults.push({
          pageNumber: currentPage,
          markdown: `[FAILED: Could not render page — PDF rendering error]`,
          tokensUsed: 0,
          durationMs: 0,
        });
        failedPages++;

        // Still update progress for the failed page
        const progress = Math.round((currentPage / totalPages) * 100);
        await updateJobProgress(jobId, {
          processedPages: currentPage,
          progress,
          currentPage,
        });
        continue;
      }

      // ---- 5b. OCR ----
      let ocrResult: Awaited<ReturnType<typeof ocrPage>>;
      try {
        ocrResult = await ocrPage(
          pngBuffer,
          currentPage,
          totalPages,
          effectiveModelName,
          modelConfig,
          undefined,
          false,
          (job.ocrMode as "text" | "table" | "figure" | "generic" | undefined) ?? undefined,
          job.customInstructions ?? undefined,
        );
      } catch (ocrErr: unknown) {
        const message = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
        const isModelNotFound = message.toLowerCase().includes("not found");
        if (isModelNotFound) {
          logger.warn("[ocr] OCR model not found", {
            jobId,
            page: currentPage,
            error: message,
          });
        } else {
          logger.error("[ocr] OCR failed", {
            jobId,
            page: currentPage,
            error: message,
          });
        }
        pageResults.push({
          pageNumber: currentPage,
          markdown: isModelNotFound
            ? `[FAILED: OCR model not installed — ${message}]`
            : `[FAILED: OCR model error — ${message}]`,
          tokensUsed: 0,
          durationMs: 0,
        });
        failedPages++;

        const progress = Math.round((currentPage / totalPages) * 100);
        await updateJobProgress(jobId, {
          processedPages: currentPage,
          progress,
          currentPage,
        });
        continue;
      }

      // ---- 5c. Strip grounding tags (DeepSeek OCR only) ----
      let cleanMarkdown = ocrResult.markdown;
      if (modelConfig.promptTemplate === "deepseek-ocr") {
        // Log raw output length for debugging empty-page issues
        const rawLen = ocrResult.markdown.trim().length;
        logger.info("[ocr] Pre-strip output length", {
          jobId,
          page: currentPage,
          rawLength: rawLen,
        });
        cleanMarkdown = stripGroundingTags(ocrResult.markdown);
      }
      // Universal chat-template token sanitize pass (always-on, all templates)
      cleanMarkdown = sanitizeChatTokens(cleanMarkdown);

      // ---- 5d. Guard ----
      let guardResult = applyHallucinationGuard(
        cleanMarkdown,
        currentPage,
        !!job.archiveId,
      );
      if (guardResult.hasUnverified) {
        hasUnverified = true;
      }

      // Handle empty output with retry
      let pageMarkdown = guardResult.markdown;
      if (guardResult.hasEmpty) {
        logger.warn("[ocr] Empty page output detected, retrying", {
          jobId,
          page: currentPage,
        });

        // Brief pause before retry to avoid hammering the model
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        let retrySuccess = false;
        for (
          let retry = 0;
          retry < MAX_EMPTY_RETRIES && !retrySuccess;
          retry++
        ) {
          try {
            // Use fallback prompt on retry to avoid repeating the same
            // prompt that produced empty output (e.g., grounding-only pages).
            const retryResult = await ocrPage(
              pngBuffer,
              currentPage,
              totalPages,
              effectiveModelName,
              modelConfig,
              undefined,
              true, // useFallbackPrompt — different strategy for retry
              (job.ocrMode as "text" | "table" | "figure" | "generic" | undefined) ?? undefined,
              job.customInstructions ?? undefined,
            );

            let retryMarkdown = retryResult.markdown;
            if (modelConfig.promptTemplate === "deepseek-ocr") {
              const retryRawLen = retryResult.markdown.trim().length;
              logger.info("[ocr] Retry pre-strip output length", {
                jobId,
                page: currentPage,
                retry,
                rawLength: retryRawLen,
              });
              retryMarkdown = stripGroundingTags(retryResult.markdown);
            }
            // Universal chat-template token sanitize pass (always-on, all templates)
            retryMarkdown = sanitizeChatTokens(retryMarkdown);

            const retryGuard = applyHallucinationGuard(
              retryMarkdown,
              currentPage,
              !!job.archiveId,
            );

            if (!retryGuard.hasEmpty) {
              // Retry succeeded — overwrite guard and OCR result for downstream use
              guardResult = retryGuard;
              pageMarkdown = retryGuard.markdown;
              if (retryGuard.hasUnverified) {
                hasUnverified = true;
              }
              ocrResult = retryResult;
              retrySuccess = true;
              logger.info("[ocr] Empty page retry succeeded", {
                jobId,
                page: currentPage,
                retry,
              });
            } else {
              logger.warn("[ocr] Empty page retry also returned empty", {
                jobId,
                page: currentPage,
                retry,
              });
            }
          } catch (retryErr: unknown) {
  const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
            logger.error("[ocr] Empty page retry failed with error", {
              jobId,
              page: currentPage,
              retry,
              error: message,
            });
          }
        }

        if (!retrySuccess) {
          pageMarkdown = `[FAILED: OCR model returned empty output for page ${currentPage} after ${MAX_EMPTY_RETRIES + 1} attempt(s)]`;
          failedPages++;
        }
      }

      // ---- 5d. Score ----
      computePageQualityScore(
        guardResult.markdown,
        guardResult.hasUnverified,
        guardResult.unverifiedCount,
        guardResult.issues,
      );

      // ---- 5e. Write Markdown to raw/ (file-first ordering) ----
      const rawDir = path.resolve(ARCHIVES_BASE, job.archiveId, "raw_sources");
      await fs.mkdir(rawDir, { recursive: true });

      const paddedPage = String(currentPage).padStart(4, "0");
      const markdownRelPath = `raw_sources/page-${paddedPage}.md`;
      validateArchivePath(
        path.resolve(ARCHIVES_BASE, job.archiveId),
        markdownRelPath,
      );
      const markdownPath = path.resolve(
        ARCHIVES_BASE,
        job.archiveId,
        markdownRelPath,
      );
      await fs.writeFile(markdownPath, pageMarkdown, "utf-8");

      // ---- 5f. Write source PNG alongside ----
      const imageRelPath = `raw_sources/page-${paddedPage}.png`;
      validateArchivePath(
        path.resolve(ARCHIVES_BASE, job.archiveId),
        imageRelPath,
      );
      const imagePath = path.resolve(
        ARCHIVES_BASE,
        job.archiveId,
        imageRelPath,
      );
      await fs.writeFile(imagePath, pngBuffer);

      // ---- 5g. Accumulate results ----
      pageResults.push({
        pageNumber: currentPage,
        markdown: pageMarkdown,
        imagePath: imageRelPath,
        tokensUsed: ocrResult.tokensUsed,
        durationMs: ocrResult.durationMs,
      });
      totalTokens += ocrResult.tokensUsed;
      totalDurationMs += ocrResult.durationMs;

      // ---- 5h. Update progress ----
      const progress = Math.round((currentPage / totalPages) * 100);
      await updateJobProgress(jobId, {
        processedPages: currentPage,
        progress,
        currentPage,
      });
    } catch (pageErr: unknown) {
  const message = pageErr instanceof Error ? pageErr.message : String(pageErr);
      // Catch-all for unexpected errors on a single page
      logger.error("[ocr] Unexpected page processing error", {
        jobId,
        page: currentPage,
        error: message,
      });
      pageResults.push({
        pageNumber: currentPage,
        markdown: `[FAILED: Unexpected error — ${message}]`,
        tokensUsed: 0,
        durationMs: 0,
      });
      failedPages++;

      const progress = Math.round((currentPage / totalPages) * 100);
      await updateJobProgress(jobId, {
        processedPages: currentPage,
        progress,
        currentPage,
      });
    }
  }

  return {
    job,
    pageResults,
    totalPages,
    totalTokens,
    totalDurationMs,
    hasUnverified,
    failedPages,
    contentHash,
    modelConfig,
    effectiveModelName,
    userId,
  };
}

// ---------------------------------------------------------------------------
// Group 3 — Finalize stage (Steps 6-10, §871-1019)
// ---------------------------------------------------------------------------

/**
 * Finalize stage — concatenate page results, compute document quality score,
 * write concatenated file, extract title, complete job, fire-and-forget
 * event log. Runs ONLY for the PDF flow (image branch finalizes itself inside
 * the OCR stage).
 */
async function runOcrFinalizeStage(ocr: OcrResult): Promise<void> {
  const { job, pageResults, totalPages, totalTokens, totalDurationMs, hasUnverified, failedPages, contentHash, effectiveModelName, userId } = ocr;
  const jobId = job.id;

  // ---- Step 6: Concatenate page results ----
  let fullMarkdown = pageResults
    .map((r) => `## Page ${r.pageNumber}\n\n${r.markdown}`)
    .join("\n\n---\n\n");

  if (fullMarkdown.length > MAX_CONCATENATED_LENGTH) {
    const truncated = truncateAtParagraph(
      fullMarkdown,
      MAX_CONCATENATED_LENGTH,
    );
    fullMarkdown =
      truncated +
      `\n\n[TRUNCATED: Output exceeds ${MAX_CONCATENATED_LENGTH} characters. ` +
      `Total pages: ${totalPages}. Full per-page files available in raw/]`;
  }

  // ---- Step 7: Compute document quality score ----
  const qualityScore = computeDocumentQualityScore(
    pageResults.map((r) => {
      // Use the page quality score we computed earlier; for failed pages default to 1
      const failedMarker = r.markdown.startsWith("[FAILED:");
      return {
        score: failedMarker ? 1 : 4,
        pageNumber: r.pageNumber,
      };
    }),
    totalDurationMs,
    totalTokens,
  );

  // ---- Step 8: Write concatenated file ----
  const rawDir = path.resolve(ARCHIVES_BASE, job.archiveId, "raw_sources");
  await fs.mkdir(rawDir, { recursive: true });
  const concatRelPath = "raw_sources/concatenated.md";
  validateArchivePath(
    path.resolve(ARCHIVES_BASE, job.archiveId),
    concatRelPath,
  );
  const concatPath = path.resolve(
    ARCHIVES_BASE,
    job.archiveId,
    concatRelPath,
  );
  await fs.writeFile(concatPath, fullMarkdown, "utf-8");

  // ---- Step 8: Extract title from first page's OCR markdown ----
  let extractedTitle: string | undefined;

  // Find the first non-failed page
  for (const pr of pageResults) {
    if (pr.markdown.startsWith("[FAILED:")) continue;

    // Try to extract first level-1 heading
    const headingMatch = pr.markdown.match(/^#\s+(.+)$/m);
    if (headingMatch && headingMatch[1]!.trim()) {
      extractedTitle = headingMatch[1]!.trim();
      break;
    }

    // Fallback: first non-empty line after stripping markdown formatting
    const lines = pr.markdown.split("\n");
    for (const line of lines) {
      const stripped = line
        .replace(/^#{1,6}\s+/, "")   // remove heading markers
        .replace(/\*\*([^*]+)\*\*/g, "$1")  // remove bold
        .replace(/\*([^*]+)\*/g, "$1")      // remove italic
        .replace(/`([^`]+)`/g, "$1")        // remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // remove links
        .trim();
      if (stripped.length > 0) {
        extractedTitle = stripped;
        break;
      }
    }
    if (extractedTitle) break;
  }

  // Truncate to 200 characters if needed
  if (extractedTitle && extractedTitle.length > 200) {
    extractedTitle = extractedTitle.slice(0, 200);
  }

  // ---- Step 9: Complete job with full result (single atomic write) ----
  await completeOcrJob(
    jobId,
    {
      totalPages,
      qualityScore: qualityScore.overall,
      totalTokens,
      totalDurationMs,
      hasUnverified,
      failedPages,
    },
    {
      pageResults,
      contentHash,
      qualityScoreDetail: qualityScore,
      extractedTitle,
    }
  );
  await finalizeAutoApproveOnComplete(jobId, job.archiveId, userId, {
    pageResults,
    contentHash,
    qualityScoreDetail: qualityScore,
    extractedTitle,
  });

  // 260829-lkq: make the completed state truthful when some pages failed —
  // a COMPLETED job with [FAILED: pages used to log as a plain success with
  // zero tokens; the WARN makes the degraded status unmissable in logs.
  if (failedPages > 0) {
    logger.warn("[ocr] Job completed with failed pages", {
      jobId,
      failedPages,
      totalPages,
    });
  }

  // ---- Step 10: Fire-and-forget event log ----
  logEvent("ocr_job", jobId, "job.completed", userId, {
    archiveId: job.archiveId,
    totalPages,
    totalTokens,
    totalDurationMs,
    hasUnverified,
    modelName: effectiveModelName,
  }).catch((err: Error) =>
    logger.error("[ocr] Failed to log completion event", {
      jobId,
      error: err.message,
    }),
  );
}

// ---------------------------------------------------------------------------
// Single entry — orchestrates the 3 stage groups (D-05, RESEARCH Code Examples)
// ---------------------------------------------------------------------------

/**
 * Process a single OcrJob from PENDING to COMPLETED (or FAILED).
 *
 * Designed as a Bree-compatible job handler:
 *   - Accepts a jobId string
 *   - Returns a Promise<void>
 *   - All errors caught internally, job state set to FAILED on unhandled errors
 *
 * Orchestrates the 3 stage groups (Setup → OCR → Finalize). The outer try/catch
 * preserves the original catastrophic-failure handling byte-for-byte: on any
 * unhandled error, marks the job FAILED, fires the auto-approve-fail hook, and
 * logs a `job.failed` event.
 */
export async function runOcrPipeline(jobId: string): Promise<void> {
  let userId: string | null = null;

  try {
    const setup = await runOcrSetupStage(jobId);
    if (setup === null) {
      // Setup short-circuited (terminal state, missing source, file not found,
      // or dedup hit) — all side effects already emitted. Mirror the original
      // processOcrJob early-return control flow.
      return;
    }
    userId = setup.userId;

    const ocr = await runOcrStage(setup);
    if (ocr === null) {
      // Image branch (D-14) finalized itself — skip PDF finalize stage.
      return;
    }

    await runOcrFinalizeStage(ocr);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // ---- Catastrophic failure (outer try/catch) ----
    logger.error("[ocr] Pipeline failed", {
      jobId,
      error: message,
    });

    try {
      await failOcrJob(jobId, message);
      await finalizeAutoApproveOnFail(jobId, message);
    } catch (failErr: unknown) {
      const failMessage = failErr instanceof Error ? failErr.message : String(failErr);
      logger.error("[ocr] Failed to mark job as FAILED", {
        jobId,
        error: failMessage,
      });
    }

    // Fire-and-forget event log for failure
    logEvent("ocr_job", jobId, "job.failed", userId, {
      error: message,
    }).catch((logErr: Error) =>
      logger.error("[ocr] Failed to log failure event", {
        jobId,
        error: logErr.message,
      }),
    );
  }
}
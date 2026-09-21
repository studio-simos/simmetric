// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ocrRepair.ts — post-job page repair (260919-kvm)
 *
 * Re-OCRs ONLY the pages whose markdown carries a [FAILED: marker, using the
 * persisted page PNG (raw_sources/page-NNNN.png) when available, or
 * re-rendering from the persisted source PDF (storage/archives/<archiveId>/
 * source/<sourceFileName>) when the page failed before the PNG was written
 * (render/model-error pages push their marker BEFORE the PNG write).
 *
 * Persistence contract: prisma.ocrJob.update writes ONLY `result` —
 * status/progress are NEVER touched (the job stays COMPLETED).
 */

import path from "path";
import fs from "fs/promises";
import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { validateArchivePath } from "../utils/archivePath";
import { getOcrJob, parseOcrJobResult } from "../services/ocrJobService";
import { getSetting } from "../services/systemConfigService";
import { renderPageToPng } from "./pdfRenderer";
import { ocrPage } from "./ollamaVisionClient";
import { resolveModelConfig } from "./modelRegistry";
import { applyHallucinationGuard } from "./hallucinationGuard";
import type { GuardResult } from "./hallucinationGuard";
import { stripGroundingTags, sanitizeChatTokens } from "./groundingCleanup";
import { computeDocumentQualityScore } from "./qualityScoring";
import {
  buildConcatenatedMarkdown,
  resolveGuardMode,
  finalizeAutoApproveOnComplete,
} from "./ocrStages";
import type { OcrPageRetryRequest } from "@simmetric-chat/shared";

const ARCHIVES_BASE = path.resolve(process.cwd(), "storage/archives");
const MAX_REPAIR_TARGETS = 50;
const MAX_REPAIR_ATTEMPTS = 2;

export class JobNotFoundError extends Error {
  constructor() {
    super("Job not found");
    this.name = "JobNotFoundError";
  }
}

export class JobNotCompletedError extends Error {
  constructor() {
    super("Job not completed");
    this.name = "JobNotCompletedError";
  }
}

export class TooManyRepairTargetsError extends Error {
  requestedCount: number;
  constructor(count: number) {
    super(`Too many failed pages (max ${MAX_REPAIR_TARGETS} per request)`);
    this.name = "TooManyRepairTargetsError";
    this.requestedCount = count;
  }
}

export interface RepairPageOutcome {
  pageNumber: number;
  markdown: string;
  stillFailed: boolean;
}

export interface RepairOutcome {
  repaired: RepairPageOutcome[];
  failedPages: number;
  qualityScore: number | null;
}

interface RepairPageEntry {
  pageNumber: number;
  markdown: string;
  imagePath?: string;
  tokensUsed: number;
  durationMs: number;
}

/**
 * Repair failed OCR pages of a COMPLETED job (260919-kvm).
 *
 * @param jobId - The COMPLETED OcrJob id
 * @param pages - Optional explicit page list (1-based); omitted = all
 *   [FAILED: pages. > 50 targets throws TooManyRepairTargetsError (the
 *   route maps it to 400).
 * @param userId - Requester (event-log + auto-approve attribution)
 * @throws JobNotFoundError — job missing
 * @throws JobNotCompletedError — job not in COMPLETED state
 * @throws TooManyRepairTargetsError — more than 50 repair targets
 */
export async function repairOcrPages(
  jobId: string,
  pages: OcrPageRetryRequest["pages"],
  userId: string | null,
): Promise<RepairOutcome> {
  const job = await getOcrJob(jobId);
  if (!job) {
    throw new JobNotFoundError();
  }
  if (job.status !== "COMPLETED") {
    throw new JobNotCompletedError();
  }

  const parsed = parseOcrJobResult(job.result);
  const pageResults: RepairPageEntry[] = (parsed.pageResults ?? []).map((p) => ({
    pageNumber: p.pageNumber,
    markdown: p.markdown,
    imagePath: p.imagePath,
    tokensUsed: p.tokensUsed,
    durationMs: p.durationMs,
  }));

  // Targets = explicitly listed pages ∩ existing pageResults, else every
  // [FAILED: page.
  const targets = pages
    ? pageResults.filter((p) => pages.includes(p.pageNumber))
    : pageResults.filter((p) => p.markdown.startsWith("[FAILED:"));

  if (targets.length > MAX_REPAIR_TARGETS) {
    throw new TooManyRepairTargetsError(targets.length);
  }

  const repaired: RepairPageOutcome[] = [];

  if (targets.length > 0) {
    // Mirror the setup-stage model resolution — job.modelName ??
    // OCR_DEFAULT_MODEL setting ?? glm-ocr:latest.
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

    for (const target of targets) {
      const outcome = await repairSinglePage(
        job,
        target,
        effectiveModelName,
        modelConfig,
      );
      repaired.push(outcome);

      // Replace the matching entry IN THE SAME SLOT — never delete the
      // [FAILED: marker without a replacement.
      const slot = pageResults.find((p) => p.pageNumber === target.pageNumber);
      if (slot) {
        slot.markdown = outcome.markdown;
        if (!outcome.stillFailed) {
          slot.tokensUsed = outcome.tokensUsed;
          slot.durationMs = outcome.durationMs;
        }
      }
    }
  }

  // Recompute tallies across ALL pages (260829-lkq semantics — [FAILED:
  // prefix count; failed pages score 1, mirroring the finalize stage).
  const failedPages = pageResults.filter((p) =>
    p.markdown.startsWith("[FAILED:"),
  ).length;

  const qualityScore = computeDocumentQualityScore(
    pageResults.map((r) => ({
      score: r.markdown.startsWith("[FAILED:") ? 1 : 4,
      pageNumber: r.pageNumber,
    })),
    parsed.totalDurationMs ?? 0,
    parsed.totalTokens ?? 0,
  );

  // Spread the FULL parsed result — approved/rejected/contentHash/
  // extractedTitle/etc. metadata preserved; only pageResults + the
  // recomputed tallies change.
  const newResult: Record<string, unknown> = {
    ...parsed,
    pageResults,
    qualityScore: qualityScore.overall,
    qualityScoreDetail: qualityScore,
    failedPages,
  };

  // Persist — result ONLY. Status/progress untouched (job stays COMPLETED).
  await prisma.ocrJob.update({
    where: { id: jobId },
    data: { result: newResult as Prisma.InputJsonValue },
  });

  // Rewrite concatenated.md with the same builder the finalize stage uses.
  const archiveBase = path.resolve(ARCHIVES_BASE, job.archiveId);
  const concatRelPath = "raw_sources/concatenated.md";
  validateArchivePath(archiveBase, concatRelPath);
  await fs.writeFile(
    path.resolve(archiveBase, concatRelPath),
    buildConcatenatedMarkdown(pageResults, job.totalPages ?? pageResults.length),
    "utf-8",
  );

  // Re-approve hook: fire-and-forget ONLY when every page is now valid AND
  // a recoverable (PENDING/FAILED) import job exists — a COMPLETED AIJ must
  // never double-create an ArchivePage. Repair never fails from the hook.
  if (failedPages === 0 && pageResults.length > 0) {
    try {
      const aij = await prisma.archiveImportJob.findFirst({
        where: { result: { path: ["ocrJobId"], equals: jobId } },
      });
      if (aij && (aij.status === "PENDING" || aij.status === "FAILED")) {
        finalizeAutoApproveOnComplete(jobId, job.archiveId, userId, newResult).catch(
          (err: Error) =>
            logger.error("[ocr] Repair auto-approve hook failed", {
              jobId,
              error: err.message,
            }),
        );
      }
    } catch (aijErr: unknown) {
      const message = aijErr instanceof Error ? aijErr.message : String(aijErr);
      logger.error("[ocr] Repair AIJ lookup failed (non-fatal)", {
        jobId,
        error: message,
      });
    }
  }

  import("../services/eventLogService")
    .then(({ logEvent }) =>
      logEvent("ocr_job", jobId, "job.pages_repaired", userId, {
        archiveId: job.archiveId,
        repaired: repaired.filter((r) => !r.stillFailed).length,
        stillFailed: repaired.filter((r) => r.stillFailed).length,
      }),
    )
    .catch((err: Error) =>
      logger.error("[ocr] Failed to log repair event", {
        jobId,
        error: err.message,
      }),
    );

  return {
    repaired,
    failedPages,
    qualityScore: pageResults.length > 0 ? qualityScore.overall : null,
  };
}

/**
 * Re-OCR one failed page: resolve the PNG (persisted page image, else
 * re-render from the persisted source PDF), call ocrPage with the fallback
 * prompt, ONE bounded re-try on empty/degenerated output, overwrite
 * raw_sources/page-NNNN.md on success.
 */
async function repairSinglePage(
  job: NonNullable<Awaited<ReturnType<typeof getOcrJob>>>,
  target: RepairPageEntry,
  effectiveModelName: string,
  modelConfig: ReturnType<typeof resolveModelConfig>,
): Promise<RepairPageOutcome & { tokensUsed: number; durationMs: number }> {
  const { pageNumber } = target;
  const archiveBase = path.resolve(ARCHIVES_BASE, job.archiveId);
  const jobId = job.id;

  let pngBuffer: Buffer | null = null;

  if (target.imagePath) {
    try {
      const relImagePath = `raw_sources/${path.basename(target.imagePath)}`;
      validateArchivePath(archiveBase, relImagePath);
      pngBuffer = await fs.readFile(path.resolve(archiveBase, relImagePath));
    } catch (imgErr: unknown) {
      const message = imgErr instanceof Error ? imgErr.message : String(imgErr);
      logger.warn("[ocr] Repair: persisted PNG unreadable", {
        jobId,
        page: pageNumber,
        error: message,
      });
    }
  }

  if (!pngBuffer) {
    // Render-error pages have no PNG — re-render from the persisted source
    // PDF. Source missing → the page stays failed (nothing to OCR from).
    if (!job.sourceFileName) {
      return {
        pageNumber,
        markdown: target.markdown,
        stillFailed: true,
        tokensUsed: 0,
        durationMs: 0,
      };
    }
    const sourceRelPath = path.join("source", path.basename(job.sourceFileName));
    const sourcePath = path.resolve(archiveBase, sourceRelPath);
    try {
      validateArchivePath(archiveBase, sourceRelPath);
      pngBuffer = await renderPageToPng(sourcePath, pageNumber, 2.0);
    } catch (renderErr: unknown) {
      const message = renderErr instanceof Error ? renderErr.message : String(renderErr);
      logger.warn("[ocr] Repair: could not re-render page from source PDF", {
        jobId,
        page: pageNumber,
        error: message,
      });
      return {
        pageNumber,
        markdown: target.markdown,
        stillFailed: true,
        tokensUsed: 0,
        durationMs: 0,
      };
    }
  }

  // Re-OCR with the fallback prompt; ONE bounded re-try on empty/degenerated
  // output (2s pause), then the page returns to its previous [FAILED:
  // state in the SAME slot.
  let finalCall: Awaited<ReturnType<typeof ocrPage>> | null = null;
  let finalGuard: GuardResult | null = null;

  for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS && !finalCall; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    try {
      const call = await ocrPage(
        pngBuffer,
        pageNumber,
        job.totalPages ?? pageNumber,
        effectiveModelName,
        modelConfig,
        undefined,
        true,
        (job.ocrMode as "text" | "table" | "figure" | "generic" | undefined) ?? undefined,
        job.customInstructions ?? undefined,
      );

      let cleanMarkdown = call.markdown;
      if (modelConfig.promptTemplate === "deepseek-ocr") {
        cleanMarkdown = stripGroundingTags(call.markdown);
      }
      cleanMarkdown = sanitizeChatTokens(cleanMarkdown);
      const guard = applyHallucinationGuard(
        cleanMarkdown,
        pageNumber,
        resolveGuardMode(job.archiveId),
      );

      if (!guard.hasEmpty) {
        finalCall = call;
        finalGuard = guard;
      } else {
        logger.warn("[ocr] Repair attempt returned empty/degenerated output", {
          jobId,
          page: pageNumber,
          attempt,
          reason: guard.degenerated ? "degeneration" : "empty",
        });
      }
    } catch (ocrErr: unknown) {
      const message = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
      logger.warn("[ocr] Repair OCR call failed", {
        jobId,
        page: pageNumber,
        attempt,
        error: message,
      });
    }
  }

  if (!finalCall || !finalGuard) {
    return {
      pageNumber,
      markdown: target.markdown,
      stillFailed: true,
      tokensUsed: 0,
      durationMs: 0,
    };
  }

  // Overwrite raw_sources/page-NNNN.md on disk.
  const paddedPage = String(pageNumber).padStart(4, "0");
  const markdownRelPath = `raw_sources/page-${paddedPage}.md`;
  validateArchivePath(archiveBase, markdownRelPath);
  await fs.writeFile(
    path.resolve(archiveBase, markdownRelPath),
    finalGuard.markdown,
    "utf-8",
  );

  return {
    pageNumber,
    markdown: finalGuard.markdown,
    stillFailed: false,
    tokensUsed: finalCall.tokensUsed,
    durationMs: finalCall.durationMs,
  };
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import { Router, type Request, type Response, type NextFunction } from "express";
import path from "path";
import {
  ocrJobApproveSchema,
  ocrJobRejectSchema,
  ocrPreviewRequestSchema,
  ocrPreferencesSchema,
} from "@simmetric-chat/shared";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { verifyToken, getUserWithRoles } from "../services/authService";
import { isTokenRevoked } from "../services/tokenRevocation";
import {
  deleteOcrJob,
  getOcrJob,
  getOcrJobsByArchive,
  parseOcrJobResult,
} from "../services/ocrJobService";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { logEvent } from "../services/eventLogService";
import { getSetting } from "../services/systemConfigService";
import { resolveModelConfig, type OcrModelConfig } from "../ocr/modelRegistry";
import {
  buildDeepseekOcrPrompt,
  buildGlmOcrPrompt,
  buildGenericOcrPrompt,
} from "../ocr/promptTemplates";
import type { OcrPrompt, BuildOcrPromptParams } from "../ocr/promptTemplates";

const router = Router();

const imageRouter = Router();

imageRouter.get(
  "/:id/jobs/:jobId/pages/:pageNumber/image",
  queryTokenAuth,
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.id);
      const jobId = String(req.params.jobId);
      const pageNumber = parseInt(String(req.params.pageNumber), 10);

      if (isNaN(pageNumber) || pageNumber < 1) {
        res.status(400).json({ error: "Invalid page number" });
        return;
      }

      const job = await getOcrJob(jobId);
      if (!job || job.archiveId !== archiveId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const result = parseOcrJobResult(job.result);
      const pageResult = result.pageResults?.find((p) => p.pageNumber === pageNumber);
      if (!pageResult?.imagePath) {
        res.status(404).json({ error: "No image for this page" });
        return;
      }

      const absolutePath = path.resolve(
        process.cwd(),
        "storage/archives",
        archiveId,
        pageResult.imagePath,
      );

      const archiveDir = path.resolve(process.cwd(), "storage/archives", archiveId);
      if (!absolutePath.startsWith(archiveDir)) {
        res.status(403).json({ error: "Invalid image path" });
        return;
      }

      res.sendFile(absolutePath);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[ocr] Image serve error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.use(imageRouter);

router.use(authMiddleware);

/**
 * Lightweight auth for routes that can't send Authorization header (e.g., <img> tags).
 * Accepts JWT via ?token= query parameter instead of Authorization header.
 */
async function queryTokenAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.query.token as string | undefined;
  if (!token) {
    res.status(401).json({ error: "Missing token query parameter" });
    return;
  }
  try {
    const payload = verifyToken(token);
    // TEC-03b: a revoked token must not serve OCR images. The `payload.jti &&`
    // guard keeps pre-deploy tokens working (D-04).
    if (payload.jti && (await isTokenRevoked(payload.jti))) {
      res.status(401).json({ error: "Token revoked" });
      return;
    }
    const user = await getUserWithRoles(payload.userId);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    req.userId = payload.userId;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// --- Catalog Router (mounted separately at /api/ocr) ---
const ocrCatalogRouter = Router();
ocrCatalogRouter.use(authMiddleware);

let catalogCache: { data: OcrModelConfig[]; timestamp: number } | null = null;
const CATALOG_CACHE_TTL_MS = 60_000;

async function getCachedCatalog(): Promise<OcrModelConfig[]> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.timestamp < CATALOG_CACHE_TTL_MS) {
    return catalogCache.data;
  }
  const models = await prisma.providerModel.findMany({ where: { isOcr: true } });
  const data: OcrModelConfig[] = models.map((model) => {
    const config = resolveModelConfig(model.name);
    return {
      ...config,
      name: model.name,
      namePattern: model.name,
    };
  });
  catalogCache = { data, timestamp: now };
  return data;
}

/**
 * @openapi
 * /ocr/models:
 *   get:
 *     tags: [OCR]
 *     summary: List available OCR models with capabilities
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Array of OCR model configurations }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 */
ocrCatalogRouter.get("/models", requirePermission("archive:read"), async (_req: Request, res: Response) => {
  try {
    res.json(await getCachedCatalog());
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[ocr] Catalog route error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /ocr/preview:
 *   post:
 *     tags: [OCR]
 *     summary: Preview system prompt for a model+mode+instructions
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               model: { type: string }
 *               ocrMode: { type: string, enum: [text, table, figure, generic] }
 *               customInstructions: { type: string }
 *     responses:
 *       200: { description: System prompt preview }
 *       400: { description: Invalid request }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       500: { description: Internal server error }
 */
ocrCatalogRouter.post("/preview", requirePermission("archive:read"), async (req: Request, res: Response) => {
  try {
    const parsed = ocrPreviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const config = resolveModelConfig(parsed.data.model);

    const params: BuildOcrPromptParams = {
      pageNumber: 1,
      totalPages: 1,
      base64Image: "",
      ocrMode: parsed.data.ocrMode,
      customInstructions: parsed.data.customInstructions,
    };

    let prompt: OcrPrompt;
    switch (config.promptTemplate) {
      case "deepseek-ocr":
        prompt = buildDeepseekOcrPrompt(params);
        break;
      case "glm-ocr":
        prompt = buildGlmOcrPrompt(params);
        break;
      default:
        prompt = buildGenericOcrPrompt(params);
    }

    res.json({ systemPrompt: prompt.systemPrompt });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[ocr] Preview error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /ocr/preferences:
 *   get:
 *     tags: [OCR]
 *     summary: Get OCR preferences for current user and workspace
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string, format: uuid }
 *         required: true
 *     responses:
 *       200: { description: User OCR preferences }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       500: { description: Internal server error }
 */
ocrCatalogRouter.get("/preferences", requirePermission("archive:read"), async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.query.workspaceId || "");
    const key = `ocr_prefs_${req.userId}`;
    const config = await prisma.systemConfig.findUnique({ where: { key } });
    const allPrefs = config ? JSON.parse(config.value) : {};
    res.json(allPrefs[workspaceId] || {});
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[ocr] Preferences read error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /ocr/preferences:
 *   post:
 *     tags: [OCR]
 *     summary: Save OCR preferences for current user and workspace
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId: { type: string, format: uuid }
 *               model: { type: string }
 *               ocrMode: { type: string, enum: [text, table, figure, generic] }
 *               customInstructions: { type: string }
 *     responses:
 *       200: { description: Preferences saved }
 *       400: { description: Invalid request }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       500: { description: Internal server error }
 */
ocrCatalogRouter.post("/preferences", requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const parsed = ocrPreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { workspaceId, model, ocrMode, customInstructions } = parsed.data;
    const key = `ocr_prefs_${req.userId}`;
    const existing = await prisma.systemConfig.findUnique({ where: { key } });
    const allPrefs = existing ? JSON.parse(existing.value) : {};

    const workspacePrefs: Record<string, unknown> = {};
    if (model !== undefined) workspacePrefs.model = model;
    if (ocrMode !== undefined) workspacePrefs.ocrMode = ocrMode;
    if (customInstructions !== undefined) workspacePrefs.customInstructions = customInstructions;

    allPrefs[workspaceId] = workspacePrefs;

    await prisma.systemConfig.upsert({
      where: { key },
      create: { key, value: JSON.stringify(allPrefs) },
      update: { value: JSON.stringify(allPrefs) },
    });

    res.json({ message: "Preferences saved" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[ocr] Preferences write error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/archives/:id/jobs/:jobId — get job status for polling
router.get(
  "/:id/jobs/:jobId",
  requirePermission("archive:read"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.id);
      const jobId = String(req.params.jobId);

      const job = await getOcrJob(jobId);
      if (!job || job.archiveId !== archiveId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      res.json(job);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[ocr] Route error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /api/archives/:id/jobs — list all jobs for archive
router.get(
  "/:id/jobs",
  requirePermission("archive:read"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.id);

      const jobs = await getOcrJobsByArchive(archiveId);
      res.json(jobs);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[ocr] Route error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/archives/:id/jobs/:jobId/approve — approve OCR output
router.post(
  "/:id/jobs/:jobId/approve",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    const archiveId = String(req.params.id);
    const jobId = String(req.params.jobId);
    try {

      // Validate request body (empty object, per schema)
      const parsed = ocrJobApproveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const job = await getOcrJob(jobId);
      if (!job || job.archiveId !== archiveId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      if (job.status !== "COMPLETED") {
        res.status(400).json({
          error: "Only completed jobs can be approved",
        });
        return;
      }

      // Update result metadata with approval info
      const parsedResult = parseOcrJobResult(job.result);
      const updatedResult = {
        ...parsedResult,
        approved: true,
        approvedAt: new Date().toISOString(),
        approvedBy: req.userId,
      };

      await prisma.ocrJob.update({
        where: { id: jobId },
        data: { result: updatedResult as Prisma.InputJsonValue },
      });

      // Create a single archive page from OCR content (all pages concatenated)
      const pageResults = parsedResult.pageResults || [];
      if (pageResults.length > 0) {
        const { createPage, rebuildIndex } = await import("../services/archivePageService");
        const title = parsedResult.extractedTitle
          || parsedResult.originalFileName?.replace(/\.[^.]+$/, "")
          || "OCR import";
        const content = pageResults
          .map((pr) => `## Page ${pr.pageNumber}\n\n${pr.markdown}`)
          .join("\n\n---\n\n");
        await createPage(
          archiveId,
          { title, content, category: "entities" },
          req.userId!,
        );
        await rebuildIndex(archiveId);
        logger.info("[ocr] Created archive page from approved job", {
          jobId,
          archiveId,
          title,
          pageCount: pageResults.length,
        });
      }

      // Fire-and-forget event log
      logEvent("ocr_job", jobId, "job.approved", req.userId!, {
        archiveId,
      }).catch((err: Error) => {
        logger.error("[ocr] Failed to log approval event", {
          jobId,
          error: err.message,
        });
      });

      // Fire-and-forget synthesis trigger (D-01: must not block the OCR response)
      import("../services/synthesisTriggerService")
        .then((m) =>
          m.onOcrJobCompleted(jobId, archiveId).catch((err: Error) =>
            logger.error("[synthesis] Trigger error", {
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

      logger.info("[ocr] Job approved", { jobId, archiveId });

      res.json({ message: "Job approved", jobId });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const err_stack = err instanceof Error ? err.stack : undefined;
  const errCode = (err as { code?: string }).code;
      logger.error("[ocr] Approve route error", {
        error: message,
        stack: err_stack,
        archiveId,
        jobId,
        code: errCode,
        cause: err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/archives/:id/jobs/:jobId/reject — reject OCR output
router.post(
  "/:id/jobs/:jobId/reject",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.id);
      const jobId = String(req.params.jobId);

      // Validate request body
      const parsed = ocrJobRejectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const job = await getOcrJob(jobId);
      if (!job || job.archiveId !== archiveId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      if (job.status !== "COMPLETED") {
        res.status(400).json({
          error: "Only completed jobs can be rejected",
        });
        return;
      }

      // Update result metadata with rejection info
      const updatedResult = {
        ...parseOcrJobResult(job.result),
        rejected: true,
        rejectedAt: new Date().toISOString(),
        rejectedBy: req.userId,
        rejectionReason: parsed.data.reason ?? null,
      };

      await prisma.ocrJob.update({
        where: { id: jobId },
        data: { result: updatedResult as Prisma.InputJsonValue },
      });

      // Fire-and-forget event log
      logEvent("ocr_job", jobId, "job.rejected", req.userId!, {
        archiveId,
        reason: parsed.data.reason ?? null,
      }).catch((err: Error) => {
        logger.error("[ocr] Failed to log rejection event", {
          jobId,
          error: err.message,
        });
      });

      logger.info("[ocr] Job rejected", {
        jobId,
        archiveId,
        reason: parsed.data.reason,
      });

      res.json({ message: "Job rejected", jobId });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[ocr] Route error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * @openapi
 * /ocr/defaults:
 *   get:
 *     tags: [OCR]
 *     summary: Get global OCR defaults from SystemConfig
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Global OCR defaults }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       500: { description: Internal server error }
 */
ocrCatalogRouter.get("/defaults", requirePermission("archive:read"), async (_req: Request, res: Response) => {
  try {
    const modelEntry = await getSetting("OCR_DEFAULT_MODEL").catch(() => null);
    const modeEntry = await getSetting("OCR_DEFAULT_MODE").catch(() => null);
    const instructionsEntry = await getSetting("OCR_DEFAULT_CUSTOM_INSTRUCTIONS").catch(() => null);
    res.json({
      model: modelEntry?.value ?? "",
      ocrMode: modeEntry?.value ?? "",
      customInstructions: instructionsEntry?.value ?? "",
    });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[ocr] Defaults read error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/archives/:id/jobs/:jobId — delete an OCR/ingestion job
router.delete(
  "/:id/jobs/:jobId",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.id);
      const jobId = String(req.params.jobId);

      const deleted = await deleteOcrJob(jobId, archiveId);
      if (!deleted) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      res.json({ message: "Job deleted successfully" });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[ocr] Delete route error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export { ocrCatalogRouter };
export default router;

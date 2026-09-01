// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Provider Preset Catalog routes — mounted at `/api/provider-presets`.
 *
 * Mirrors the marketplace.ts pattern: list/detail are readable by any user
 * with `provider:read`; install requires `provider:write` (same gate as
 * manual provider create). Install creates a `Provider` row from the preset
 * (baseUrl/type/defaultModel precompiled), encrypts the admin-supplied
 * apiKey via encryptionService, and triggers `refreshModels` for
 * OpenAI-compatible types. OAuth presets reject with 422 (manual-only);
 * native types (gemini/xiaomi/minimax) create the record but surface a
 * "handler pending" lastError from refreshModels.
 */
import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import {
  providerPresetIdParamSchema,
  installProviderPresetSchema,
} from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";
import { encrypt } from "../services/encryptionService";
import { refreshModels, isNativeHandlerPending } from "../services/providerService";

const router = Router();

// All catalog routes require authentication
router.use(authMiddleware);

// GET / — list all presets, augmented with `isInstalled` (Provider with same name exists)
router.get("/", requirePermission("provider:read"), async (_req: Request, res: Response) => {
  try {
    const presets = await prisma.providerPreset.findMany({
      orderBy: { name: "asc" },
    });
    if (presets.length === 0) {
      res.json([]);
      return;
    }
    // Single query to check which preset names already have a Provider row — no N+1.
    const presetNames = presets.map((p) => p.name);
    const installedProviders = await prisma.provider.findMany({
      where: { name: { in: presetNames } },
      select: { name: true },
    });
    const installedSet = new Set(installedProviders.map((p) => p.name));
    res.json(presets.map((p) => ({ ...p, isInstalled: installedSet.has(p.name) })));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[providerPresets] Error listing presets", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:presetId — single preset detail
router.get("/:presetId", requirePermission("provider:read"), async (req: Request, res: Response) => {
  try {
    const paramResult = providerPresetIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: paramResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { presetId } = paramResult.data;
    const preset = await prisma.providerPreset.findUnique({ where: { id: presetId } });
    if (!preset) {
      res.status(404).json({ error: "Provider preset not found" });
      return;
    }
    res.json(preset);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[providerPresets] Error fetching preset", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:presetId/install — install a preset as a Provider (provider:write gate)
router.post("/:presetId/install", requirePermission("provider:write"), async (req: Request, res: Response) => {
  try {
    const paramResult = providerPresetIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: paramResult.error.flatten().fieldErrors,
      });
      return;
    }
    const { presetId } = paramResult.data;

    const parsed = installProviderPresetSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const { name: overrideName, apiKey } = parsed.data;

    const preset = await prisma.providerPreset.findUnique({ where: { id: presetId } });
    if (!preset) {
      res.status(404).json({ error: "Provider preset not found" });
      return;
    }

    // OAuth presets are manual-only — no install path.
    if (preset.requiresOAuth) {
      res.status(422).json({
        error: "OAuth provider — manual configuration required",
        docsUrl: preset.docsUrl,
      });
      return;
    }

    const providerName = overrideName || preset.name;

    // 409 if a Provider with that name already exists
    const existing = await prisma.provider.findFirst({ where: { name: providerName } });
    if (existing) {
      res.status(409).json({
        error: `A provider named "${providerName}" already exists. Rename it or delete the existing one before installing this preset.`,
      });
      return;
    }

    // T-ps2-01: baseUrl comes from the seeded preset (author-controlled),
    // NOT from the request body — no admin-controlled baseUrl injection.
    const provider = await prisma.provider.create({
      data: {
        name: providerName,
        type: preset.type,
        baseUrl: preset.baseUrl ?? "",
        apiKey: apiKey ? encrypt(apiKey) : null,
        isEnabled: true,
      },
    });

    // Audit log
    await logEvent("provider", provider.id, "provider.installed_from_preset", req.userId!, {
      presetId,
      presetSlug: preset.slug,
      providerName,
    });

    // Refresh models. For native types, refreshModels throws a "handler pending"
    // error — catch it, store on lastError, and still return 201 (record exists).
    if (isNativeHandlerPending(preset.type)) {
      try {
        await refreshModels(provider.id);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[providerPresets] Native refreshModels failed for ${provider.id}: ${message}`);
        await prisma.provider.update({ where: { id: provider.id }, data: { lastError: message } });
        const updated = await prisma.provider.findUnique({ where: { id: provider.id }, include: { models: true } });
        res.status(201).json(stripApiKey(updated));
        return;
      }
    } else {
      try {
        await refreshModels(provider.id);
      } catch (err: unknown) {
        // refreshModels already stored lastError on the provider record.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[providerPresets] refreshModels failed for ${provider.id}: ${message}`);
      }
    }

    const fresh = await prisma.provider.findUnique({ where: { id: provider.id }, include: { models: true } });
    res.status(201).json(stripApiKey(fresh));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[providerPresets] Error installing preset", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

function stripApiKey(p: Record<string, unknown> | null) {
  if (!p) return p;
  const { apiKey: _omit, ...rest } = p;
  return { ...rest, apiKey: _omit ? "masked" : null };
}

export default router;
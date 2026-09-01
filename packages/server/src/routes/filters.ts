// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 100 (PLG-01) — Filter plugin admin API.
 *
 *   GET   /api/filters        — list all registered plugins (D-04)
 *   PATCH /api/filters/:name  — enable/disable a plugin (D-04, D-08)
 *
 * Both routes require `authMiddleware` + `requirePermission("filters:manage")`
 * (D-09: admin + superuser only; the 31st permission, seeded in seed.ts).
 *
 * PATCH writes directly to `prisma.systemConfig.upsert` with key
 * `filter_<name>_enabled` — NOT via `updateSettings()`, because dynamic
 * filter keys are not in `configKeySchema` (Pitfall 6). The in-memory
 * `plugin.enabled` flag is mutated so the running registry reflects the
 * change immediately. Every toggle emits an audit event (D-08):
 *   logEvent("chat", null, "filter.enable" | "filter.disable", userId, { pluginName })
 *
 * No POST (no upload — D-04 filesystem discovery) and no DELETE (no API-side
 * plugin removal — D-04) routes exist on this router.
 */
import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { updateFilterSchema } from "@simmetric-chat/shared";
import { getAllFilters, getFilter } from "../filters/filterRegistry";
import { logEvent } from "../services/eventLogService";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const router = Router();

// Both routes require auth + filters:manage (D-09: admin + superuser only).
router.use(authMiddleware, requirePermission("filters:manage"));

/**
 * @openapi
 * /api/filters:
 *   get:
 *     summary: List all registered filter plugins
 *     description: Returns the descriptor of every filter plugin registered in the in-memory registry (priority-ordered). Admin-only (filters:manage).
 *     tags: [Filters]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Array of plugin descriptors
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name: { type: string }
 *                   priority: { type: number }
 *                   enabled: { type: boolean }
 *                   hasInlet: { type: boolean }
 *                   hasOutlet: { type: boolean }
 *                   outletStreaming: { type: boolean }
 *                   description: { type: string }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 */
router.get("/", (_req: Request, res: Response) => {
  try {
    const plugins = getAllFilters().map((p) => ({
      name: p.name,
      priority: p.priority,
      enabled: p.enabled !== false,
      hasInlet: p.inlet !== undefined,
      hasOutlet: p.outlet !== undefined,
      outletStreaming: p.outletStreaming === true,
      description: p.description ?? "",
    }));
    res.json(plugins);
  } catch (err: unknown) {
    logger.error("[filters] Error listing plugins", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /api/filters/{name}:
 *   patch:
 *     summary: Enable or disable a filter plugin
 *     description: Upserts SystemConfig key `filter_<name>_enabled` and updates the in-memory registry. Audit-logged (D-08). Admin-only (filters:manage).
 *     tags: [Filters]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled: { type: boolean }
 *     responses:
 *       200:
 *         description: Filter toggled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string }
 *       400: { description: Invalid request body }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       404: { description: Filter plugin not found }
 */
router.patch("/:name", async (req: Request, res: Response) => {
  try {
    const name = req.params.name as string;
    const plugin = getFilter(name);
    if (!plugin) {
      res.status(404).json({ error: "Filter plugin not found" });
      return;
    }

    const parsed = updateFilterSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { enabled } = parsed.data;
    // Pitfall 6: write directly to prisma.systemConfig.upsert — dynamic
    // `filter_<name>_enabled` keys are NOT in configKeySchema, so
    // updateSettings() would reject them. Direct upsert bypasses that gate.
    const configKey = `filter_${name}_enabled`;
    await prisma.systemConfig.upsert({
      where: { key: configKey },
      update: { value: enabled.toString() },
      create: { key: configKey, value: enabled.toString() },
    });

    // Mutate the in-memory registry flag so the running chain reflects the
    // change immediately (initFilters reads SystemConfig at startup; this
    // route is the runtime toggle path).
    plugin.enabled = enabled;

    // D-08 audit log — EntityType "chat" (existing, no enum widening).
    // entityId "system" mirrors the chatRetention.ts precedent (filter toggles
    // are system-level chat events, not tied to a specific chat entity).
    await logEvent(
      "chat",
      "system",
      enabled ? "filter.enable" : "filter.disable",
      req.userId!,
      { pluginName: name },
    );

    res.json({ message: `Filter "${name}" ${enabled ? "enabled" : "disabled"}` });
  } catch (err: unknown) {
    logger.error("[filters] Error toggling plugin", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
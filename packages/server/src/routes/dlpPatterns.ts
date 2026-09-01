// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP pattern configuration routes (quick 260829-ony — DLP_FEATURES_SPEC
 * §2.3 endpoint list). Admin-only: requirePermission("admin:settings") —
 * reuses the EXISTING 31-permission RBAC set (no seed change).
 *
 * GET    /api/system/dlp/patterns         — list all (enabled + disabled)
 * POST   /api/system/dlp/patterns         — create custom (50-cap, §4.9)
 * PUT    /api/system/dlp/patterns/:id     — update; BUILT-INS accept ONLY
 *                                           displayName + isEnabled (regex
 *                                           frozen → 400, spec §4.4)
 * DELETE /api/system/dlp/patterns/:id     — delete; built-in → 400 (spec §2.3:
 *                                           built-ins can only be disabled)
 * POST   /api/system/dlp/patterns/:id/test — test pattern vs sample (no persist)
 *
 * Every mutation calls invalidatePatternCache() so the next scan reloads from
 * the DB (spec §2.4 point 4); cross-instance propagation rides the 5-min TTL
 * (spec §4.5). Errors follow the { error } / { error, details } API shape.
 */

import { Router, type Request, type Response } from "express";
import {
  createDlpPatternSchema,
  updateDlpPatternSchema,
  testPatternSchema,
  dlpPatternIdParamSchema,
} from "@simmetric-chat/shared";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  compileRegex,
  invalidateCache as invalidatePatternCache,
  listPatterns,
  countCustomPatterns,
  MAX_CUSTOM_PATTERNS,
  testPattern,
} from "../services/dlpPatternService";

const router = Router();

/** List — ordered createdAt (built-ins seeded first), name tie-break (§4.3). */
router.get(
  "/patterns",
  authMiddleware,
  requirePermission("admin:settings"),
  async (_req: Request, res: Response) => {
    try {
      const patterns = await listPatterns();
      res.json({ patterns });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[dlp-patterns] list failed", { error: message });
      res.status(500).json({ error: message });
    }
  },
);

/** Create a CUSTOM pattern (isBuiltIn forced false — built-ins come only from the seed). */
router.post(
  "/patterns",
  authMiddleware,
  requirePermission("admin:settings"),
  async (req: Request, res: Response) => {
    try {
      const parsed = createDlpPatternSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      // Compile-validate BEFORE the uniqueness/count writes (spec §4.2).
      try {
        compileRegex(parsed.data.pattern, parsed.data.patternFlags);
      } catch (err: unknown) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Invalid regex" });
        return;
      }
      // Spec §4.9: max 50 custom patterns per instance.
      const customCount = await countCustomPatterns();
      if (customCount >= MAX_CUSTOM_PATTERNS) {
        res.status(400).json({
          error: `Custom pattern limit reached (${MAX_CUSTOM_PATTERNS})`,
        });
        return;
      }
      try {
        const created = await prisma.dlpPattern.create({
          data: {
            name: parsed.data.name,
            displayName: parsed.data.displayName,
            pattern: parsed.data.pattern,
            patternFlags: parsed.data.patternFlags,
            replacement: parsed.data.replacement,
            isEnabled: parsed.data.isEnabled,
            isBuiltIn: false,
          },
        });
        invalidatePatternCache();
        res.status(201).json({ pattern: created });
      } catch (err: unknown) {
        // P2002 unique violation → duplicate name.
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String((err as { code: unknown }).code)
            : "";
        if (code === "P2002") {
          res.status(409).json({ error: "A pattern with this name already exists" });
          return;
        }
        throw err;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[dlp-patterns] create failed", { error: message });
      res.status(500).json({ error: message });
    }
  },
);

/**
 * Update. Built-in immutability (spec §4.4): when the row is built-in, ANY
 * key beyond displayName/isEnabled present in the payload → 400 "Cannot
 * modify built-in pattern regex" (the frozen fields are pattern,
 * patternFlags, replacement — sending them even with an unchanged value is
 * rejected so a stale client cannot drift a built-in).
 */
router.put(
  "/patterns/:id",
  authMiddleware,
  requirePermission("admin:settings"),
  async (req: Request, res: Response) => {
    try {
      // Malformed :id → 404 (NOT 400) — indistinguishable from a missing row
      // so a probing client gets no format feedback (Pitfall 4 convention).
      const param = dlpPatternIdParamSchema.safeParse(req.params);
      if (!param.success) {
        res.status(404).json({ error: "DLP pattern not found" });
        return;
      }
      const id = param.data.id;
      const existing = await prisma.dlpPattern.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: "DLP pattern not found" });
        return;
      }

      const parsed = updateDlpPatternSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      if (existing.isBuiltIn) {
        const frozenKeys = ["pattern", "patternFlags", "replacement"] as const;
        const touchedFrozen = frozenKeys.filter((k) => parsed.data[k] !== undefined);
        if (touchedFrozen.length > 0) {
          res.status(400).json({
            error: "Cannot modify built-in pattern regex",
            details: { fields: touchedFrozen },
          });
          return;
        }
      }

      // Custom rows that change pattern/patternFlags must compile (built-ins
      // cannot reach here with a new pattern — frozen above).
      if (parsed.data.pattern !== undefined || parsed.data.patternFlags !== undefined) {
        try {
          compileRegex(
            parsed.data.pattern ?? existing.pattern,
            parsed.data.patternFlags ?? existing.patternFlags,
          );
        } catch (err: unknown) {
          res.status(400).json({ error: err instanceof Error ? err.message : "Invalid regex" });
          return;
        }
      }

      const updated = await prisma.dlpPattern.update({
        where: { id },
        data: {
          ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
          ...(parsed.data.pattern !== undefined ? { pattern: parsed.data.pattern } : {}),
          ...(parsed.data.patternFlags !== undefined ? { patternFlags: parsed.data.patternFlags } : {}),
          ...(parsed.data.replacement !== undefined ? { replacement: parsed.data.replacement } : {}),
          ...(parsed.data.isEnabled !== undefined ? { isEnabled: parsed.data.isEnabled } : {}),
        },
      });
      invalidatePatternCache();
      res.json({ pattern: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[dlp-patterns] update failed", { error: message });
      res.status(500).json({ error: message });
    }
  },
);

/** Delete — built-ins are permanent (disable instead, spec §2.3/§4.4). */
router.delete(
  "/patterns/:id",
  authMiddleware,
  requirePermission("admin:settings"),
  async (req: Request, res: Response) => {
    try {
      // Malformed :id → 404 (NOT 400) — indistinguishable from a missing row
      // so a probing client gets no format feedback (Pitfall 4 convention).
      const param = dlpPatternIdParamSchema.safeParse(req.params);
      if (!param.success) {
        res.status(404).json({ error: "DLP pattern not found" });
        return;
      }
      const id = param.data.id;
      const existing = await prisma.dlpPattern.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: "DLP pattern not found" });
        return;
      }
      if (existing.isBuiltIn) {
        res.status(400).json({ error: "Cannot delete a built-in pattern — disable it instead" });
        return;
      }
      await prisma.dlpPattern.delete({ where: { id } });
      invalidatePatternCache();
      res.json({ message: "DLP pattern deleted" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[dlp-patterns] delete failed", { error: message });
      res.status(500).json({ error: message });
    }
  },
);

/**
 * Test a pattern against sample text — NO persistence of the sample or the
 * matches (audit-safe preview for the admin dialog).
 */
router.post(
  "/patterns/:id/test",
  authMiddleware,
  requirePermission("admin:settings"),
  async (req: Request, res: Response) => {
    try {
      // Malformed :id → 404 (NOT 400) — indistinguishable from a missing row
      // so a probing client gets no format feedback (Pitfall 4 convention).
      const param = dlpPatternIdParamSchema.safeParse(req.params);
      if (!param.success) {
        res.status(404).json({ error: "DLP pattern not found" });
        return;
      }
      const id = param.data.id;
      const existing = await prisma.dlpPattern.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ error: "DLP pattern not found" });
        return;
      }
      const parsed = testPatternSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }
      try {
        const result = testPattern(existing.pattern, existing.patternFlags, parsed.data.sample);
        res.json(result);
      } catch (err: unknown) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Invalid regex" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[dlp-patterns] test failed", { error: message });
      res.status(500).json({ error: message });
    }
  },
);

export default router;
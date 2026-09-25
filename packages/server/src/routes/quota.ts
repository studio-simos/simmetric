// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 207 (CLOUD-06, D-09): quota reset + usage read routes.
// Chain order auth → tenant → permission (roles.ts:21-28 idiom). Gated on
// requirePermission("agency:users:manage") — admins auto-gain it via the
// PERMISSION_NAMES spread; agencies hold it via the 206 delegation lattice.
// Per D-09: reset = admin (any target) OR sponsor-of-target; a sponsor
// touching an unrelated user resolves to 404, never 403 (206 D-04 idiom).
// Storage is NEVER resettable (D-12) — the schema admits only kind "tokens".
// Config editing (quota columns/presets) is admin-only and lives on the
// users/system-config routes (Plan 04 wires the UI; D-09).

import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requirePermission, requireAdmin } from "../middleware/rbac";
import { isAdmin } from "../utils/auth";
import { manualResetSchema, updateQuotaInputSchema } from "@simmetric-chat/shared";
import {
  QuotaError,
  resolveTokenQuota,
  getTokenWindowUsage,
  windowStart,
  resetTokenQuota,
  getStorageUsage,
  resolveStorageQuota,
} from "../services/quotaService";
import { logEvent } from "../services/eventLogService";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const router = Router();

router.use(authMiddleware);
router.use(tenantContextMiddleware);

const RESET_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * D-09 gate helper: admin resets ANY target; a non-admin acts ONLY on users
 * they sponsor (UserSponsorship AND-merge scoped to the actor — 206 D-04);
 * a scope miss resolves to 404 fail-closed. Returns null when the target is
 * out of scope (route maps to 404).
 */
async function resolveManageableTarget(actorId: string, actorIsAdmin: boolean, targetId: string) {
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, disabledAt: true, resetAnchorDate: true },
  });
  if (!target) return null;
  if (actorIsAdmin) return target;
  const sponsorship = await prisma.userSponsorship.findFirst({
    where: { sponsorId: actorId, subUserId: targetId, deletedAt: null },
  });
  return sponsorship ? target : null;
}

/** Next recurring-reset boundary for the viewer display (null = none). */
function computeNextResetAt(resetAnchorDate: Date | null, now: Date): string | null {
  if (!resetAnchorDate) return null;
  const start = new Date(resetAnchorDate);
  const elapsed = now.getTime() - start.getTime();
  if (elapsed < 0) return null;
  const k = Math.floor(elapsed / RESET_PERIOD_MS);
  return new Date(start.getTime() + (k + 1) * RESET_PERIOD_MS).toISOString();
}

/**
 * @openapi
 * /api/quota/{userId}/reset:
 *   post:
 *     tags: [Quota]
 *     summary: Manual token-quota reset (admin or sponsor-of-target; CLOUD-06)
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind]
 *             properties:
 *               kind: { type: string, enum: [tokens] }
 *     responses:
 *       200: anchor written; usage history untouched (D-02)
 *       400: storage reset attempt (D-12) or malformed body
 *       404: target user not found OR out of sponsor scope (D-04 404 idiom)
 */
router.post("/:userId/reset", requirePermission("agency:users:manage"), async (req: Request, res: Response) => {
  try {
    const parsedBody = manualResetSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      // D-12: storage (or any non-tokens kind) is never manually resettable.
      res.status(400).json({
        error: "Only the token quota is resettable — storage is a cap, not a rolling allowance",
        details: parsedBody.error.flatten().fieldErrors,
      });
      return;
    }
    const targetId = req.params.userId as string;
    if (!/^[0-9a-fA-F-]{36}$/.test(targetId)) {
      res.status(400).json({ error: "Invalid userId" });
      return;
    }
    const actorIsAdmin = isAdmin(req.user);
    const target = await resolveManageableTarget(req.userId!, actorIsAdmin, targetId);
    if (!target) {
      // Cross-sponsor / unknown target → 404 fail-closed (206 D-04/SC-1).
      res.status(404).json({ error: "User not found" });
      return;
    }
    const result = await resetTokenQuota(targetId, "tokens", "manual");
    await logEvent("quota", targetId, "quota.token_reset", req.userId!, {
      triggeredBy: "manual",
      actorIsAdmin,
    });
    res.status(200).json({
      ok: true,
      kind: "tokens",
      at: result.at.toISOString(),
      windowStart: (await windowStart(targetId, "tokens")).toISOString(),
    });
  } catch (err: unknown) {
    if (err instanceof QuotaError) {
      res.status(err.status).json(err.payload);
      return;
    }
    logger.error("[quota] Reset failed:", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Quota reset failed" });
  }
});

/**
 * Shared read builder — GET and the admin PUT both return the same payload
 * (tokens + storage blocks).
 */
async function buildQuotaRead(targetId: string, resetAnchorDate: Date | null) {
  const resolution = await resolveTokenQuota(targetId);
  const used = await getTokenWindowUsage(targetId);
  const start = await windowStart(targetId, "tokens");
  const nextResetAt =
    resolution.limit != null && resetAnchorDate ? computeNextResetAt(resetAnchorDate, new Date()) : null;
  const storageResolution = await resolveStorageQuota(targetId);
  const storageUsage = await getStorageUsage(targetId);
  return {
    userId: targetId,
    tokens: {
      limit: resolution.limit,
      used,
      windowStart: start.toISOString(),
      nextResetAt,
      source: resolution.source,
    },
    storage: {
      limitGb: storageResolution.limit,
      usedBytes: storageUsage.totalBytes,
      source: storageResolution.source,
    },
  };
}

/**
 * @openapi
 * /api/quota/{userId}:
 *   put:
 *     tags: [Quota]
 *     summary: Admin per-user quota column write (D-07/D-09 admin-only)
 *     responses:
 *       200: updated quota read
 *       400: malformed body (updateQuotaInputSchema)
 *       404: unknown target
 */
router.put("/:userId", requireAdmin, async (req: Request, res: Response) => {
  try {
    const targetId = req.params.userId as string;
    if (!/^[0-9a-fA-F-]{36}$/.test(targetId)) {
      res.status(400).json({ error: "Invalid userId" });
      return;
    }
    const parsed = updateQuotaInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid quota config", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, resetAnchorDate: true } });
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await prisma.user.update({
      where: { id: targetId },
      data: {
        tokenQuotaLimit: parsed.data.tokenQuotaLimit,
        storageQuotaGb: parsed.data.storageQuotaGb,
        tokenQuotaUnlimited: parsed.data.tokenQuotaUnlimited,
        storageQuotaUnlimited: parsed.data.storageQuotaUnlimited,
        resetAnchorDate: parsed.data.resetAnchorDate ? new Date(parsed.data.resetAnchorDate) : null,
      },
    });
    await logEvent("quota", targetId, "quota.config_updated", req.userId!, { actorIsAdmin: true });
    res.status(200).json(await buildQuotaRead(targetId, target.resetAnchorDate));
  } catch (err: unknown) {
    if (err instanceof QuotaError) {
      res.status(err.status).json(err.payload);
      return;
    }
    logger.error("[quota] Config write failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Quota config write failed" });
  }
});

/**
 * @openapi
 * /api/quota/{userId}:
 *   get:
 *     tags: [Quota]
 *     summary: Quota usage read — admin UI (Plan 207-04) + Phase 209 consume this
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { tokens: {limit, used, windowStart, nextResetAt, source}, storage }
 *       404: unknown target or out of sponsor scope
 */
router.get("/:userId", requirePermission("agency:users:manage"), async (req: Request, res: Response) => {
  try {
    const targetId = req.params.userId as string;
    if (!/^[0-9a-fA-F-]{36}$/.test(targetId)) {
      res.status(400).json({ error: "Invalid userId" });
      return;
    }
    const actorIsAdmin = isAdmin(req.user);
    const target = await resolveManageableTarget(req.userId!, actorIsAdmin, targetId);
    if (!target) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(200).json(await buildQuotaRead(targetId, target.resetAnchorDate));
  } catch (err: unknown) {
    if (err instanceof QuotaError) {
      res.status(err.status).json(err.payload);
      return;
    }
    logger.error("[quota] Usage read failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Quota read failed" });
  }
});

export default router;
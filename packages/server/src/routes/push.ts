// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { requireFeature } from "../middleware/license";
import prisma from "../utils/prisma";
import webpush from "web-push";
import { logger } from "../utils/logger";
import { getEnv } from "../config/env";

const router = Router();

// Initialize web-push with VAPID keys (from env or generate)
let vapidKeys: { publicKey: string; privateKey: string };

function initVapid() {
  // Routed through the Zod-validated getEnv() instead of raw process.env so a
  // missing/malformed VAPID config is surfaced through the schema, not silently
  // swallowed until push-send time.
  const env = getEnv();
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;

  if (publicKey && privateKey) {
    vapidKeys = { publicKey, privateKey };
  } else {
    // Generate keys for development (should be set in production)
    vapidKeys = webpush.generateVAPIDKeys();
    logger.warn("[push] Using auto-generated VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in production.");
  }

  webpush.setVapidDetails(
    env.VAPID_SUBJECT || "mailto:admin@simmetric-chat.local",
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
}

initVapid();

// GET /api/system/push/vapid-key — get public VAPID key for frontend
router.get("/vapid-key", authMiddleware, (_req: Request, res: Response) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// POST /api/system/push/subscribe — register a push subscription
// Available in all tiers (Community + Enterprise) — push notifications are
// a core UX feature, not a premium gate.
router.post("/subscribe", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { endpoint, keys } = req.body;

    if (!endpoint || !keys) {
      res.status(400).json({ error: "endpoint and keys are required" });
      return;
    }

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: req.userId!,
        endpoint,
        keys: JSON.stringify(keys),
      },
      update: {
        userId: req.userId!,
        keys: JSON.stringify(keys),
      },
    });

    res.json({ message: "Push subscription registered" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/system/push/subscribe — unregister push subscription
router.delete("/subscribe", authMiddleware, async (req: Request, res: Response) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }

    await prisma.pushSubscription.deleteMany({ where: { endpoint } });
    res.json({ message: "Push subscription removed" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// Phase 155 / CSW-06: batch size for the /test broadcast fan-out. Bounds the
// pushSubscription findMany so a 10K-row table no longer loads into memory in
// one query. Per D-07 — the broadcast still reaches ALL subscriptions; this
// only bounds the per-query window. The Promise.allSettled fan-out is reused
// per batch (preserving the existing success/failure accounting).
const PUSH_BROADCAST_BATCH_SIZE = 100;

// POST /api/system/push/test — send a test push notification (admin only)
router.post("/test", authMiddleware, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const payload = JSON.stringify({
      title: "Simmetric Chat",
      body: "Push notifications are working!",
    });

    // Batched broadcast (Phase 155 / CSW-06): page through pushSubscription in
    // windows of PUSH_BROADCAST_BATCH_SIZE rather than loading the full table.
    // Each batch is fanned out via the same Promise.allSettled used previously;
    // succeeded/failed accumulate across batches so the response matches the
    // non-batched baseline (no silent truncation).
    let offset = 0;
    let succeeded = 0;
    let failed = 0;
    while (true) {
      const batch = await prisma.pushSubscription.findMany({
        take: PUSH_BROADCAST_BATCH_SIZE,
        skip: offset,
      });
      if (batch.length === 0) break;

      const results = await Promise.allSettled(
        batch.map((sub) => {
          const keys = JSON.parse(sub.keys);
          return webpush.sendNotification(
            { endpoint: sub.endpoint, keys },
            payload
          );
        })
      );

      succeeded += results.filter((r) => r.status === "fulfilled").length;
      failed += results.filter((r) => r.status === "rejected").length;
      offset += PUSH_BROADCAST_BATCH_SIZE;
    }

    res.json({ message: `Test push sent`, succeeded, failed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * Send a push notification to a specific user (or all subscribers if no userId).
 * Called internally by OCR completion, synthesis completion, upload KB
 * completion/failure, backup completion, etc.
 *
 * Failures are logged but never throw — push is best-effort.
 * Subscriptions that return 410 (Gone) are automatically removed.
 *
 * @param title   Notification title
 * @param body    Notification body text
 * @param userId  Optional — if set, only notify that user's subscriptions.
 *                If null/undefined, broadcast to ALL subscribers.
 * @param url     Optional URL to open when the notification is clicked.
 */
export async function sendPushNotification(
  title: string,
  body: string,
  userId?: string | null,
  url?: string,
): Promise<void> {
  try {
    const where = userId ? { userId } : {};
    const subscriptions = await prisma.pushSubscription.findMany({ where });
    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({ title, body, url });

    for (const sub of subscriptions) {
      try {
        const keys = JSON.parse(sub.keys);
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys },
          payload
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const errStatusCode = (err as { statusCode?: number }).statusCode;
        // Remove invalid subscriptions (410 = Gone, 404 = Not Found)
        if (errStatusCode === 410 || errStatusCode === 404) {
          await prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
        }
        logger.debug(`[push] Failed to send to ${sub.endpoint}: ${message}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[push] Notification dispatch failed: ${message}`);
  }
}

export default router;
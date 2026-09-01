// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response, type Router as RouterType } from "express";
import crypto from "crypto";
import { getWidgetConfig } from "../services/widgetApi";
import { getEnv } from "../config/env";
import { getRedis } from "../services/redisService";
import { logger } from "../utils/logger";

const router: RouterType = Router();

/**
 * Constant-time comparison of the presented X-Api-Key against the expected
 * WIDGET_API_KEY (G-3, T-DRD-03). Byte-identical discipline to the server's
 * secretEquals (routes/documents.ts) and the collector's requireCollectorSecret
 * (ingest.ts): Buffer.from both sides, length mismatch → false (the guard is
 * load-bearing — crypto.timingSafeEqual throws on unequal lengths), then
 * crypto.timingSafeEqual. String `!==` short-circuits on the first differing
 * byte, leaking key length/prefix via timing.
 */
function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

interface CacheEntry {
  data: any;
  expiresAt: number;
}

const configCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_TTL_SECONDS = 300;

router.get("/:widgetId", async (req: Request<{ widgetId: string }>, res: Response) => {
  const widgetId = req.params.widgetId;

  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(`widget:config:${widgetId}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        res.json(parsed);
        return;
      }
    } catch {
    }
  }

  const memCached = configCache.get(widgetId);
  if (memCached && memCached.expiresAt > Date.now()) {
    res.json(memCached.data);
    return;
  }

  try {
    const config = await getWidgetConfig(widgetId);

    if (redis) {
      try {
        await redis.setex(`widget:config:${widgetId}`, CACHE_TTL_SECONDS, JSON.stringify(config));
      } catch {
      }
    }

    configCache.set(widgetId, {
      data: config,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    res.json(config);
  } catch (err: any) {
    if (err.response?.status === 404) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    // 151-02 (Task 7): upstream 402 = widget disabled by license (Community).
    // The iframe loader treats a failed config as "unavailable" — surface it
    // gracefully (503) instead of a generic 500.
    if (err.response?.status === 402) {
      res.status(503).json({ error: "Widget disabled" });
      return;
    }
    logger.error("[widget/config] Failed to get widget config", { error: err.message });
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:widgetId/cache-bust", async (req: Request<{ widgetId: string }>, res: Response) => {
  const widgetId = req.params.widgetId;
  // G-3 (T-DRD-03): timing-safe + fail-closed. The `!expected` arm is
  // defense-in-depth fail-closed — the Zod env schema makes an unset
  // WIDGET_API_KEY unreachable in practice (min(1) validation exits at boot).
  const expected = getEnv().WIDGET_API_KEY;
  const presented = String(req.headers["x-api-key"] ?? "");
  if (!expected || !secretEquals(presented, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const redis = getRedis();
  if (redis) {
    try {
      await redis.del(`widget:config:${widgetId}`);
    } catch {
    }
  }

  configCache.delete(widgetId);
  res.json({ busted: true, widgetId });
});

export default router;
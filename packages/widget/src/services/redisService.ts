// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Widget-side Redis singleton (package boundary forbids importing from server — Open Q2).
//
// Mirrors the server's redisService.ts pattern exactly (lazy singleton, graceful
// degradation per D-02). The widget service needs its own REDIS_URL because it
// has its own .env (package boundary — Open Q2).
//
// When REDIS_URL is absent, getRedis() returns null and all consumers fall back
// to in-memory/API behavior.

import Redis from "ioredis";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

let redisInstance: Redis | null = null;
let initAttempted = false;

export function getRedis(): Redis | null {
  if (initAttempted) return redisInstance;
  initAttempted = true;

  const redisUrl = getEnv().REDIS_URL;
  if (!redisUrl) {
    logger.info("[widget] [redis] REDIS_URL not set — operating in single-instance mode");
    return null;
  }

  try {
    redisInstance = new Redis(redisUrl, {
      retryStrategy(times: number): number {
        return Math.min(times * 50, 2000);
      },
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });

    redisInstance.on("error", (err: Error) => {
      logger.error("[widget] [redis] Connection error", { error: err.message });
    });

    redisInstance.on("connect", () => {
      logger.info("[widget] [redis] Connected");
    });

    redisInstance.on("reconnecting", (delay: number) => {
      logger.warn("[widget] [redis] Reconnecting", { delayMs: delay });
    });

    redisInstance.on("end", () => {
      logger.warn("[widget] [redis] Connection ended — falling back to in-memory mode");
    });
  } catch (err: unknown) {
    logger.error("[widget] [redis] Failed to create client", {
      error: err instanceof Error ? err.message : String(err),
    });
    redisInstance = null;
  }

  return redisInstance;
}

export function isRedisAvailable(): boolean {
  return getRedis() !== null;
}

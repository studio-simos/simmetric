// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Redis singleton service (D-06).
//
// All Redis interactions in the server package go through getRedis(). The
// function returns a connected ioredis instance or null (graceful
// degradation per D-02). The connection is lazy — ioredis is only constructed
// on the first getRedis() call, NOT at module load (Pitfall 5: Redis init
// order — getEnv() must be ready before the URL is read).
//
// Mirrors the existing getEnv() / getVectorStore() / getEmbeddingProvider()
// singleton pattern. When REDIS_URL is absent the system operates in
// single-instance mode — all consumers check `getRedis() === null` and fall
// back to existing in-memory/DB behavior.

import Redis from "ioredis";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

let redisInstance: Redis | null = null;
let initAttempted = false;

/**
 * Returns a connected ioredis instance, or null when Redis is not configured
 * (REDIS_URL absent) or the connection could not be established. The instance
 * is cached for the process lifetime — subsequent calls return the same object.
 */
export function getRedis(): Redis | null {
  if (initAttempted) return redisInstance;
  initAttempted = true;

  const redisUrl = getEnv().REDIS_URL;
  if (!redisUrl) {
    logger.info("[redis] REDIS_URL not set — operating in single-instance mode");
    return null;
  }

  try {
    redisInstance = new Redis(redisUrl, {
      retryStrategy(times: number): number {
        // Exponential backoff capped at 2s (ioredis built-in reconnection)
        return Math.min(times * 50, 2000);
      },
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });

    redisInstance.on("error", (err: Error) => {
      logger.error("[redis] Connection error", { error: err.message });
    });

    redisInstance.on("connect", () => {
      logger.info("[redis] Connected");
    });

    redisInstance.on("reconnecting", (delay: number) => {
      logger.warn("[redis] Reconnecting", { delayMs: delay });
    });

    redisInstance.on("end", () => {
      logger.warn("[redis] Connection ended — falling back to in-memory mode");
    });
  } catch (err: unknown) {
    logger.error("[redis] Failed to create client", {
      error: err instanceof Error ? err.message : String(err),
    });
    redisInstance = null;
  }

  return redisInstance;
}

// NOTE (Phase 180 dead-code sweep): the `isRedisAvailable()` convenience
// helper was REMOVED — zero production consumers (tests that reference the
// name define it in their own jest.mock factory shapes). Callers use
// `getRedis() !== null` directly.
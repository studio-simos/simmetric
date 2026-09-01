// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// JWT jti revocation store (TEC-03b, D-03) — Redis SET+TTL blacklist.
//
// D-01 locked decision: revocation is a `rev:jti:<jti>` key presence check on
// the shared Redis store. A token whose jti key exists is rejected at every
// enforcement site (authMiddleware + the two direct verifyToken call sites).
//
// Non-blocking contract (D-03, mirrors invalidateAuthCache in authService.ts):
// every Redis operation is inside try/catch with a `[redis]`-prefixed warn —
// Redis failure must never break auth. When Redis is absent (single-instance
// mode) both functions degrade: isTokenRevoked returns false (token passes),
// revokeToken no-ops.
//
// The key shape `rev:jti:<jti>` (value "1", TTL EX <ttlSeconds>, default
// SESSION_EXPIRY/1000 = 86400s) is the Phase 124 cross-instance smoke-test
// contract.

import { getRedis } from "./redisService";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

const REVOCATION_PREFIX = "rev:jti:";

export async function isTokenRevoked(jti: string | undefined): Promise<boolean> {
  if (!jti) return false; // D-04: pre-deploy tokens without jti still verify
  const redis = getRedis();
  if (!redis) return false; // graceful degradation — single-instance mode
  try {
    return (await redis.get(`${REVOCATION_PREFIX}${jti}`)) !== null;
  } catch (err: unknown) {
    logger.warn("[redis] revocation check failed (non-blocking)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * @public — the TEC-03b write API. Deliberately not route-wired (client-side
 * logout is the documented single-instance contract; the smoke-multi-instance
 * Pitfall 3 note pins this). Kept + tested as the Redis revocation surface
 * for scale-layer deployments (Phase 180 reviewed-keep).
 */
export async function revokeToken(jti: string, ttlSeconds?: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const ttl = ttlSeconds ?? Math.floor(getEnv().SESSION_EXPIRY / 1000); // 86400s default
  try {
    await redis.set(`${REVOCATION_PREFIX}${jti}`, "1", "EX", ttl);
  } catch (err: unknown) {
    logger.warn("[redis] token revocation failed (non-blocking)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

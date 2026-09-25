// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview providerFetch (Phase 196, MCPO-04 D-07 / SC-3) — the single
 * backoff wrapper for all first-party connector provider calls (Drive v3,
 * Graph v1.0).
 *
 * Retry policy (D-07): retry ONLY on HTTP 429/503, at most MAX_RETRIES times.
 * Per retry, honor the Retry-After response header when present (seconds →
 * ms, capped at 60s — Graph documents Retry-After as the fastest recovery;
 * Google documents exponential backoff min((2^n + random_ms), max_backoff)
 * with jitter ≤ 1000 ms). Without the header, exponential backoff
 * Math.min((2 ** attempt) * 1000 + jitter≤1000ms, 64_000). After exhaustion
 * throw "provider rate limit: retries exhausted" — no tight loop.
 *
 * Log posture (T-196-01 / oauthProviderRegistry.ts:217-220): logs carry
 * provider + numeric status ONLY — never URL body, never headers, never
 * token material.
 *
 * Base URLs are NOT hardcoded in tool call sites — callers resolve
 * GDRIVE_API_BASE_URL / GRAPH_API_BASE_URL via getEnv() (air-gap lever,
 * T-196-05). This module is transport only.
 */

import { logger } from "../../utils/logger";

/** Max retries after the initial attempt (≤3 per D-07/SC-3 — no tight loop). */
const MAX_RETRIES = 3;
/** Retry-After cap (ms) — a hostile/large header can never pin the loop. */
const RETRY_AFTER_CAP_MS = 60_000;
/** Exponential backoff ceiling (Google's documented max_backoff band). */
const BACKOFF_CAP_MS = 64_000;

/** Throttle statuses that trigger the retry loop. */
function isThrottled(status: number): boolean {
  return status === 429 || status === 503;
}

/** Parse a Retry-After header (seconds) into ms; invalid/absent → null. */
function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null || headerValue.trim() === "") return null;
  const seconds = Number(headerValue);
  // Garbage / negative / zero fall through to the exponential arm (Task 2 pin).
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

/**
 * Fetch a provider endpoint with 429/503 backoff. The `provider` key in
 * `init` (google | microsoft) feeds the log posture; it is stripped before
 * the request is sent.
 */
export async function providerFetch(
  url: string,
  init: RequestInit & { provider: string },
): Promise<Response> {
  const { provider, ...rest } = init;
  const fetchInit = rest as RequestInit;

  let lastRetryAfterHeader: string | null = null;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const retryAfterMs = parseRetryAfterMs(lastRetryAfterHeader);
      const delay =
        retryAfterMs ??
        Math.min(
          2 ** attempt * 1000 + Math.floor(Math.random() * 1000),
          BACKOFF_CAP_MS,
        );
      logger.warn("[providerFetch] throttled — backing off", {
        provider,
        status: lastStatus,
        attempt,
        delayMs: delay,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const res = await fetch(url, fetchInit);
    lastStatus = res.status;
    if (!isThrottled(res.status)) {
      return res;
    }
    // Keep the header for the next arm's decision (Retry-After present →
    // honor it; absent/garbage → exponential).
    lastRetryAfterHeader = res.headers.get("retry-after");
    logger.warn("[providerFetch] provider throttled request", {
      provider,
      status: res.status,
      attempt,
    });
  }

  logger.error("[providerFetch] retries exhausted", { provider, status: lastStatus });
  throw new Error("provider rate limit: retries exhausted");
}
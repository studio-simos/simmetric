// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import rateLimit, { type RateLimitRequestHandler, ipKeyGenerator } from "express-rate-limit";
import RedisStore from "rate-limit-redis";
import type { Request } from "express";
import { getEnv } from "../config/env";
import { getRedis, isRedisAvailable } from "../services/redisService";

const isDev = getEnv().NODE_ENV !== "production";

// Exported key generators for testability (express-rate-limit v8 doesn't expose keyGenerator on handler).
// SEC-02: key on the widgetId from the URL path so throttling is per-tenant
// (per-Widget). The widgetChatLimiter is mounted at `/api/chat` (index.ts:38)
// BEFORE the `:widgetId` route param is parsed by the chat router, so
// req.params.widgetId is NOT populated here — the tenant id is read from
// req.originalUrl instead. This is the value that is actually present on the
// INBOUND browser request: the Preact client (useWidgetChat.ts) sends only
// `Content-Type` + `X-Session-Token`; `X-Api-Key` is an OUTBOUND header the
// widget service adds when proxying to the main server (routes/chat.ts:120),
// never sent by the browser, so it must NOT be used as the inbound key (it
// would always miss → collapse to the IP fallback → no per-tenant isolation).
// Do NOT key on the authenticated user id — server apiKeyMiddleware sets a
// constant service-account-001 for all widget traffic, which would collapse
// every widget into a single bucket. Fall back to ipKeyGenerator(req.ip)
// (malformed URL with no parseable widgetId), then "unknown".
export function chatKeyGenerator(req: Request): string {
  const widgetId = extractWidgetId(req);
  if (widgetId) {
    return `widget:${widgetId}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : "unknown";
}

// widgetChatLimiter is mounted at /api/chat (index.ts:38); the :widgetId
// segment sits immediately after the mount path, so parse it from the original
// URL. Tolerates query strings / trailing path (e.g. /api/chat/<id>/stream).
// Intentionally not exported — internal helper of this module's limiters
// (Phase 180 sweep: the export had no production consumers).
function extractWidgetId(req: Request): string | undefined {
  const match = req.originalUrl?.match(/^\/api\/chat\/([^/?#]+)/);
  return match ? match[1] : undefined;
}

export function sessionKeyGenerator(req: Request): string {
  return req.ip ? ipKeyGenerator(req.ip) : "unknown";
}

// 151-02 (G-151-1b): daily budget key — per-widget + per-IP composite. The
// daily message budget belongs to each VISITOR per widget (unlike
// widgetChatLimiter's per-widget-only burst cap). Exported for testability
// (express-rate-limit v8 doesn't expose keyGenerator on handler).
export function dailyKeyGenerator(req: Request): string {
  const widgetId = extractWidgetId(req);
  if (widgetId) {
    return `widget:${widgetId}:${req.ip || "unknown"}`;
  }
  return req.ip ? ipKeyGenerator(req.ip) : "unknown";
}

// Helper: create rate-limit-redis store when Redis is available
function createRedisStore() {
  const redis = getRedis();
  if (!redis) return undefined;
  return new RedisStore({
    prefix: "rl:",
    sendCommand: (...args: string[]) => (redis as any).call(...args),
  });
}

// SEC-02 D-06: per-tenant (per-Widget, keyed on widgetId from the URL path)
// 30 req/min prod / 200 req/min dev over a 60s window. The widgetChatLimiter is
// the sole chokepoint on /api/chat (mounted at packages/widget/src/index.ts:38).
// The server-side apiRateLimiter skips requests carrying X-Widget-Id so this
// limiter is authoritative.
//
// D-05, Open Q1, Pitfall 4: max is a function that reads rateLimitPerMinute
// from the Redis widget config cache (widget:config:{widgetId}). The limiter
// runs BEFORE sessionMiddleware (index.ts:38), so req.widgetConfig is NOT
// populated — the max function reads from Redis directly. On cache miss or
// Redis unavailable, falls back to global default (30 prod / 200 dev).
export const widgetChatLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (async (req: Request): Promise<number> => {
    const redis = getRedis();
    if (redis) {
      try {
        const widgetId = extractWidgetId(req);
        if (widgetId) {
          const cached = await redis.get(`widget:config:${widgetId}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed.rateLimitPerMinute != null && parsed.rateLimitPerMinute > 0) {
              return parsed.rateLimitPerMinute;
            }
          }
        }
      } catch {
        // Redis read failed — fall through to default
      }
    }
    return isDev ? 200 : 30;
  }) as any,  // D-01: express-rate-limit v8 supports async max at runtime; TS types lack Promise variant
  keyGenerator: chatKeyGenerator as any,
  store: createRedisStore(),
  message: { error: "Rate limit exceeded", retryAfter: "60" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-widget daily MESSAGE limit (151-02, G-151-1b). 24h window; per-widget +
// per-IP composite key (the daily budget is per VISITOR per widget, unlike
// widgetChatLimiter's per-widget-only burst cap). max is an async function
// reading sessionLimitPerDay from the Redis widget config cache
// (widget:config:{widgetId}) — exactly mirroring widgetChatLimiter.max reading
// rateLimitPerMinute. On cache miss / null / Redis unavailable, falls back to
// the global default (5 messages/day prod, 50/day dev). Mounted on the chat
// router BEFORE widgetChatLimiter (index.ts) so the daily cap is checked
// first. The widgetId IS in the URL path (/api/chat/:widgetId/stream), so
// extractWidgetId(req) is used — no body parsing needed.
export const widgetDailyMessageLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: (async (req: Request): Promise<number> => {
    const redis = getRedis();
    if (redis) {
      try {
        const widgetId = extractWidgetId(req);
        if (widgetId) {
          const cached = await redis.get(`widget:config:${widgetId}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed.sessionLimitPerDay != null && parsed.sessionLimitPerDay > 0) {
              return parsed.sessionLimitPerDay;
            }
          }
        }
      } catch {
        // Redis read failed — fall through to default
      }
    }
    return isDev ? 50 : 5;
  }) as any, // D-01: express-rate-limit v8 supports async max at runtime; TS types lack Promise variant
  keyGenerator: dailyKeyGenerator as any,
  store: createRedisStore(),
  message: { error: "Daily message limit reached", retryAfter: "86400" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-IP: high anti-spam cap on session creations (151-02, G-151-1b). Widget
// VIEWS must never count against the daily message budget — the session
// endpoint is POSTed on every widget load (useWidgetChat.ts mount), so the old
// 5/day cap burned the budget on views. 50/day per IP (500 dev) is still
// spam-protection but decoupled from the message limit (enforced by
// widgetDailyMessageLimiter on the send path).
export const widgetSessionLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: isDev ? 500 : 50,
  keyGenerator: sessionKeyGenerator as any,
  message: { error: "Daily conversation limit reached", retryAfter: "86400" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Lead submission: 3 per IP per hour (strict to prevent spam)
export const widgetLeadLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 30 : 3,
  message: { error: "Too many lead submissions. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
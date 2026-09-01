// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import RedisStore, { type RedisReply } from "rate-limit-redis";
import { getEnv } from "../config/env";
import { getRedis } from "../services/redisService";

const isDev = getEnv().NODE_ENV !== "production";

// Phase 169 E2E testability unblock (D-02 from 169-01 triage, Rule 2 missing-
// critical): the full 35-test E2E suite issues ~35 logins (globalSetup + per-
// spec loginAsAdmin + 1 retry). The dev authRateLimiter bucket (100/min per IP)
// exhausts mid-suite → 429 on /api/auth/login → cascade failures that mask the
// real carry-forward Layer-2 failures (169-01 dominant root cause, 18/25).
// E2E is a trusted, single-operator, local-only context: the rate limit exists
// to defend a shared/hosted auth surface from brute-force; an automated local
// Playwright run is not that threat and cannot be meaningfully brute-forced
// from a test harness. `playwright.config.ts` sets E2E_RUN=1 for the spawned
// server (webServer.command env), so the skip is ONLY active under the E2E
// harness — never in `pnpm dev`, `pnpm start`, or production. Mirrors the
// existing `apiRateLimiter` X-Widget-Id skip pattern (SEC-02 D-08) and the
// `authRateLimiter` GET-in-dev skip already on line below. This is a
// testability gate, NOT a security relaxation in any reachable surface.
const isE2ERun = process.env.E2E_RUN === "1";

// TEC-03a (D-03): create a rate-limit-redis store on the shared getRedis()
// connection when Redis is available; undefined otherwise (express-rate-limit
// falls back to its in-process MemoryStore — graceful degradation, air-gap
// Community). Per-limiter prefixes keep buckets from colliding (T-121-03).
// The tuple-rest signature satisfies SendCommandFn's arg contract (OQ5 /
// Pitfall 3 — TS2556); the return-position assertion to the library's own
// exported `RedisReply` bridges ioredis's `Promise<unknown>` call() result —
// a typed assertion, NOT `as any`.
// No redis.duplicate() here: the store only sends commands, and the SSE
// subscriber already duplicates at routes/chat.ts:109 — no shared-connection
// conflict (D-03).
function createRedisStore(prefix: string) {
  const redis = getRedis();
  if (!redis) return undefined;
  return new RedisStore({
    prefix,
    sendCommand: (...args: [string, ...string[]]) =>
      redis.call(...args) as Promise<RedisReply>,
  });
}

// Auth endpoints: 10 (prod) / 100 (dev) requests per minute per IP
export const authRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 100 : 10,
  message: { error: "Too many authentication attempts, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limit on GET in dev (e.g. /auth/me) AND for the E2E harness
  // (process.env.E2E_RUN === "1", set by playwright.config.ts webServer env) —
  // see the isE2ERun block above for the full rationale. The skip returns true
  // for EVERY method under E2E, because POST /api/auth/login is the cascade
  // source (not GET). Without this, the 35-test suite exhausts the 100/min
  // bucket mid-run and every subsequent test fails with a 429 cascade (169-01).
  skip: (req) => (isDev && req.method === "GET") || isE2ERun,
  store: createRedisStore("rl:auth:"),
});

// General API: 200 (prod) / 2000 (dev) requests per minute per IP
export const apiRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 2000 : 200,
  message: { error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  // SEC-02 D-08: widget-originated upstream calls are throttled by the widget
  // service's widgetChatLimiter (30/min per hashed apiKey) — the server's
  // per-IP 200/min bucket would otherwise throttle first because all widget
  // traffic shares the widget service's IP, and with 7+ active widgets the
  // shared bucket exhausts before the per-widget limiter does. X-Widget-Id is
  // sent on every widget upstream call (packages/widget/src/routes/chat.ts:121).
  skip: (req) => Boolean(req.headers["x-widget-id"]),
  store: createRedisStore("rl:api:"),
});

// Lead submission: 3 per IP per hour (strict to prevent spam per RESEARCH.md)
export const widgetLeadLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 30 : 3,
  message: { error: "Too many lead submissions. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore("rl:lead:"),
});

// Phase 152 gap G-152-2 (CR-01, WR-05): dedicated probe rate limiter for the
// wizard's PUBLIC /api/system/probe-llm and /probe-vector endpoints. Both
// are unauthenticated (wizard-gated only) and issue server-side outbound
// HTTP requests to attacker-chosen URLs — without a dedicated limiter an
// attacker could fire 200/min per IP through the global apiRateLimiter,
// amplifying the SSRF scan budget. Mirrors authRateLimiter exactly (the
// precedent for unauthenticated-and-sensitive): 10/min prod, 100/min dev.
// Mounted per-route in system.ts so it composes with — not replaces — the
// global apiRateLimiter (which runs at index.ts mount).
export const probeRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 100 : 10,
  message: { error: "Too many probe requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore("rl:probe:"),
});

// NOTE: `chatRateLimiter` was removed as part of the Variante A refactor.
// The ReAct agent now enforces its own budget via `AgentBudgetTracker`
// (see `services/agentBudgetService.ts`):
//   - Per-user concurrency cap (CHAT_MAX_CONCURRENT_PER_USER)
//   - Per-request token budget (AGENT_MAX_TOTAL_TOKENS)
//   - Per-request wallclock timeout (AGENT_WALLCLOCK_TIMEOUT_MS)
// The general `apiRateLimiter` above still provides a coarse global safety
// net (200 req/min per IP) to protect against runaway clients.
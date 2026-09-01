// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * Phase 169 Nyquist audit — authRateLimiter E2E_RUN skip predicate.
 *
 * The core code change of Phase 169 Plan 04 (commit 673b261a) extends
 * `authRateLimiter.skip` to return true for EVERY method when
 * `process.env.E2E_RUN === "1"` (set by playwright.config.ts webServer env),
 * unblocking the 429 cascade that masked 18/25 E2E failures (169-01 dominant
 * root cause). This is a security-relevant skip: the rate limit defends the
 * shared/hosted auth surface from brute-force; the E2E gate must be active
 * ONLY under the harness — never in `pnpm dev`/`pnpm start`/production.
 *
 * Behavioral contract under test (the gap the SUMMARY's manual_procedural
 * verification did NOT automate):
 *  1. E2E_RUN=1  → skip returns true for POST /api/auth/login (cascade source)
 *  2. E2E_RUN=1  → skip returns true for GET (regression: was true in dev,
 *     must stay true — the OR must not invert the existing GET-in-dev skip)
 *  3. E2E_RUN unset → skip returns FALSE for POST (brute-force defense intact
 *     in production/dev — the security invariant the fix must not weaken)
 *  4. E2E_RUN unset → skip returns true for GET in dev (existing behavior
 *     preserved — the E2E addition must not break the GET-in-dev skip)
 *
 * Pattern: mirrors chatRateLimit.test.ts describe "(c) apiRateLimiter skip
 * returns true for X-Widget-Id" — jest.resetModules() + jest.doMock env/redis/
 * rate-limit-redis/express-rate-limit, then drive the captured `skip` fn.
 * `isE2ERun` is read at module scope, so resetModules re-evaluates it against
 * the current process.env.E2E_RUN value (set/cleared per test below).
 */
import "./helpers/setupEnv";

describe("authRateLimiter E2E_RUN skip predicate (Phase 169)", () => {
  const mockEnv = { NODE_ENV: "test" as string, REDIS_URL: undefined as string | undefined };
  let capturedOptions: Array<Record<string, unknown>>;

  beforeEach(() => {
    capturedOptions = [];
    mockEnv.REDIS_URL = undefined;
  });

  afterEach(() => {
    // Restore the process env — never leak E2E_RUN into other suites (the
    // setupEnv helper does not set it, so the ambient value is undefined).
    delete process.env.E2E_RUN;
  });

  function freshRateLimit() {
    jest.resetModules();
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => mockEnv),
    }));
    jest.doMock("../services/redisService", () => ({
      getRedis: jest.fn(() => null),
      isRedisAvailable: jest.fn(() => false),
    }));
    jest.doMock("rate-limit-redis", () => ({
      __esModule: true,
      default: jest.fn(() => ({})),
    }));
    jest.doMock("express-rate-limit", () => ({
      __esModule: true,
      default: jest.fn((options: Record<string, unknown>) => {
        capturedOptions.push(options);
        return jest.fn((_req: unknown, _res: unknown, next: unknown) => {
          if (typeof next === "function") next();
        });
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../middleware/rateLimit");
  }

  it("E2E_RUN=1 → skip returns true for POST /api/auth/login (the 429 cascade source — the fix)", () => {
    process.env.E2E_RUN = "1";
    freshRateLimit();

    expect(capturedOptions).toHaveLength(4);
    const [authOpts] = capturedOptions as [Record<string, unknown>];
    const skip = authOpts.skip as (req: { method: string; headers: Record<string, string> }) => boolean;
    // POST is the cascade source method — this is the actual fix behavior.
    expect(skip({ method: "POST", headers: {} })).toBe(true);
  });

  it("E2E_RUN=1 → skip returns true for GET (regression guard — existing GET-in-dev skip preserved)", () => {
    process.env.E2E_RUN = "1";
    freshRateLimit();

    const [authOpts] = capturedOptions as [Record<string, unknown>];
    const skip = authOpts.skip as (req: { method: string; headers: Record<string, string> }) => boolean;
    expect(skip({ method: "GET", headers: {} })).toBe(true);
  });

  it("E2E_RUN unset → skip returns FALSE for POST (brute-force defense intact in production/dev)", () => {
    delete process.env.E2E_RUN;
    freshRateLimit();

    const [authOpts] = capturedOptions as [Record<string, unknown>];
    const skip = authOpts.skip as (req: { method: string; headers: Record<string, string> }) => boolean;
    // The security invariant: without E2E_RUN, POST login must STILL be rate-
    // limited. If the OR short-circuits wrongly or isE2ERun leaks true, this
    // fails — proving the rate limit is not silently disabled in prod.
    expect(skip({ method: "POST", headers: {} })).toBe(false);
  });

  it("E2E_RUN unset → skip returns true for GET in dev (existing GET-in-dev skip preserved)", () => {
    delete process.env.E2E_RUN;
    // NODE_ENV=test is non-production → isDev true → GET skip applies.
    mockEnv.NODE_ENV = "test";
    freshRateLimit();

    const [authOpts] = capturedOptions as [Record<string, unknown>];
    const skip = authOpts.skip as (req: { method: string; headers: Record<string, string> }) => boolean;
    expect(skip({ method: "GET", headers: {} })).toBe(true);
  });

  it("E2E_RUN unset + production → skip returns false for GET (E2E addition does not weaken prod GET limit)", () => {
    delete process.env.E2E_RUN;
    mockEnv.NODE_ENV = "production";
    freshRateLimit();

    const [authOpts] = capturedOptions as [Record<string, unknown>];
    const skip = authOpts.skip as (req: { method: string; headers: Record<string, string> }) => boolean;
    // In production, neither the GET-in-dev skip nor E2E_RUN applies.
    expect(skip({ method: "GET", headers: {} })).toBe(false);
    expect(skip({ method: "POST", headers: {} })).toBe(false);
  });
});
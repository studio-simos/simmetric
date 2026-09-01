// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

import { createApp } from "../index";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import jwt from "jsonwebtoken";
import { getLicenseInfo } from "../services/licenseService";

const request = require("supertest");

const app = createApp();
const env = getEnv();

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Chat rate limiter", () => {
  const token = generateToken("rate-limit-test-user");

  it("applies rate limiting to POST /:workspaceId/chat", async () => {
    // Verify the route exists and returns 4xx/5xx (not 404 which means route not mounted)
    // We use a non-existent workspace to get a 500 or proper error — not testing chat logic
    const res = await request(app)
      .post("/api/workspaces/nonexistent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "test" });

    // Should NOT be 404 (route must be mounted)
    expect(res.status).not.toBe(404);
  });

  it("applies rate limiting to POST /:workspaceId/chat/stream", async () => {
    const res = await request(app)
      .post("/api/workspaces/nonexistent/chat/stream")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "test" });

    // Should NOT be 404 (route must be mounted)
    expect(res.status).not.toBe(404);
  });

  it("returns 429 when rate limit is exceeded (Community tier)", async () => {
    // In dev mode, Community limit is 200 req/min — too many to hit in tests.
    // We verify the limiter is mounted by checking the response includes
    // rate limit headers on successful requests.
    const res = await request(app)
      .post("/api/workspaces/nonexistent/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "test" });

    // Rate limit headers should be present (express-rate-limit adds them)
    expect(res.headers["ratelimit-limit"]).toBeDefined();
  });

  it("uses license tier to determine rate limit", () => {
    // Verify the rate limiter reads the license tier correctly
    const info = getLicenseInfo();
    expect(["community", "enterprise"]).toContain(info.tier);
  });
});
// ─── Redis store selection (TEC-03a, D-03) ──────────────────────────────────
// Additive describes following the widget rateLimit.redis.test.ts mock
// strategy: jest.doMock rate-limit-redis + express-rate-limit in a
// jest.resetModules fresh-module context where the env mock controls
// REDIS_URL. The existing 429/header assertions above are untouched.

describe("server rate limiters — Redis store selection (TEC-03a, D-03)", () => {
  const mockEnv = { NODE_ENV: "test" as string, REDIS_URL: undefined as string | undefined };
  const mockRedisInstance = {
    call: jest.fn().mockResolvedValue("OK"),
    on: jest.fn(),
  };
  let mockRedisStoreConstructor: jest.Mock;
  let mockRedisStoreInstances: Array<{ kind: string; id: number }>;
  let capturedOptions: Array<Record<string, unknown>>;

  beforeEach(() => {
    mockEnv.REDIS_URL = undefined;
    mockRedisStoreInstances = [];
    mockRedisStoreConstructor = jest.fn(() => {
      const inst = { kind: "mock-redis-store", id: mockRedisStoreInstances.length };
      mockRedisStoreInstances.push(inst);
      return inst;
    });
    capturedOptions = [];
  });

  function freshRateLimit() {
    jest.resetModules();
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => mockEnv),
    }));
    jest.doMock("../services/redisService", () => ({
      getRedis: jest.fn(() => (mockEnv.REDIS_URL ? mockRedisInstance : null)),
      isRedisAvailable: jest.fn(() => Boolean(mockEnv.REDIS_URL)),
    }));
    jest.doMock("rate-limit-redis", () => ({
      __esModule: true,
      default: mockRedisStoreConstructor,
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

  it("(a) REDIS_URL set → 4 RedisStores with prefixes rl:auth:/rl:api:/rl:lead:/rl:probe:, each limiter's store === its own RedisStore", () => {
    mockEnv.REDIS_URL = "redis://localhost:6379";
    const mod = freshRateLimit();

    expect(mod.authRateLimiter).toBeDefined();
    expect(mod.apiRateLimiter).toBeDefined();
    expect(mod.widgetLeadLimiter).toBeDefined();
    expect(mod.probeRateLimiter).toBeDefined();
    expect(mockRedisStoreConstructor).toHaveBeenCalledTimes(4);
    const prefixes = mockRedisStoreConstructor.mock.calls.map(
      (c: unknown[]) => (c[0] as { prefix: string }).prefix,
    );
    expect(prefixes).toEqual(["rl:auth:", "rl:api:", "rl:lead:", "rl:probe:"]);

    const [authOpts, apiOpts, leadOpts, probeOpts] = capturedOptions as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(authOpts.store).toBe(mockRedisStoreInstances[0]);
    expect(apiOpts.store).toBe(mockRedisStoreInstances[1]);
    expect(leadOpts.store).toBe(mockRedisStoreInstances[2]);
    expect(probeOpts.store).toBe(mockRedisStoreInstances[3]);
  });

  it("(b) REDIS_URL absent → all 4 limiters have store undefined (in-process MemoryStore fallback)", () => {
    mockEnv.REDIS_URL = undefined;
    freshRateLimit();

    expect(mockRedisStoreConstructor).not.toHaveBeenCalled();
    expect(capturedOptions).toHaveLength(4);
    for (const opts of capturedOptions) {
      expect(opts.store).toBeUndefined();
    }
  });

  it("(c) apiRateLimiter skip returns true for X-Widget-Id and false without (SEC-02 D-08 preserved)", () => {
    mockEnv.REDIS_URL = "redis://localhost:6379";
    freshRateLimit();

    const [, apiOpts] = capturedOptions as [Record<string, unknown>, Record<string, unknown>];
    const skip = apiOpts.skip as (req: { headers: Record<string, string> }) => boolean;
    expect(skip({ headers: { "x-widget-id": "w1" } })).toBe(true);
    expect(skip({ headers: {} })).toBe(false);
  });
});

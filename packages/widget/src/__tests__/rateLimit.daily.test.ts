// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for widgetDailyMessageLimiter (151-02, G-151-1b) — the per-widget
// daily MESSAGE limit on POST /api/chat/:widgetId/stream.
//
// The max function reads sessionLimitPerDay from the Redis widget config cache
// (widget:config:{widgetId}) — exactly mirroring widgetChatLimiter.max reading
// rateLimitPerMinute. On cache miss / null / Redis unavailable, it falls back
// to the global default (5 messages/day prod, 50/day dev).
//
// Mock strategy (mirrors rateLimit.redis.test.ts):
// - ioredis is mocked with a shared mutable instance (controls Redis availability).
// - rate-limit-redis is mocked so RedisStore construction is a no-op.
// - express-rate-limit is mocked to capture the options (max) while returning
//   a dummy middleware handler. This lets us call the max function directly
//   without needing a real rate-limiting cycle.
// - getEnv is mocked with a shared mutable object.
// Kept in a SEPARATE file (not rateLimit.test.ts) because jest.resetModules +
// doMock pollutes the module registry for the sibling throttle tests that
// require the real express-rate-limit at runtime.

import "./helpers/setupEnv";

// ─── Shared mutable mock state ───────────────────────────────────────────────

const mockEnv = {
  REDIS_URL: undefined as string | undefined,
  NODE_ENV: "test" as string,
  WIDGET_PORT: 3211,
  SERVER_URL: "http://localhost:3000",
  WIDGET_API_KEY: "sk-test-widget-key",
  LOG_LEVEL: "info",
};

const mockRedisInstance = {
  on: jest.fn(),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
  setex: jest.fn().mockResolvedValue("OK"),
  del: jest.fn().mockResolvedValue(1),
  ping: jest.fn().mockResolvedValue("PONG"),
  sendCommand: jest.fn().mockResolvedValue("OK"),
  duplicate: jest.fn(),
  disconnect: jest.fn(),
};

const mockRedisConstructor = jest.fn(() => mockRedisInstance);

// ─── Rate limiter specific mocks ──────────────────────────────────────────────

let capturedRateLimitOptions: Record<string, unknown> | null = null;
let mockRateLimitCallCount = 0;
const mockRateLimitHandler = jest.fn(
  (_req: unknown, _res: unknown, next: unknown) => {
    if (typeof next === "function") next();
  },
);

jest.mock("ioredis", () => ({
  __esModule: true,
  default: mockRedisConstructor,
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => mockEnv),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("rate-limit-redis", () => ({
  __esModule: true,
  default: jest.fn(() => ({ kind: "mock-redis-store" })),
}));

jest.mock("express-rate-limit", () => ({
  __esModule: true,
  default: jest.fn((options: Record<string, unknown>) => {
    mockRateLimitCallCount++;
    // Module order in rateLimit.ts: widgetChatLimiter(1), widgetDailyMessageLimiter(2),
    // widgetSessionLimiter(3), widgetLeadLimiter(4). Capture the DAILY limiter's options.
    if (mockRateLimitCallCount === 2) {
      capturedRateLimitOptions = options;
    }
    return mockRateLimitHandler;
  }),
  ipKeyGenerator: jest.fn((ip: string) => ip),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Reset modules and re-require rateLimit.ts with a fresh Redis singleton state. */
function freshRateLimit() {
  jest.resetModules();
  mockRedisConstructor.mockClear();
  capturedRateLimitOptions = null;
  mockRateLimitCallCount = 0;
  return require("../middleware/rateLimit");
}

/** Build a minimal mock Request for the max function. */
function maxReq(originalUrl: string) {
  return { originalUrl, headers: {}, ip: "1.2.3.4" } as any;
}

// ─── Tests: widgetDailyMessageLimiter max function ───────────────────────────

describe("widgetDailyMessageLimiter max function (151-02, G-151-1b)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockEnv.REDIS_URL = "redis://localhost:6379";
    mockEnv.NODE_ENV = "test"; // isDev = true → default 50
    mockRedisInstance.get.mockResolvedValue(null);
    capturedRateLimitOptions = null;
    mockRateLimitCallCount = 0;
  });

  it("returns sessionLimitPerDay from the Redis widget config cache on cache hit", async () => {
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;
    expect(typeof maxFn).toBe("function");

    // Simulate a cache hit with sessionLimitPerDay: 25
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", sessionLimitPerDay: 25 }),
    );

    const result = await maxFn(maxReq("/api/chat/wid-abc/stream"), {});
    expect(result).toBe(25);
    // Verify the Redis key pattern: widget:config:{widgetId}
    expect(mockRedisInstance.get).toHaveBeenCalledWith("widget:config:wid-abc");
  });

  it("ignores null/zero/negative sessionLimitPerDay → global default (50 dev)", async () => {
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    // null → fall back to default
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", sessionLimitPerDay: null }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(50);

    // zero → fall back to default
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", sessionLimitPerDay: 0 }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(50);

    // negative → fall back to default
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", sessionLimitPerDay: -5 }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(50);

    // positive → use override
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", sessionLimitPerDay: 100 }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(100);
  });

  it("falls back to the global default (50 dev) on cache miss (Redis returns null)", async () => {
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    mockRedisInstance.get.mockResolvedValue(null); // cache miss
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(50);
  });

  it("falls back to the global default (5 prod) when NODE_ENV=production", async () => {
    mockEnv.NODE_ENV = "production"; // isDev = false → 5
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    mockRedisInstance.get.mockResolvedValue(null);
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(5);
  });

  it("falls back to the global default when Redis is unavailable (REDIS_URL not set)", async () => {
    mockEnv.REDIS_URL = undefined;
    mockEnv.NODE_ENV = "test"; // isDev = true → 50
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(50);
    expect(mockRedisInstance.get).not.toHaveBeenCalled();
  });

  it("falls back to the global default when no widgetId is parseable from the URL", async () => {
    mockEnv.NODE_ENV = "test";
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    expect(await maxFn(maxReq("/api/other"), {})).toBe(50);
  });
});

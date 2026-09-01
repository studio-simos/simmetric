// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for widgetChatLimiter with rate-limit-redis store + per-widget max
// function (SCALE-04, D-05, Open Q1) and widget config Redis cache (D-07, Pitfall 7).
//
// Tests 4-7: widgetChatLimiter store selection (Redis vs in-memory) + max function
//   reading rateLimitPerMinute from Redis widget config cache.
// Tests 8-11: widget config route Redis cache (widget:config:{widgetId}).
//
// Mock strategy:
// - ioredis is mocked with a shared mutable instance (controls Redis availability).
// - rate-limit-redis is mocked so we can spy on RedisStore construction.
// - express-rate-limit is mocked to capture the options (store, max) while
//   returning a dummy middleware handler. This lets us inspect the store
//   selection and call the max function directly without needing a real
//   rate-limiting cycle.
// - getEnv is mocked with a shared mutable object.
// - getWidgetConfig is mocked for config cache tests.
// - supertest is used for config route tests (real Express app with fresh router).

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
  subscribe: jest.fn(),
  unsubscribe: jest.fn(),
  publish: jest.fn(),
};

const mockRedisConstructor = jest.fn(() => mockRedisInstance);

// ─── Module mocks (hoisted by jest.mock) ─────────────────────────────────────

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

// Mock getWidgetConfig for config cache tests
const mockGetWidgetConfig = jest.fn();
jest.mock("../services/widgetApi", () => ({
  getWidgetConfig: mockGetWidgetConfig,
  validateSession: jest.fn(),
  createSession: jest.fn(),
  incrementSessionCounters: jest.fn(),
  searchWidgetWorkspaces: jest.fn(),
  submitLead: jest.fn(),
}));

// ─── Rate limiter specific mocks ──────────────────────────────────────────────
//
// We mock express-rate-limit to capture the options object (store, max, etc.)
// so we can inspect store selection and call the max function directly.
// We mock rate-limit-redis to spy on RedisStore construction.

let capturedRateLimitOptions: Record<string, unknown> | null = null;
let mockRateLimitCallCount = 0;
const mockRateLimitHandler = jest.fn(
  (_req: unknown, _res: unknown, next: unknown) => {
    if (typeof next === "function") next();
  },
);

const mockRedisStoreInstance = { kind: "mock-redis-store" };
const mockRedisStoreConstructor = jest.fn(() => mockRedisStoreInstance);

jest.mock("rate-limit-redis", () => ({
  __esModule: true,
  default: mockRedisStoreConstructor,
}));

jest.mock("express-rate-limit", () => ({
  __esModule: true,
  default: jest.fn((options: Record<string, unknown>) => {
    mockRateLimitCallCount++;
    if (mockRateLimitCallCount === 1) {
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
  mockRedisStoreConstructor.mockClear();
  capturedRateLimitOptions = null;
  mockRateLimitCallCount = 0;
  return require("../middleware/rateLimit");
}

/** Resolve a CJS require with SWC interop (handle function vs { default: fn }). */
function resolveCjs(mod: any): any {
  return typeof mod === "function" ? mod : mod.default ?? mod;
}

/** Reset modules and re-require config.ts, returning a fresh Express app. */
function freshConfigApp() {
  jest.resetModules();
  const expressRaw = require("express");
  const express: any = resolveCjs(expressRaw);
  const configRoutes = require("../routes/config").default;
  const app = express();
  app.use(express.json());
  app.use("/api/config", configRoutes);
  return app;
}

/** Fresh supertest after resetModules. */
function freshSupertest(): any {
  return resolveCjs(require("supertest"));
}

/** Build a minimal mock Request for the max function. */
function maxReq(originalUrl: string) {
  return { originalUrl, headers: {}, ip: "1.2.3.4" } as any;
}

// ─── Tests 4-5: widgetChatLimiter store selection ─────────────────────────────

describe("widgetChatLimiter store selection (SCALE-04, D-05, D-02)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockEnv.REDIS_URL = undefined;
    mockEnv.NODE_ENV = "test";
    mockRedisConstructor.mockClear();
    mockRedisStoreConstructor.mockClear();
    capturedRateLimitOptions = null;
    mockRateLimitCallCount = 0;
  });

  // Test 4: widgetChatLimiter uses rate-limit-redis store when Redis available.
  // 151-02 (G-151-1b): widgetDailyMessageLimiter ALSO constructs a RedisStore
  // when Redis is available (2 total — chat + daily). capturedRateLimitOptions
  // holds the FIRST call (widgetChatLimiter), so the store assertion below
  // still pins the chat limiter's store selection.
  it("uses rate-limit-redis store (RedisStore constructed) when Redis is available", () => {
    mockEnv.REDIS_URL = "redis://localhost:6379";
    freshRateLimit(); // triggers module load → getRedis() → store creation
    expect(mockRedisStoreConstructor).toHaveBeenCalledTimes(2);
    expect(capturedRateLimitOptions).not.toBeNull();
    expect(capturedRateLimitOptions!.store).toBe(mockRedisStoreInstance);
  });

  // Test 5: widgetChatLimiter uses in-memory store (undefined) when Redis unavailable
  it("uses in-memory store (undefined) when Redis is unavailable", () => {
    mockEnv.REDIS_URL = undefined;
    freshRateLimit();
    expect(mockRedisStoreConstructor).not.toHaveBeenCalled();
    expect(capturedRateLimitOptions).not.toBeNull();
    // store should be undefined (express-rate-limit default = in-memory)
    expect(capturedRateLimitOptions!.store).toBeUndefined();
  });
});

// ─── Tests 6-7: widgetChatLimiter max function ────────────────────────────────

describe("widgetChatLimiter max function (SCALE-04, D-05, Open Q1, Pitfall 4)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockEnv.REDIS_URL = "redis://localhost:6379";
    mockEnv.NODE_ENV = "test"; // isDev = true → default 200
    mockRedisInstance.get.mockResolvedValue(null);
    capturedRateLimitOptions = null;
    mockRateLimitCallCount = 0;
  });

  // Test 6: max function reads rateLimitPerMinute from Redis widget config cache
  it("returns rateLimitPerMinute from Redis widget config cache on cache hit", async () => {
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;
    expect(typeof maxFn).toBe("function");

    // Simulate a cache hit with rateLimitPerMinute: 50
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", rateLimitPerMinute: 50 }),
    );

    const result = await maxFn(maxReq("/api/chat/wid-abc/stream"), {});
    expect(result).toBe(50);
    // Verify the Redis key pattern: widget:config:{widgetId}
    expect(mockRedisInstance.get).toHaveBeenCalledWith("widget:config:wid-abc");
  });

  it("returns rateLimitPerMinute when it is a positive number, ignores null/zero/negative", async () => {
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    // null rateLimitPerMinute → fall back to default
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", rateLimitPerMinute: null }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(200);

    // zero → fall back to default
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", rateLimitPerMinute: 0 }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(200);

    // negative → fall back to default
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", rateLimitPerMinute: -5 }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(200);

    // positive → use override
    mockRedisInstance.get.mockResolvedValue(
      JSON.stringify({ id: "wid-abc", rateLimitPerMinute: 100 }),
    );
    expect(await maxFn(maxReq("/api/chat/wid-abc/stream"), {})).toBe(100);
  });

  // Test 7: max function falls back to global default on cache miss or Redis unavailable
  it("falls back to global default (200 dev) on cache miss (Redis returns null)", async () => {
    mockEnv.NODE_ENV = "test"; // isDev = true → 200
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    mockRedisInstance.get.mockResolvedValue(null); // cache miss
    const result = await maxFn(maxReq("/api/chat/wid-abc/stream"), {});
    expect(result).toBe(200);
  });

  it("falls back to global default (30 prod) when NODE_ENV=production", async () => {
    mockEnv.NODE_ENV = "production"; // isDev = false → 30
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    mockRedisInstance.get.mockResolvedValue(null);
    const result = await maxFn(maxReq("/api/chat/wid-abc/stream"), {});
    expect(result).toBe(30);
  });

  it("falls back to global default when Redis is unavailable (REDIS_URL not set)", async () => {
    mockEnv.REDIS_URL = undefined;
    mockEnv.NODE_ENV = "test"; // isDev = true → 200
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    const result = await maxFn(maxReq("/api/chat/wid-abc/stream"), {});
    expect(result).toBe(200);
  });

  it("falls back to global default when no widgetId is parseable from URL", async () => {
    mockEnv.NODE_ENV = "test";
    freshRateLimit();
    const maxFn = capturedRateLimitOptions!.max as (
      req: unknown,
      res: unknown,
    ) => Promise<number>;

    const result = await maxFn(maxReq("/api/other"), {});
    expect(result).toBe(200);
  });
});

// ─── Tests 8-11: widget config Redis cache ────────────────────────────────────

describe("widget config Redis cache (D-07, Pitfall 7)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockEnv.REDIS_URL = "redis://localhost:6379";
    mockEnv.NODE_ENV = "test";
    mockEnv.WIDGET_API_KEY = "sk-test-widget-key";
    mockRedisInstance.get.mockResolvedValue(null);
    mockRedisInstance.setex.mockResolvedValue("OK");
    mockRedisInstance.del.mockResolvedValue(1);
    mockGetWidgetConfig.mockReset();
  });

  // Test 8: widget config route reads from Redis (widget:config:{widgetId}) on cache hit
  it("reads from Redis on cache hit and does NOT call server API", async () => {
    const cachedConfig = {
      id: "wid-abc",
      name: "Test Widget",
      primaryColor: "#4c6ef5",
      botName: "AI",
      rateLimitPerMinute: 50,
    };
    mockRedisInstance.get.mockResolvedValue(JSON.stringify(cachedConfig));

    const app = freshConfigApp();
    const request = freshSupertest();
    const res = await request(app).get("/api/config/wid-abc");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "wid-abc", rateLimitPerMinute: 50 });
    expect(mockRedisInstance.get).toHaveBeenCalledWith("widget:config:wid-abc");
    expect(mockGetWidgetConfig).not.toHaveBeenCalled();
  });

  // Test 9: widget config route writes to Redis on cache miss (5-min TTL)
  it("calls server API on cache miss and writes result to Redis with 5-min TTL", async () => {
    const serverConfig = {
      id: "wid-abc",
      name: "Test Widget",
      primaryColor: "#4c6ef5",
      botName: "AI",
      rateLimitPerMinute: 50,
    };
    mockRedisInstance.get.mockResolvedValue(null); // cache miss
    mockGetWidgetConfig.mockResolvedValue(serverConfig);

    const app = freshConfigApp();
    const request = freshSupertest();
    const res = await request(app).get("/api/config/wid-abc");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "wid-abc" });
    expect(mockGetWidgetConfig).toHaveBeenCalledWith("wid-abc");
    // Verify Redis write with 5-min TTL (300 seconds)
    expect(mockRedisInstance.setex).toHaveBeenCalledWith(
      "widget:config:wid-abc",
      300,
      JSON.stringify(serverConfig),
    );
  });

  // Test 10: widget config cache-bust endpoint DELs the Redis key
  it("cache-bust endpoint DELs the Redis key (cross-instance invalidation)", async () => {
    const app = freshConfigApp();
    const request = freshSupertest();
    const res = await request(app)
      .post("/api/config/wid-abc/cache-bust")
      .set("x-api-key", "sk-test-widget-key");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ busted: true, widgetId: "wid-abc" });
    expect(mockRedisInstance.del).toHaveBeenCalledWith("widget:config:wid-abc");
  });

  // Test 11: widget config route falls through to server API when Redis unavailable
  it("falls through to server API when Redis is unavailable (existing behavior)", async () => {
    mockEnv.REDIS_URL = undefined; // Redis unavailable
    const serverConfig = {
      id: "wid-abc",
      name: "Test Widget",
      primaryColor: "#4c6ef5",
      botName: "AI",
    };
    mockGetWidgetConfig.mockResolvedValue(serverConfig);

    const app = freshConfigApp();
    const request = freshSupertest();
    const res = await request(app).get("/api/config/wid-abc");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "wid-abc" });
    expect(mockGetWidgetConfig).toHaveBeenCalledWith("wid-abc");
    // Redis should not be called at all (getRedis() returns null → no Redis ops)
    expect(mockRedisInstance.get).not.toHaveBeenCalled();
    expect(mockRedisInstance.setex).not.toHaveBeenCalled();
  });

  it("cache-bust returns 401 when X-Api-Key does not match", async () => {
    const app = freshConfigApp();
    const request = freshSupertest();
    const res = await request(app)
      .post("/api/config/wid-abc/cache-bust")
      .set("x-api-key", "wrong-key");

    expect(res.status).toBe(401);
  });

  it("returns 404 when server API returns 404 for widget not found", async () => {
    mockRedisInstance.get.mockResolvedValue(null); // cache miss
    mockGetWidgetConfig.mockRejectedValue({
      response: { status: 404 },
      message: "Not found",
    });

    const app = freshConfigApp();
    const request = freshSupertest();
    const res = await request(app).get("/api/config/wid-abc");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Widget not found" });
  });
});

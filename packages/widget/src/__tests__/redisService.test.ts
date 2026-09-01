// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the widget Redis singleton service (D-06, Open Q2).
//
// The widget service has its OWN redisService.ts — the package boundary
// forbids importing from the server package (Open Q2). This mirrors the
// server's redisService.ts pattern (lazy singleton, graceful degradation).
//
// Mock strategy (mirrors server redisService.test.ts):
// - ioredis is mocked with a shared mutable instance.
// - getEnv is mocked with a shared mutable object so resetModules preserves it.
// - logger is mocked to prevent file/console output.

const rsMockEnv = {
  REDIS_URL: undefined as string | undefined,
  NODE_ENV: "test" as string,
  WIDGET_PORT: 3211,
  SERVER_URL: "http://localhost:3000",
  WIDGET_API_KEY: "sk-test-widget-key",
  LOG_LEVEL: "info",
};

const mockRedisInstance = {
  on: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  ping: jest.fn(),
  publish: jest.fn(),
  duplicate: jest.fn(),
  disconnect: jest.fn(),
  subscribe: jest.fn(),
  unsubscribe: jest.fn(),
  sendCommand: jest.fn(),
};

const rsMockRedisConstructor = jest.fn(() => mockRedisInstance);

jest.mock("ioredis", () => ({
  __esModule: true,
  default: rsMockRedisConstructor,
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => rsMockEnv),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function freshRedisService() {
  jest.resetModules();
  rsMockRedisConstructor.mockClear();
  return require("../services/redisService");
}

describe("widget redisService — singleton and degradation (SCALE-01, Open Q2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    rsMockEnv.REDIS_URL = undefined;
    rsMockRedisConstructor.mockClear();
  });

  // Test 1: widget getRedis() returns null when REDIS_URL is not set
  it("getRedis() returns null when REDIS_URL is not set", () => {
    rsMockEnv.REDIS_URL = undefined;
    const { getRedis } = freshRedisService();
    expect(getRedis()).toBeNull();
  });

  // Test 2: widget getRedis() returns a Redis instance when REDIS_URL is set
  it("getRedis() returns a Redis instance when REDIS_URL is set", () => {
    rsMockEnv.REDIS_URL = "redis://localhost:6379";
    const { getRedis } = freshRedisService();
    const redis = getRedis();
    expect(redis).not.toBeNull();
    expect(rsMockRedisConstructor).toHaveBeenCalledWith(
      "redis://localhost:6379",
      expect.objectContaining({
        maxRetriesPerRequest: 3,
        enableOfflineQueue: true,
      }),
    );
  });

  // Test 3: widget getRedis() returns the same instance on second call (singleton)
  it("getRedis() returns the same instance on second call (singleton caching)", () => {
    rsMockEnv.REDIS_URL = "redis://localhost:6379";
    const { getRedis } = freshRedisService();
    const first = getRedis();
    const second = getRedis();
    expect(rsMockRedisConstructor).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("isRedisAvailable() returns false when REDIS_URL is absent", () => {
    rsMockEnv.REDIS_URL = undefined;
    const { isRedisAvailable } = freshRedisService();
    expect(isRedisAvailable()).toBe(false);
  });

  it("isRedisAvailable() returns true when REDIS_URL is set and client is constructed", () => {
    rsMockEnv.REDIS_URL = "redis://localhost:6379";
    const { isRedisAvailable } = freshRedisService();
    expect(isRedisAvailable()).toBe(true);
  });
});

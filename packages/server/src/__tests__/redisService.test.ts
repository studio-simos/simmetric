// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the Redis singleton service (D-06).
// Covers SCALE-01: getRedis() lazy singleton + graceful degradation (D-02).
//
// Mock strategy:
// - ioredis is mocked with a shared mutable instance.
// - getEnv is mocked with a shared mutable object so resetModules preserves it.
// - logger is mocked to prevent file/console output.

const rsMockEnv = { REDIS_URL: undefined as string | undefined, SESSION_EXPIRY: 86400000 };

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

describe("redisService — singleton and degradation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    rsMockEnv.REDIS_URL = undefined;
    rsMockRedisConstructor.mockClear();
  });

  it("getRedis() returns null when REDIS_URL is not set", () => {
    rsMockEnv.REDIS_URL = undefined;
    const { getRedis } = freshRedisService();
    expect(getRedis()).toBeNull();
  });

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

  it("getRedis() returns the same instance on second call (singleton caching)", () => {
    rsMockEnv.REDIS_URL = "redis://localhost:6379";
    const { getRedis } = freshRedisService();
    const first = getRedis();
    const second = getRedis();
    expect(rsMockRedisConstructor).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("getRedis() returns null when REDIS_URL is absent (degradation probe)", () => {
    // Phase 180 dead-code sweep: the isRedisAvailable() convenience helper
    // was removed (zero production consumers) — callers probe
    // `getRedis() !== null` directly. This test pins that contract.
    rsMockEnv.REDIS_URL = undefined;
    const { getRedis } = freshRedisService();
    expect(getRedis()).toBeNull();
  });
});
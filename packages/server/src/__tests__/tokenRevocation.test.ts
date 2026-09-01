// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the token revocation store (TEC-03b, D-03) — Redis SET+TTL
// jti blacklist backed by getRedis(). Mirrors the distributedLock test harness:
// redisService is mocked directly (the store's only dependency is getRedis()).
// Covers the nine store behaviors: revoked → true, not-revoked → false, Redis
// absent → false, Redis error → false + [redis] warn, undefined jti → false
// (getRedis NOT called), revokeToken key/EX/ttl args (default 86400 + explicit),
// Redis absent → no-op, set rejection → warn + no throw.

const mockGetRedis = jest.fn();

jest.mock("../services/redisService", () => ({
  getRedis: mockGetRedis,
  isRedisAvailable: jest.fn(() => mockGetRedis() !== null),
}));

const trMockEnv = { SESSION_EXPIRY: 86400000 };

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => trMockEnv),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function freshTokenRevocation() {
  jest.resetModules();
  return require("../services/tokenRevocation");
}

describe("tokenRevocation — isTokenRevoked", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockGetRedis.mockReturnValue(null);
  });

  it("returns true when the jti key exists (redis.get resolves '1')", async () => {
    const redis = { get: jest.fn().mockResolvedValue("1"), set: jest.fn() };
    mockGetRedis.mockReturnValue(redis);
    const { isTokenRevoked } = freshTokenRevocation();

    await expect(isTokenRevoked("j1")).resolves.toBe(true);
    expect(redis.get).toHaveBeenCalledWith("rev:jti:j1");
  });

  it("returns false when the jti key is absent (redis.get resolves null)", async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    mockGetRedis.mockReturnValue(redis);
    const { isTokenRevoked } = freshTokenRevocation();

    await expect(isTokenRevoked("j1")).resolves.toBe(false);
    expect(redis.get).toHaveBeenCalledWith("rev:jti:j1");
  });

  it("returns false when Redis is absent (getRedis() null)", async () => {
    const { isTokenRevoked } = freshTokenRevocation();

    await expect(isTokenRevoked("j1")).resolves.toBe(false);
  });

  it("returns false and warns with a [redis] prefix when redis.get rejects", async () => {
    const redis = { get: jest.fn().mockRejectedValue(new Error("conn refused")), set: jest.fn() };
    mockGetRedis.mockReturnValue(redis);
    const { isTokenRevoked } = freshTokenRevocation();
    const { logger } = require("../utils/logger");

    await expect(isTokenRevoked("j1")).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[redis\]/), expect.any(Object));
  });

  it("returns false without calling getRedis for undefined jti (D-04)", async () => {
    const { isTokenRevoked } = freshTokenRevocation();

    await expect(isTokenRevoked(undefined)).resolves.toBe(false);
    expect(mockGetRedis).not.toHaveBeenCalled();
  });
});

describe("tokenRevocation — revokeToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockGetRedis.mockReturnValue(null);
  });

  it("sets rev:jti:<jti> with value '1', EX, and the default 86400s TTL", async () => {
    const redis = { get: jest.fn(), set: jest.fn().mockResolvedValue("OK") };
    mockGetRedis.mockReturnValue(redis);
    const { revokeToken } = freshTokenRevocation();

    await revokeToken("j1");
    expect(redis.set).toHaveBeenCalledWith("rev:jti:j1", "1", "EX", 86400);
  });

  it("honors an explicit ttlSeconds", async () => {
    const redis = { get: jest.fn(), set: jest.fn().mockResolvedValue("OK") };
    mockGetRedis.mockReturnValue(redis);
    const { revokeToken } = freshTokenRevocation();

    await revokeToken("j1", 3600);
    expect(redis.set).toHaveBeenCalledWith("rev:jti:j1", "1", "EX", 3600);
  });

  it("is a no-op when Redis is absent (set NOT called, no throw)", async () => {
    const { revokeToken } = freshTokenRevocation();

    await expect(revokeToken("j1")).resolves.toBeUndefined();
  });

  it("warns with a [redis] prefix and does not throw when redis.set rejects", async () => {
    const redis = { get: jest.fn(), set: jest.fn().mockRejectedValue(new Error("timeout")) };
    mockGetRedis.mockReturnValue(redis);
    const { revokeToken } = freshTokenRevocation();
    const { logger } = require("../utils/logger");

    await expect(revokeToken("j1")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[redis\]/), expect.any(Object));
  });
});

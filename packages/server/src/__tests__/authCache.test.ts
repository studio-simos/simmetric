// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the auth cache layer (D-07, Pattern 5).
// Covers SCALE-01: getCachedUserWithRoles + invalidateAuthCache.
//
// Mock strategy:
// - ioredis is mocked with a shared mutable instance.
// - getEnv is mocked with a shared mutable object.
// - logger is mocked.
// - prisma is mocked with a shared mock fn so resetModules preserves it.

const acMockEnv = {
  REDIS_URL: undefined as string | undefined,
  SESSION_EXPIRY: 86400000,
  JWT_SECRET: "test-jwt-secret",
};

const acMockRedis = {
  on: jest.fn(),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
  setex: jest.fn().mockResolvedValue("OK"),
  del: jest.fn().mockResolvedValue(1),
  ping: jest.fn().mockResolvedValue("PONG"),
  publish: jest.fn(),
  duplicate: jest.fn(),
  disconnect: jest.fn(),
  subscribe: jest.fn(),
  unsubscribe: jest.fn(),
};

const acMockRedisConstructor = jest.fn(() => acMockRedis);

const mockUserFindUnique = jest.fn();

jest.mock("ioredis", () => ({
  __esModule: true,
  default: acMockRedisConstructor,
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => acMockEnv),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: mockUserFindUnique,
    },
  },
}));

function freshAuthModule() {
  jest.resetModules();
  return require("../services/authService");
}

describe("authCache — getCachedUserWithRoles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    acMockEnv.REDIS_URL = undefined;
    acMockRedis.get.mockResolvedValue(null);
    acMockRedis.setex.mockResolvedValue("OK");
    acMockRedis.del.mockResolvedValue(1);
    mockUserFindUnique.mockResolvedValue(null);
  });

  it("returns cached user from Redis on cache hit (no DB call)", async () => {
    acMockEnv.REDIS_URL = "redis://localhost:6379";
    const cachedUser = {
      id: "user-1",
      username: "alice",
      roles: [{ role: { id: "role-1", name: "admin", permissions: [] } }],
    };
    acMockRedis.get.mockResolvedValue(JSON.stringify(cachedUser));

    const { getCachedUserWithRoles } = freshAuthModule();
    const result = await getCachedUserWithRoles("user-1");

    expect(result).toEqual(cachedUser);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("falls through to DB on cache miss, writes result to Redis", async () => {
    acMockEnv.REDIS_URL = "redis://localhost:6379";
    const dbUser = {
      id: "user-2",
      username: "bob",
      roles: [{ role: { id: "role-2", name: "user", permissions: [] } }],
    };
    acMockRedis.get.mockResolvedValue(null);
    mockUserFindUnique.mockResolvedValue(dbUser);

    const { getCachedUserWithRoles } = freshAuthModule();
    const result = await getCachedUserWithRoles("user-2");

    expect(result).toEqual(dbUser);
    expect(mockUserFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-2" } }),
    );
    expect(acMockRedis.setex).toHaveBeenCalledWith(
      "auth:user:user-2",
      86400,
      JSON.stringify(dbUser),
    );
  });

  it("falls through to DB when Redis unavailable (getRedis returns null)", async () => {
    acMockEnv.REDIS_URL = undefined;
    const dbUser = {
      id: "user-3",
      username: "charlie",
      roles: [],
    };
    mockUserFindUnique.mockResolvedValue(dbUser);

    const { getCachedUserWithRoles } = freshAuthModule();
    const result = await getCachedUserWithRoles("user-3");

    expect(result).toEqual(dbUser);
    expect(mockUserFindUnique).toHaveBeenCalled();
  });
});

describe("authCache — invalidateAuthCache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    acMockEnv.REDIS_URL = undefined;
  });

  it("deletes the Redis key for the given userId", async () => {
    acMockEnv.REDIS_URL = "redis://localhost:6379";
    acMockRedis.del.mockResolvedValue(1);

    const { invalidateAuthCache } = freshAuthModule();
    await invalidateAuthCache("user-99");

    expect(acMockRedis.del).toHaveBeenCalledWith("auth:user:user-99");
  });
});
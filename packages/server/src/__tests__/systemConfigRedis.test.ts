// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for the SystemConfig Redis cache layer (D-07).
// Covers SCALE-01: Redis-cached getSetting() and cache invalidation in
// updateSettings(). Cache key prefix: `config:`, TTL: 300s (5 minutes).
//
// Mock strategy:
// - redisService is mocked directly to control getRedis() return value.
// - prisma is mocked for systemConfig.findUnique / findMany / upsert.
// - licenseService is mocked for getLicenseInfo (Phase 145 replaced the
//   hardcoded isFeatureEnabled("white_label") check with the validator
//   loop + D-02 fallback).
// - logger is mocked to suppress log output.
// - @simmetric-chat/shared is real (via moduleNameMapper to dist) — uses real
//   configKeySchema, CONFIG_DEFAULTS, and SettingsEntry types.

// ─── Mocks ───────────────────────────────────────────────────────────────────

const scMockRedis = {
  on: jest.fn(),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
  setex: jest.fn().mockResolvedValue("OK"),
  del: jest.fn().mockResolvedValue(1),
  eval: jest.fn().mockResolvedValue(1),
  ping: jest.fn().mockResolvedValue("PONG"),
  disconnect: jest.fn(),
};

const scMockGetRedis = jest.fn();

jest.mock("../services/redisService", () => ({
  getRedis: scMockGetRedis,
  isRedisAvailable: jest.fn(() => scMockGetRedis() !== null),
}));

const scMockFindUnique = jest.fn();
const scMockFindMany = jest.fn();
const scMockUpsert = jest.fn();
const scMockRoleFindFirst = jest.fn();
const scMockUserRoleCount = jest.fn();

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    systemConfig: {
      findUnique: scMockFindUnique,
      findMany: scMockFindMany,
      upsert: scMockUpsert,
    },
    role: {
      findFirst: scMockRoleFindFirst,
    },
    userRole: {
      count: scMockUserRoleCount,
    },
  },
}));

jest.mock("../services/licenseService", () => ({
  getLicenseInfo: jest.fn(() => ({
    tier: "community",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// ─── Helper: fresh module require ─────────────────────────────────────────────

function freshSystemConfig() {
  jest.resetModules();
  return require("../services/systemConfigService");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("systemConfigRedis — getSetting cache layer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scMockRedis.get.mockResolvedValue(null);
    scMockRedis.setex.mockResolvedValue("OK");
    scMockRedis.del.mockResolvedValue(1);
    scMockGetRedis.mockReturnValue(scMockRedis);
    scMockFindUnique.mockResolvedValue(null);
    // Clear ENV overrides for the keys we test (LLM_PROVIDER, EMBEDDING_MODEL)
    delete process.env.LLM_PROVIDER;
    delete process.env.EMBEDDING_MODEL;
  });

  it("Test 1: getSetting checks Redis cache (config:{key}) before DB query", async () => {
    // Redis cache hit — return a cached value
    scMockRedis.get.mockResolvedValue(JSON.stringify("openai"));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting("LLM_PROVIDER");

    expect(result.value).toBe("openai");
    expect(result.readOnly).toBe(false);
    // Redis cache was checked
    expect(scMockRedis.get).toHaveBeenCalledWith("config:LLM_PROVIDER");
    // DB query was NOT called (cache hit)
    expect(scMockFindUnique).not.toHaveBeenCalled();
  });

  it("Test 2: getSetting writes result to Redis on DB query (cache miss fill)", async () => {
    // Redis cache miss
    scMockRedis.get.mockResolvedValue(null);
    // DB returns a value
    scMockFindUnique.mockResolvedValue({ key: "LLM_PROVIDER", value: "ollama" });

    const { getSetting } = freshSystemConfig();
    const result = await getSetting("LLM_PROVIDER");

    expect(result.value).toBe("ollama");
    // DB query was called (cache miss)
    expect(scMockFindUnique).toHaveBeenCalled();
    // Redis setex was called to fill the cache (TTL 300s)
    expect(scMockRedis.setex).toHaveBeenCalledWith(
      "config:LLM_PROVIDER",
      300,
      JSON.stringify("ollama"),
    );
  });

  it("Test 3: getSetting falls through to DB when Redis unavailable", async () => {
    // Redis unavailable
    scMockGetRedis.mockReturnValue(null);
    // DB returns a value
    scMockFindUnique.mockResolvedValue({ key: "LLM_PROVIDER", value: "anthropic" });

    const { getSetting } = freshSystemConfig();
    const result = await getSetting("LLM_PROVIDER");

    expect(result.value).toBe("anthropic");
    // DB query was called (Redis unavailable, fell through)
    expect(scMockFindUnique).toHaveBeenCalled();
    // Redis setex was NOT called (Redis unavailable)
    expect(scMockRedis.setex).not.toHaveBeenCalled();
  });

  it("Test 6: ALWAYS_READONLY keys are NOT cached in Redis (ENV-only)", async () => {
    // JWT_SECRET is an ALWAYS_READONLY key — set via setupEnv.ts
    // Redis is available but should NOT be consulted for readonly keys
    scMockRedis.get.mockResolvedValue(JSON.stringify("should-not-be-used"));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting("JWT_SECRET");

    // Value comes from ENV (setupEnv.ts sets it), not Redis
    expect(result.readOnly).toBe(true);
    // Redis get was NOT called (ALWAYS_READONLY skips Redis)
    expect(scMockRedis.get).not.toHaveBeenCalled();
    // Redis setex was NOT called (ALWAYS_READONLY not cached)
    expect(scMockRedis.setex).not.toHaveBeenCalled();
  });
});

describe("systemConfigRedis — updateSettings cache invalidation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scMockRedis.del.mockResolvedValue(1);
    scMockGetRedis.mockReturnValue(scMockRedis);
    // getAllSettings needs findMany to return empty (no existing DB configs)
    scMockFindMany.mockResolvedValue([]);
    scMockUpsert.mockResolvedValue({});
    delete process.env.LLM_PROVIDER;
  });

  it("Test 4: updateSettings invalidates Redis cache for changed keys (DEL config:{key})", async () => {
    const { updateSettings } = freshSystemConfig();
    await updateSettings([{ key: "LLM_PROVIDER", value: "openai" }]);

    // DB upsert was called (the write succeeded)
    expect(scMockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "LLM_PROVIDER" },
        create: { key: "LLM_PROVIDER", value: "openai" },
        update: { value: "openai" },
      }),
    );
    // Redis del was called to invalidate the cache for the changed key
    expect(scMockRedis.del).toHaveBeenCalledWith("config:LLM_PROVIDER");
  });

  it("Test 5: updateSettings invalidation is non-blocking (Redis error does not prevent DB write)", async () => {
    // Redis del throws an error
    scMockRedis.del.mockRejectedValue(new Error("Redis connection lost"));

    const { updateSettings } = freshSystemConfig();
    // Should NOT throw — the DB write should still succeed
    const result = await updateSettings([{ key: "LLM_PROVIDER", value: "openai" }]);

    // DB upsert was still called (Redis error didn't block it)
    expect(scMockUpsert).toHaveBeenCalled();
    // The update was reported as successful
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].key).toBe("LLM_PROVIDER");
  });
});

// Phase 152 gap G-152-1: ensureSetupWizardMode() must invalidate the Redis
// config:setup_wizard_mode key after the prisma.upsert writes the derived
// value. Without this DEL, getSetting()'s cache-first read serves a stale
// "completed" even after the DB row is re-derived to "active" on a fresh
// install (the G-152-1 bug). The invalidation mirrors updateSettings' pattern
// (lines 239-245) exactly: non-blocking on Redis error, skipped when Redis is
// null (single-instance mode), and NOT run on the idempotent early-return path
// (value unchanged → cache still valid).
describe("ensureSetupWizardMode cache invalidation (G-152-1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scMockRedis.del.mockResolvedValue(1);
    scMockGetRedis.mockReturnValue(scMockRedis);
    scMockUpsert.mockResolvedValue({});
    // ensureSetupWizardMode derives "active" when no admin exists (the write
    // path that must invalidate). role.findFirst returns an admin role,
    // userRole.count returns 0 (no admin user) → hasAdmin=false → derived="active".
    scMockRoleFindFirst.mockResolvedValue({ id: "role-admin" });
    scMockUserRoleCount.mockResolvedValue(0);
    // findUnique returns an empty/unset row so the idempotent early-return is
    // NOT taken (the function proceeds to derive + write + invalidate).
    scMockFindUnique.mockResolvedValue({ key: "setup_wizard_mode", value: "" });
  });

  it("invalidates Redis config:setup_wizard_mode after the prisma.upsert (write path)", async () => {
    const { ensureSetupWizardMode } = freshSystemConfig();
    await ensureSetupWizardMode();

    // The DB write happened (the derived value was upserted).
    expect(scMockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "setup_wizard_mode" },
        create: { key: "setup_wizard_mode", value: "active" },
        update: { value: "active" },
      }),
    );
    // Redis del was called to invalidate the stale cache (G-152-1 fix).
    expect(scMockRedis.del).toHaveBeenCalledWith("config:setup_wizard_mode");
  });

  it("does NOT invalidate Redis on the idempotent early-return path (value already set)", async () => {
    // A non-empty value is left untouched — the cache is still valid, no DEL.
    scMockFindUnique.mockResolvedValue({ key: "setup_wizard_mode", value: "completed" });

    const { ensureSetupWizardMode } = freshSystemConfig();
    await ensureSetupWizardMode();

    // No DB write (idempotent early return at lines 354-356).
    expect(scMockUpsert).not.toHaveBeenCalled();
    // No Redis invalidation (value unchanged → cache still correct).
    expect(scMockRedis.del).not.toHaveBeenCalled();
  });

  it("skips Redis invalidation when getRedis() returns null (single-instance mode)", async () => {
    // Redis unavailable — no cache to invalidate, no DEL needed.
    scMockGetRedis.mockReturnValue(null);

    const { ensureSetupWizardMode } = freshSystemConfig();
    // Must not throw (graceful degradation, mirrors updateSettings).
    await expect(ensureSetupWizardMode()).resolves.toBeUndefined();

    // DB write still happened (Redis absence does not block the derivation).
    expect(scMockUpsert).toHaveBeenCalled();
    // Redis del was NOT called (getRedis() returned null).
    expect(scMockRedis.del).not.toHaveBeenCalled();
  });

  it("is non-blocking when redis.del rejects (DB write already succeeded)", async () => {
    scMockRedis.del.mockRejectedValue(new Error("Redis connection lost"));

    const { ensureSetupWizardMode } = freshSystemConfig();
    // Must not throw — the DB upsert already wrote the value; invalidation is
    // best-effort (the same contract as updateSettings line 243-248).
    await expect(ensureSetupWizardMode()).resolves.toBeUndefined();

    // DB write happened before the Redis error.
    expect(scMockUpsert).toHaveBeenCalled();
    // The logger.warn was called (non-blocking error logged, not thrown).
    const { logger } = require("../utils/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      "[redis] config cache invalidation failed (non-blocking)",
      expect.objectContaining({ key: "setup_wizard_mode" }),
    );
  });
});

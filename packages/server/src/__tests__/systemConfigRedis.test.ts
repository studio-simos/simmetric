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
// - prisma is mocked for systemConfig.findFirst / findMany /
//   update / create / upsert. 183-01: the service's DB read (getDbValue) is
//   findFirst({ key, organizationId: null }) and its writes route through
//   upsertSystemConfigRow (find-first → id-anchored update-or-create), so the
//   probes assert that surface; findUnique/upsert stay mocked only because
//   Plan-02 external sites still pin them.
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
  // Phase 183 (SAAS-02, Plan 04): first set-command usage in the repo (D-01
  // membership set). srem is mocked for harness completeness — no delete-path
  // call site exists this phase (documented in the 183-04 summary).
  sadd: jest.fn().mockResolvedValue(1),
  srem: jest.fn().mockResolvedValue(1),
  smembers: jest.fn().mockResolvedValue([]),
  disconnect: jest.fn(),
};

const scMockGetRedis = jest.fn();

jest.mock("../services/redisService", () => ({
  getRedis: scMockGetRedis,
  isRedisAvailable: jest.fn(() => scMockGetRedis() !== null),
}));

const scMockFindUnique = jest.fn();
const scMockFindFirst = jest.fn();
const scMockFindMany = jest.fn();
const scMockUpdate = jest.fn();
const scMockCreate = jest.fn();
const scMockUpsert = jest.fn();
const scMockRoleFindFirst = jest.fn();
const scMockUserRoleCount = jest.fn();

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    systemConfig: {
      findUnique: scMockFindUnique,
      findFirst: scMockFindFirst,
      findMany: scMockFindMany,
      update: scMockUpdate,
      create: scMockCreate,
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
    // 183-01: getDbValue reads via findFirst({ key, organizationId: null })
    scMockFindFirst.mockResolvedValue(null);
    scMockUpdate.mockResolvedValue({});
    scMockCreate.mockResolvedValue({});
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
    expect(scMockFindFirst).not.toHaveBeenCalled();
  });

  it("Test 2: getSetting writes result to Redis on DB query (cache miss fill)", async () => {
    // Redis cache miss
    scMockRedis.get.mockResolvedValue(null);
    // DB returns a value (183-01: the read delegate is findFirst — the
    // getDbValue probe re-pointed from findUnique; payload identical)
    scMockFindFirst.mockResolvedValue({ key: "LLM_PROVIDER", value: "ollama" });

    const { getSetting } = freshSystemConfig();
    const result = await getSetting("LLM_PROVIDER");

    expect(result.value).toBe("ollama");
    // DB query was called (cache miss) — the find-first read with the
    // explicit null-org filter
    expect(scMockFindFirst).toHaveBeenCalledWith({
      where: { key: "LLM_PROVIDER", organizationId: null },
    });
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
    // DB returns a value (findFirst delegate, 183-01)
    scMockFindFirst.mockResolvedValue({ key: "LLM_PROVIDER", value: "anthropic" });

    const { getSetting } = freshSystemConfig();
    const result = await getSetting("LLM_PROVIDER");

    expect(result.value).toBe("anthropic");
    // DB query was called (Redis unavailable, fell through)
    expect(scMockFindFirst).toHaveBeenCalled();
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
    // 183-01: the write routes through upsertSystemConfigRow (find-first →
    // id-anchored update on the existing row)
    scMockFindFirst.mockResolvedValue({ id: "row-llm", key: "LLM_PROVIDER", value: "ollama" });
    scMockUpdate.mockResolvedValue({});
    scMockCreate.mockResolvedValue({});
    scMockUpsert.mockResolvedValue({});
    delete process.env.LLM_PROVIDER;
  });

  it("Test 4: updateSettings invalidates Redis cache for changed keys (DEL config:{key})", async () => {
    const { updateSettings } = freshSystemConfig();
    await updateSettings([{ key: "LLM_PROVIDER", value: "openai" }]);

    // The helper-mediated write happened: find-first on the global row, then
    // the id-anchored update (183-01 shape — the old keyed upsert is gone).
    expect(scMockFindFirst).toHaveBeenCalledWith({
      where: { key: "LLM_PROVIDER", organizationId: null },
    });
    expect(scMockUpdate).toHaveBeenCalledWith({
      where: { id: "row-llm" },
      data: { value: "openai" },
    });
    // Redis del was called to invalidate the cache for the changed key
    expect(scMockRedis.del).toHaveBeenCalledWith("config:LLM_PROVIDER");
  });

  it("Test 5: updateSettings invalidation is non-blocking (Redis error does not prevent DB write)", async () => {
    // Redis del throws an error
    scMockRedis.del.mockRejectedValue(new Error("Redis connection lost"));

    const { updateSettings } = freshSystemConfig();
    // Should NOT throw — the DB write should still succeed
    const result = await updateSettings([{ key: "LLM_PROVIDER", value: "openai" }]);

    // DB write was still made (Redis error didn't block it) — the helper's
    // update arm fired.
    expect(scMockUpdate).toHaveBeenCalled();
    // The update was reported as successful
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].key).toBe("LLM_PROVIDER");
  });
});

// ─── Phase 183 (SAAS-02, Plan 04): org-aware writes + membership-set ────────
//
// updateSettings routes each item's optional organizationId to a tenant-row
// write (helper) or a global-row write (pre-183 path). Invalidation derives
// from the WRITTEN ROW's org (D-02 — never request context):
//   - tenant write:  SADD config:tenants:{key} {orgId} + DEL config:{orgId}:{key} ONLY
//   - global write:  DEL config:{key} + SMEMBERS config:tenants:{key} + DEL per member
// All ops non-blocking try/catch-warn (SP-2); Redis absent → skip silently.

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

describe("systemConfigRedis — org-aware updateSettings + membership-set invalidation (SAAS-02)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scMockRedis.del.mockResolvedValue(1);
    scMockRedis.sadd.mockResolvedValue(1);
    scMockRedis.smembers.mockResolvedValue([]);
    scMockGetRedis.mockReturnValue(scMockRedis);
    scMockFindMany.mockResolvedValue([]);
    scMockFindFirst.mockResolvedValue({ id: "row-llm", key: "LLM_PROVIDER", value: "ollama" });
    scMockUpdate.mockResolvedValue({});
    scMockCreate.mockResolvedValue({});
    delete process.env.LLM_PROVIDER;
  });

  it("tenant write: SADD config:tenants:{key} + DEL config:{orgId}:{key} ONLY (legacy key NOT deleted)", async () => {
    const { updateSettings } = freshSystemConfig();
    const result = await updateSettings([
      { key: "LLM_PROVIDER", value: "tenant-value", organizationId: ORG_A },
    ]);

    expect(result.updated).toHaveLength(1);
    // Helper-mediated tenant-row write: find-first on the (org, key) pair.
    expect(scMockFindFirst).toHaveBeenCalledWith({
      where: { key: "LLM_PROVIDER", organizationId: ORG_A },
    });
    // D-01: SADD registers the org in the membership set...
    expect(scMockRedis.sadd).toHaveBeenCalledWith(`config:tenants:LLM_PROVIDER`, ORG_A);
    // ...and ONLY the namespaced key is invalidated (D-01).
    expect(scMockRedis.del).toHaveBeenCalledWith(`config:${ORG_A}:LLM_PROVIDER`);
    expect(scMockRedis.del).not.toHaveBeenCalledWith("config:LLM_PROVIDER");
  });

  it("global write fan-out: DEL legacy key + SMEMBERS + DEL per member (O(override-count), no SCAN)", async () => {
    scMockRedis.smembers.mockResolvedValue([ORG_A, ORG_B]);

    const { updateSettings } = freshSystemConfig();
    await updateSettings([{ key: "LLM_PROVIDER", value: "global-value" }]);

    // Helper-mediated global-row write (bare item, no organizationId).
    expect(scMockFindFirst).toHaveBeenCalledWith({
      where: { key: "LLM_PROVIDER", organizationId: null },
    });
    // D-09: the legacy key is invalidated...
    expect(scMockRedis.del).toHaveBeenCalledWith("config:LLM_PROVIDER");
    // ...the membership set is read...
    expect(scMockRedis.smembers).toHaveBeenCalledWith("config:tenants:LLM_PROVIDER");
    // ...and every overriding tenant's cache key is DELed (D-01/D-03).
    expect(scMockRedis.del).toHaveBeenCalledWith(`config:${ORG_A}:LLM_PROVIDER`);
    expect(scMockRedis.del).toHaveBeenCalledWith(`config:${ORG_B}:LLM_PROVIDER`);
    // No SADD on a global write.
    expect(scMockRedis.sadd).not.toHaveBeenCalled();
  });

  it("global write with NO overrides: legacy DEL only, SMEMBERS returns empty", async () => {
    scMockRedis.smembers.mockResolvedValue([]);

    const { updateSettings } = freshSystemConfig();
    await updateSettings([{ key: "LLM_PROVIDER", value: "global-value" }]);

    expect(scMockRedis.del).toHaveBeenCalledWith("config:LLM_PROVIDER");
    expect(scMockRedis.smembers).toHaveBeenCalledWith("config:tenants:LLM_PROVIDER");
    // No tenant keys exist → no namespaced DELs.
    expect(scMockRedis.del).toHaveBeenCalledTimes(1);
  });

  it("cross-tenant cache isolation: org-a and org-b org-scoped getSetting hit DIFFERENT cache keys", async () => {
    scMockRedis.get.mockResolvedValue(null);
    // Tenant row exists for org-a only.
    scMockFindFirst.mockImplementation(async (args: { where: { key: string; organizationId: string | null } }) => {
      if (args.where.organizationId === ORG_A) {
        return { key: "LLM_PROVIDER", value: "org-a-value" };
      }
      return null;
    });

    const { getSetting } = freshSystemConfig();
    await getSetting("LLM_PROVIDER", ORG_A);
    await getSetting("LLM_PROVIDER", ORG_B);

    // SC-3: each org's resolution consults its OWN namespaced key.
    expect(scMockRedis.get).toHaveBeenCalledWith(`config:${ORG_A}:LLM_PROVIDER`);
    expect(scMockRedis.get).toHaveBeenCalledWith(`config:${ORG_B}:LLM_PROVIDER`);
  });

  it("degradation: getRedis() → null on the tenant write path — no throw, DB write observable", async () => {
    scMockGetRedis.mockReturnValue(null);

    const { updateSettings } = freshSystemConfig();
    const result = await updateSettings([
      { key: "LLM_PROVIDER", value: "tenant-value", organizationId: ORG_A },
    ]);

    // Must not throw; the write is reported as successful.
    expect(result.updated).toHaveLength(1);
    // DB write observable on the prisma mock (helper's update arm fired).
    expect(scMockFindFirst).toHaveBeenCalledWith({
      where: { key: "LLM_PROVIDER", organizationId: ORG_A },
    });
    expect(scMockUpdate).toHaveBeenCalledWith({
      where: { id: "row-llm" },
      data: { value: "tenant-value" },
    });
    // No Redis ops attempted.
    expect(scMockRedis.sadd).not.toHaveBeenCalled();
    expect(scMockRedis.del).not.toHaveBeenCalled();
  });

  it("degradation: getRedis() → null on the global write path — legacy DEL skipped, DB write observable", async () => {
    scMockGetRedis.mockReturnValue(null);

    const { updateSettings } = freshSystemConfig();
    const result = await updateSettings([{ key: "LLM_PROVIDER", value: "global-value" }]);

    expect(result.updated).toHaveLength(1);
    expect(scMockUpdate).toHaveBeenCalled();
    expect(scMockRedis.del).not.toHaveBeenCalled();
    expect(scMockRedis.smembers).not.toHaveBeenCalled();
  });

  it("Redis error mid-SMEMBERS: warn logged, no throw (DB write already succeeded)", async () => {
    scMockRedis.smembers.mockRejectedValue(new Error("Redis connection lost"));

    const { updateSettings } = freshSystemConfig();
    const result = await updateSettings([{ key: "LLM_PROVIDER", value: "global-value" }]);

    // No throw; the DB write persisted and the item is reported updated.
    expect(result.updated).toHaveLength(1);
    expect(scMockUpdate).toHaveBeenCalled();
    // The canonical SP-2 warn string.
    const { logger } = require("../utils/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      "[redis] config cache invalidation failed (non-blocking)",
      expect.objectContaining({ key: "LLM_PROVIDER" }),
    );
  });

  it("Redis error mid-SADD on a tenant write: warn logged, no throw", async () => {
    scMockRedis.sadd.mockRejectedValue(new Error("Redis connection lost"));

    const { updateSettings } = freshSystemConfig();
    const result = await updateSettings([
      { key: "LLM_PROVIDER", value: "tenant-value", organizationId: ORG_A },
    ]);

    expect(result.updated).toHaveLength(1);
    expect(scMockUpdate).toHaveBeenCalled();
    const { logger } = require("../utils/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      "[redis] config cache invalidation failed (non-blocking)",
      expect.objectContaining({ key: "LLM_PROVIDER" }),
    );
  });

  it("org-scoped ALWAYS_READONLY write rejected by the existing readOnlyKeys branch (D-11)", async () => {
    const { updateSettings } = freshSystemConfig();
    const result = await updateSettings([
      { key: "JWT_SECRET", value: "tenant-override-attempt", organizationId: ORG_A },
    ]);

    // Rejected via the readOnlyKeys reject (by KEY — covers org items, P6).
    expect(result.rejected).toContain("JWT_SECRET");
    expect(result.updated).toHaveLength(0);
    // No write of any tier, no Redis bookkeeping.
    expect(scMockUpdate).not.toHaveBeenCalled();
    expect(scMockCreate).not.toHaveBeenCalled();
    expect(scMockRedis.sadd).not.toHaveBeenCalled();
    expect(scMockRedis.del).not.toHaveBeenCalled();
  });
});

// Phase 152 gap G-152-1: ensureSetupWizardMode() must invalidate the Redis
// config:setup_wizard_mode key after the write persists the derived value.
// Without this DEL, getSetting()'s cache-first read serves a stale
// "completed" even after the DB row is re-derived to "active" on a fresh
// install (the G-152-1 bug). The invalidation mirrors updateSettings' pattern
// exactly: non-blocking on Redis error, skipped when Redis is
// null (single-instance mode), and NOT run on the idempotent early-return path
// (value unchanged → cache still valid). 183-01: the write routes through
// upsertSystemConfigRow (find-first → id-anchored update) and the read is a
// null-org findFirst.
describe("ensureSetupWizardMode cache invalidation (G-152-1)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scMockRedis.del.mockResolvedValue(1);
    scMockGetRedis.mockReturnValue(scMockRedis);
    scMockUpdate.mockResolvedValue({});
    scMockCreate.mockResolvedValue({});
    // ensureSetupWizardMode derives "active" when no admin exists (the write
    // path that must invalidate). role.findFirst returns an admin role,
    // userRole.count returns 0 (no admin user) → hasAdmin=false → derived="active".
    scMockRoleFindFirst.mockResolvedValue({ id: "role-admin" });
    scMockUserRoleCount.mockResolvedValue(0);
    // findFirst returns an empty/unset row so the idempotent early-return is
    // NOT taken (the function proceeds to derive + write + invalidate).
    scMockFindFirst.mockResolvedValue({ id: "row-wizard", key: "setup_wizard_mode", value: "" });
  });

  it("invalidates Redis config:setup_wizard_mode after the helper-mediated write (write path)", async () => {
    const { ensureSetupWizardMode } = freshSystemConfig();
    await ensureSetupWizardMode();

    // The DB write happened via the helper: find-first on the global row,
    // then the id-anchored update (183-01 shape).
    expect(scMockFindFirst).toHaveBeenCalledWith({
      where: { key: "setup_wizard_mode", organizationId: null },
    });
    expect(scMockUpdate).toHaveBeenCalledWith({
      where: { id: "row-wizard" },
      data: { value: "active" },
    });
    // Redis del was called to invalidate the stale cache (G-152-1 fix).
    expect(scMockRedis.del).toHaveBeenCalledWith("config:setup_wizard_mode");
  });

  it("does NOT invalidate Redis on the idempotent early-return path (value already set)", async () => {
    // A non-empty value is left untouched — the cache is still valid, no DEL.
    scMockFindFirst.mockResolvedValue({ id: "row-wizard", key: "setup_wizard_mode", value: "completed" });

    const { ensureSetupWizardMode } = freshSystemConfig();
    await ensureSetupWizardMode();

    // No DB write (idempotent early return).
    expect(scMockUpdate).not.toHaveBeenCalled();
    expect(scMockCreate).not.toHaveBeenCalled();
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
    expect(scMockUpdate).toHaveBeenCalled();
    // Redis del was NOT called (getRedis() returned null).
    expect(scMockRedis.del).not.toHaveBeenCalled();
  });

  it("is non-blocking when redis.del rejects (DB write already succeeded)", async () => {
    scMockRedis.del.mockRejectedValue(new Error("Redis connection lost"));

    const { ensureSetupWizardMode } = freshSystemConfig();
    // Must not throw — the DB write already persisted the value; invalidation
    // is best-effort (the same contract as updateSettings).
    await expect(ensureSetupWizardMode()).resolves.toBeUndefined();

    // DB write happened before the Redis error.
    expect(scMockUpdate).toHaveBeenCalled();
    // The logger.warn was called (non-blocking error logged, not thrown).
    const { logger } = require("../utils/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      "[redis] config cache invalidation failed (non-blocking)",
      expect.objectContaining({ key: "setup_wizard_mode" }),
    );
  });
});

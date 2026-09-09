// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 176 (D-04/D-05/D-08): 8-case precedence matrix + Redis cache-hit case.
 *
 * Matrix: {readonly, non-readonly} × {ENV present, ENV absent} × {DB present, DB absent}
 *   1. readonly     + ENV present + DB row     → env value,  readOnly:true   (DB never consulted)
 *   2. readonly     + ENV present + no DB row  → env value,  readOnly:true
 *   3. readonly     + no ENV     + DB row     → CONFIG_DEFAULTS ?? "" (DB ignored!), readOnly:true
 *   4. readonly     + no ENV     + no DB row  → CONFIG_DEFAULTS ?? "", readOnly:true
 *   5. non-readonly + ENV present + DB row     → DB value,   readOnly:false, envOverridden:true
 *   6. non-readonly + ENV present + no DB row  → env value,  readOnly:false, envOverridden:true
 *   7. non-readonly + no ENV     + DB row     → DB value,   readOnly:false, no flag
 *   8. non-readonly + no ENV     + no DB row  → CONFIG_DEFAULTS, readOnly:false, no flag
 *
 * Case 3 pins the SHARPEST fact: ALWAYS_READONLY NEVER reads the DB row even
 * when a row exists. Case 9 (D-05) pins the Redis cache-hit path for the
 * non-readonly branch. "ENV absent" is modeled EXCLUSIVELY via
 * `delete process.env[KEY]` — never empty string, never undefined
 * (process.env stringifies undefined to "undefined").
 *
 * Mock scaffolding cloned from systemConfigRedis.test.ts (same jest.mock
 * declarations + freshSystemConfig() with jest.resetModules()).
 */

// setupEnv loads .env.test (COLLECTOR_SECRET etc.) — importing it FIRST also
// makes this file a TS module, so its top-level mock names never collide with
// the global-script declarations in systemConfigRedis.test.ts.
import "./helpers/setupEnv";

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
  // Fix Round 1 (WR-01): the org-scoped global-tier cache fill SADDs the org
  // into the membership set (config:tenants:{key}) — mock added for the
  // fan-out-visibility probe.
  sadd: jest.fn().mockResolvedValue(1),
};

const scMockGetRedis = jest.fn();

jest.mock("../services/redisService", () => ({
  getRedis: scMockGetRedis,
  isRedisAvailable: jest.fn(() => scMockGetRedis() !== null),
}));

const scMockFindUnique = jest.fn();
const scMockFindFirst = jest.fn();
const scMockFindMany = jest.fn();
const scMockUpsert = jest.fn();

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    systemConfig: {
      findUnique: scMockFindUnique,
      findFirst: scMockFindFirst,
      findMany: scMockFindMany,
      upsert: scMockUpsert,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshSystemConfig() {
  jest.resetModules();
  return require("../services/systemConfigService");
}

function findEntry(
  settings: Array<{ key: string; value?: string; readOnly?: boolean; envOverridden?: boolean }>,
  key: string,
) {
  const entry = settings.find((s) => s.key === key);
  expect(entry).toBeDefined();
  return entry!;
}

// ─── ENV hygiene (ollamaKeepAliveEnv.test.ts doctrine) ──────────────────────

const JWT_KEY = "JWT_SECRET";
const LLM_KEY = "LLM_PROVIDER";
const ORIGINAL_JWT = process.env[JWT_KEY];
const ORIGINAL_LLM = process.env[LLM_KEY];

afterEach(() => {
  if (ORIGINAL_JWT === undefined) {
    delete process.env[JWT_KEY];
  } else {
    process.env[JWT_KEY] = ORIGINAL_JWT;
  }
  if (ORIGINAL_LLM === undefined) {
    delete process.env[LLM_KEY];
  } else {
    process.env[LLM_KEY] = ORIGINAL_LLM;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  scMockRedis.get.mockResolvedValue(null);
  scMockGetRedis.mockReturnValue(scMockRedis);
  scMockFindUnique.mockResolvedValue(null);
  // 183-01: getDbValue migrates to findFirst({ key, organizationId: null }) —
  // the harness mock surface gains the delegate (row fixtures unchanged).
  scMockFindFirst.mockResolvedValue(null);
  scMockFindMany.mockResolvedValue([]);
  scMockUpsert.mockResolvedValue({});
  // Default state for both tested keys: ENV absent (strict delete, never "")
  delete process.env[JWT_KEY];
  delete process.env[LLM_KEY];
});

// ─── The 8-case precedence matrix (D-04 LOCKED behavior) ────────────────────

describe("systemConfig.precedence — 8-case matrix (D-04/D-05)", () => {
  it("Case 1: readonly + ENV present + DB row → env value, readOnly:true, DB never consulted", async () => {
    // DB row exists with a DIFFERENT value — it must be ignored for readonly keys
    scMockFindMany.mockResolvedValue([
      { key: JWT_KEY, value: "db-value-should-be-ignored" },
    ]);
    process.env[JWT_KEY] = "env-secret-value";

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), JWT_KEY);

    expect(entry.value).toBe("env-secret-value");
    expect(entry.readOnly).toBe(true);
    expect(entry.envOverridden).toBeUndefined(); // ALWAYS_READONLY never carries the flag
    expect(Object.keys(entry).sort()).toEqual(["key", "readOnly", "value"]); // payload shape pin
  });

  it("Case 2: readonly + ENV present + no DB row → env value, readOnly:true", async () => {
    scMockFindMany.mockResolvedValue([]);
    process.env[JWT_KEY] = "env-secret-value";

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), JWT_KEY);

    expect(entry.value).toBe("env-secret-value");
    expect(entry.readOnly).toBe(true);
    expect(entry.envOverridden).toBeUndefined();
  });

  it("Case 3: readonly + no ENV + DB row → CONFIG_DEFAULTS ?? '' (DB value IGNORED — sharpest fact)", async () => {
    scMockFindMany.mockResolvedValue([
      { key: JWT_KEY, value: "db-value-should-be-ignored" },
    ]);
    delete process.env[JWT_KEY];

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), JWT_KEY);

    // JWT_SECRET is NOT in CONFIG_DEFAULTS → the ?? "" fallback fires.
    // The DB row's value never leaks through the readonly branch.
    const { CONFIG_DEFAULTS } = require("@simmetric-chat/shared");
    expect(entry.value).toBe(CONFIG_DEFAULTS[JWT_KEY] ?? "");
    expect(entry.value).toBe("");
    expect(entry.readOnly).toBe(true);
  });

  it("Case 4: readonly + no ENV + no DB row → CONFIG_DEFAULTS fallback, readOnly:true", async () => {
    scMockFindMany.mockResolvedValue([]);
    delete process.env[JWT_KEY];

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), JWT_KEY);

    expect(entry.value).toBe("");
    expect(entry.readOnly).toBe(true);
  });

  it("Case 5: non-readonly + ENV present + DB row → DB value wins, envOverridden:true", async () => {
    scMockFindMany.mockResolvedValue([
      { key: LLM_KEY, value: "db-provider-wins" },
    ]);
    process.env[LLM_KEY] = "env-loses";

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), LLM_KEY);

    expect(entry.value).toBe("db-provider-wins"); // D-04: DB > ENV
    expect(entry.readOnly).toBe(false);
    expect(entry.envOverridden).toBe(true); // flag present: ineffective env var exists
    expect(Object.keys(entry).sort()).toEqual([
      "envOverridden",
      "key",
      "readOnly",
      "value",
    ]); // payload shape pin (flag rides only when set)
  });

  it("Case 6: non-readonly + ENV present + no DB row → env value acts as default, envOverridden:true", async () => {
    scMockFindMany.mockResolvedValue([]);
    process.env[LLM_KEY] = "env-acts-as-default";

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), LLM_KEY);

    expect(entry.value).toBe("env-acts-as-default");
    expect(entry.readOnly).toBe(false);
    expect(entry.envOverridden).toBe(true);
  });

  it("Case 7: non-readonly + no ENV + DB row → DB value, flag omitted (toBeUndefined)", async () => {
    scMockFindMany.mockResolvedValue([{ key: LLM_KEY, value: "db-only" }]);
    delete process.env[LLM_KEY];

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), LLM_KEY);

    expect(entry.value).toBe("db-only");
    expect(entry.readOnly).toBe(false);
    expect(entry.envOverridden).toBeUndefined(); // optional flag omitted, not false — payload shape pin
    expect(Object.keys(entry).sort()).toEqual(["key", "readOnly", "value"]);
  });

  it("Case 8: non-readonly + no ENV + no DB row → CONFIG_DEFAULTS value, flag omitted", async () => {
    scMockFindMany.mockResolvedValue([]);
    delete process.env[LLM_KEY];

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), LLM_KEY);

    const { CONFIG_DEFAULTS } = require("@simmetric-chat/shared");
    expect(entry.value).toBe(CONFIG_DEFAULTS[LLM_KEY]);
    expect(entry.readOnly).toBe(false);
    expect(entry.envOverridden).toBeUndefined();
  });
});

// ─── CF-02 idempotency probes ────────────────────────────────────────────────

describe("systemConfig.precedence — getAllSettings idempotency (CF-02)", () => {
  it("two calls with unchanged mocks return deep-equal arrays (pure function of rows+env)", async () => {
    scMockFindMany.mockResolvedValue([{ key: LLM_KEY, value: "db-provider" }]);
    process.env[LLM_KEY] = "env-provider";

    const { getAllSettings } = freshSystemConfig();
    const first = await getAllSettings();
    const second = await getAllSettings();
    expect(second).toEqual(first);
  });
});

// ─── D-05 Redis interplay + Pitfall 5 boundary ──────────────────────────────

describe("systemConfig.precedence — getSetting Redis cache-hit (D-05 case 9)", () => {
  it("non-readonly + Redis hit → cached payload, DB untouched, NO envOverridden flag (Pitfall 5)", async () => {
    scMockRedis.get.mockResolvedValue(JSON.stringify("openai"));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY);

    expect(result).toEqual({ key: LLM_KEY, value: "openai", readOnly: false });
    // 183-01: the DB read is the findFirst delegate now — assert the cache hit
    // never reaches the DB (both the legacy findUnique arm and the migrated
    // findFirst read).
    expect(scMockFindFirst).not.toHaveBeenCalled();
    expect(scMockFindUnique).not.toHaveBeenCalled();
    // Pitfall 5: the flag is scoped to getAllSettings (settings-UI GET path);
    // the cache-first single-key path intentionally never carries it.
    expect((result as { envOverridden?: boolean }).envOverridden).toBeUndefined();
  });

  it("two getSetting calls with unchanged mocks return equal payloads (CF-02 idempotency)", async () => {
    scMockRedis.get.mockResolvedValue(JSON.stringify("openai"));

    const { getSetting } = freshSystemConfig();
    const first = await getSetting(LLM_KEY);
    const second = await getSetting(LLM_KEY);
    expect(second).toEqual(first);
  });
});

// ─── Pitfall 4: empty-string env behaves as ENV-absent ──────────────────────

describe("systemConfig.precedence — empty-string env (Pitfall 4)", () => {
  it('process.env.LLM_PROVIDER = "" behaves as ENV-absent AND does not crash', async () => {
    scMockFindMany.mockResolvedValue([{ key: LLM_KEY, value: "db-wins-over-empty" }]);
    // Test-only setup of the empty-string edge (production :82 semantics pinned, not changed)
    process.env[LLM_KEY] = "";

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), LLM_KEY);

    expect(entry.value).toBe("db-wins-over-empty"); // DB > empty-env (hasEnvOverride false)
    expect(entry.readOnly).toBe(false);
    expect(entry.envOverridden).toBeUndefined(); // empty env value is NOT an override
  });

  it('process.env.LLM_PROVIDER = "" with no DB row → CONFIG_DEFAULTS', async () => {
    scMockFindMany.mockResolvedValue([]);
    process.env[LLM_KEY] = "";

    const { getAllSettings } = freshSystemConfig();
    const entry = findEntry(await getAllSettings(), LLM_KEY);

    const { CONFIG_DEFAULTS } = require("@simmetric-chat/shared");
    expect(entry.value).toBe(CONFIG_DEFAULTS[LLM_KEY]);
    expect(entry.envOverridden).toBeUndefined();
  });
});

// ─── Phase 183 (SAAS-02, Plan 04): org-scoped cascade matrix ────────────────
//
// getSetting(key, organizationId?) resolves tenant row → global row → ENV →
// CONFIG_DEFAULTS (D-06), caching under config:{orgId}:{key} (D-09) and
// emitting `source` ONLY on the org-scoped path (P2 — the 8-case global
// matrix above stays untouched-green). The P5 probe pins that the
// ALWAYS_READONLY short-circuit runs FIRST even when organizationId is
// passed: an org-scoped JWT_SECRET read never touches Redis or any DB row
// (D-11/SC-2).

const ORG_A = "org-a-uuid";
const ORG_B = "org-b-uuid";

/**
 * Org-aware findFirst wiring: the service's cascade issues TWO distinct
 * findFirst shapes — the tenant read `{ key, organizationId: <org> }` and the
 * global read `{ key, organizationId: null }`. This helper routes fixtures by
 * the where-clause so each probe can pin the tier it exercises.
 */
function wireOrgAwareFindFirst(opts: {
  tenantRow?: { key: string; value: string } | null;
  globalRow?: { key: string; value: string } | null;
  orgId?: string;
}) {
  const { tenantRow = null, globalRow = null, orgId = ORG_A } = opts;
  scMockFindFirst.mockImplementation(async (args: { where: { key: string; organizationId: string | null } }) => {
    if (args.where.organizationId === orgId && tenantRow && args.where.key === tenantRow.key) {
      return tenantRow;
    }
    if (args.where.organizationId === null && globalRow && args.where.key === globalRow.key) {
      return globalRow;
    }
    return null;
  });
}

describe("systemConfig.precedence — org-scoped cascade matrix (SAAS-02 SC-1)", () => {
  it("tenant hit → tenant value, source:'tenant', cached under config:{orgId}:{key} only", async () => {
    // BOTH tiers have rows — the tenant row must win (cascade ordering).
    wireOrgAwareFindFirst({
      tenantRow: { key: LLM_KEY, value: "tenant-wins" },
      globalRow: { key: LLM_KEY, value: "global-loses" },
    });
    process.env[LLM_KEY] = "env-loses-too";

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    expect(result).toEqual({ key: LLM_KEY, value: "tenant-wins", readOnly: false, source: "tenant" });
    // D-09: the org-scoped read consults the NAMESPACED cache key...
    expect(scMockRedis.get).toHaveBeenCalledWith(`config:${ORG_A}:${LLM_KEY}`);
    // ...and cache-fills ONLY the tenant tier's namespaced key. Fix Round 1
    // (WR-01): the payload is the tier-carrying envelope { v, s }.
    expect(scMockRedis.setex).toHaveBeenCalledWith(
      `config:${ORG_A}:${LLM_KEY}`,
      300,
      JSON.stringify({ v: "tenant-wins", s: "tenant" }),
    );
    // No SADD on the tenant-tier fill: the tenant-write fan-out DELs this
    // org's key directly (set membership would be redundant here).
    expect(scMockRedis.sadd).not.toHaveBeenCalled();
    // Org-scoped entry shape: source rides the payload (P2 org-scoped-only emission).
    expect(Object.keys(result).sort()).toEqual(["key", "readOnly", "source", "value"]);
  });

  it("org-scoped cache hit → cached value with source:'tenant' (namespaced key)", async () => {
    scMockRedis.get.mockResolvedValue(JSON.stringify("cached-tenant-value"));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    expect(result).toEqual({ key: LLM_KEY, value: "cached-tenant-value", readOnly: false, source: "tenant" });
    // Cache hit → no DB round-trip at either tier.
    expect(scMockFindFirst).not.toHaveBeenCalled();
  });

  it("tenant miss → global row fallback, source:'global'", async () => {
    wireOrgAwareFindFirst({
      tenantRow: null,
      globalRow: { key: LLM_KEY, value: "global-fallback" },
    });
    process.env[LLM_KEY] = "env-loses-to-global-row";

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    expect(result).toEqual({ key: LLM_KEY, value: "global-fallback", readOnly: false, source: "global" });
    // The tenant tier was consulted FIRST (cascade ordering proof).
    expect(scMockFindFirst).toHaveBeenCalledWith({ where: { key: LLM_KEY, organizationId: ORG_A } });
    // The resolved level is the global row → cached under the ORG's namespaced
    // key. Fix Round 1 (WR-01): tier-carrying envelope + SADD into the
    // membership set so the global-write fan-out can invalidate this org's
    // cache (pre-fix these fills were invisible to fan-out → stale ≤ TTL).
    expect(scMockRedis.setex).toHaveBeenCalledWith(
      `config:${ORG_A}:${LLM_KEY}`,
      300,
      JSON.stringify({ v: "global-fallback", s: "global" }),
    );
    expect(scMockRedis.sadd).toHaveBeenCalledWith(`config:tenants:${LLM_KEY}`, ORG_A);
  });

  it("tenant + global miss → ENV override wins, source:'env'", async () => {
    wireOrgAwareFindFirst({ tenantRow: null, globalRow: null });
    process.env[LLM_KEY] = "env-override-value";

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    expect(result).toEqual({ key: LLM_KEY, value: "env-override-value", readOnly: false, source: "env" });
    // ENV tier is never cached (only DB-resolved tiers fill the cache).
    expect(scMockRedis.setex).not.toHaveBeenCalled();
  });

  it("tenant + global miss + no ENV → CONFIG_DEFAULTS, source:'default'", async () => {
    wireOrgAwareFindFirst({ tenantRow: null, globalRow: null });
    delete process.env[LLM_KEY];

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    const { CONFIG_DEFAULTS } = require("@simmetric-chat/shared");
    expect(result).toEqual({
      key: LLM_KEY,
      value: CONFIG_DEFAULTS[LLM_KEY],
      readOnly: false,
      source: "default",
    });
    expect(scMockRedis.setex).not.toHaveBeenCalled();
  });

  it("cross-org isolation: org-a override does not bleed into org-b (org-b reads global)", async () => {
    wireOrgAwareFindFirst({
      tenantRow: { key: LLM_KEY, value: "org-a-override" },
      globalRow: { key: LLM_KEY, value: "global-shared" },
    });
    delete process.env[LLM_KEY];

    const { getSetting } = freshSystemConfig();
    const orgA = await getSetting(LLM_KEY, ORG_A);
    const orgB = await getSetting(LLM_KEY, ORG_B);

    // org-a: tenant override. org-b: NO tenant row → global fallback.
    expect(orgA).toEqual({ key: LLM_KEY, value: "org-a-override", readOnly: false, source: "tenant" });
    expect(orgB).toEqual({ key: LLM_KEY, value: "global-shared", readOnly: false, source: "global" });
    // Cache isolation (SC-3): each org's resolution lives under its own key.
    expect(scMockRedis.get).toHaveBeenCalledWith(`config:${ORG_A}:${LLM_KEY}`);
    expect(scMockRedis.get).toHaveBeenCalledWith(`config:${ORG_B}:${LLM_KEY}`);
  });

  it("global path (no organizationId) NEVER carries source — legacy shape byte-identical (P2)", async () => {
    // The exact legacy scenario: Redis hit on config:{key} → no source field.
    scMockRedis.get.mockResolvedValue(JSON.stringify("openai"));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY);

    expect(result).toEqual({ key: LLM_KEY, value: "openai", readOnly: false });
    expect((result as { source?: string }).source).toBeUndefined();
  });

  // ── Fix Round 1 (WR-01, 183-REVIEW): truthful cache-hit tier + fan-out ──
  //
  // Pre-fix: org-scoped fills cached the bare value and cache hits hardcoded
  // source:"tenant" — a global-tier fallback came back MISLABELED "tenant"
  // on the hit path, and the org was never SADDed into config:tenants:{key},
  // so a global write could not invalidate the org's cache (stale ≤ TTL).

  it("WR-01: envelope cache hit carries the CACHED tier — global fill hits as source:'global'", async () => {
    // A global-tier fallback cached the envelope { v, s: "global" } under the
    // org's namespaced key; the subsequent hit must report source:"global"
    // (pre-fix hardcode: "tenant") without touching the DB.
    scMockRedis.get.mockResolvedValue(JSON.stringify({ v: "cached-global-value", s: "global" }));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    expect(result).toEqual({
      key: LLM_KEY,
      value: "cached-global-value",
      readOnly: false,
      source: "global",
    });
    expect(scMockFindFirst).not.toHaveBeenCalled();
  });

  it("WR-01: envelope cache hit keeps source:'tenant' for a tenant-tier fill (regression pin)", async () => {
    scMockRedis.get.mockResolvedValue(JSON.stringify({ v: "cached-tenant-value", s: "tenant" }));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    expect(result).toEqual({
      key: LLM_KEY,
      value: "cached-tenant-value",
      readOnly: false,
      source: "tenant",
    });
    expect(scMockFindFirst).not.toHaveBeenCalled();
  });

  it("WR-01: legacy bare-string cache payload falls back to source:'tenant' (rolling-deploy compat)", async () => {
    // A pre-183 / in-flight-deploy payload is the bare JSON string: decode
    // value-only, label tenant (the only tier the legacy format ever
    // carried under the namespaced key).
    scMockRedis.get.mockResolvedValue(JSON.stringify("legacy-bare-value"));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    expect(result).toEqual({
      key: LLM_KEY,
      value: "legacy-bare-value",
      readOnly: false,
      source: "tenant",
    });
    expect(scMockFindFirst).not.toHaveBeenCalled();
  });

  it("WR-01: global-tier fill SADDs the org into the membership set — visible to global-write fan-out", async () => {
    wireOrgAwareFindFirst({
      tenantRow: null,
      globalRow: { key: LLM_KEY, value: "global-fanout-visible" },
    });
    scMockRedis.get.mockResolvedValue(null);
    scMockRedis.setex.mockResolvedValue("OK");
    scMockRedis.sadd.mockClear();

    const { getSetting } = freshSystemConfig();
    await getSetting(LLM_KEY, ORG_A);

    // The fill SADDed the org into config:tenants:{key} — a later global
    // updateSettings write SMEMBERS this set and DELs config:{ORG_A}:{key}
    // (D-01/D-03 fan-out completeness).
    expect(scMockRedis.sadd).toHaveBeenCalledWith(`config:tenants:${LLM_KEY}`, ORG_A);
  });

  it("WR-01: SADD failure on the global-tier fill is non-blocking (read still returns the global value)", async () => {
    wireOrgAwareFindFirst({
      tenantRow: null,
      globalRow: { key: LLM_KEY, value: "global-value-sadd-fails" },
    });
    scMockRedis.get.mockResolvedValue(null);
    scMockRedis.sadd.mockRejectedValue(new Error("Redis connection lost"));

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(LLM_KEY, ORG_A);

    // The read must NOT throw: setex succeeded (cache filled), SADD failed —
    // staleness degrades to the bounded TTL, per the SP-2 contract.
    expect(result).toEqual({
      key: LLM_KEY,
      value: "global-value-sadd-fails",
      readOnly: false,
      source: "global",
    });
    const { logger } = require("../utils/logger");
    expect(logger.warn).toHaveBeenCalledWith(
      "[redis] config cache write failed (non-blocking)",
      expect.objectContaining({ key: LLM_KEY }),
    );
  });
});

describe("systemConfig.precedence — ALWAYS_READONLY org-scoped short-circuit (SAAS-02 SC-2 / P5)", () => {
  it("org-scoped JWT_SECRET read → ENV value with source:'env', NO redis call, NO prisma findFirst (D-11)", async () => {
    process.env[JWT_KEY] = "env-secret-value";
    // Redis holds a decoy payload and the DB holds a decoy row — NEITHER may
    // be consulted: the readonly short-circuit runs BEFORE org resolution.
    scMockRedis.get.mockResolvedValue(JSON.stringify("should-not-be-used"));
    scMockFindFirst.mockResolvedValue({ key: JWT_KEY, value: "db-value-should-be-ignored" });

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(JWT_KEY, ORG_A);

    expect(result).toEqual({ key: JWT_KEY, value: "env-secret-value", readOnly: true, source: "env" });
    // Redis was NEVER touched (Test-6 shape, org-scoped).
    expect(scMockRedis.get).not.toHaveBeenCalled();
    expect(scMockRedis.setex).not.toHaveBeenCalled();
    // No DB row was read at EITHER tier (no tenant read, no null-org read).
    expect(scMockFindFirst).not.toHaveBeenCalled();
    expect(scMockFindUnique).not.toHaveBeenCalled();
  });

  it("org-scoped JWT_SECRET read with no ENV → CONFIG_DEFAULTS fallback, source:'default'", async () => {
    delete process.env[JWT_KEY];
    scMockRedis.get.mockResolvedValue(JSON.stringify("should-not-be-used"));
    scMockFindFirst.mockResolvedValue({ key: JWT_KEY, value: "db-value-should-be-ignored" });

    const { getSetting } = freshSystemConfig();
    const result = await getSetting(JWT_KEY, ORG_A);

    const { CONFIG_DEFAULTS } = require("@simmetric-chat/shared");
    expect(result).toEqual({
      key: JWT_KEY,
      value: CONFIG_DEFAULTS[JWT_KEY] ?? "",
      readOnly: true,
      source: "default",
    });
    expect(scMockRedis.get).not.toHaveBeenCalled();
    expect(scMockFindFirst).not.toHaveBeenCalled();
  });
});
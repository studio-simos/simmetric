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
};

const scMockGetRedis = jest.fn();

jest.mock("../services/redisService", () => ({
  getRedis: scMockGetRedis,
  isRedisAvailable: jest.fn(() => scMockGetRedis() !== null),
}));

const scMockFindUnique = jest.fn();
const scMockFindMany = jest.fn();
const scMockUpsert = jest.fn();

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    systemConfig: {
      findUnique: scMockFindUnique,
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
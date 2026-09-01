// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck

/**
 * Phase 178 (raw-env-reads-guard) — SERVER raw-channel behavioral guard suite.
 *
 * Phase 176 consolidated env parsing into Zod (fail-loud) and Phase 177 added
 * the root-env loader (loadRootEnv). The keys below are DOCUMENTED raw
 * `process.env` reads (docs/CONFIGURATION.md "Zod validation" paragraph) that
 * are deliberately NOT migrated into the Zod schema. These suites ARE the
 * regression tripwire: any future refactor (Zod absorption, loadRootEnv
 * shadowing, rename) that removes the raw read turns them RED.
 *
 * Guarded here (server keys, behavioral probes at the consumption sites):
 *   1. API_KEY_HMAC_SECRET    — apiKeyService.getHmacSecret() named throws
 *                               + Buffer return  (Phase 163 / SCALE-03)
 *   2. ENCRYPTION_KEY         — encryptionService.getDecryptKeyChain()[0]
 *                               starts from the RAW env value  (Phase 162)
 *   3. LEGACY_PREVIOUS_ENCRYPTION_KEYS — parsed into the decrypt chain tail
 *   4. E2E_RUN                — rateLimit.ts module-scope `=== "1"` gate
 *                               (Phase 169 429-cascade unblock)
 *   5. GSD_TEST_MOCK_PLUGIN   — REMOVED from production code (Phase 180
 *                               PUB-02); probes pin its no-op status
 *   6. LOG_LEVEL              — utils/logger.ts MODULE-LOAD read (structural
 *                               exception: logger is imported BY config/env.ts)
 *   7. D-03 schema-absence tripwire — the raw-only keys must STAY OUT of
 *      Object.keys(getEnv()); the declared-but-consumption-validated keys
 *      (ENCRYPTION_KEY / API_KEY_HMAC_SECRET / LOG_LEVEL) must STAY IN.
 *
 * Doctrine (ollamaKeepAliveEnv.test.ts):
 *   - ORIGINAL save at module scope for every touched key;
 *     afterEach deletes when ORIGINAL === undefined (NEVER assign undefined —
 *     process.env stringifies it to "undefined"), restores otherwise.
 *   - jest.resetModules() + dynamic require per test wherever the module
 *     caches the read at module scope (rateLimit.ts isE2ERun, logger.ts level).
 *   - Fixtures are PLACEHOLDER base64 only (the AAAA…= 32-byte class —
 *     T-178-01: no real secret values, behavior asserted not values).
 *   - DB-free + network-free: prisma is module-mocked in the fresh-requires
 *     that pull it; no REDIS_URL in the unit env → MemoryStore; no supertest,
 *     no express app boot.
 */

import "./helpers/setupEnv";

// ─── RAW_ENV_EXCEPTIONS (D-03 — per-package tripwire constant) ──────────────
// The server raw-only keys: consumed via raw process.env, deliberately NOT
// declared in the Zod schema (docs/CONFIGURATION.md documents the exception).
// If a future refactor absorbs any of these into getEnv(), the D-03 block
// below fails — boot semantics would change (fail-loud Zod routing).
const RAW_ENV_EXCEPTIONS: ReadonlySet<string> = new Set([
  "LEGACY_PREVIOUS_ENCRYPTION_KEYS",
  "E2E_RUN",
  "GSD_TEST_MOCK_PLUGIN",
]);

// Declared-but-consumption-validated: these ARE in the Zod schema (optional
// strings) while their strict validation lives at the consumption site. Their
// REMOVAL from the schema is also a regression (they are the documented
// contract surface) — asserted alongside the absence tripwire.
const DECLARED_BUT_CONSUMPTION_VALIDATED: ReadonlySet<string> = new Set([
  "ENCRYPTION_KEY",
  "API_KEY_HMAC_SECRET",
  "LOG_LEVEL",
]);

// ─── Env save/restore doctrine (T-178-02) ────────────────────────────────────
// Every key any probe touches: module-scope ORIGINAL save; afterEach deletes
// when ORIGINAL === undefined, restores otherwise. Never assign undefined.
const TOUCHED_ENV_KEYS = [
  "E2E_RUN",
  "GSD_TEST_MOCK_PLUGIN",
  "LOG_LEVEL",
  "API_KEY_HMAC_SECRET",
  "ENCRYPTION_KEY",
  "LEGACY_PREVIOUS_ENCRYPTION_KEYS",
  "JWT_SECRET", // used only to keep scrypt fallback well-defined; restored too
  "NODE_ENV",
] as const;
const ORIGINALS: Record<string, string | undefined> = {};
for (const key of TOUCHED_ENV_KEYS) {
  ORIGINALS[key] = process.env[key];
}

afterEach(() => {
  for (const key of TOUCHED_ENV_KEYS) {
    if (ORIGINALS[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = ORIGINALS[key];
    }
  }
});

// Placeholder fixture class (T-178-01): base64 of 32 padded bytes — decodes to
// exactly 32 bytes, same shape as `openssl rand -base64 32` output, no secret.
const HMAC_PLACEHOLDER_32B = Buffer.alloc(32, 0xaa).toString("base64"); // AAAA…=
const KEY_A_PLACEHOLDER = Buffer.alloc(32, 0xab).toString("base64");
const KEY_B_PLACEHOLDER = Buffer.alloc(32, 0xcd).toString("base64");

// ─── Fresh-module helpers (env.ts / rateLimit.ts / logger.ts all cache at ───
// ─── module scope — resetModules + require per probe) ───────────────────────

/**
 * Fresh require of apiKeyService with the prisma singleton mocked (the module
 * top-level imports it; getHmacSecret itself never touches the DB).
 */
function freshApiKeyService() {
  jest.resetModules();
  jest.doMock("../utils/prisma", () => ({ __esModule: true, default: {} }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../services/apiKeyService") as typeof import("../services/apiKeyService");
}

/**
 * Fresh require of middleware/rateLimit with a hermetic env stub (unit env has
 * no REDIS_URL → the real express-rate-limit MemoryStore path is used) and a
 * null Redis service. Mirrors authRateLimiterE2ESkip.test.ts's freshRateLimit
 * minus the express-rate-limit mock: HERE the real limiter must run so the
 * closed-gate probes observe a real 429.
 */
function freshRateLimiter() {
  jest.resetModules();
  jest.doMock("../config/env", () => ({
    getEnv: jest.fn(() => ({ NODE_ENV: "test", REDIS_URL: undefined })),
  }));
  jest.doMock("../services/redisService", () => ({
    getRedis: jest.fn(() => null),
    isRedisAvailable: jest.fn(() => false),
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../middleware/rateLimit") as typeof import("../middleware/rateLimit");
}

/** Plain req/res/next mocks — no supertest, no express app, no Redis.
 * ip is a valid IPv4 string so express-rate-limit's default keyGenerator
 * validations pass; app.get returns undefined so the trust-proxy validations
 * stay inert (neither `=== true` nor `=== false` triggers a throw). */
function mockReq(method = "POST") {
  return {
    ip: "127.0.0.1",
    method,
    headers: {},
    app: { get: () => undefined },
  };
}

function mockRes() {
  const res: any = {
    statusCode: 200,
    writableEnded: false,
    send: jest.fn(),
    // express-rate-limit v8 always emits standardHeaders via response.setHeader
    // (unless headersSent) — the stub must carry it or the middleware pipes a
    // TypeError into next(error) before the 429 handler can ever fire.
    setHeader: jest.fn(),
  };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  return res;
}

/** Fresh require of enterpriseLoader with prisma + the delegate targets
 * mocked so the module top-level side effects stay inert. */
function freshEnterpriseLoader() {
  jest.resetModules();
  jest.doMock("../utils/prisma", () => ({ __esModule: true, default: {} }));
  jest.doMock("../services/eventLogService", () => ({
    setAuditLogDelegate: jest.fn(),
  }));
  jest.doMock("../services/webhookService", () => ({
    dispatchWebhookEvent: jest.fn(),
  }));
  jest.doMock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
  jest.doMock("../services/systemConfigService", () => ({
    setLimitOverride: jest.fn(),
    registerConfigKeyValidator: jest.fn(),
  }));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../services/enterpriseLoader") as typeof import("../services/enterpriseLoader");
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. API_KEY_HMAC_SECRET — raw read + consumption-site validation (D-03)
// ═════════════════════════════════════════════════════════════════════════════
describe("API_KEY_HMAC_SECRET raw channel (apiKeyService.getHmacSecret)", () => {
  it("unset → throws the NAMED error (never a generic throw)", () => {
    delete process.env.API_KEY_HMAC_SECRET;
    const svc = freshApiKeyService();
    expect(() => svc.getHmacSecret()).toThrow(/API_KEY_HMAC_SECRET is required/);
  });

  it('empty string "" → same named throw (empty is treated as unset)', () => {
    process.env.API_KEY_HMAC_SECRET = "";
    const svc = freshApiKeyService();
    expect(() => svc.getHmacSecret()).toThrow(/API_KEY_HMAC_SECRET is required/);
  });

  it('"AAAA" (decodes to 3 bytes) → throws the exact-32-bytes error', () => {
    process.env.API_KEY_HMAC_SECRET = "AAAA"; // Buffer.from("AAAA","base64") → 3 bytes
    const svc = freshApiKeyService();
    expect(() => svc.getHmacSecret()).toThrow(/exactly 32 bytes/);
  });

  it("44-char base64 placeholder (32 bytes) → returns a Buffer of length 32", () => {
    process.env.API_KEY_HMAC_SECRET = HMAC_PLACEHOLDER_32B;
    const svc = freshApiKeyService();
    const secret = svc.getHmacSecret();
    expect(Buffer.isBuffer(secret)).toBe(true);
    expect(secret.length).toBe(32);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2-3. ENCRYPTION_KEY + LEGACY_PREVIOUS_ENCRYPTION_KEYS — decrypt key chain
// ═════════════════════════════════════════════════════════════════════════════
describe("ENCRYPTION_KEY raw channel (encryptionService.getDecryptKeyChain)", () => {
  beforeEach(() => {
    // Keep JWT_SECRET well-defined for the scrypt fallback path (restored in
    // the shared afterEach).
    process.env.JWT_SECRET = "test-jwt-secret-for-unit-encryption-chain-guard";
  });

  it("chain[0] equals the RAW ENCRYPTION_KEY placeholder (raw read wins after reset)", () => {
    process.env.ENCRYPTION_KEY = KEY_B_PLACEHOLDER;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    const enc = require("../services/encryptionService") as typeof import("../services/encryptionService");
    enc.resetEncryptionKeyCache();
    const chain = enc.getDecryptKeyChain();
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain[0].toString("base64")).toBe(KEY_B_PLACEHOLDER);
  });

  it("ENCRYPTION_KEY deleted + reset → chain still returns a USABLE fallback key (scrypt(JWT_SECRET))", () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    const enc = require("../services/encryptionService") as typeof import("../services/encryptionService");
    enc.resetEncryptionKeyCache();
    const chain = enc.getDecryptKeyChain();
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.isBuffer(chain[0])).toBe(true);
    // Behavioral proof the fallback key is live: encrypt → decrypt round-trip.
    const blob = enc.encrypt("raw-embeds-guard-roundtrip");
    expect(enc.decrypt(blob)).toBe("raw-embeds-guard-roundtrip");
  });
});

describe("LEGACY_PREVIOUS_ENCRYPTION_KEYS raw channel (decrypt chain tail)", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret-for-unit-encryption-chain-guard";
  });

  it("ENCRYPTION_KEY=KEY_B + LEGACY=KEY_A → chain[0]=KEY_B and chain[1]=KEY_A (raw parse order)", () => {
    process.env.ENCRYPTION_KEY = KEY_B_PLACEHOLDER;
    process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS = KEY_A_PLACEHOLDER;
    const enc = require("../services/encryptionService") as typeof import("../services/encryptionService");
    enc.resetEncryptionKeyCache();
    const chain = enc.getDecryptKeyChain();
    // The scrypt legacy tail may additionally follow (D-03 — by design when an
    // explicit key is set); the guard pins the RAW keys' positions, not the tail.
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0].toString("base64")).toBe(KEY_B_PLACEHOLDER);
    expect(chain[1].toString("base64")).toBe(KEY_A_PLACEHOLDER);
  });

  it("LEGACY deleted + ENCRYPTION_KEY deleted + reset → single fallback key, no crash", () => {
    delete process.env.LEGACY_PREVIOUS_ENCRYPTION_KEYS;
    delete process.env.ENCRYPTION_KEY;
    const enc = require("../services/encryptionService") as typeof import("../services/encryptionService");
    enc.resetEncryptionKeyCache();
    const chain = enc.getDecryptKeyChain();
    expect(chain.length).toBe(1);
    expect(Buffer.isBuffer(chain[0])).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. E2E_RUN — module-scope "=== '1'" gate over the REAL express-rate-limit
// ═════════════════════════════════════════════════════════════════════════════
describe("E2E_RUN raw gate (middleware/rateLimit authRateLimiter)", () => {
  it('E2E_RUN="1" → authRateLimiter NEVER 429s POSTs (skip active, next called every time)', async () => {
    process.env.E2E_RUN = "1";
    const { authRateLimiter } = freshRateLimiter();
    for (let i = 0; i < 5; i++) {
      const req = mockReq("POST");
      const res = mockRes();
      const next = jest.fn();
      await (authRateLimiter as any)(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).not.toBe(429);
    }
  });

  it("E2E_RUN deleted → bucket exhausts into a 429 (gate closed, brute-force defense intact)", async () => {
    delete process.env.E2E_RUN;
    const { authRateLimiter } = freshRateLimiter();
    let saw429 = false;
    for (let i = 0; i < 150; i++) {
      // isDev (NODE_ENV=test) bucket = 100/min → the 101st request must 429.
      const res = mockRes();
      await (authRateLimiter as any)(mockReq("POST"), res, jest.fn());
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it('E2E_RUN="" (empty) → bucket exhausts into a 429 (only the exact string "1" opens)', async () => {
    process.env.E2E_RUN = "";
    const { authRateLimiter } = freshRateLimiter();
    let saw429 = false;
    for (let i = 0; i < 150; i++) {
      const res = mockRes();
      await (authRateLimiter as any)(mockReq("POST"), res, jest.fn());
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

  it('E2E_RUN="0" → bucket exhausts into a 429 (non-"1" values keep the gate closed)', async () => {
    process.env.E2E_RUN = "0";
    const { authRateLimiter } = freshRateLimiter();
    let saw429 = false;
    for (let i = 0; i < 150; i++) {
      const res = mockRes();
      await (authRateLimiter as any)(mockReq("POST"), res, jest.fn());
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Production seam is env-var-free (Phase 180 PUB-02 — replaces the
//    Phase-146 GSD_TEST_MOCK_PLUGIN raw gate)
// ═════════════════════════════════════════════════════════════════════════════
// The GSD_TEST_MOCK_PLUGIN env-var seam was REMOVED from production code
// (enterpriseLoader.resolve() is now branch-free). Tests that need a mock
// enterprise plugin in a SUBPROCESS use the `tsx -r` bootstrap fixture
// (__tests__/fixtures/enterpriseMockBootstrap.ts overrides __pluginResolver
// in the child before index.ts boots) — jest-registry injection covers the
// in-process cases. These probes pin the removal: the env var must have NO
// effect on resolution.
describe("GSD_TEST_MOCK_PLUGIN is a no-op (env-var seam removed, PUB-02)", () => {
  it("resolve() behaves identically with the legacy env var set or unset (branch-free)", () => {
    // Same guaranteed-absent relative specifier for both probes —
    // resolution outcome must NOT depend on the legacy env var.
    const absent = "./__tests__/no-such-enterprise-module-xyz";
    delete process.env.GSD_TEST_MOCK_PLUGIN;
    const withoutVar = freshEnterpriseLoader();
    const errWithout = captureResolveError(withoutVar, absent);

    process.env.GSD_TEST_MOCK_PLUGIN = "1";
    const withVar = freshEnterpriseLoader();
    const errWith = captureResolveError(withVar, absent);

    expect(errWith?.code).toBe(errWithout?.code);
    // And the legacy "1" value must NOT redirect to the old mock helper.
    expect(errWith?.message ?? "").not.toContain("mockBackupPlugin");
  });
});

/** Run resolve() and capture its thrown error (or null when it resolves). */
function captureResolveError(
  loader: { __pluginResolver: { resolve(specifier: string): string } },
  specifier: string,
): { code?: string; message: string } | null {
  try {
    loader.__pluginResolver.resolve(specifier);
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? String(err) };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. LOG_LEVEL — utils/logger.ts MODULE-LOAD read (structural exception)
// ═════════════════════════════════════════════════════════════════════════════
describe("LOG_LEVEL module-load read (utils/logger.ts)", () => {
  it('LOG_LEVEL="debug" at import → logger.level === "debug"', async () => {
    process.env.LOG_LEVEL = "debug";
    jest.resetModules();
    const { logger } = await import("../utils/logger");
    expect(logger.level).toBe("debug");
  });

  it("LOG_LEVEL deleted at import → logger.level === \"info\" (default intact)", async () => {
    delete process.env.LOG_LEVEL;
    jest.resetModules();
    const { logger } = await import("../utils/logger");
    expect(logger.level).toBe("info");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. D-03 schema-absence tripwire — RAW_ENV_EXCEPTIONS stay OUT of getEnv()
// ═════════════════════════════════════════════════════════════════════════════
describe("D-03 schema-absence tripwire (server env.ts)", () => {
  it("RAW_ENV_EXCEPTIONS declares exactly the 3 server raw keys", () => {
    expect([...RAW_ENV_EXCEPTIONS].sort()).toEqual([
      "E2E_RUN",
      "GSD_TEST_MOCK_PLUGIN",
      "LEGACY_PREVIOUS_ENCRYPTION_KEYS",
    ]);
  });

  it("each RAW_ENV_EXCEPTIONS key is ABSENT from Object.keys(getEnv())", async () => {
    // jest.dontMock: the doMock("../config/env") stubs registered by the
    // rateLimit probes above persist for the remainder of the FILE under
    // jest's module-registry semantics — restore the REAL env module here so
    // the tripwire inspects the genuine Zod schema shape.
    jest.dontMock("../config/env");
    jest.dontMock("../utils/logger");
    jest.dontMock("../utils/prisma");
    jest.resetModules();
    const envModule = await import("../config/env");
    envModule.clearEnvCache();
    const schemaKeys = Object.keys(envModule.getEnv());
    for (const key of RAW_ENV_EXCEPTIONS) {
      expect(schemaKeys).not.toContain(key);
    }
  });

  it("each declared-but-consumption-validated key is still PRESENT in getEnv() keys", async () => {
    // Zod omits optional keys whose value is undefined from the parsed output,
    // so the presence probe plants placeholder values for all three keys —
    // if the schema stopped declaring them, they would vanish from getEnv()
    // and this assertion fails (their removal is the tripwired regression).
    jest.dontMock("../config/env");
    jest.dontMock("../utils/logger");
    jest.dontMock("../utils/prisma");
    process.env.ENCRYPTION_KEY = KEY_A_PLACEHOLDER;
    process.env.API_KEY_HMAC_SECRET = HMAC_PLACEHOLDER_32B;
    process.env.LOG_LEVEL = "info";
    jest.resetModules();
    const envModule = await import("../config/env");
    envModule.clearEnvCache();
    const schemaKeys = Object.keys(envModule.getEnv());
    for (const key of DECLARED_BUT_CONSUMPTION_VALIDATED) {
      expect(schemaKeys).toContain(key);
    }
  });
});
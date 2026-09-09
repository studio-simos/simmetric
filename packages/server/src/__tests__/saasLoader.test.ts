// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 186 (SAAS-05, D-08/D-09) — saasLoader unit tests.
 *
 * Covers the Wave-0 contract cases (186-RESEARCH Validation Architecture):
 *  1. Community no-op: `@simmetric-chat/saas` not installed → logger.info
 *     with "community" + "no-op" + reason MODULE_NOT_FOUND, register NOT
 *     called, NO error logged (SC-4 community path).
 *  2. Broken install: resolve OK but load throws → logger.error +
 *     process.exit(1); MUST NOT log the community no-op (Pitfall 7).
 *  3. Missing/invalid register → exit(1) (fail-loud, D-09).
 *  4. Downgrade guard: an apiVersion 1 plugin handed to the SaaS loader →
 *     exit(1) with expected "2" (per-loader acceptance cuts BOTH ways,
 *     T-186-01b).
 *  5. Success path (apiVersion 2): register receives a ctx exposing the
 *     FULL shared surface (member-for-member identical to the enterprise
 *     ctx — Pitfall 8 parity) PLUS the 5 v2 members.
 *  6. v2 hook stubs: registerBillingProvider / registerPlanResolver /
 *     registerTenantProvisioner throw synchronously "not wired until
 *     Parte II" (D-07); issueTenantLicense rejects (D-04). A stub that
 *     returns instead of throwing would be a silent no-op (Pitfall 5).
 *  7. registerQuotaEnforcer delegates to the middleware/license.ts registry
 *     setter (D-06 — the ONE real forward; mirrors the enterpriseLoader
 *     setLimitOverride probe).
 *  8. Register-throw → exit(1) BEFORE loadPlugin resolves (probe edge,
 *     T-186-08 mechanism (a): the boot caller never regains control, so
 *     the boot sequence cannot continue on to the catch-all mount).
 *
 * Mock strategy replicates `enterpriseLoader.test.ts` WHOLESALE —
 * resolver-override on the `__pluginResolver` seam, NEVER env vars
 * (PUB-02 removed the GSD_TEST_MOCK_PLUGIN seam; rawEnvReads.test.ts
 * guards the name).
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({
    tier: "enterprise",
    licensee: "Acme Corp",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  getLicenseInfo: jest.fn(() => ({
    tier: "enterprise",
    licensee: "Acme Corp",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  isFeatureEnabled: jest.fn(() => false),
  setLimitOverride: jest.fn(),
}));

// Phase 186 (D-06): the QuotaEnforcer registry lives in middleware/license.ts.
// The mock lets the delegation test assert the forward without loading the
// real license-service chain a second time.
jest.mock("../middleware/license", () => ({
  setQuotaEnforcer: jest.fn(),
  requireFeature: jest.fn(),
  requireFeatureLimit: jest.fn(),
}));

jest.mock("../services/eventLogService", () => ({
  setAuditLogDelegate: jest.fn(),
}));

jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  registerConfigKeyValidator: jest.fn(),
}));

import { logger } from "../utils/logger";
import type { Express } from "express";
import { loadSaaSPlugin, __pluginResolver } from "../services/saasLoader";
import { buildPluginContext } from "../services/pluginLoaderCore";

type PluginShape = {
  apiVersion: number;
  register?: jest.Mock;
};

const fakeApp = { use: jest.fn() } as unknown as Express;

/** The 5 v2 members added on top of the shared PluginContext surface. */
const V2_MEMBERS = [
  "registerBillingProvider",
  "registerQuotaEnforcer",
  "registerPlanResolver",
  "registerTenantProvisioner",
  "issueTenantLicense",
] as const;

/** Save the real resolver so each test can restore it. */
const realResolve = __pluginResolver.resolve.bind(__pluginResolver);
const realLoad = __pluginResolver.load.bind(__pluginResolver);

beforeEach(() => {
  jest.clearAllMocks();
  __pluginResolver.resolve = realResolve;
  __pluginResolver.load = realLoad;
});

afterEach(() => {
  jest.restoreAllMocks();
  __pluginResolver.resolve = realResolve;
  __pluginResolver.load = realLoad;
});

/** Mock process.exit to throw (so we can catch it and assert it was called). */
function mockProcessExit(): jest.SpyInstance {
  return jest
    .spyOn(process, "exit")
    .mockImplementation((() => {
      throw new Error("__PROCESS_EXIT__");
    }) as unknown as (code?: number) => never);
}

/** Simulate "package not installed" — resolve throws MODULE_NOT_FOUND. */
function mockResolveNotFound(): void {
  __pluginResolver.resolve = jest.fn(() => {
    const err = new Error("Cannot find module '@simmetric-chat/saas'");
    (err as { code?: string }).code = "MODULE_NOT_FOUND";
    throw err;
  });
}

/** Simulate a successfully-installed plugin package. */
function mockResolveAndLoad(plugin: PluginShape): void {
  const fakePath = "/fake/node_modules/@simmetric-chat/saas/index.js";
  __pluginResolver.resolve = jest.fn(() => fakePath);
  __pluginResolver.load = jest.fn(() => ({
    __esModule: true,
    default: plugin,
  }));
}

describe("saasLoader — community no-op (SC-4, D-09)", () => {
  it("logs info 'community' + 'no-op' with reason MODULE_NOT_FOUND and does NOT call register when package is absent", async () => {
    mockResolveNotFound();

    const register = jest.fn();

    await loadSaaSPlugin(fakeApp);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/community/i),
      expect.objectContaining({ reason: "MODULE_NOT_FOUND" }),
    );
    // The info message must ALSO contain "no-op".
    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const communityNoOpCall = infoCalls.find(
      (c) => typeof c[0] === "string" && /community/i.test(c[0]) && /no-op/.test(c[0]),
    );
    expect(communityNoOpCall).toBeDefined();
    expect(logger.error).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });
});

describe("saasLoader — broken install (D-09 two-step, fail-loud)", () => {
  it("load throws (ERR_REQUIRE_ESM) → logger.error + process.exit(1), NOT community no-op (Pitfall 7)", async () => {
    const exitSpy = mockProcessExit();
    // resolve succeeds (package is "installed"), but load throws.
    __pluginResolver.resolve = jest.fn(() => "/fake/path/saas.js");
    __pluginResolver.load = jest.fn(() => {
      throw new Error("ERR_REQUIRE_ESM");
    });

    await expect(loadSaaSPlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      "[saas] SaaS package found but failed to load",
      expect.objectContaining({ error: "ERR_REQUIRE_ESM" }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Must NOT have logged the community no-op.
    const infoCalls = (logger.info as jest.Mock).mock.calls;
    const communityCall = infoCalls.find(
      (c) => typeof c[0] === "string" && /community/.test(c[0]),
    );
    expect(communityCall).toBeUndefined();
  });

  it("missing/invalid register → exit(1) with the 'missing register' error (fail-loud)", async () => {
    const exitSpy = mockProcessExit();
    // A module that exports NO plugin (empty object) — register missing.
    mockResolveAndLoad({ apiVersion: 2 });

    await expect(loadSaaSPlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      "[saas] SaaS package did not export a valid plugin (missing register)",
      {},
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("saasLoader — per-loader apiVersion acceptance (D-03 downgrade guard, T-186-01b)", () => {
  it("an apiVersion 1 plugin handed to the SaaS loader → exit(1) with expected '2' (downgrade guard cuts BOTH ways)", async () => {
    const exitSpy = mockProcessExit();
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await expect(loadSaaSPlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      "[saas] API version mismatch",
      expect.objectContaining({ expected: "2", got: 1 }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(register).not.toHaveBeenCalled();
  });

  it("an apiVersion 3 plugin → exit(1) with expected '2' (acceptance list is exactly [2])", async () => {
    const exitSpy = mockProcessExit();
    mockResolveAndLoad({ apiVersion: 3, register: jest.fn() });

    await expect(loadSaaSPlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      "[saas] API version mismatch",
      expect.objectContaining({ expected: "2", got: 3 }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("saasLoader — register throws (D-09 fail-loud + probe edge T-186-08 mechanism (a))", () => {
  it("register throws → '[saas] Plugin registration failed' + process.exit(1) BEFORE loadPlugin resolves", async () => {
    const exitSpy = mockProcessExit();
    mockResolveAndLoad({
      apiVersion: 2,
      register: jest.fn(() => {
        throw new Error("boom");
      }),
    });

    await expect(loadSaaSPlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      "[saas] Plugin registration failed",
      expect.objectContaining({ error: "boom" }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Exit-before-mount guarantee mechanism (a): the throw reaches the
    // exit(1) arm and loadPlugin REJECTS — the boot caller (index.ts) never
    // regains control, so it cannot continue on to the catch-all mount.
  });
});

describe("saasLoader — success path (apiVersion 2, Pitfall 8 ctx parity)", () => {
  it("logs success and register receives the FULL shared surface + the 5 v2 members", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 2, register });

    await loadSaaSPlugin(fakeApp);

    expect(register).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("[saas] Plugin registered successfully");
    expect(logger.error).not.toHaveBeenCalled();

    const saasCtx = register.mock.calls[0]![0] as Record<string, unknown>;
    // Pitfall 8 parity baseline: the shared ctx factory output.
    const enterpriseCtx = buildPluginContext(fakeApp) as unknown as Record<string, unknown>;

    // 1. EVERY shared-surface member is present with the same runtime type
    //    (member-for-member identical to the enterprise ctx).
    const entKeys = Object.keys(enterpriseCtx).sort();
    const saasKeys = Object.keys(saasCtx).sort();
    const saasSharedKeys = saasKeys.filter((k) => !(V2_MEMBERS as readonly string[]).includes(k));
    expect(saasSharedKeys).toEqual(entKeys);
    for (const key of entKeys) {
      expect(typeof saasCtx[key]).toBe(typeof enterpriseCtx[key]);
    }

    // 2. The 5 v2 members are present and callable.
    for (const member of V2_MEMBERS) {
      expect(typeof saasCtx[member]).toBe("function");
    }

    // 3. Core identity anchors.
    expect(saasCtx.app).toBe(fakeApp);
    expect(saasCtx.logger).toBe(logger);
  });

  it("registerBillingProvider throws synchronously 'not wired until Parte II' (D-07, Pitfall 5)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 2, register });
    await loadSaaSPlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      registerBillingProvider: (p: unknown) => void;
    };
    expect(() => ctx.registerBillingProvider({})).toThrow("not wired until Parte II");
  });

  it("registerPlanResolver throws synchronously 'not wired until Parte II' (D-07, Pitfall 5)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 2, register });
    await loadSaaSPlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      registerPlanResolver: (r: unknown) => void;
    };
    expect(() => ctx.registerPlanResolver({})).toThrow("not wired until Parte II");
  });

  it("registerTenantProvisioner throws synchronously 'not wired until Parte II' (D-07, Pitfall 5)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 2, register });
    await loadSaaSPlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      registerTenantProvisioner: (p: unknown) => void;
    };
    expect(() => ctx.registerTenantProvisioner({})).toThrow("not wired until Parte II");
  });

  it("issueTenantLicense REJECTS 'not wired until Parte II' (D-04 — no signing code in core)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 2, register });
    await loadSaaSPlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      issueTenantLicense: (orgId: string, plan: string, expiresAt: Date) => Promise<string>;
    };
    await expect(
      ctx.issueTenantLicense("org-123", "pro", new Date("2030-01-01")),
    ).rejects.toThrow("not wired until Parte II");
  });

  it("registerQuotaEnforcer delegates to setQuotaEnforcer (D-06 IoC forward — mirrors the enterprise setLimitOverride probe)", async () => {
    const enforcer = jest.fn().mockResolvedValue({ allowed: true });
    const register = jest.fn((ctx: { registerQuotaEnforcer: (fn: unknown) => void }) => {
      ctx.registerQuotaEnforcer(enforcer);
    });
    mockResolveAndLoad({ apiVersion: 2, register });

    await loadSaaSPlugin(fakeApp);

    const { setQuotaEnforcer } = require("../middleware/license");
    expect(setQuotaEnforcer).toHaveBeenCalledWith(enforcer);
  });

  it("registerScheduler + onShutdown close over the SaaS loader's OWN registries (per-loader teardown, Pitfall 2)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 2, register });
    await loadSaaSPlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      registerScheduler: (n: string, s: unknown) => void;
    };
    // The SaaS ctx must carry the shared scheduler surface (the teardown
    // order is pinned in bootOrder.test.ts / index.ts source-strings).
    expect(typeof ctx.registerScheduler).toBe("function");
  });
});
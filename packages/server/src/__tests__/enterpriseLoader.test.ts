// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 140 (EPA-01) — enterpriseLoader unit tests.
 *
 * Covers the 4 contract cases:
 *  1. Community no-op: `@simmetric-chat/enterprise` not installed →
 *     logger.info with "community" + "no-op", register NOT called.
 *  2. apiVersion mismatch: plugin.apiVersion !== 1 → logger.error +
 *     process.exit(1) (D-03).
 *  3. register throws: plugin.register(ctx) throws → logger.error +
 *     process.exit(1) (D-07 fail-loud).
 *  4. Success: register succeeds → logger.info success + register called
 *     with a PluginContext-shaped arg.
 *
 * Mock strategy follows `license.test.ts`: jest.mock the server internals
 * (prisma, env, logger, licenseService). The enterprise package
 * resolution is simulated by overriding the loader's `__pluginResolver`
 * seam (an internal export) — this lets us test the two-step
 * resolve→load pattern (D-05) without the real package on disk, and
 * without collapsing resolve-failure into load-failure (which would be
 * fail-open, the exact bug D-05/D-07 exist to prevent).
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
  // Phase 147 (EPA-07): the loader's ctx.overrideFeatureLimit delegates to
  // setLimitOverride via the addLimitOverride alias import. The mock must
  // expose it — before the Phase-147 wiring the test asserted the throwing
  // stub, and the mock omitting the export made the delegation crash with
  // "setLimitOverride is not a function" instead of exercising the contract.
  setLimitOverride: jest.fn(),
}));

// Phase 143: ctx.generateToken/decrypt/encrypt delegate to these via require().
// Mock only the specific exports the ctx delegation tests assert on; spread the
// real module for everything else so the SC-2 integration test (which uses the
// real authMiddleware → authService.verifyToken/getCachedUserWithRoles) keeps
// working. authService.generateToken is unused by authMiddleware (it's only
// called by ctx.generateToken), so mocking it is safe. encryptionService is
// only touched by ctx.encrypt/decrypt — mock it fully with a round-trip shape.
jest.mock("../services/authService", () => {
  const actual = jest.requireActual("../services/authService");
  return {
    ...actual,
    generateToken: jest.fn((userId: string) => `mock-jwt-for-${userId}`),
  };
});
jest.mock("../services/encryptionService", () => {
  // Minimal AES-256-GCM-shaped mock: round-trip a marker so decrypt(encrypt(x)) === x.
  const encode = (plaintext: string) => `iv:authTag:${Buffer.from(plaintext).toString("hex")}`;
  return {
    encrypt: jest.fn((plaintext: string) => encode(plaintext)),
    decrypt: jest.fn((ciphertext: string) => {
      const parts = ciphertext.split(":");
      return Buffer.from(parts[2] || "", "hex").toString("utf8");
    }),
    resetEncryptionKeyCache: jest.fn(),
  };
});

// Additional mocks required by createApp() for the integration test block
// (mirror auth.test.ts:27-52). These are hoisted by jest regardless of position.
jest.mock("../services/redisService", () => {
  const mockGetRedis = jest.fn();
  return {
    getRedis: mockGetRedis,
    isRedisAvailable: jest.fn(() => mockGetRedis() !== null),
  };
});
jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  // Phase 145 (D-01): the alias import `addConfigKeyValidator` resolves to
  // this mock. The loader's ctx.registerConfigKeyValidator(fn) forwards to
  // it — the test asserts the delegation does not throw.
  registerConfigKeyValidator: jest.fn(),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/hybridSearchService", () => ({
  checkCollectorHealth: jest.fn().mockResolvedValue({ reachable: true }),
  hybridSearch: jest.fn(),
  multiWorkspaceHybridSearch: jest.fn(),
}));

import { logger } from "../utils/logger";
import type { Express } from "express";
import {
  loadEnterprisePlugin,
  shutdownEnterprisePlugin,
  __pluginResolver,
} from "../services/enterpriseLoader";
import request from "supertest";
import { Router } from "express";
import { createApp, mountCatchAlls } from "../index";
import { generateTestToken, adminUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";

type PluginShape = {
  apiVersion: number;
  register: jest.Mock;
};

const fakeApp = { use: jest.fn() } as unknown as Express;

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
    const err = new Error("Cannot find module '@simmetric-chat/enterprise'");
    (err as { code?: string }).code = "MODULE_NOT_FOUND";
    throw err;
  });
}

/** Simulate a successfully-installed plugin package. */
function mockResolveAndLoad(plugin: PluginShape): void {
  const fakePath = "/fake/node_modules/@simmetric-chat/enterprise/index.js";
  __pluginResolver.resolve = jest.fn(() => fakePath);
  __pluginResolver.load = jest.fn(() => ({
    __esModule: true,
    default: plugin,
  }));
}

describe("enterpriseLoader — community no-op (SC-1, D-06)", () => {
  it("logs info 'community' + 'no-op' and does NOT call register when package is absent", async () => {
    mockResolveNotFound();

    await loadEnterprisePlugin(fakeApp);

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
  });
});

describe("enterpriseLoader — apiVersion mismatch (D-03)", () => {
  it("logs error and calls process.exit(1) when plugin.apiVersion !== 1", async () => {
    const exitSpy = mockProcessExit();
    mockResolveAndLoad({ apiVersion: 2, register: jest.fn() });

    await expect(loadEnterprisePlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("version"),
      expect.objectContaining({ expected: 1, got: 2 }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("enterpriseLoader — register throws (D-07 fail-loud)", () => {
  it("logs '[enterprise] Plugin registration failed' and calls process.exit(1)", async () => {
    const exitSpy = mockProcessExit();
    mockResolveAndLoad({
      apiVersion: 1,
      register: jest.fn(() => {
        throw new Error("boom");
      }),
    });

    await expect(loadEnterprisePlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      "[enterprise] Plugin registration failed",
      expect.objectContaining({ error: "boom" }),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("enterpriseLoader — success path", () => {
  it("logs success and calls register with a PluginContext-shaped arg", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);

    expect(register).toHaveBeenCalledTimes(1);
    const ctx = register.mock.calls[0]![0] as {
      app: unknown;
      prisma: unknown;
      logger: unknown;
      env: unknown;
      licenseInfo: unknown;
      mountProtected: unknown;
      mountPublic: unknown;
      registerScheduler: unknown;
      onShutdown: unknown;
      registerAuditLogWriter: unknown;
      registerConfigKeyValidator: unknown;
      auditLog: unknown;
      overrideFeatureLimit: unknown;
      generateToken: unknown;
      decrypt: unknown;
      encrypt: unknown;
    };
    expect(ctx.app).toBe(fakeApp);
    expect(ctx.prisma).toBeDefined();
    expect(ctx.logger).toBe(logger);
    expect(ctx.env).toBeDefined();
    expect(ctx.licenseInfo).toBeDefined();
    expect(typeof ctx.mountProtected).toBe("function");
    expect(typeof ctx.mountPublic).toBe("function");
    expect(typeof ctx.registerScheduler).toBe("function");
    expect(typeof ctx.onShutdown).toBe("function");
    // Phase 144 (D-10/D-11): auditLog is now a typed AuditLog field (no
    // longer a throwing function stub), and registerAuditLogWriter is the
    // new IoC hook for injecting the enterprise writer into the shim.
    expect(typeof ctx.registerAuditLogWriter).toBe("function");
    // Phase 145 (D-01): registerConfigKeyValidator is the new IoC hook for
    // injecting the enterprise branding validator into updateSettings().
    expect(typeof ctx.registerConfigKeyValidator).toBe("function");
    expect(ctx.auditLog).toBeUndefined();
    expect(typeof ctx.overrideFeatureLimit).toBe("function");
    // Phase 143 capabilities (D-02 amendment):
    expect(typeof ctx.generateToken).toBe("function");
    expect(typeof ctx.decrypt).toBe("function");
    expect(typeof ctx.encrypt).toBe("function");
    expect(logger.info).toHaveBeenCalledWith(
      "[enterprise] Plugin registered successfully",
    );
  });

  it("registerAuditLogWriter delegates to setAuditLogDelegate (D-11 IoC hook)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      registerAuditLogWriter: (fn: (e: unknown) => Promise<void>) => void;
    };

    // The hook should accept a function and not throw (the delegation to
    // setAuditLogDelegate is a module-level variable assignment).
    const writer = jest.fn().mockResolvedValue(undefined);
    expect(() => ctx.registerAuditLogWriter(writer)).not.toThrow();
  });

  it("registerConfigKeyValidator delegates to the community setter (D-01 IoC hook)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      registerConfigKeyValidator: (fn: (key: unknown, li: unknown) => unknown) => void;
    };

    // The hook should accept a validator function and not throw (the
    // delegation to the community registerConfigKeyValidator setter is a
    // module-level array push — alias import avoids the name collision,
    // Pitfall 1).
    const validator = jest.fn();
    expect(() => ctx.registerConfigKeyValidator(validator)).not.toThrow();
  });

  it("overrideFeatureLimit delegates to setLimitOverride (Phase 147 EPA-07 — replaces the pre-147 throwing stub)", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      overrideFeatureLimit: (f: string, v: number) => void;
    };
    // c980c1ba (147-01) wired the real resolver: the ctx method forwards to
    // the community setLimitOverride setter (alias import addLimitOverride —
    // Phase 145 Pitfall 1 pattern) which mutates licenseService's module-level
    // limitOverrides map; getFeatureLimit() consults it FIRST (D-01). The old
    // test pinned the pre-147 stub ("not wired until Phase 147") — obsolete.
    expect(() => ctx.overrideFeatureLimit("max_workspaces", 50)).not.toThrow();
    const { setLimitOverride } = require("../services/licenseService");
    expect(setLimitOverride).toHaveBeenCalledWith("max_workspaces", 50);
  });

  it("mountProtected calls app.use('/api/enterprise', authMiddleware, router) (D-07 3-arg)", async () => {
    const use = jest.fn();
    const app = { use } as unknown as Express;
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(app);
    const ctx = register.mock.calls[0]![0] as { mountProtected: (r: unknown) => void };
    const router = { name: "protectedRouter" };
    ctx.mountProtected(router);
    // D-07: 3-arg form — authMiddleware applied before the plugin's router.
    expect(use).toHaveBeenCalledWith("/api/enterprise", expect.any(Function), router);
  });

  it("mountPublic calls app.use('/api/enterprise', router) (default — Phase 143 standardized)", async () => {
    const use = jest.fn();
    const app = { use } as unknown as Express;
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(app);
    const ctx = register.mock.calls[0]![0] as { mountPublic: (r: unknown) => void };
    const router = { name: "publicRouter" };
    ctx.mountPublic(router);
    // Phase 143 (Finding 1): default standardized to /api/enterprise (the
    // Phase 142 hardcoded /api/sso was the bug — it would mount SAML at
    // /api/sso/saml/login instead of /api/auth/saml/login).
    expect(use).toHaveBeenCalledWith("/api/enterprise", router);
  });

  // ─── Phase 143 (Finding 1) path-arg overload tests ──────────────────────

  it("mountPublic('/api/auth', router) calls app.use('/api/auth', router) (path-arg, SC-2)", async () => {
    const use = jest.fn();
    const app = { use } as unknown as Express;
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(app);
    const ctx = register.mock.calls[0]![0] as { mountPublic: (p: string, r: unknown) => void };
    const router = { name: "samlRoutes" };
    ctx.mountPublic("/api/auth", router);
    expect(use).toHaveBeenCalledWith("/api/auth", router);
  });

  it("mountProtected('/api/sso', router) calls app.use('/api/sso', authMiddleware, router) (path-arg, SC-2)", async () => {
    const use = jest.fn();
    const app = { use } as unknown as Express;
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(app);
    const ctx = register.mock.calls[0]![0] as { mountProtected: (p: string, r: unknown) => void };
    const router = { name: "ssoRoutes" };
    ctx.mountProtected("/api/sso", router);
    // 3-arg form with explicit path — preserves D-07 auth (authMiddleware).
    expect(use).toHaveBeenCalledWith("/api/sso", expect.any(Function), router);
  });

  // ─── Phase 143 capability delegation tests (generateToken/decrypt/encrypt) ──

  it("ctx.generateToken delegates to authService.generateToken", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as { generateToken: (userId: string) => string };
    const token = ctx.generateToken("user-1");
    // authService.generateToken is mocked above to return `mock-jwt-for-${userId}`.
    expect(token).toBe("mock-jwt-for-user-1");
  });

  it("ctx.decrypt delegates to encryptionService.decrypt", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as { decrypt: (ciphertext: string) => string; encrypt: (plaintext: string) => string };
    // encryptionService is mocked above with a round-trip encode/decode.
    const plaintext = "secret-client-secret-123";
    const ciphertext = ctx.encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.split(":").length).toBe(3); // iv:authTag:ciphertext
    expect(ctx.decrypt(ciphertext)).toBe(plaintext);
  });

  it("ctx.encrypt delegates to encryptionService.encrypt", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as { encrypt: (plaintext: string) => string };
    const ciphertext = ctx.encrypt("test-plaintext");
    // Mock shape: iv:authTag:<hex-encoded plaintext>
    expect(ciphertext.split(":").length).toBe(3);
  });

  it("registerScheduler starts the scheduler immediately and shutdown stops it", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as {
      registerScheduler: (n: string, s: { start: () => void; stop: () => void }) => void;
    };
    const start = jest.fn();
    const stop = jest.fn();
    ctx.registerScheduler("test-sched", { start, stop });
    expect(start).toHaveBeenCalledTimes(1);

    await shutdownEnterprisePlugin();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("onShutdown callbacks are invoked during shutdownEnterprisePlugin", async () => {
    const register = jest.fn();
    mockResolveAndLoad({ apiVersion: 1, register });

    await loadEnterprisePlugin(fakeApp);
    const ctx = register.mock.calls[0]![0] as { onShutdown: (fn: () => void) => void };
    const cb = jest.fn();
    ctx.onShutdown(cb);

    await shutdownEnterprisePlugin();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("enterpriseLoader — broken install (D-05 two-step, D-07 fail-loud)", () => {
  it("load throws (broken install) → logger.error + process.exit(1), NOT community no-op", async () => {
    const exitSpy = mockProcessExit();
    // resolve succeeds (package is "installed"), but load throws
    // (ERR_REQUIRE_ESM / SyntaxError / etc).
    __pluginResolver.resolve = jest.fn(() => "/fake/path/enterprise.js");
    __pluginResolver.load = jest.fn(() => {
      throw new Error("ERR_REQUIRE_ESM");
    });

    await expect(loadEnterprisePlugin(fakeApp)).rejects.toThrow("__PROCESS_EXIT__");
    expect(logger.error).toHaveBeenCalledWith(
      "[enterprise] Enterprise package found but failed to load",
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
});

// ─── D-12 integration test — mountProtected auth (SC-2, SC-4) ───────────────
// Uses createApp() (real Express app) + supertest + the __pluginResolver seam
// to mount a MOCK enterprise plugin (not the real package — the real package
// lives in the private repo). Asserts the health route returns 200 with a
// valid Bearer JWT + mocked user (SC-2) and 401 without Authorization (SC-4).
// PITFALL 1: the 200 test MUST mock prisma.user.findUnique to return a user —
// authMiddleware calls getCachedUserWithRoles → authService → prisma; a mock
// returning null → 401 even with a valid token.

describe("enterprise integration — mountProtected auth (SC-2, SC-4, D-07)", () => {
  // Handle to the factory-created redisService mock (mirrors auth.test.ts).
  const { getRedis: mockGetRedis } = jest.requireMock("../services/redisService") as {
    getRedis: jest.Mock;
  };

  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    // Redis absent — authMiddleware degrades gracefully (no jti revocation).
    mockGetRedis.mockReturnValue(null);

    // Mock plugin with a real Express Router mounting /health.
    const router = Router();
    router.get("/health", (_req, res) => res.json({ status: "ok", enterprise: true }));

    const mockPlugin = {
      apiVersion: 1,
      register: jest.fn((ctx: { mountProtected: (r: unknown) => void }) => {
        ctx.mountProtected(router);
      }),
    };

    // Inject the mock plugin via the __pluginResolver seam (D-05 two-step).
    __pluginResolver.resolve = jest.fn(() => "/fake/enterprise");
    __pluginResolver.load = jest.fn(() => ({ __esModule: true, default: mockPlugin }));

    app = createApp();
    await loadEnterprisePlugin(app);
    // Mount the 404 + error catch-all AFTER loadEnterprisePlugin so enterprise
    // routes (added by the plugin) are registered before the catch-all and are
    // reachable. createApp() deliberately omits the catch-all for this reason.
    mountCatchAlls(app);
  });

  it("SC-4: returns 401 without Authorization header", async () => {
    const res = await request(app).get("/api/enterprise/health");
    expect(res.status).toBe(401);
  });

  it("SC-2: returns 200 { status: 'ok', enterprise: true } with valid token + mocked user", async () => {
    // PITFALL 1: authMiddleware fetches the user via getCachedUserWithRoles →
    // prisma.user.findUnique. A mock returning null → 401 even with a valid
    // token. Mock it to return adminUser (helpers/mockAuth.ts).
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
    const token = generateTestToken("admin-001");
    const res = await request(app)
      .get("/api/enterprise/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", enterprise: true });
  });
});
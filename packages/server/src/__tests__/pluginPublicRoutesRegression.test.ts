// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 148 (EPA-12 — SC-1 D-02) — Enterprise plugin `mountPublic` routes
 * regression guard.
 *
 * Asserts the 3 `ctx.mountPublic(...)` routes mounted by the real
 * enterprise `register(ctx)` are registered WITHOUT `authMiddleware`
 * (D-02). These are intentionally unauthenticated Express mounts:
 *   - `/api/auth` (SAML — IdP-initiated callbacks, no JWT at entry)
 *   - `/api/auth` (OIDC — browser redirect flow, no JWT at entry)
 *   - `/scim/v2` (SCIM 2.0 — applies its own `scimAuth` Bearer token
 *     internally; NOT a JWT)
 *
 * Adding `authMiddleware` to these mounts would break SAML/OIDC SSO
 * (the IdP POSTs an assertion to /api/auth/saml/callback with no
 * Authorization header) and break SCIM (external IdPs push with a
 * SCIM Bearer token, not the community JWT). This test catches that
 * regression at the loader-shim level.
 *
 * The test does NOT assert 401 on these routes (Pitfall: they're
 * intentionally unauthenticated at the Express mount level — SCIM
 * applies its own Bearer auth internally).
 *
 * Mechanism: mirrors `pluginAuthBoundary.test.ts` — dynamic
 * `require("@simmetric-chat/enterprise")` with try/catch skip (D-01,
 * Pitfall 7) + `__pluginResolver` override (Pattern 1) + real
 * `express()` app with `jest.spyOn(app, "use")` (OQ-02).
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
  clearLimitOverrides: jest.fn(),
}));

jest.mock("../services/authService", () => {
  const actual = jest.requireActual("../services/authService");
  return {
    ...actual,
    generateToken: jest.fn((userId: string) => `mock-jwt-for-${userId}`),
  };
});
jest.mock("../services/encryptionService", () => {
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
  registerConfigKeyValidator: jest.fn(),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/hybridSearchService", () => ({
  checkCollectorHealth: jest.fn().mockResolvedValue({ reachable: true }),
  hybridSearch: jest.fn(),
  multiWorkspaceHybridSearch: jest.fn(),
}));
jest.mock("../services/eventLogService", () => ({
  setAuditLogDelegate: jest.fn(),
  logEvent: jest.fn(),
}));

import express, { type Express } from "express";
import { authMiddleware } from "../middleware/auth";
import {
  loadEnterprisePlugin,
  __pluginResolver,
} from "../services/enterpriseLoader";

type EnterprisePlugin = {
  apiVersion: number;
  register: (ctx: unknown) => void | Promise<void>;
};

// D-01 / Pitfall 7: dynamic require.resolve with try/catch skip.
// NOTE: we do NOT inject the REAL enterprise plugin (ESM imports fail under
// Jest CJS — see pluginAuthBoundary.test.ts for the full NOTE). A STUB plugin
// replicating the 3 mountPublic call pattern is sufficient: this test guards
// that the shim does NOT apply authMiddleware to mountPublic routes.
let enterprisePluginAvailable = false;
try {
  require.resolve("@simmetric-chat/enterprise");
  enterprisePluginAvailable = true;
} catch (e: { code?: string }) {
  if (e.code !== "MODULE_NOT_FOUND") throw e;
  enterprisePluginAvailable = false;
}

// Stub plugin mirroring the real enterprise register(ctx) mountPublic pattern.
const stubEnterprisePlugin: EnterprisePlugin = {
  apiVersion: 1,
  register: (ctx: unknown) => {
    const c = ctx as {
      mountProtected: (pathOrRouter: string | unknown, routerArg?: unknown) => void;
      mountPublic: (pathOrRouter: string | unknown, routerArg?: unknown) => void;
    };
    const mk = () => {
      const r = express.Router();
      r.get("/_stub", (_req, res) => res.json({ ok: true }));
      return r;
    };
    // The real register(ctx) also makes 9 mountProtected calls — replicate
    // them so the full mount sequence matches (the test filters for
    // mountPublic calls only, so the mountProtected calls are noise here).
    c.mountProtected("/api/enterprise/modules", mk());
    c.mountProtected(mk());
    c.mountProtected("/api/sso", mk());
    c.mountProtected("/api/event-logs", mk());
    c.mountProtected("/api/system/settings/branding", mk());
    c.mountProtected("/api/system/backups", mk());
    c.mountProtected("/api/backup-destinations", mk());
    c.mountProtected("/api/backup-jobs", mk());
    c.mountProtected("/api/backups", mk());
    // The 3 mountPublic calls under test (F-03):
    c.mountPublic("/api/auth", mk());
    c.mountPublic("/api/auth", mk());
    c.mountPublic("/scim/v2", mk());
  },
};

const realResolve = __pluginResolver.resolve.bind(__pluginResolver);
const realLoad = __pluginResolver.load.bind(__pluginResolver);

/** The 3 mountPublic paths enumerated by F-03 (enterprise register(ctx)). */
const EXPECTED_PUBLIC_PATHS = ["/api/auth", "/api/auth", "/scim/v2"];

(enterprisePluginAvailable ? describe : describe.skip)(
  "plugin mountPublic regression — IdP/SCIM routes registered WITHOUT authMiddleware (D-02, SC-1)",
  () => {
    let app: Express;
    let useSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.clearAllMocks();
      __pluginResolver.resolve = realResolve;
      __pluginResolver.load = realLoad;

      app = express();
      useSpy = jest.spyOn(app, "use");

      __pluginResolver.resolve = jest.fn(
        () => "/fake/node_modules/@simmetric-chat/enterprise/index.js",
      );
      __pluginResolver.load = jest.fn(() => ({
        __esModule: true,
        default: stubEnterprisePlugin,
      }));
    });

    afterEach(() => {
      useSpy.mockRestore();
      __pluginResolver.resolve = realResolve;
      __pluginResolver.load = realLoad;
    });

    it("registers exactly 3 mountPublic routes (F-03)", async () => {
      await loadEnterprisePlugin(app);

      // mountPublic calls app.use(path, router) — 2 args, NO authMiddleware.
      // Filter for calls where the first arg is a string path AND the
      // second arg is NOT authMiddleware (it's a Router). This excludes
      // the 9 mountProtected calls (3 args, second === authMiddleware).
      const publicCalls = useSpy.mock.calls.filter(
        (args: unknown[]) =>
          typeof args[0] === "string" &&
          args.length === 2 &&
          args[1] !== authMiddleware,
      );
      expect(publicCalls).toHaveLength(3);

      const paths = publicCalls.map((args: unknown[]) => args[0] as string);
      // /api/auth appears twice (SAML + OIDC both mount there).
      expect(paths).toEqual(EXPECTED_PUBLIC_PATHS);
    });

    it("NONE of the mountPublic calls pass authMiddleware as a middleware arg (D-02 regression guard)", async () => {
      await loadEnterprisePlugin(app);

      // Every app.use call for a mountPublic path must be the 2-arg form
      // (path, router) — NEVER the 3-arg form (path, authMiddleware, router).
      // Adding authMiddleware to /api/auth would break SAML/OIDC IdP
      // callbacks; adding it to /scim/v2 would break SCIM (external IdPs
      // use a SCIM Bearer token, not the community JWT).
      const publicCalls = useSpy.mock.calls.filter(
        (args: unknown[]) =>
          typeof args[0] === "string" &&
          (args[0] === "/api/auth" || args[0] === "/scim/v2"),
      );
      for (const call of publicCalls) {
        // The call must NOT include authMiddleware in any position.
        expect(call).not.toContain(authMiddleware);
        // And it must be the 2-arg form (path, router).
        expect(call).toHaveLength(2);
      }
      // 3 mountPublic calls total: 2x /api/auth (SAML + OIDC) + 1x /scim/v2.
      expect(publicCalls).toHaveLength(3);
    });
  },
);
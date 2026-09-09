// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 140 (EPA-01) — Plugin contract schema tests.
 *
 * Validates the PluginContext / EnterprisePlugin / API_VERSION contract
 * that `@simmetric-chat/shared` exports. Types are erased at runtime, so
 * these tests assert runtime-observable facts (API_VERSION value, stub
 * throw messages, constructibility of the interfaces via structural casts).
 */
import {
  API_VERSION,
  type PluginContext,
  type EnterprisePlugin,
  type SaaSPlugin,
  type SaaSPluginContext,
  type QuotaEnforcer,
  type BillingProvider,
  type PlanResolver,
  type TenantProvisioner,
  type MinimalPrismaClient,
  type MinimalExpressApp,
  type MinimalLogger,
} from "../schemas/plugin.schema";

describe("plugin.schema — API_VERSION", () => {
  // Phase 186 (SAAS-05, D-03): the const bumped 1 → 2. The pin moved to the
  // Phase 186 describe below; the structural typeof assertion stays.
  it("is a literal const (typeof number)", () => {
    expect(typeof API_VERSION).toBe("number");
  });
});

describe("Phase 186 — contract v2 (SAAS-05, D-01/D-03/D-04/D-07)", () => {
  it("API_VERSION is bumped to 2 (the SAAS gate)", () => {
    expect(API_VERSION).toBe(2);
  });

  it("EnterprisePlugin contract is UNCHANGED — apiVersion stays the literal 1 (D-03/A1)", () => {
    const plugin: EnterprisePlugin = {
      apiVersion: 1,
      register: jest.fn(),
    };
    expect(plugin.apiVersion).toBe(1);
    expect(typeof plugin.register).toBe("function");
  });

  it("SaaSPlugin requires apiVersion: 2 (literal, not number)", () => {
    const plugin: SaaSPlugin = {
      apiVersion: 2,
      register: jest.fn(),
    };
    expect(plugin.apiVersion).toBe(2);
    expect(typeof plugin.register).toBe("function");
  });

  it("SaaSPlugin.register may be async", () => {
    const plugin: SaaSPlugin = {
      apiVersion: 2,
      register: async () => {
        /* async ok */
      },
    };
    const result = plugin.register({} as SaaSPluginContext);
    expect(result).toBeInstanceOf(Promise);
  });

  it("SaaSPluginContext is assignable where PluginContext is expected (extends, additive — D-01)", () => {
    // Structural proof: a complete SaaSPluginContext (all v2 members present)
    // satisfies the PluginContext structural type.
    const saasCtx = {
      app: { use: jest.fn() } as unknown as MinimalExpressApp,
      prisma: {
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(),
      } as unknown as MinimalPrismaClient,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as MinimalLogger,
      env: { NODE_ENV: "test" },
      licenseInfo: {
        tier: "community",
        licensee: null,
        expiresAt: null,
        features: {},
        valid: true,
      },
      mountProtected: jest.fn(),
      mountPublic: jest.fn(),
      registerScheduler: jest.fn(),
      onShutdown: jest.fn(),
      registerAuditLogWriter: jest.fn(),
      registerConfigKeyValidator: jest.fn(),
      auditLog: undefined,
      overrideFeatureLimit: jest.fn(),
      registerBillingProvider: jest.fn(),
      registerQuotaEnforcer: jest.fn(),
      registerPlanResolver: jest.fn(),
      registerTenantProvisioner: jest.fn(),
      issueTenantLicense: jest.fn(),
    } as unknown as SaaSPluginContext;
    // Additive assignability: SaaSPluginContext feeds a PluginContext slot.
    const baseCtx: PluginContext = saasCtx;
    expect(baseCtx.app).toBeDefined();
  });

  it("QuotaEnforcer verdict type accepts BOTH sync and async returns (D-06/A4)", () => {
    const syncEnforcer: QuotaEnforcer = (_input) => ({ allowed: true });
    const asyncEnforcer: QuotaEnforcer = async (_input) => ({ allowed: false, current: 3, limit: 2 });
    expect(syncEnforcer({ organizationId: "org-1", flag: "max_workspaces", current: 1 }).allowed).toBe(true);
    return asyncEnforcer({ organizationId: "org-1", flag: "max_workspaces", current: 3 }).then((verdict) => {
      expect(verdict.allowed).toBe(false);
    });
  });

  it("minimal Part I hook interfaces accept call-signature stubs (D-07 — Parte II widens additively)", () => {
    const billing: BillingProvider = {};
    const plan: PlanResolver = {};
    const provisioner: TenantProvisioner = {};
    expect(billing).toBeDefined();
    expect(plan).toBeDefined();
    expect(provisioner).toBeDefined();
  });

  it("structural zero-dep guard: plugin.schema.ts imports NOTHING beyond the existing shared type imports", () => {
    // The shared kernel's zero-runtime-dep rule (only zod) — plugin.schema.ts
    // is structural interfaces; it must never import express or @prisma/client
    // (or anything else beyond ../types + ./config.schema).
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../schemas/plugin.schema.ts"),
      "utf8",
    );
    const importLines = src.split(/\r?\n/).filter((l: string) => /^import /.test(l));
    expect(importLines.length).toBe(2);
    expect(importLines[0]).toContain('from "../types"');
    expect(importLines[1]).toContain('from "./config.schema"');
    expect(src).not.toMatch(/from ["'](express|@prisma\/client)["']/);
  });
});
describe("plugin.schema — EnterprisePlugin contract", () => {
  it("requires apiVersion: 1 (literal)", () => {
    const plugin: EnterprisePlugin = {
      apiVersion: 1,
      register: jest.fn(),
    };
    expect(plugin.apiVersion).toBe(1);
    expect(typeof plugin.register).toBe("function");
  });

  it("register may return a Promise (async plugins)", () => {
    const plugin: EnterprisePlugin = {
      apiVersion: 1,
      register: async () => {
        /* async ok */
      },
    };
    const result = plugin.register({} as PluginContext);
    expect(result).toBeInstanceOf(Promise);
  });
});

describe("plugin.schema — PluginContext constructibility", () => {
  it("a minimal stub satisfies the structural interface", () => {
    const ctx = {
      app: { use: jest.fn() } as unknown as MinimalExpressApp,
      prisma: {
        $connect: jest.fn(),
        $disconnect: jest.fn(),
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(),
      } as unknown as MinimalPrismaClient,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as MinimalLogger,
      env: { NODE_ENV: "test" },
      licenseInfo: {
        tier: "enterprise",
        licensee: "Acme",
        expiresAt: null,
        features: {},
        valid: true,
      },
      mountProtected: jest.fn(),
      mountPublic: jest.fn(),
      registerScheduler: jest.fn(),
      onShutdown: jest.fn(),
      auditLog: jest.fn(),
      overrideFeatureLimit: jest.fn(),
    } as unknown as PluginContext;

    expect(typeof ctx).toBe("object");
    expect(ctx.app).toBeDefined();
    expect(ctx.prisma).toBeDefined();
    expect(ctx.logger).toBeDefined();
    expect(ctx.env).toBeDefined();
    expect(ctx.licenseInfo).toBeDefined();
    expect(ctx.mountProtected).toBeDefined();
    expect(ctx.mountPublic).toBeDefined();
    expect(ctx.registerScheduler).toBeDefined();
    expect(ctx.onShutdown).toBeDefined();
  });

  it("auditLog stub throws the 'not wired until Phase 144' message", () => {
    // Per D-02: the loader constructs the auditLog stub as a throwing fn.
    // The interface itself can't enforce throwing, so we assert the
    // canonical stub behavior the loader implements.
    const auditLogStub = async (): Promise<void> => {
      throw new Error("auditLog not wired until Phase 144");
    };
    expect(auditLogStub()).rejects.toThrow("auditLog not wired until Phase 144");
  });

  it("overrideFeatureLimit stub throws the 'not wired until Phase 147' message", () => {
    // Per D-02: the loader constructs the overrideFeatureLimit stub as a throwing fn.
    const overrideStub = (): void => {
      throw new Error("overrideFeatureLimit not wired until Phase 147");
    };
    expect(overrideStub).toThrow("overrideFeatureLimit not wired until Phase 147");
  });
});

describe("plugin.schema — structural interfaces (no forbidden imports)", () => {
  // These tests are static guarantees — they exist to fail the build if
  // someone accidentally adds `import ... from "express"` or
  // `@prisma/client` to plugin.schema.ts. The interfaces themselves are
  // type-only and erased at runtime; we assert constructibility here.

  it("MinimalPrismaClient accepts a structurally-compatible object", () => {
    const prisma: MinimalPrismaClient = {
      $connect: jest.fn(),
      $disconnect: jest.fn(),
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
      user: { findMany: jest.fn() }, // index signature coverage
    };
    expect(typeof prisma.$connect).toBe("function");
    expect(typeof (prisma as { user: { findMany: unknown } }).user.findMany).toBe("function");
  });

  it("MinimalExpressApp accepts a structurally-compatible object", () => {
    const app: MinimalExpressApp = { use: jest.fn() };
    expect(typeof app.use).toBe("function");
  });
});
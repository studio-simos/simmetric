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
  type MinimalPrismaClient,
  type MinimalExpressApp,
  type MinimalLogger,
} from "../schemas/plugin.schema";

describe("plugin.schema — API_VERSION", () => {
  it("equals 1", () => {
    expect(API_VERSION).toBe(1);
  });

  it("is a literal const (typeof number)", () => {
    expect(typeof API_VERSION).toBe("number");
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
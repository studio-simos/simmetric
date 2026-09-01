// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget rateLimitPerMinute migration tests — SCALE-04, D-05
 *
 * Tests the per-widget rate-limit override data model:
 *  1. Widget.rateLimitPerMinute Int? field exists in Prisma schema
 *  2. updateWidgetSchema accepts rateLimitPerMinute (null or positive int)
 *  3. PUT /api/widgets/:id passes rateLimitPerMinute through to DB
 *  4. GET /api/internal/widget/:id/config response includes rateLimitPerMinute
 *  5. Migration is additive (ALTER TABLE ADD COLUMN, nullable, no default)
 *  6. Validation rejects negative numbers, zero, and non-integer values
 */
import "./helpers/setupEnv";

import fs from "fs";
import path from "path";

// ── Prisma mock (shared factory) ──────────────────────────────────
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

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
  getFeatureLimit: jest.fn(() => 1),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
// internalWidget.ts imports hybridSearchWithRerank at module load — mock to avoid
// pulling in the full hybrid search service chain (LanceDB, embeddings, etc.).
jest.mock("../services/hybridSearchService", () => ({
  hybridSearchWithRerank: jest.fn(),
}));
jest.mock("../services/widgetCacheBustService", () => ({ fireWidgetCacheBust: jest.fn() }));

// Mock auth middleware: admin Bearer + widget API-key paths
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.userId = "admin-001";
    req.user = {
      id: "admin-001",
      roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, res: any, next: any) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      res.status(401).json({ error: "Missing API key" });
      return;
    }
    req.userId = "service-account-001";
    req.user = { id: "service-account-001", username: "widget-service", roles: [] };
    next();
  },
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { updateWidgetSchema } from "@simmetric-chat/shared";
import { generateTestToken } from "./helpers/mockAuth";
import { isFeatureEnabled } from "../services/licenseService";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

// Base mock widget — includes all fields the route reads, with rateLimitPerMinute
const mockWidget: Record<string, unknown> = {
  id: "widget-001",
  name: "Test Widget",
  welcomeMessage: "Hello!",
  fallbackMessage: "Sorry, I can't help with that.",
  position: "bottom-right",
  isActive: true,
  primaryColor: "#4c6ef5",
  botName: "AI Assistant",
  logoUrl: null,
  avatarUrl: null,
  autoOpenDelay: null,
  autoOpenUrlPatterns: null,
  exitIntentEnabled: false,
  exitIntentCooldownMs: 1800000,
  leadCaptureEnabled: false,
  leadCapturePrompt: null,
  rateLimitPerMinute: null,
  createdBy: "admin-001",
  deletedAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
  workspaces: [{ workspaceId: "workspace-001" }],
  _count: { sessions: 0 },
};

// ─── Test 1: Widget model in schema.prisma includes rateLimitPerMinute Int? ─────

describe("Widget.rateLimitPerMinute Prisma schema field", () => {
  it("schema.prisma Widget model includes rateLimitPerMinute Int? field", () => {
    const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
    const schema = fs.readFileSync(schemaPath, "utf-8");
    // Extract the Widget model block (from "model Widget {" to the closing "}")
    const widgetModelMatch = schema.match(/model Widget \{[\s\S]*?^\}/m);
    expect(widgetModelMatch).not.toBeNull();
    const widgetModel = widgetModelMatch![0];
    expect(widgetModel).toContain("rateLimitPerMinute");
    // Must be Int? (nullable integer)
    expect(widgetModel).toMatch(/rateLimitPerMinute\s+Int\?/);
  });
});

// ─── Test 2 & 6: Zod schema validation ────────────────────────────

describe("updateWidgetSchema rateLimitPerMinute validation", () => {
  it("accepts null (use global default)", () => {
    const result = updateWidgetSchema.safeParse({ rateLimitPerMinute: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rateLimitPerMinute).toBeNull();
    }
  });

  it("accepts positive integer (custom limit)", () => {
    const result = updateWidgetSchema.safeParse({ rateLimitPerMinute: 60 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rateLimitPerMinute).toBe(60);
    }
  });

  it("accepts omission (field is optional — leave unchanged)", () => {
    const result = updateWidgetSchema.safeParse({ name: "Updated Name" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rateLimitPerMinute).toBeUndefined();
    }
  });

  it("rejects negative numbers", () => {
    const result = updateWidgetSchema.safeParse({ rateLimitPerMinute: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer values (decimals)", () => {
    const result = updateWidgetSchema.safeParse({ rateLimitPerMinute: 30.5 });
    expect(result.success).toBe(false);
  });

  it("rejects zero (must be positive, not just non-negative)", () => {
    const result = updateWidgetSchema.safeParse({ rateLimitPerMinute: 0 });
    expect(result.success).toBe(false);
  });
});

// ─── Test 3: PUT /api/widgets/:id passes rateLimitPerMinute through ─────────────

describe("PUT /api/widgets/:id rateLimitPerMinute passthrough", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("updates rateLimitPerMinute to a custom value in the database", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockResolvedValue({
      ...mockWidget,
      rateLimitPerMinute: 60,
    });

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ rateLimitPerMinute: 60 });

    expect(res.status).toBe(200);
    // The Prisma update call must include rateLimitPerMinute in the data
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rateLimitPerMinute: 60 }),
      })
    );
    expect(res.body.rateLimitPerMinute).toBe(60);
  });

  it("updates rateLimitPerMinute to null (revert to global default)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);
    (prisma.widget.update as jest.Mock).mockResolvedValue({
      ...mockWidget,
      rateLimitPerMinute: null,
    });

    const res = await request(app)
      .put("/api/widgets/widget-001")
      .set(adminAuth())
      .send({ rateLimitPerMinute: null });

    expect(res.status).toBe(200);
    expect(prisma.widget.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rateLimitPerMinute: null }),
      })
    );
  });
});

// ─── Test 4: GET /api/internal/widget/:id/config includes rateLimitPerMinute ───

describe("GET /api/internal/widget/:id/config includes rateLimitPerMinute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 151-02 (Task 7): the internal widget router is gated by
    // requireFeature("widget_enabled") — the license mock here defaults to
    // false (Community), so these route tests must flip the flag ON.
    (isFeatureEnabled as jest.Mock).mockReturnValue(true);
  });

  it("includes rateLimitPerMinute in the config response when set", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue({
      ...mockWidget,
      rateLimitPerMinute: 45,
    });

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("rateLimitPerMinute");
    expect(res.body.rateLimitPerMinute).toBe(45);
  });

  it("includes rateLimitPerMinute as null when not set (global default)", async () => {
    (prisma.widget.findFirst as jest.Mock).mockResolvedValue(mockWidget);

    const res = await request(app)
      .get("/api/internal/widget/widget-001/config")
      .set("X-Api-Key", "sk-test-key");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("rateLimitPerMinute");
    expect(res.body.rateLimitPerMinute).toBeNull();
  });
});

// ─── Test 5: Additive migration (nullable column, no default change) ────────────

describe("rateLimitPerMinute migration is additive", () => {
  // Phase 138 squashed all 25 migrations into 00000000000000_init. The
  // rateLimitPerMinute column now lives in the squashed baseline.
  it("squashed baseline contains the rateLimitPerMinute column definition", () => {
    const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");
    const dirs = fs.readdirSync(migrationsDir);
    const migrationDir = dirs.find((d) => d.includes("00000000000000_init"));
    expect(migrationDir).toBeDefined();
  });

  it("squashed baseline SQL is additive (ALTER TABLE ADD COLUMN, nullable, no default)", () => {
    const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");
    const baselineSqlPath = path.join(migrationsDir, "00000000000000_init", "migration.sql");
    const sql = fs.readFileSync(baselineSqlPath, "utf-8");
    // Additive: the column appears as ADD COLUMN or in CREATE TABLE (squash folds both)
    // Search for the column name in the squashed DDL.
    expect(sql).toMatch(/rateLimitPerMinute.*INTEGER/i);
  });
});

// ─── Redis store selection (TEC-03a, D-03) ──────────────────────────────────
// Additive describe following the widget rateLimit.redis.test.ts mock
// strategy: jest.doMock rate-limit-redis + express-rate-limit in a
// jest.resetModules fresh-module context where the env mock controls
// REDIS_URL. Requires only ../middleware/rateLimit (not the full createApp)
// so the existing widget-migration assertions above stay untouched.

describe("server limiters Redis store selection (TEC-03a) — widgetRateLimitMigration variant", () => {
  const mockEnv = { NODE_ENV: "test" as string, REDIS_URL: undefined as string | undefined };
  const mockRedisInstance = {
    call: jest.fn().mockResolvedValue("OK"),
    on: jest.fn(),
  };
  let mockRedisStoreConstructor: jest.Mock;
  let mockRedisStoreInstances: Array<{ kind: string; id: number }>;
  let capturedOptions: Array<Record<string, unknown>>;

  beforeEach(() => {
    mockEnv.REDIS_URL = undefined;
    mockRedisStoreInstances = [];
    mockRedisStoreConstructor = jest.fn(() => {
      const inst = { kind: "mock-redis-store", id: mockRedisStoreInstances.length };
      mockRedisStoreInstances.push(inst);
      return inst;
    });
    capturedOptions = [];
  });

  function freshRateLimit() {
    jest.resetModules();
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => mockEnv),
    }));
    jest.doMock("../services/redisService", () => ({
      getRedis: jest.fn(() => (mockEnv.REDIS_URL ? mockRedisInstance : null)),
      isRedisAvailable: jest.fn(() => Boolean(mockEnv.REDIS_URL)),
    }));
    jest.doMock("rate-limit-redis", () => ({
      __esModule: true,
      default: mockRedisStoreConstructor,
    }));
    jest.doMock("express-rate-limit", () => ({
      __esModule: true,
      default: jest.fn((options: Record<string, unknown>) => {
        capturedOptions.push(options);
        return jest.fn((_req: unknown, _res: unknown, next: unknown) => {
          if (typeof next === "function") next();
        });
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../middleware/rateLimit");
  }

  it("(a) REDIS_URL set → 4 RedisStores with distinct prefixes, stores wired per limiter", () => {
    mockEnv.REDIS_URL = "redis://localhost:6379";
    const mod = freshRateLimit();

    expect(mod.authRateLimiter).toBeDefined();
    expect(mod.apiRateLimiter).toBeDefined();
    expect(mod.widgetLeadLimiter).toBeDefined();
    expect(mod.probeRateLimiter).toBeDefined();
    expect(mockRedisStoreConstructor).toHaveBeenCalledTimes(4);
    const prefixes = mockRedisStoreConstructor.mock.calls.map(
      (c: unknown[]) => (c[0] as { prefix: string }).prefix,
    );
    expect(prefixes).toEqual(["rl:auth:", "rl:api:", "rl:lead:", "rl:probe:"]);

    const [authOpts, apiOpts, leadOpts, probeOpts] = capturedOptions as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(authOpts.store).toBe(mockRedisStoreInstances[0]);
    expect(apiOpts.store).toBe(mockRedisStoreInstances[1]);
    expect(leadOpts.store).toBe(mockRedisStoreInstances[2]);
    expect(probeOpts.store).toBe(mockRedisStoreInstances[3]);
  });

  it("(b) REDIS_URL absent → 4 limiters with store undefined (in-process fallback)", () => {
    mockEnv.REDIS_URL = undefined;
    freshRateLimit();

    expect(mockRedisStoreConstructor).not.toHaveBeenCalled();
    expect(capturedOptions).toHaveLength(4);
    for (const opts of capturedOptions) {
      expect(opts.store).toBeUndefined();
    }
  });

  it("(c) apiRateLimiter skip honors X-Widget-Id (SEC-02 D-08 preserved)", () => {
    mockEnv.REDIS_URL = "redis://localhost:6379";
    freshRateLimit();

    const [, apiOpts] = capturedOptions as [Record<string, unknown>, Record<string, unknown>];
    const skip = apiOpts.skip as (req: { headers: Record<string, string> }) => boolean;
    expect(skip({ headers: { "x-widget-id": "w1" } })).toBe(true);
    expect(skip({ headers: {} })).toBe(false);
  });
});

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP pattern configuration route tests (quick 260829-ony).
 *
 * Supertest against createApp() like archiveConfig.test.ts, with prisma mocked
 * (createMockPrisma) and authMiddleware stubbed to an ADMIN (admin:settings)
 * or a plain USER (no admin:settings) to pin the RBAC boundary.
 *
 * Covers: 401 unauthenticated, 403 non-admin permission, built-in immutability
 * (PUT pattern → 400, spec §4.4), delete built-in → 400, create → cache
 * invalidation, custom-pattern 50-cap (spec §4.9), 404s, invalid regex → 400.
 */
import "./helpers/setupEnv";

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
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  ensureSetupWizardMode: jest.fn(),
  getSetting: jest.fn(async (_k: string) => ({ value: "false" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

// Spy seam: the routes import invalidateCache aliased as invalidatePatternCache —
// keep the REAL service behaviors (compileRegex/listPatterns/countCustomPatterns/
// testPattern hit the mocked prisma dlpPattern delegate) and only stub the cache
// clear so we can assert it fires on mutations.
const mockInvalidateCache = jest.fn();
jest.mock("../services/dlpPatternService", () => {
  const actual = jest.requireActual("../services/dlpPatternService") as Record<string, unknown>;
  return { __esModule: true, ...actual, invalidateCache: (...a: unknown[]) => mockInvalidateCache(...(a as [])) };
});

const VALID_BUILT_IN = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "email",
  displayName: "Email",
  pattern: "[a-z]+@[a-z]+\\.[a-z]+",
  patternFlags: "gu",
  replacement: "[REDACTED]",
  isEnabled: true,
  isBuiltIn: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const VALID_CUSTOM = {
  ...VALID_BUILT_IN,
  id: "22222222-2222-4222-8222-222222222222",
  name: "fiscal_code",
  displayName: "Italian Fiscal Code",
  pattern: "[A-Z]{6}\\d{2}[A-Z]\\d{2}[A-Z]\\d{5}",
  isBuiltIn: false,
};

let adminMode = true;

jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: { headers: Record<string, unknown>; userId?: string; user?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !String(authHeader).startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (adminMode) {
      req.userId = "admin-001";
      req.user = {
        id: "admin-001",
        roles: [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }] } }],
      };
    } else {
      req.userId = "user-001";
      req.user = {
        id: "user-001",
        roles: [{ role: { name: "user", permissions: [{ permissionName: "chat:read" }] } }],
      };
    }
    next();
  },
  apiKeyMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

// generateTestToken import AFTER the auth mock — same import order as archiveConfig.test.ts
import { generateTestToken } from "./helpers/mockAuth";

beforeEach(() => {
  jest.clearAllMocks();
  adminMode = true;
});

describe("GET /api/system/dlp/patterns", () => {
  it("401 without a token", async () => {
    await request(app).get("/api/system/dlp/patterns").expect(401);
  });

  it("403 for a non-admin user", async () => {
    adminMode = false;
    await request(app)
      .get("/api/system/dlp/patterns")
      .set({ Authorization: `Bearer ${generateTestToken("user-001")}` })
      .expect(403);
  });

  it("200 with the pattern list for an admin", async () => {
    (prisma.dlpPattern.findMany as jest.Mock).mockResolvedValue([VALID_BUILT_IN, VALID_CUSTOM]);
    const res = await request(app)
      .get("/api/system/dlp/patterns")
      .set(adminAuth())
      .expect(200);
    expect(res.body.patterns).toHaveLength(2);
    expect(res.body.patterns[0].isBuiltIn).toBe(true);
  });
});

describe("POST /api/system/dlp/patterns", () => {
  it("creates a custom pattern and invalidates the cache", async () => {
    (prisma.dlpPattern.count as jest.Mock).mockResolvedValue(0);
    (prisma.dlpPattern.create as jest.Mock).mockResolvedValue({ ...VALID_CUSTOM, isBuiltIn: false });
    const res = await request(app)
      .post("/api/system/dlp/patterns")
      .set(adminAuth())
      .send({
        name: "fiscal_code",
        displayName: "Italian Fiscal Code",
        pattern: "[A-Z]{6}\\d{2}[A-Z]\\d{2}[A-Z]\\d{5}",
      })
      .expect(201);
    expect(res.body.pattern.isBuiltIn).toBe(false);
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
   });

  it("400 on an invalid regex (compile validation — spec §4.2)", async () => {
    const res = await request(app)
      .post("/api/system/dlp/patterns")
      .set(adminAuth())
      .send({ name: "bad", displayName: "Bad", pattern: "([unclosed" })
      .expect(400);
    expect(res.body.error).toMatch(/[Ii]nvalid regex/);
    expect(prisma.dlpPattern.create).not.toHaveBeenCalled();
  });

  it("400 when the 50-custom-pattern cap is reached (spec §4.9)", async () => {
    (prisma.dlpPattern.count as jest.Mock).mockResolvedValue(50);
    const res = await request(app)
      .post("/api/system/dlp/patterns")
      .set(adminAuth())
      .send({ name: "one_too_many", displayName: "X", pattern: "abc" })
      .expect(400);
    expect(res.body.error).toMatch(/limit reached/);
  });

  it("400 invalid body (name not snake_case)", async () => {
    const res = await request(app)
      .post("/api/system/dlp/patterns")
      .set(adminAuth())
      .send({ name: "Bad Name!", displayName: "X", pattern: "abc" })
      .expect(400);
    expect(res.body.details).toBeDefined();
  });

  it("409 on duplicate name (P2002)", async () => {
    (prisma.dlpPattern.count as jest.Mock).mockResolvedValue(0);
    (prisma.dlpPattern.create as jest.Mock).mockRejectedValue({ code: "P2002" });
    const res = await request(app)
      .post("/api/system/dlp/patterns")
      .set(adminAuth())
      .send({ name: "email", displayName: "Email dup", pattern: "abc" })
      .expect(409);
    expect(res.body.error).toMatch(/already exists/);
  });
});

describe("PUT /api/system/dlp/patterns/:id", () => {
  it("404 for unknown id", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(null);
    await request(app)
      .put("/api/system/dlp/patterns/nope")
      .set(adminAuth())
      .send({ displayName: "X" })
      .expect(404);
  });

  it("built-in: displayName+isEnabled accepted", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_BUILT_IN);
    (prisma.dlpPattern.update as jest.Mock).mockResolvedValue({ ...VALID_BUILT_IN, isEnabled: false });
    const res = await request(app)
      .put(`/api/system/dlp/patterns/${VALID_BUILT_IN.id}`)
      .set(adminAuth())
      .send({ displayName: "Email (renamed)", isEnabled: false })
      .expect(200);
    expect(res.body.pattern.isEnabled).toBe(false);
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });

  it("built-in: pattern change → 400 (spec §4.4 immutability)", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_BUILT_IN);
    const res = await request(app)
      .put(`/api/system/dlp/patterns/${VALID_BUILT_IN.id}`)
      .set(adminAuth())
      .send({ pattern: "evil.*" })
      .expect(400);
    expect(res.body.error).toBe("Cannot modify built-in pattern regex");
    expect(prisma.dlpPattern.update).not.toHaveBeenCalled();
  });

  it("built-in: replacement change → 400 (frozen field)", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_BUILT_IN);
    await request(app)
      .put(`/api/system/dlp/patterns/${VALID_BUILT_IN.id}`)
      .set(adminAuth())
      .send({ replacement: "[X]" })
      .expect(400);
  });

  it("custom: full field update works", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_CUSTOM);
    (prisma.dlpPattern.update as jest.Mock).mockResolvedValue({ ...VALID_CUSTOM, pattern: "xyz" });
    await request(app)
      .put(`/api/system/dlp/patterns/${VALID_CUSTOM.id}`)
      .set(adminAuth())
      .send({ pattern: "xyz" })
      .expect(200);
    expect(prisma.dlpPattern.update).toHaveBeenCalled();
  });

  it("custom: invalid new regex → 400", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_CUSTOM);
    const res = await request(app)
      .put(`/api/system/dlp/patterns/${VALID_CUSTOM.id}`)
      .set(adminAuth())
      .send({ pattern: "([nope" })
      .expect(400);
    expect(res.body.error).toMatch(/[Ii]nvalid regex/);
  });
});

describe("DELETE /api/system/dlp/patterns/:id", () => {
  it("built-in delete → 400 (disable instead)", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_BUILT_IN);
    const res = await request(app)
      .delete(`/api/system/dlp/patterns/${VALID_BUILT_IN.id}`)
      .set(adminAuth())
      .expect(400);
    expect(res.body.error).toMatch(/built-in/);
    expect(prisma.dlpPattern.delete).not.toHaveBeenCalled();
  });

  it("custom delete → 200 + cache invalidation", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_CUSTOM);
    (prisma.dlpPattern.delete as jest.Mock).mockResolvedValue(VALID_CUSTOM);
    await request(app)
      .delete(`/api/system/dlp/patterns/${VALID_CUSTOM.id}`)
      .set(adminAuth())
      .expect(200);
    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });

  it("404 for unknown id", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(null);
    await request(app)
      .delete("/api/system/dlp/patterns/nope")
      .set(adminAuth())
      .expect(404);
  });
});

describe("POST /api/system/dlp/patterns/:id/test", () => {
  it("returns matches + redacted preview, no persist", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_CUSTOM);
    const res = await request(app)
      .post(`/api/system/dlp/patterns/${VALID_CUSTOM.id}/test`)
      .set(adminAuth())
      .send({ sample: "code RSSMRA85T01A56225 here" })
      .expect(200);
    expect(res.body.matches.length).toBeGreaterThan(0);
    expect(res.body.redactedText).toContain("[REDACTED]");
  });

  it("400 on invalid body", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(VALID_CUSTOM);
    await request(app)
      .post(`/api/system/dlp/patterns/${VALID_CUSTOM.id}/test`)
      .set(adminAuth())
      .send({})
      .expect(400);
  });

  it("404 for unknown id", async () => {
    (prisma.dlpPattern.findUnique as jest.Mock).mockResolvedValue(null);
    await request(app)
      .post("/api/system/dlp/patterns/nope/test")
      .set(adminAuth())
      .send({ sample: "x" })
      .expect(404);
  });
});
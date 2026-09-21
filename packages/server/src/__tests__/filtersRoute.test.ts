// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 100 — Plan 100-02.
 *
 * Unit tests (supertest) for the filters admin API (GET /api/filters,
 * PATCH /api/filters/:name) covering PLG-01 / D-04 / D-08 / D-09:
 *   - GET list (admin) → 200 with plugin descriptor array
 *   - GET list (non-admin) → 403
 *   - GET list (no auth) → 401
 *   - PATCH enable/disable (admin) → 200, writes SystemConfig (find-first shape), audit log
 *   - PATCH unknown plugin → 404
 *   - PATCH invalid body → 400 with details
 *   - PATCH non-admin → 403
 *   - PERMISSION_NAMES includes 'filters:manage' as 31st entry
 *
 * Strategy: mount ONLY the filters router on a minimal Express app with
 * mocked middleware so auth/RBAC behavior is controllable per-test. This
 * isolates route logic from the full createApp() machinery (mirrors
 * chatRetention.route.test.ts pattern).
 */
import "./helpers/setupEnv";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";

// --- Prisma mock ----------------------------------------------------------
// Phase 183 (SAAS-02): upsertSystemConfigRow's find-first surface — the route
// no longer issues keyed writes.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    // Phase 185 (185-02): tenantContextMiddleware (D-09) resolves the org via
    // organizationMember.findFirst — live default-org membership keeps the
    // single-org suite responses byte-identical.
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue({ organizationId: "org-default" }),
    },
    systemConfig: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

// --- systemConfigService mock ---------------------------------------------
// Phase 183 (SAAS-02): the PATCH write routes through upsertSystemConfigRow —
// mock it at the module boundary and assert its call surface.
jest.mock("../services/systemConfigService", () => ({
  upsertSystemConfigRow: jest.fn().mockResolvedValue({}),
}));

// --- eventLogService mock -------------------------------------------------
jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));
const mockLogEvent = require("../services/eventLogService").logEvent as jest.Mock;

// --- logger mock ----------------------------------------------------------
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- filterRegistry mock --------------------------------------------------
// The route imports getAllFilters/getFilter from ../filters/filterRegistry.
// We mock the registry so the route module can be imported in isolation and
// the plugin set is deterministic per-test. Mock fns live INSIDE the factory
// to avoid TDZ under @swc/jest (mirrors chatRetention.route.test.ts pattern).
jest.mock("../filters/filterRegistry", () => ({
  __esModule: true,
  getAllFilters: jest.fn(),
  getFilter: jest.fn(),
}));
const mockGetAllFilters = require("../filters/filterRegistry").getAllFilters as jest.Mock;
const mockGetFilter = require("../filters/filterRegistry").getFilter as jest.Mock;

// --- auth/rbac mocks (controllable per-test via mockState) ----------------
type AuthMode = "ok" | "no-auth" | "no-permission";

jest.mock("../middleware/auth", () => {
  const mockState: { authMode: AuthMode; userId: string | null } = {
    authMode: "ok",
    userId: "admin-user-id",
  };
  return {
    authMiddleware: (req: Request, res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-auth") {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.userId = mockState.userId ?? undefined;
      (req as unknown as { user: unknown }).user = { id: mockState.userId };
      next();
    },
    __mockState: mockState,
  };
});

jest.mock("../middleware/rbac", () => {
  const mockState = require("../middleware/auth").__mockState;
  return {
  // Phase 189 (189-02 sweep): routes now import the graded middlewares —
  // the mock must export them (shadow no-op) or express throws at load.
  requireWorkspaceWriteAccess: () => (_req: any, _res: any, next: any) => next(),
  requireWorkspaceRead: () => (_req: any, _res: any, next: any) => next(),

    requirePermission: (_perm: string) => (req: Request, res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-permission") {
        res.status(403).json({ error: "Insufficient permissions" });
        return;
      }
      next();
    },
    requireAdmin: (req: Request, res: Response, next: NextFunction) => {
      if (mockState.authMode === "no-permission") {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
      next();
    },
  };
});
const mockState: { authMode: AuthMode; userId: string | null } = require("../middleware/auth").__mockState;

import filtersRoutes from "../routes/filters";
import { upsertSystemConfigRow } from "../services/systemConfigService";
// TS: the import binds the real function type; the jest.mock factory above
// replaces it at runtime — cast through unknown for the mock surface.
const mockUpsertHelper = upsertSystemConfigRow as unknown as jest.Mock;
import { PERMISSION_NAMES } from "@simmetric-chat/shared";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/filters", filtersRoutes);
  return app;
}

const dlpPlugin = {
  name: "dlp",
  priority: -1,
  enabled: true,
  inlet: jest.fn(),
  outlet: jest.fn(),
  outletStreaming: true,
  description: "DLP PII redaction",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockState.authMode = "ok";
  mockState.userId = "admin-user-id";
  mockGetAllFilters.mockReturnValue([dlpPlugin]);
  mockGetFilter.mockImplementation((name: string) =>
    name === "dlp" ? dlpPlugin : undefined,
  );
  mockPrisma.systemConfig.findFirst.mockResolvedValue(null);
  mockPrisma.systemConfig.update.mockResolvedValue({});
  mockPrisma.systemConfig.create.mockResolvedValue({});
  mockLogEvent.mockResolvedValue(undefined);
});

// ─── GET /api/filters ───────────────────────────────────────────────────

describe("GET /api/filters", () => {
  it("returns 200 with plugin descriptor array (admin)", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/filters");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: "dlp",
      priority: -1,
      enabled: true,
      hasInlet: true,
      hasOutlet: true,
      outletStreaming: true,
      description: "DLP PII redaction",
    });
  });

  it("returns 403 for non-admin (no filters:manage)", async () => {
    mockState.authMode = "no-permission";
    const app = buildApp();
    const res = await request(app).get("/api/filters");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Insufficient permissions" });
  });

  it("returns 401 without auth", async () => {
    mockState.authMode = "no-auth";
    const app = buildApp();
    const res = await request(app).get("/api/filters");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("hasInlet/hasOutlet false when plugin lacks hooks", async () => {
    const noHooks = { name: "noop", priority: 5, description: "" };
    mockGetAllFilters.mockReturnValue([noHooks]);
    const app = buildApp();
    const res = await request(app).get("/api/filters");

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      name: "noop",
      hasInlet: false,
      hasOutlet: false,
      outletStreaming: false,
      description: "",
    });
  });
});

// ─── PATCH /api/filters/:name ───────────────────────────────────────────

describe("PATCH /api/filters/:name", () => {
  it("disables a plugin (admin) → 200, writes SystemConfig find-first shape, audit log", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/filters/dlp")
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Filter "dlp" disabled' });

    // Helper-mediated write: assert upsertSystemConfigRow's call surface —
    // the mock prisma as db param + the global-row write args (dynamic
    // filter_* keys stay global-only, Phase-183 P3). The find-first probe
    // rides through the real helper against the mock prisma.
    expect(mockUpsertHelper).toHaveBeenCalledTimes(1);
    const [dbArg, writeArg] = mockUpsertHelper.mock.calls[0];
    expect(dbArg).toBe(mockPrisma);
    expect(writeArg).toEqual({ key: "filter_dlp_enabled", value: "false" });

    // Registry plugin.enabled mutated in-memory
    expect(dlpPlugin.enabled).toBe(false);

    // Audit log: logEvent('chat', 'system', 'filter.disable', userId, { pluginName })
    // entityId 'system' mirrors chatRetention.ts precedent (logEvent signature
    // requires string, not null — Rule 1 deviation from plan's null).
    expect(mockLogEvent).toHaveBeenCalledWith(
      "chat",
      "system",
      "filter.disable",
      "admin-user-id",
      { pluginName: "dlp" },
    );
  });

  it("enables a plugin (admin) → 200, writes SystemConfig=true via find-first shape, audit log enable", async () => {
    dlpPlugin.enabled = false; // currently disabled
    const app = buildApp();
    const res = await request(app)
      .patch("/api/filters/dlp")
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Filter "dlp" enabled' });

    expect(mockUpsertHelper).toHaveBeenCalledTimes(1);
    const [, enableWriteArg] = mockUpsertHelper.mock.calls[0];
    expect(enableWriteArg).toEqual({ key: "filter_dlp_enabled", value: "true" });

    expect(dlpPlugin.enabled).toBe(true);

    expect(mockLogEvent).toHaveBeenCalledWith(
      "chat",
      "system",
      "filter.enable",
      "admin-user-id",
      { pluginName: "dlp" },
    );
  });

  it("returns 404 for unknown plugin", async () => {
    mockGetFilter.mockReturnValue(undefined);
    const app = buildApp();
    const res = await request(app)
      .patch("/api/filters/nonexistent")
      .send({ enabled: false });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Filter plugin not found" });
    expect(mockUpsertHelper).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body (enabled not boolean)", async () => {
    const app = buildApp();
    const res = await request(app)
      .patch("/api/filters/dlp")
      .send({ enabled: "yes" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "Invalid request body");
    expect(res.body).toHaveProperty("details");
    expect(mockUpsertHelper).not.toHaveBeenCalled();
    expect(mockLogEvent).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin", async () => {
    mockState.authMode = "no-permission";
    const app = buildApp();
    const res = await request(app)
      .patch("/api/filters/dlp")
      .send({ enabled: false });

    expect(res.status).toBe(403);
    expect(mockUpsertHelper).not.toHaveBeenCalled();
  });
});

// ─── Permission constant ─────────────────────────────────────────────────

describe("PERMISSION_NAMES — filters:manage (D-09)", () => {
  it("includes 'filters:manage' at index 30 (after 'memory:write'; length 36 after the Phase 192 dlp:unmask addition)", () => {
    expect(PERMISSION_NAMES).toContain("filters:manage");
    const idx = PERMISSION_NAMES.indexOf("filters:manage");
    const memoryWriteIdx = PERMISSION_NAMES.indexOf("memory:write");
    expect(idx).toBeGreaterThan(memoryWriteIdx);
    // 31st entry → index 30 (0-based) — still true: Phase 190 appended the
    // skill:* rows AFTER filters:manage (indexes 31-34) and Phase 192 the
    // dlp:unmask row last (index 35), so this pin holds.
    expect(idx).toBe(30);
    expect(PERMISSION_NAMES).toHaveLength(36);
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget Workspace Archive API tests (WGTA-01) — admin-only read-only
 * projection over the WidgetWorkspace join (grouped / flat / stats).
 *
 * Pins: grouped M:N appearance (widget under EACH project group, spec §5.1),
 * flat one-row-per-widgetId×workspaceId, D-02 effective orphans (all links
 * soft-deleted → orphan), soft-deleted widgets never appear, route order
 * (/workspace-archive NOT captured by /:id), filter parsing, empty-DB edges.
 * Mirrors the widgetCrud.test.ts mock pattern (mocked prisma + env + license
 * + auth).
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
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    WIDGET_SERVICE_URL: "http://localhost:3211",
    WIDGET_API_KEY: "test-key",
  })),
  clearEnvCache: jest.fn(),
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

jest.mock("axios", () => ({
  post: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
  get: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
  put: jest.fn().mockImplementation(() => Promise.resolve({ status: 200 })),
}));

// Mock auth middleware: accept Bearer tokens, set admin user on request.
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
      roles: [{
        role: {
          name: "admin",
          permissions: [{ permissionName: "admin:settings" }],
        },
      }],
    };
    next();
  },
  apiKeyMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import request from "supertest";
import { createApp } from "../index";
import prisma from "../utils/prisma";
import { generateTestToken } from "./helpers/mockAuth";

const app = createApp();

function adminAuth() {
  return { Authorization: `Bearer ${generateTestToken("admin-001")}` };
}

// Valid RFC-9562 UUIDs for the fixtures (the filter schema is uuid-validated;
// zod 4 checks version + variant nibbles, so variant must be 8/9/a/b).
const P1 = "a1b2c3d4-e1f1-41a1-b1c1-d1e1f1a1b1c1"; // project 1
const P2 = "b2c3d4e5-f2a2-42b2-82d2-e1f2a2b2c2d1"; // project 2
const W1 = "c3d4e5f6-a3b3-43c3-83e3-f1a2b3c4d5e1"; // workspace 1 (P1)
const W2 = "d4e5f6a7-b4c4-44d4-a4f4-a2b3c4d5e6f1"; // workspace 2 (P2)
const WS1 = "550e8400-e29b-41d4-a716-446655440000"; // widget 1
const WS2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // widget 2
const WS3 = "7c9e6679-7425-40de-944b-e07fc1f90ae7"; // widget 3 (effective orphan)

/** Join-row builder matching the service's include shape. */
function joinRow(widgetId: string, workspaceId: string, extra: {
  widgetDeletedAt?: Date | null;
  workspaceDeletedAt?: Date | null;
  widget?: { id?: string; name?: string; isActive?: boolean };
  workspaceName?: string;
  projectId?: string;
  projectName?: string;
} = {}) {
  return {
    widgetId,
    workspaceId,
    widget: {
      id: widgetId,
      name: extra.widget?.name ?? `Widget ${widgetId.slice(0, 6)}`,
      isActive: extra.widget?.isActive ?? true,
      deletedAt: extra.widgetDeletedAt ?? null,
    },
    workspace: {
      id: workspaceId,
      name: extra.workspaceName ?? `Workspace ${workspaceId.slice(0, 6)}`,
      deletedAt: extra.workspaceDeletedAt ?? null,
      project: {
        id: extra.projectId ?? P1,
        name: extra.projectName ?? `Project ${P1.slice(0, 6)}`,
      },
    },
  };
}

// ─── GET /api/widgets/workspace-archive (grouped) ──────────────────

describe("GET /api/widgets/workspace-archive", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with empty array on an empty database (probe-authored empty-input edge)", async () => {
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 200 with the grouped payload; a widget linked to workspaces of TWO projects appears under BOTH groups (Pitfall 8 M:N)", async () => {
    // Widget WS1 links W1 (P1) and W2 (P2) → must appear in BOTH project groups.
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([
      joinRow(WS1, W1, { projectId: P1, workspaceName: "Docs P1" }),
      joinRow(WS1, W2, { projectId: P2, workspaceName: "Docs P2" }),
      joinRow(WS2, W1, { projectId: P1, workspaceName: "Docs P1" }),
    ]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const p1Group = res.body.find((g: any) => g.project.id === P1);
    const p2Group = res.body.find((g: any) => g.project.id === P2);
    expect(p1Group).toBeDefined();
    expect(p2Group).toBeDefined();

    // P1: WS1 and WS2, each with only W1 (Docs P1).
    const p1WidgetIds = p1Group.widgets.map((w: any) => w.id).sort();
    expect(p1WidgetIds).toEqual([WS1, WS2].sort());
    const ws1InP1 = p1Group.widgets.find((w: any) => w.id === WS1);
    expect(ws1InP1.workspaces).toEqual([{ id: W1, name: "Docs P1" }]);

    // P2: only WS1, with only W2 (Docs P2) — NOT W1's P1 workspaces.
    expect(p2Group.widgets).toHaveLength(1);
    expect(p2Group.widgets[0].id).toBe(WS1);
    expect(p2Group.widgets[0].workspaces).toEqual([{ id: W2, name: "Docs P2" }]);
  });

  it("is NOT captured by /:id (route-order guard) — grouped shape returned, no widget id-lookup issued", async () => {
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive")
      .set(adminAuth());

    // A /:id capture would 404 with the widget-CRUD shape and call
    // prisma.widget.findFirst with an id lookup. Neither happens.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(Array.isArray(res.body)).toBe(true);
    expect(prisma.widget.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 without a Bearer token", async () => {
    const res = await request(app).get("/api/widgets/workspace-archive");
    expect(res.status).toBe(401);
  });

  it("returns 400 with a malformed (non-uuid) projectId filter", async () => {
    const res = await request(app)
      .get("/api/widgets/workspace-archive")
      .set(adminAuth())
      .query({ projectId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid query parameters/i);
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 with a non-uuid widgetId filter", async () => {
    const res = await request(app)
      .get("/api/widgets/workspace-archive")
      .set(adminAuth())
      .query({ widgetId: "widget-001" });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/widgets/workspace-archive/flat ────────────────────────

describe("GET /api/widgets/workspace-archive/flat", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with empty array on an empty database (probe-authored empty-input edge)", async () => {
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive/flat")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns exactly one row per widgetId × workspaceId (Pitfall 8 invariant: flat count = sum of grouped chips)", async () => {
    // Same fixture as the grouped M:N test: WS1→W1(P1)+W2(P2), WS2→W1(P1).
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([
      joinRow(WS1, W1, { projectId: P1, workspaceName: "Docs P1" }),
      joinRow(WS1, W2, { projectId: P2, workspaceName: "Docs P2" }),
      joinRow(WS2, W1, { projectId: P1, workspaceName: "Docs P1" }),
    ]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive/flat")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3); // 3 join rows = 1+1+2 grouped chips

    const pairs = res.body.map((r: any) => `${r.widgetId}×${r.workspaceId}`).sort();
    expect(new Set(pairs).size).toBe(pairs.length); // no duplicate pairs
    expect(pairs).toEqual([`${WS1}×${W1}`, `${WS1}×${W2}`, `${WS2}×${W1}`].sort());

    // Row shape carries widget + workspace + project names for the flat table/CSV.
    const first = res.body[0];
    expect(first).toHaveProperty("widgetName");
    expect(first).toHaveProperty("workspaceName");
    expect(first).toHaveProperty("projectId");
    expect(first).toHaveProperty("projectName");
  });

  it("respects projectId / workspaceId / widgetId filter passthrough", async () => {
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive/flat")
      .set(adminAuth())
      .query({ projectId: P1, workspaceId: W1, widgetId: WS1 });

    expect(res.status).toBe(200);
    const where = (prisma.widgetWorkspace.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.widgetId).toBe(WS1);
    expect(where.workspaceId).toBe(W1);
    // projectId lands INSIDE the workspace relation filter (D-02 shape).
    expect(where.workspace.projectId).toBe(P1);
    expect(where.workspace.deletedAt).toBeNull();
    expect(where.widget.deletedAt).toBeNull();
  });

  it("returns 400 with a malformed (non-uuid) workspaceId filter", async () => {
    const res = await request(app)
      .get("/api/widgets/workspace-archive/flat")
      .set(adminAuth())
      .query({ workspaceId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid query parameters/i);
  });

  it("returns 401 without a Bearer token", async () => {
    const res = await request(app).get("/api/widgets/workspace-archive/flat");
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/widgets/workspace-archive/stats ───────────────────────

describe("GET /api/widgets/workspace-archive/stats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with all four zero-valued fields on an empty DB (probe-authored empty-input edge)", async () => {
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.widget.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive/stats")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalWidgets: 0,
      totalWorkspacesLinked: 0,
      totalProjects: 0,
      orphans: 0,
    });
  });

  it("carries exactly the four spec-named fields", async () => {
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.widget.findMany as jest.Mock).mockResolvedValue([{ id: WS1 }]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive/stats")
      .set(adminAuth());

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ["orphans", "totalProjects", "totalWidgets", "totalWorkspacesLinked"].sort(),
    );
  });

  it("D-02 EFFECTIVE ORPHANS pin: widget whose join rows ALL point at soft-deleted workspaces counts as an orphan and is absent from the grouped view", async () => {
    // Stats fetch (first call): the mock returns what the DB would return
    // AFTER the D-02 where-filters — WS3's only row pointed at a soft-deleted
    // workspace (excluded), WS_DELETED's row was excluded by the widget filter.
    // WS2 has one live link; WS1 has none.
    (prisma.widgetWorkspace.findMany as jest.Mock)
      .mockResolvedValueOnce([
        { widgetId: WS2, workspace: { project: { id: P1 } } },
      ])
      // Grouped fetch (second call) — post-filter rows.
      .mockResolvedValueOnce([
        joinRow(WS2, W1, { projectId: P1, workspaceName: "Docs P1" }),
      ]);
    (prisma.widget.findMany as jest.Mock).mockResolvedValue([
      { id: WS1 },
      { id: WS2 },
      { id: WS3 }, // live widget, ALL its links soft-deleted → EFFECTIVE ORPHAN
    ]);

    const statsRes = await request(app)
      .get("/api/widgets/workspace-archive/stats")
      .set(adminAuth());
    const groupedRes = await request(app)
      .get("/api/widgets/workspace-archive")
      .set(adminAuth());

    expect(statsRes.status).toBe(200);
    // liveWithLinks = {WS2} only. Orphans = WS1 (no rows) + WS3 (effective orphan).
    expect(statsRes.body.totalWidgets).toBe(3);
    expect(statsRes.body.totalWorkspacesLinked).toBe(1);
    expect(statsRes.body.totalProjects).toBe(1);
    expect(statsRes.body.orphans).toBe(2);

    // WS3 (the effective orphan) is ABSENT from the grouped view.
    expect(groupedRes.status).toBe(200);
    const groupedWidgetIds = groupedRes.body
      .flatMap((g: any) => g.widgets.map((w: any) => w.id));
    expect(groupedWidgetIds).toContain(WS2);
    expect(groupedWidgetIds).not.toContain(WS3);

    // Consistency guard (Pitfall 2 warning-sign): grouped widget count + orphans = totalWidgets.
    const groupedWidgetCount = groupedWidgetIds.length;
    expect(groupedWidgetCount + statsRes.body.orphans).toBe(statsRes.body.totalWidgets);
  });

  it("stats consistency assertion: grouped widget count + orphans equals totalWidgets (Pitfall 2 warning-sign guard)", async () => {
    // Both fetches must model the SAME DB row set (D-02-filtered): WS1 and
    // WS2 each have one live link; WS3 has none at all.
    (prisma.widgetWorkspace.findMany as jest.Mock)
      .mockResolvedValueOnce([
        { widgetId: WS1, workspace: { project: { id: P1 } } },
        { widgetId: WS2, workspace: { project: { id: P2 } } },
      ])
      .mockResolvedValueOnce([
        joinRow(WS1, W1, { projectId: P1 }),
        joinRow(WS2, W2, { projectId: P2 }),
      ]);
    (prisma.widget.findMany as jest.Mock).mockResolvedValue([
      { id: WS1 },
      { id: WS2 },
      { id: WS3 },
    ]);

    const statsRes = await request(app)
      .get("/api/widgets/workspace-archive/stats")
      .set(adminAuth());
    const groupedRes = await request(app)
      .get("/api/widgets/workspace-archive")
      .set(adminAuth());

    expect(statsRes.status).toBe(200);
    expect(groupedRes.status).toBe(200);

    const groupedWidgetCount = groupedRes.body.reduce(
      (acc: number, g: any) => acc + g.widgets.length, 0,
    );
    expect(groupedWidgetCount).toBe(2); // WS1 (P1) + WS2 (P2)
    expect(statsRes.body.orphans).toBe(1); // WS3 (no live links)
    expect(groupedWidgetCount + statsRes.body.orphans).toBe(statsRes.body.totalWidgets);
  });

  it("stats is filter-free (no query params accepted on the stats path)", async () => {
    (prisma.widgetWorkspace.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.widget.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/widgets/workspace-archive/stats")
      .set(adminAuth())
      .query({ widgetId: "ignored" });

    expect(res.status).toBe(200);
    // The stats service takes NO filters — its where clause never carries
    // the filter keys (single unfiltered projection).
    const statsCall = (prisma.widgetWorkspace.findMany as jest.Mock).mock.calls[0][0];
    expect(statsCall.where.widgetId).toBeUndefined();
  });
});
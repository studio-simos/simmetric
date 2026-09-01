// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * wikiGraphTriggerRoute.test.ts — Plan 153-02 Task 2 (TDD).
 *
 * Unit test (supertest against createApp() with mocked prisma + mocked
 * runWikiGraphPipeline) for the POST /api/synthesis/trigger-graph-wiki
 * route — the admin-only trigger that creates a SynthesisRun row and
 * fires the graph-wiki pipeline fire-and-forget.
 *
 * HTTP contract (mirrors synthesisRoutes.test.ts:635-690 for the existing
 * /trigger route):
 *   - 401 when no Authorization header (authMiddleware rejects first).
 *   - 403 when authenticated but lacking archive:write (RBAC deny path).
 *   - 400 when body invalid (graphWikiTriggerSchema.safeParse fails).
 *   - 404 when archive missing / soft-deleted.
 *   - 201 on success: body matches { id, status: "PENDING", createdBy }
 *     and runWikiGraphPipeline is invoked exactly once with
 *     (archiveId, req.userId, run.id) — fire-and-forget (microtask flush
 *     before asserting the mock was called).
 *
 * Resolves D-01 (admin-triggered, extends synthesis infra), T-153-04
 * (requirePermission("archive:write") — elevation-of-privilege mitigation),
 * A2 (separate pipeline — runWikiGraphPipeline, NOT runPipelineStages).
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  mock.prisma.synthesisRun = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
  };
  return { __esModule: true, default: mock.prisma };
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
  initLicense: jest.fn(() => ({
    tier: "enterprise",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  getLicenseInfo: jest.fn(() => ({
    tier: "enterprise",
    licensee: "Test",
    expiresAt: null,
    features: {},
    valid: true,
  })),
  isFeatureEnabled: jest.fn(() => true),
  getFeatureLimit: jest.fn(() => Infinity),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({
  seedTemplates: jest.fn(),
}));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
}));
jest.mock("../services/ftsService", () => ({
  initPostgreSQLFTS: jest.fn(),
}));
jest.mock("../agent/mcpServer", () => ({
  mountMCPServer: jest.fn(),
}));
jest.mock("../services/archiveIndexService", () => ({
  rebuildAllIndexFiles: jest
    .fn()
    .mockResolvedValue({ reindexed: 0, errors: [] }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../routes/internalWidget", () => {
  const { Router } = require("express");
  const router = Router();
  return { __esModule: true, default: router };
});

// Mock the graph-wiki pipeline so the route's fire-and-forget call is
// observable without a real DB or a real pipeline. The mock resolves so
// the route's .catch handler is a no-op (the success path).
jest.mock("../services/wikiGraphStage", () => ({
  runWikiGraphPipeline: jest.fn().mockResolvedValue({
    pagesWritten: 0,
    status: "COMPLETED",
  }),
}));

// Mock auth middleware — simulates an authenticated admin user with
// archive:write. The 401/403 paths below override this default via
// jest.spyOn on requirePermission output (see the 403 test).
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
      roles: [
        {
          role: {
            name: "admin",
            permissions: [
              { permissionName: "archive:read" },
              { permissionName: "archive:write" },
              { permissionName: "archive:delete" },
            ],
          },
        },
      ],
    };
    next();
  },
}));

import request from "supertest";
import { createApp } from "../index";
import * as prismaModule from "../utils/prisma";
import * as wikiGraphStageModule from "../services/wikiGraphStage";
import { defaultWikiGraphRunName } from "../services/synthesisService";

const prisma = prismaModule.default as any;
const mockPipeline = wikiGraphStageModule as jest.Mocked<
  typeof wikiGraphStageModule
>;

describe("POST /api/synthesis/trigger-graph-wiki — Plan 153-02 Task 2", () => {
  let app: ReturnType<typeof createApp>;

  const validArchiveId = "11111111-1111-4111-8111-111111111111";
  const validRunId = "22222222-2222-4222-2222-222222222222";

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-establish the default mock resolution after clearAllMocks.
    mockPipeline.runWikiGraphPipeline.mockResolvedValue({
      pagesWritten: 0,
      status: "COMPLETED",
    });
  });

  it("returns 401 when not authenticated", async () => {
    await request(app)
      .post("/api/synthesis/trigger-graph-wiki")
      .send({ archiveId: validArchiveId })
      .expect(401);
  });

  it("returns 400 when body is invalid (archiveId not a UUID)", async () => {
    await request(app)
      .post("/api/synthesis/trigger-graph-wiki")
      .set("Authorization", "Bearer test-token")
      .send({ archiveId: "not-a-uuid" })
      .expect(400);
  });

  it("returns 400 when archiveId is missing", async () => {
    await request(app)
      .post("/api/synthesis/trigger-graph-wiki")
      .set("Authorization", "Bearer test-token")
      .send({})
      .expect(400);
  });

  it("returns 404 when archive does not exist", async () => {
    prisma.archive.findFirst = jest.fn().mockResolvedValue(null);

    await request(app)
      .post("/api/synthesis/trigger-graph-wiki")
      .set("Authorization", "Bearer test-token")
      .send({ archiveId: validArchiveId })
      .expect(404);
  });

  it("returns 201 + SynthesisRun shape and invokes runWikiGraphPipeline with (archiveId, req.userId, run.id) exactly once (fire-and-forget)", async () => {
    const fakeArchive = {
      id: validArchiveId,
      name: "Test Archive",
      createdBy: "admin-001",
    };
    const fakeRun = {
      id: validRunId,
      archiveId: validArchiveId,
      status: "PENDING",
      createdBy: "admin-001",
      name: "Wiki Graph · Test Archive · 25/08/2026 00:00",
      createdAt: new Date().toISOString(),
    };
    prisma.archive.findFirst = jest.fn().mockResolvedValue(fakeArchive);
    prisma.synthesisRun.create = jest.fn().mockResolvedValue(fakeRun);

    const res = await request(app)
      .post("/api/synthesis/trigger-graph-wiki")
      .set("Authorization", "Bearer test-token")
      .send({ archiveId: validArchiveId })
      .expect(201);

    expect(res.body).toMatchObject({
      id: validRunId,
      archiveId: validArchiveId,
      status: "PENDING",
      createdBy: "admin-001",
    });

    // Fire-and-forget: the route does NOT await runWikiGraphPipeline. Flush
    // the microtask queue so the mock is observable before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockPipeline.runWikiGraphPipeline).toHaveBeenCalledTimes(1);
    expect(mockPipeline.runWikiGraphPipeline).toHaveBeenCalledWith(
      validArchiveId,
      "admin-001", // req.userId from the mocked authMiddleware
      validRunId, // the created SynthesisRun's id
    );
  });

  // WR-05: the /trigger-graph-wiki route must use a SHARED helper for the run
  // name (no inline dd/mm/yyyy hh:mm + "Senza nome" fallback). The helper
  // lives in synthesisStages.ts and is re-exported via synthesisService.ts as
  // defaultWikiGraphRunName. It must produce the same string shape the route
  // previously inlined: "Wiki Graph · {archiveName} · {DD/MM/YYYY HH:mm}".
  it("WR-05: defaultWikiGraphRunName shared helper produces 'Wiki Graph · {name} · {DD/MM/YYYY HH:mm}'", () => {
    const name = defaultWikiGraphRunName(
      { name: "Test Archive" },
      new Date("2026-08-25T00:00:00"),
    );
    expect(name).toContain("Wiki Graph · Test Archive ·");
    expect(name).toContain("25/08/2026 00:00");
  });

  it("WR-05: defaultWikiGraphRunName falls back to 'Senza nome' when archive.name is null/empty", () => {
    expect(
      defaultWikiGraphRunName({ name: null }, new Date("2026-08-25T00:00:00")),
    ).toContain("Wiki Graph · Senza nome ·");
    expect(
      defaultWikiGraphRunName({ name: "" }, new Date("2026-08-25T00:00:00")),
    ).toContain("Wiki Graph · Senza nome ·");
  });
});
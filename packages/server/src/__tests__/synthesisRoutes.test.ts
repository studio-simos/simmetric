// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Synthesis Routes integration tests — supertest against Express app.
 * TDD tests covering 6 synthesis endpoints: status, run detail, approve,
 * reject, pending count, and manual trigger.
 *
 * Task 1 RED phase: tests WILL fail because synthesis routes are not
 * yet registered in index.ts.
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  // Add synthesisRun model (not yet in mockPrisma helper)
  mock.prisma.synthesisRun = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };
  // Add ocrJob model for ownership checks
  mock.prisma.ocrJob = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
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

// Mock synthesisPageWriter.applyApprovedChanges for approve endpoint
jest.mock("../services/synthesisPageWriter", () => ({
  applyApprovedChanges: jest.fn(),
}));

// Mock auth middleware — simulates authenticated admin user
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
import * as synthesisPageWriterModule from "../services/synthesisPageWriter";

const prisma = prismaModule.default as any;
const mockPageWriter = synthesisPageWriterModule as jest.Mocked<
  typeof synthesisPageWriterModule
>;

describe("Synthesis Routes", () => {
  let app: ReturnType<typeof createApp>;

  const validArchiveId = "11111111-1111-4111-8111-111111111111";
  const validRunId = "22222222-2222-4222-2222-222222222222";
  const otherUserId = "99999999-9999-4999-9999-999999999999";

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // GET /api/synthesis/status
  // =========================================================================
  describe("GET /api/synthesis/status", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app).get("/api/synthesis/status").expect(401);
    });

    it("returns 200 with SynthesisRun[] for authenticated user", async () => {
      const fakeRuns = [
        {
          id: validRunId,
          archiveId: validArchiveId,
          status: "COMPLETED",
          createdBy: "admin-001",
          previewJson: {},
          createdAt: new Date().toISOString(),
        },
        {
          id: "33333333-3333-4333-3333-333333333333",
          archiveId: validArchiveId,
          status: "PENDING",
          createdBy: "admin-001",
          previewJson: {},
          createdAt: new Date().toISOString(),
        },
      ];

      prisma.synthesisRun.findMany = jest.fn().mockResolvedValue(fakeRuns);

      const res = await request(app)
        .get("/api/synthesis/status")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ id: validRunId, status: "COMPLETED" });
    });

    it("includes the archive relation so the UI can resolve archive names", async () => {
      // Regression: the "Filter by archive" dropdown on the synthesis dashboard
      // rendered raw archiveId UUIDs because /status did not join the archive
      // relation. The findMany call MUST include archive.{slug,name}.
      prisma.synthesisRun.findMany = jest.fn().mockResolvedValue([
        {
          id: validRunId,
          archiveId: validArchiveId,
          status: "PENDING",
          createdBy: "admin-001",
          archive: { slug: "ricerche", name: "Ricerche" },
        },
      ]);

      const res = await request(app)
        .get("/api/synthesis/status")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(prisma.synthesisRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { archive: { select: { slug: true, name: true } } },
        }),
      );
      expect(res.body[0].archive).toMatchObject({ name: "Ricerche" });
    });

    it("filters results by archiveId query param", async () => {
      const fakeRuns = [
        {
          id: validRunId,
          archiveId: validArchiveId,
          status: "COMPLETED",
          createdBy: "admin-001",
        },
      ];

      prisma.synthesisRun.findMany = jest.fn().mockResolvedValue(fakeRuns);

      const res = await request(app)
        .get(`/api/synthesis/status?archiveId=${validArchiveId}`)
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body).toHaveLength(1);
      // Verify the findMany was called with correct where clause
      expect(prisma.synthesisRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            archiveId: validArchiveId,
          }),
        }),
      );
    });
  });

  // =========================================================================
  // GET /api/synthesis/:runId
  // =========================================================================
  describe("GET /api/synthesis/:runId", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .get(`/api/synthesis/${validRunId}`)
        .expect(401);
    });

    it("returns 200 with full SynthesisRun including previewJson", async () => {
      const fakeRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        previewJson: {
          changes: [
            {
              pageSlug: "test-page",
              action: "create",
              category: "test",
              title: "Test Page",
              proposedContent: "# Test\n\nContent",
              confidence: "HIGH",
              sources: [{ fileName: "doc.pdf", ingestDate: "2026-05-01" }],
            },
          ],
          contradictions: [],
          budgetUsed: {
            pagesRead: 5,
            pagesWritten: 1,
            tokensUsed: 1000,
            llmCallsUsed: 3,
          },
        },
        createdAt: new Date().toISOString(),
      };

      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(fakeRun);

      const res = await request(app)
        .get(`/api/synthesis/${validRunId}`)
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body).toMatchObject({
        id: validRunId,
        status: "COMPLETED",
      });
      expect(res.body.previewJson).toBeDefined();
      expect(res.body.previewJson.changes).toHaveLength(1);
    });

    it("returns 404 for non-existent run", async () => {
      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(null);

      await request(app)
        .get(`/api/synthesis/${validRunId}`)
        .set("Authorization", "Bearer test-token")
        .expect(404);
    });

    it("returns 404 when run belongs to archive owned by different user", async () => {
      // Simulate a run whose archive was created by a different user
      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(null);

      await request(app)
        .get(`/api/synthesis/${validRunId}`)
        .set("Authorization", "Bearer test-token")
        .expect(404);
    });
  });

  // =========================================================================
  // POST /api/synthesis/:runId/approve
  // =========================================================================
  describe("POST /api/synthesis/:runId/approve", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .post(`/api/synthesis/${validRunId}/approve`)
        .send({})
        .expect(401);
    });

    it("approves all changes with empty body", async () => {
      const fakeRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        previewJson: {
          changes: [
            {
              pageSlug: "page-1",
              action: "create",
              category: "test",
              title: "Page 1",
              proposedContent: "# Page 1",
              confidence: "HIGH",
              sources: [],
            },
            {
              pageSlug: "page-2",
              action: "update",
              category: "test",
              title: "Page 2",
              proposedContent: "# Page 2",
              confidence: "MEDIUM",
              sources: [],
            },
          ],
          contradictions: [],
          budgetUsed: { pagesRead: 0, pagesWritten: 0, tokensUsed: 0, llmCallsUsed: 0 },
        },
      };

      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(fakeRun);
      (mockPageWriter.applyApprovedChanges as jest.Mock).mockResolvedValue({
        applied: 2,
        conflicts: [],
      });
      prisma.synthesisRun.update = jest.fn().mockResolvedValue({});

      const res = await request(app)
        .post(`/api/synthesis/${validRunId}/approve`)
        .set("Authorization", "Bearer test-token")
        .send({})
        .expect(200);

      expect(res.body).toMatchObject({ applied: 2, conflicts: [] });
      expect(mockPageWriter.applyApprovedChanges).toHaveBeenCalled();
    });

    it("approves specific pages when pageSlugs array provided", async () => {
      const fakeRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        previewJson: {
          changes: [
            {
              pageSlug: "page-1",
              action: "create",
              category: "test",
              title: "Page 1",
              proposedContent: "# Page 1",
              confidence: "HIGH",
              sources: [],
            },
            {
              pageSlug: "page-2",
              action: "update",
              category: "test",
              title: "Page 2",
              proposedContent: "# Page 2",
              confidence: "MEDIUM",
              sources: [],
            },
          ],
          contradictions: [],
          budgetUsed: { pagesRead: 0, pagesWritten: 0, tokensUsed: 0, llmCallsUsed: 0 },
        },
      };

      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(fakeRun);
      (mockPageWriter.applyApprovedChanges as jest.Mock).mockResolvedValue({
        applied: 1,
        conflicts: [],
      });
      prisma.synthesisRun.update = jest.fn().mockResolvedValue({});

      const res = await request(app)
        .post(`/api/synthesis/${validRunId}/approve`)
        .set("Authorization", "Bearer test-token")
        .send({ pageSlugs: ["page-1"] })
        .expect(200);

      expect(res.body).toMatchObject({ applied: 1, conflicts: [] });
    });

    it("approve persists pagesApplied from applyApprovedChanges result.applied", async () => {
      // D-02: the prisma.synthesisRun.update data payload must include
      // pagesApplied: result.applied so the row tracks real writes (not
      // proposals). Mocks applyApprovedChanges to return applied=2.
      const fakeRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        previewJson: {
          changes: [
            {
              pageSlug: "page-1",
              action: "create",
              category: "test",
              title: "Page 1",
              proposedContent: "# Page 1",
              confidence: "HIGH",
              sources: [],
            },
            {
              pageSlug: "page-2",
              action: "update",
              category: "test",
              title: "Page 2",
              proposedContent: "# Page 2",
              confidence: "MEDIUM",
              sources: [],
            },
          ],
          contradictions: [],
          budgetUsed: { pagesRead: 0, pagesWritten: 0, tokensUsed: 0, llmCallsUsed: 0 },
        },
      };

      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(fakeRun);
      (mockPageWriter.applyApprovedChanges as jest.Mock).mockResolvedValue({
        applied: 2,
        conflicts: [],
      });
      prisma.synthesisRun.update = jest.fn().mockResolvedValue({});

      await request(app)
        .post(`/api/synthesis/${validRunId}/approve`)
        .set("Authorization", "Bearer test-token")
        .send({})
        .expect(200);

      // Inspect the update payload: must contain pagesApplied = 2.
      expect(prisma.synthesisRun.update).toHaveBeenCalled();
      const updateCall = (prisma.synthesisRun.update as jest.Mock).mock.calls[0];
      expect(updateCall[0].data).toMatchObject({ pagesApplied: 2 });
      // Status must still be present (all approved = APPROVED).
      expect(updateCall[0].data.status).toBe("APPROVED");
    });

    it("approve persists status PARTIAL when only some pages approved", async () => {
      // D-02: when only a subset of slugs is approved, status is PARTIAL
      // and pagesApplied reflects the count approved (not total changes).
      const fakeRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        previewJson: {
          changes: [
            {
              pageSlug: "page-1",
              action: "create",
              category: "test",
              title: "Page 1",
              proposedContent: "# Page 1",
              confidence: "HIGH",
              sources: [],
            },
            {
              pageSlug: "page-2",
              action: "update",
              category: "test",
              title: "Page 2",
              proposedContent: "# Page 2",
              confidence: "MEDIUM",
              sources: [],
            },
            {
              pageSlug: "page-3",
              action: "update",
              category: "test",
              title: "Page 3",
              proposedContent: "# Page 3",
              confidence: "MEDIUM",
              sources: [],
            },
          ],
          contradictions: [],
          budgetUsed: { pagesRead: 0, pagesWritten: 0, tokensUsed: 0, llmCallsUsed: 0 },
        },
      };

      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(fakeRun);
      (mockPageWriter.applyApprovedChanges as jest.Mock).mockResolvedValue({
        applied: 1,
        conflicts: [],
      });
      prisma.synthesisRun.update = jest.fn().mockResolvedValue({});

      await request(app)
        .post(`/api/synthesis/${validRunId}/approve`)
        .set("Authorization", "Bearer test-token")
        .send({ pageSlugs: ["page-1"] })
        .expect(200);

      const updateCall = (prisma.synthesisRun.update as jest.Mock).mock.calls[0];
      expect(updateCall[0].data).toMatchObject({ pagesApplied: 1 });
      expect(updateCall[0].data.status).toBe("PARTIAL");
    });

    it("returns 400 for invalid body (Zod validation)", async () => {
      await request(app)
        .post(`/api/synthesis/${validRunId}/approve`)
        .set("Authorization", "Bearer test-token")
        .send({ pageSlugs: "not-an-array" })
        .expect(400);
    });
  });

  // =========================================================================
  // POST /api/synthesis/:runId/reject
  // =========================================================================
  describe("POST /api/synthesis/:runId/reject", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .post(`/api/synthesis/${validRunId}/reject`)
        .send({})
        .expect(401);
    });

    it("marks entire run as REJECTED with empty body", async () => {
      const fakeRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        previewJson: {
          changes: [
            {
              pageSlug: "page-1",
              action: "create",
              category: "test",
              title: "Page 1",
              proposedContent: "# Page 1",
              confidence: "HIGH",
              sources: [],
              approved: false,
            },
          ],
          contradictions: [],
          budgetUsed: { pagesRead: 0, pagesWritten: 0, tokensUsed: 0, llmCallsUsed: 0 },
        },
      };

      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(fakeRun);
      prisma.synthesisRun.update = jest.fn().mockResolvedValue({});

      const res = await request(app)
        .post(`/api/synthesis/${validRunId}/reject`)
        .set("Authorization", "Bearer test-token")
        .send({})
        .expect(200);

      expect(res.body).toMatchObject({ message: "Rejected successfully" });
    });

    it("returns 400 for invalid body (Zod validation)", async () => {
      await request(app)
        .post(`/api/synthesis/${validRunId}/reject`)
        .set("Authorization", "Bearer test-token")
        .send({ pageSlugs: 123 })
        .expect(400);
    });
  });

  // =========================================================================
  // GET /api/synthesis/pending/count
  // =========================================================================
  describe("GET /api/synthesis/pending/count", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app).get("/api/synthesis/pending/count").expect(401);
    });

    it("returns count of PENDING runs for authenticated user", async () => {
      prisma.synthesisRun.count = jest.fn().mockResolvedValue(3);

      const res = await request(app)
        .get("/api/synthesis/pending/count")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body).toMatchObject({ count: 3 });
    });
  });

  // =========================================================================
  // POST /api/synthesis/trigger
  // =========================================================================
  describe("POST /api/synthesis/trigger", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .post("/api/synthesis/trigger")
        .send({ archiveId: validArchiveId })
        .expect(401);
    });

    it("creates a new PENDING SynthesisRun for valid archive", async () => {
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
        previewJson: {},
        createdAt: new Date().toISOString(),
      };

      prisma.archive.findFirst = jest.fn().mockResolvedValue(fakeArchive);
      prisma.synthesisRun.create = jest.fn().mockResolvedValue(fakeRun);

      const res = await request(app)
        .post("/api/synthesis/trigger")
        .set("Authorization", "Bearer test-token")
        .send({ archiveId: validArchiveId })
        .expect(201);

      expect(res.body).toMatchObject({
        id: validRunId,
        status: "PENDING",
      });
    });

    it("returns 400 for invalid archiveId (not a UUID)", async () => {
      await request(app)
        .post("/api/synthesis/trigger")
        .set("Authorization", "Bearer test-token")
        .send({ archiveId: "not-a-uuid" })
        .expect(400);
    });

    it("returns 404 when archive does not exist", async () => {
      prisma.archive.findFirst = jest.fn().mockResolvedValue(null);

      await request(app)
        .post("/api/synthesis/trigger")
        .set("Authorization", "Bearer test-token")
        .send({ archiveId: validArchiveId })
        .expect(404);
    });
  });

  // =========================================================================
  // PATCH /api/synthesis/:runId/rename (Phase 74 Plan 03, SYN-03)
  // =========================================================================
  describe("PATCH /api/synthesis/:runId/rename", () => {
    const oldName = "Sintesi · Ricerche · 21/07/2026 18:35";
    const newName = "Rinominata";

    it("returns 401 when not authenticated", async () => {
      await request(app)
        .patch(`/api/synthesis/${validRunId}/rename`)
        .send({ name: newName })
        .expect(401);
    });

    it("rename returns 200 and updates name on owned run", async () => {
      const ownedRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        name: oldName,
      };
      const updatedRun = { ...ownedRun, name: newName };
      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(ownedRun);
      prisma.synthesisRun.update = jest.fn().mockResolvedValue(updatedRun);

      const res = await request(app)
        .patch(`/api/synthesis/${validRunId}/rename`)
        .set("Authorization", "Bearer test-token")
        .send({ name: newName })
        .expect(200);

      expect(res.body).toMatchObject({ id: validRunId, name: newName });
      expect(prisma.synthesisRun.update).toHaveBeenCalledWith({
        where: { id: validRunId },
        data: { name: newName },
      });
    });

    it("rename ownership returns 404 on other user's run", async () => {
      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(null);

      const res = await request(app)
        .patch(`/api/synthesis/${validRunId}/rename`)
        .set("Authorization", "Bearer test-token")
        .send({ name: newName })
        .expect(404);

      expect(res.body).toMatchObject({ error: "Synthesis run not found" });
      expect(prisma.synthesisRun.update).not.toHaveBeenCalled();
    });

    it("rename validation returns 400 on empty name", async () => {
      const res = await request(app)
        .patch(`/api/synthesis/${validRunId}/rename`)
        .set("Authorization", "Bearer test-token")
        .send({ name: "" })
        .expect(400);

      expect(res.body).toMatchObject({ error: "Invalid request body" });
      expect(res.body.details).toBeDefined();
      // findFirst must NOT be called — validation runs before the DB lookup
      expect(prisma.synthesisRun.findFirst).not.toHaveBeenCalled();
    });

    it("rename validation returns 400 on >100 char name", async () => {
      const res = await request(app)
        .patch(`/api/synthesis/${validRunId}/rename`)
        .set("Authorization", "Bearer test-token")
        .send({ name: "a".repeat(101) })
        .expect(400);

      expect(res.body).toMatchObject({ error: "Invalid request body" });
      expect(prisma.synthesisRun.findFirst).not.toHaveBeenCalled();
    });

    it("rename logs synthesis.renamed audit event", async () => {
      const ownedRun = {
        id: validRunId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        createdBy: "admin-001",
        name: oldName,
      };
      const updatedRun = { ...ownedRun, name: newName };
      prisma.synthesisRun.findFirst = jest.fn().mockResolvedValue(ownedRun);
      prisma.synthesisRun.update = jest.fn().mockResolvedValue(updatedRun);

      await request(app)
        .patch(`/api/synthesis/${validRunId}/rename`)
        .set("Authorization", "Bearer test-token")
        .send({ name: newName })
        .expect(200);

      // logEvent is mocked at module level (jest.mock ../services/eventLogService)
      const { logEvent } = require("../services/eventLogService");
      expect(logEvent).toHaveBeenCalledWith(
        "synthesis_run",
        validRunId,
        "synthesis.renamed",
        "admin-001",
        { archiveId: validArchiveId, oldName, newName },
      );
    });
  });
});

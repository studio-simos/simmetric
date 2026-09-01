// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * OCR Route integration tests — supertest against Express app.
 * TDD tests covering multer PDF upload, job polling, and approve/reject endpoints.
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
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
jest.mock("../services/archiveIndexService", () => ({
  rebuildAllIndexFiles: jest.fn().mockResolvedValue({ reindexed: 0, errors: [] }),
}));

jest.mock("../services/eventLogService", () => ({
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// TEC-03b: redisService mock with a DEFAULT null return — every pre-existing
// test stays on the degraded (Redis absent) path. The mock instance is created
// INSIDE the factory (this file eagerly imports ../index → rateLimit → calls
// getRedis() at module scope, so an outer `const` would hit a TDZ); the test
// body reaches it via jest.requireMock, which returns the same cached module.
jest.mock("../services/redisService", () => {
  const mockGetRedis = jest.fn();
  return {
    getRedis: mockGetRedis,
    isRedisAvailable: jest.fn(() => mockGetRedis() !== null),
  };
});

// Mock ESM-only packages that Jest CommonJS mode cannot parse
jest.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: jest.fn(),
}));
jest.mock("puppeteer", () => ({
  launch: jest.fn(),
}));
jest.mock("sharp", () => jest.fn());

// Mock internalWidget routes to avoid apiKeyMiddleware loading issues in CI
jest.mock("../routes/internalWidget", () => {
  const { Router } = require("express");
  const router = Router();
  return { __esModule: true, default: router };
});

// Mock ocrJobService functions used by ocr.ts route
jest.mock("../services/ocrJobService", () => ({
  createOcrJob: jest.fn(),
  startOcrJob: jest.fn(),
  getOcrJob: jest.fn(),
  getOcrJobsByArchive: jest.fn(),
  completeOcrJob: jest.fn(),
  failOcrJob: jest.fn(),
  parseOcrJobResult: jest.fn((result: any) => (result && typeof result === "object" ? result : {})),
}));

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
          permissions: [
            { permissionName: "archive:read" },
            { permissionName: "archive:write" },
            { permissionName: "archive:delete" },
          ],
        },
      }],
    };
    next();
  },
}));

import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../index";
import * as prismaModule from "../utils/prisma";
import * as ocrJobService from "../services/ocrJobService";

const prisma = prismaModule.default as any;
const mockOcrJobService = ocrJobService as jest.Mocked<typeof ocrJobService>;

// Handle to the factory-created redisService mock (see jest.mock above).
const { getRedis: mockGetRedis } = jest.requireMock("../services/redisService") as {
  getRedis: jest.Mock;
};

describe("OCR Routes", () => {
  let app: ReturnType<typeof createApp>;

  const validArchiveId = "11111111-1111-4111-8111-111111111111";
  const validJobId = "22222222-2222-4222-2222-222222222222";

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/ocr/models", () => {
    beforeEach(() => {
      // The catalog route reads OCR-flagged models from the DB since Phase 47
      (prisma.providerModel.findMany as jest.Mock).mockResolvedValue([
        { name: "deepseek-ocr", isOcr: true },
        { name: "llava:13b", isOcr: true },
      ]);
    });

    it("returns 200 with an array of model configs containing name, promptTemplate, supportedModes", async () => {
      const res = await request(app)
        .get("/api/ocr/models")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      res.body.forEach((model: any) => {
        expect(model).toHaveProperty("name");
        expect(model).toHaveProperty("promptTemplate");
        expect(model).toHaveProperty("supportedModes");
      });
    });

    it("does not return the catalog on /api/archives/models", async () => {
      const res = await request(app)
        .get("/api/archives/models")
        .set("Authorization", "Bearer test-token")
        .expect(400);

      // Confirm it is NOT the model catalog (archives router intercepts with UUID validation)
      expect(Array.isArray(res.body)).toBe(false);
    });

    it("returns consistent data on rapid successive calls (cache hit)", async () => {
      const res1 = await request(app)
        .get("/api/ocr/models")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      const res2 = await request(app)
        .get("/api/ocr/models")
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res2.body).toEqual(res1.body);
    });
  });

  describe("GET /api/archives/:id/jobs/:jobId", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .get(`/api/archives/${validArchiveId}/jobs/${validJobId}`)
        .expect(401);
    });

    it("returns job with progress/status/result on valid request", async () => {
      const fakeJob = {
        id: validJobId,
        archiveId: validArchiveId,
        type: "OCR",
        status: "PROCESSING",
        progress: 42,
        totalPages: 10,
        processedPages: 4,
        result: { qualityScore: 4 },
        error: null,
        createdBy: "admin-001",
        sourceFileName: "test.pdf",
      };
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(fakeJob);

      const res = await request(app)
        .get(`/api/archives/${validArchiveId}/jobs/${validJobId}`)
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body).toMatchObject({
        id: validJobId,
        archiveId: validArchiveId,
        status: "PROCESSING",
        progress: 42,
      });
    });

    it("returns 404 when job not found", async () => {
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(null);

      await request(app)
        .get(`/api/archives/${validArchiveId}/jobs/${validJobId}`)
        .set("Authorization", "Bearer test-token")
        .expect(404);
    });

    it("returns 404 when job belongs to different archive", async () => {
      const fakeJob = {
        id: validJobId,
        archiveId: "different-archive-id",
      };
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(fakeJob);

      await request(app)
        .get(`/api/archives/${validArchiveId}/jobs/${validJobId}`)
        .set("Authorization", "Bearer test-token")
        .expect(404);
    });
  });

  describe("GET /api/archives/:id/jobs", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .get(`/api/archives/${validArchiveId}/jobs`)
        .expect(401);
    });

    it("returns list of jobs for archive", async () => {
      const fakeJobs = [
        { id: "job-1", archiveId: validArchiveId, status: "COMPLETED" },
        { id: "job-2", archiveId: validArchiveId, status: "PENDING" },
      ];
      (mockOcrJobService.getOcrJobsByArchive as jest.Mock).mockResolvedValue(fakeJobs);

      const res = await request(app)
        .get(`/api/archives/${validArchiveId}/jobs`)
        .set("Authorization", "Bearer test-token")
        .expect(200);

      expect(res.body).toHaveLength(2);
    });
  });

  describe("POST /api/archives/:id/jobs/:jobId/approve", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .post(`/api/archives/${validArchiveId}/jobs/${validJobId}/approve`)
        .expect(401);
    });

    it("returns 200 when approving a completed job", async () => {
      const fakeJob = {
        id: validJobId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        result: { qualityScore: 4 },
      };
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(fakeJob);
      // prisma.ocrJob.update mock for updating result metadata
      prisma.ocrJob = { update: jest.fn().mockResolvedValue({}) };

      await request(app)
        .post(`/api/archives/${validArchiveId}/jobs/${validJobId}/approve`)
        .set("Authorization", "Bearer test-token")
        .set("Content-Type", "application/json")
        .send({})
        .expect(200);
    });

    it("returns 400 when job is not completed", async () => {
      const fakeJob = {
        id: validJobId,
        archiveId: validArchiveId,
        status: "PENDING",
      };
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(fakeJob);

      await request(app)
        .post(`/api/archives/${validArchiveId}/jobs/${validJobId}/approve`)
        .set("Authorization", "Bearer test-token")
        .expect(400);
    });
  });

  describe("POST /api/archives/:id/jobs/:jobId/reject", () => {
    it("returns 401 when not authenticated", async () => {
      await request(app)
        .post(`/api/archives/${validArchiveId}/jobs/${validJobId}/reject`)
        .expect(401);
    });

    it("returns 200 when rejecting a completed job with reason", async () => {
      const fakeJob = {
        id: validJobId,
        archiveId: validArchiveId,
        status: "COMPLETED",
        result: { qualityScore: 4 },
      };
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(fakeJob);
      prisma.ocrJob = { update: jest.fn().mockResolvedValue({}) };

      await request(app)
        .post(`/api/archives/${validArchiveId}/jobs/${validJobId}/reject`)
        .set("Authorization", "Bearer test-token")
        .send({ reason: "Poor OCR quality" })
        .expect(200);
    });

    it("returns 400 when job is not completed", async () => {
      const fakeJob = {
        id: validJobId,
        archiveId: validArchiveId,
        status: "PROCESSING",
      };
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(fakeJob);

      await request(app)
        .post(`/api/archives/${validArchiveId}/jobs/${validJobId}/reject`)
        .set("Authorization", "Bearer test-token")
        .send({ reason: "bad data" })
        .expect(400);
    });
  });

  // ─── TEC-03b: queryTokenAuth revocation on the image route (OQ2, Task 3) ───

  describe("GET /api/archives/:id/jobs/:jobId/pages/:pageNumber/image — revoked jti (TEC-03b)", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetRedis.mockReturnValue(null);
    });

    it("returns 401 'Token revoked' when the query token's jti is blacklisted", async () => {
      mockGetRedis.mockReturnValue({ get: jest.fn().mockResolvedValue("1"), set: jest.fn() });
      const token = jwt.sign(
        { userId: "admin-001", jti: "revoked-ocr-jti" },
        "test-jwt-secret-for-unit-tests-32ch"
      );

      const res = await request(app)
        .get(
          `/api/archives/${validArchiveId}/jobs/${validJobId}/pages/1/image?token=${token}`
        )
        .set("Authorization", "Bearer test-token")
        .expect(401);

      expect(res.body.error).toBe("Token revoked");
    });

    it("lets a no-jti token pass the revocation gate (downstream 404 'Job not found')", async () => {
      mockGetRedis.mockReturnValue(null);
      // queryTokenAuth loads the user via getUserWithRoles → prisma.user.findUnique
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: "admin-001",
        username: "admin",
        roles: [],
      });
      (mockOcrJobService.getOcrJob as jest.Mock).mockResolvedValue(null);
      const token = jwt.sign(
        { userId: "admin-001" },
        "test-jwt-secret-for-unit-tests-32ch"
      );

      const res = await request(app)
        .get(
          `/api/archives/${validArchiveId}/jobs/${validJobId}/pages/1/image?token=${token}`
        )
        .set("Authorization", "Bearer test-token")
        .expect(404);

      expect(res.body.error).toBe("Job not found");
    });
  });
});

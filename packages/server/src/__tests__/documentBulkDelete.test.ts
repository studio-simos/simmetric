// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * POST /api/documents/bulk-delete — bulk soft-delete unit tests (Quick 260815-gak).
 *
 * Replaces the N+1 sequential DELETE loop in DocumentsPage with a single
 * server-side endpoint. Mirrors the single-delete route's access-check
 * (CR-01 D-04, applies to admins too) + $transaction soft-delete + chunk
 * hard-delete + fire-and-forget collector cleanup pattern.
 *
 * Harness follows documentDeleteCascade.test.ts (setupEnv, mock prisma via
 * createMockPrisma + withSoftDelete passthrough, mock env, mock
 * licenseService, mock eventLogService, mock ragOcrService, supertest
 * against createApp, generateTestToken/adminUser from helpers/mockAuth).
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    withSoftDelete: (where: any) => where,
  };
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
  })),
}));

jest.mock("../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "community", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => false),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn(() => ({ value: "Xenova/all-MiniLM-L6-v2" })),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

import request from "supertest";
import { createApp } from "../index";
import { generateTestToken, adminUser } from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

const DOC_ID_1 = "doc-bulk-001";
const DOC_ID_2 = "doc-bulk-002";
const WS_ID = "ws-bulk-1";

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    if (args?.where?.id === adminUser.id) return Promise.resolve(adminUser);
    return Promise.resolve(null);
  });
  // Default: admin is the project owner so the CR-01 D-04 access gate passes
  // via isProjectOwner (no need to mock workspaceAccess/projectAccess).
  (prisma.document.findMany as jest.Mock).mockResolvedValue([
    {
      id: DOC_ID_1,
      workspaceId: WS_ID,
      workspace: { projectId: "proj-bulk-1", name: "Bulk WS", project: { createdBy: adminUser.id } },
    },
    {
      id: DOC_ID_2,
      workspaceId: WS_ID,
      workspace: { projectId: "proj-bulk-1", name: "Bulk WS", project: { createdBy: adminUser.id } },
    },
  ]);
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  // $transaction mock: execute the array of operation promises in parallel
  (prisma.$transaction as jest.Mock).mockImplementation(async (args: any) => {
    if (Array.isArray(args)) return Promise.all(args);
    return args;
  });
  (prisma.document.update as jest.Mock).mockResolvedValue({});
  (prisma.documentChunk.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
  // Default fetch mock: non-2xx (no vectorCleanupAt marking)
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({ ok: false, status: 503 });
});

/** Flush pending microtasks/promises (fire-and-forget handlers). */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("POST /api/documents/bulk-delete", () => {
  it("soft-deletes accessible docs in a single $transaction and returns { deleted, failed }", async () => {
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: [DOC_ID_1, DOC_ID_2] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: [DOC_ID_1, DOC_ID_2], failed: [] });
    // Single $transaction with 4 ops (2 docs × [update + deleteMany])
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const txArgs = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(Array.isArray(txArgs)).toBe(true);
    expect(txArgs).toHaveLength(4);
    expect(prisma.documentChunk.deleteMany).toHaveBeenCalledWith({ where: { documentId: DOC_ID_1 } });
    expect(prisma.documentChunk.deleteMany).toHaveBeenCalledWith({ where: { documentId: DOC_ID_2 } });
    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC_ID_1 }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC_ID_2 }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });

  it("reports access-denied docs in failed[] (admin does NOT bypass per CR-01 D-04)", async () => {
    // Doc 2's project.createdBy !== admin → not project owner, and both
    // access lookups return null → access denied.
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      {
        id: DOC_ID_1,
        workspaceId: WS_ID,
        workspace: { projectId: "proj-bulk-1", name: "Bulk WS", project: { createdBy: adminUser.id } },
      },
      {
        id: DOC_ID_2,
        workspaceId: "ws-other",
        workspace: { projectId: "proj-other", name: "Other WS", project: { createdBy: "someone-else" } },
      },
    ]);

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: [DOC_ID_1, DOC_ID_2] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([DOC_ID_1]);
    expect(res.body.failed).toEqual([{ id: DOC_ID_2, error: "Access denied to this document" }]);
    // Only the accessible doc is in the transaction
    const txArgs = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(txArgs).toHaveLength(2);
  });

  it("reports non-existent documentIds in failed[] as 'Document not found'", async () => {
    // Only doc 1 exists; doc 2 is not in the findMany result.
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      {
        id: DOC_ID_1,
        workspaceId: WS_ID,
        workspace: { projectId: "proj-bulk-1", name: "Bulk WS", project: { createdBy: adminUser.id } },
      },
    ]);

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: [DOC_ID_1, "doc-missing"] });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toEqual([DOC_ID_1]);
    expect(res.body.failed).toEqual([{ id: "doc-missing", error: "Document not found" }]);
  });

  it("rejects invalid body (empty array) with 400", async () => {
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: [] });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects missing documentIds with 400", async () => {
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects non-array documentIds with 400", async () => {
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: "not-an-array" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("fires fire-and-forget collector cleanup per deleted doc and marks vectorCleanupAt on 2xx", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: [DOC_ID_1, DOC_ID_2] });

    expect(res.status).toBe(200);
    // Wait for fire-and-forget .then() handlers
    await flushPromises();

    // Two fetch calls (one per deleted doc)
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // Both DELETE requests target the collector ingest purge URL
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[0][1]?.method).toBe("DELETE");
    expect(calls[1][1]?.method).toBe("DELETE");
    // vectorCleanupAt marked for both docs
    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const vectorCleanupCalls = updateCalls.filter((c: any) => c[0]?.data?.vectorCleanupAt);
    expect(vectorCleanupCalls).toHaveLength(2);
  });

  it("calls logEvent per deleted doc", async () => {
    const { logEvent } = await import("../services/eventLogService");
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/bulk-delete")
      .set("Authorization", `Bearer ${token}`)
      .send({ documentIds: [DOC_ID_1, DOC_ID_2] });

    expect(res.status).toBe(200);
    expect(logEvent).toHaveBeenCalledWith("document", DOC_ID_1, "delete", adminUser.id);
    expect(logEvent).toHaveBeenCalledWith("document", DOC_ID_2, "delete", adminUser.id);
  });
});
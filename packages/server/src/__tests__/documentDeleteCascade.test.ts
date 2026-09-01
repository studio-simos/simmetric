// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Document DELETE cascade + vectorCleanupAt marking unit tests (D-07, D-08).
 *
 * Tests the hard-delete chunk cascade inside $transaction (D-07) and the
 * vectorCleanupAt marking on 2xx from the collector (D-08) in the DELETE
 * /api/documents/:documentId route. Also tests runVectorCleanupCycle "skips
 * when no pending" — the remaining runVectorCleanupCycle cases live in
 * vectorCleanupJob.test.ts (Task 3).
 *
 * Harness follows documentUpload.test.ts (setupEnv, mock prisma, mock env,
 * mock licenseService, mock builtinSkills, supertest against createApp).
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
// runVectorCleanupCycle is created in Task 2 GREEN phase; import will fail in RED.
import { runVectorCleanupCycle } from "../services/vectorCleanupJob";

const app = createApp();

const DOC_ID = "doc-cascade-001";
const WS_ID = "ws-cascade-1";

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    if (args?.where?.id === adminUser.id) return Promise.resolve(adminUser);
    return Promise.resolve(null);
  });
  (prisma.document.findFirst as jest.Mock).mockResolvedValue({
    id: DOC_ID,
    workspaceId: WS_ID,
    // CR-01 (plan 61): DELETE /documents runs a D-04 workspace-access check that
    // applies to ALL users including admins. The route reads
    // `document.workspace.project.createdBy` to compute isProjectOwner, then
    // falls back to workspaceAccess/projectAccess lookups. Make the admin the
    // project owner so the access gate passes without needing to mock the
    // access join tables.
    workspace: {
      projectId: "proj-cascade-1",
      project: { createdBy: adminUser.id },
    },
  });
  // $transaction mock: execute the array of operation promises in parallel
  (prisma.$transaction as jest.Mock).mockImplementation(async (args: any) => {
    if (Array.isArray(args)) {
      return Promise.all(args);
    }
    return args;
  });
  (prisma.document.update as jest.Mock).mockResolvedValue({});
  (prisma.documentChunk.deleteMany as jest.Mock).mockResolvedValue({ count: 2 });
  // Default fetch mock: returns a resolved Response-like object (non-2xx by default
  // so the fire-and-forget handler just logs a warning without calling document.update).
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({ ok: false, status: 503 });
});

/** Flush pending microtasks/promises (fire-and-forget handlers). */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("DELETE /api/documents/:documentId — cascade hard-delete (D-07)", () => {
  it("hard-deletes chunks in transaction on soft-delete", async () => {
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .delete(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // $transaction called with an array of 2 operations
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const txArgs = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(Array.isArray(txArgs)).toBe(true);
    expect(txArgs).toHaveLength(2);
    // documentChunk.deleteMany called with the right documentId (D-07)
    expect(prisma.documentChunk.deleteMany).toHaveBeenCalledWith({
      where: { documentId: DOC_ID },
    });
    // document.update called with deletedAt (soft-delete) inside the transaction
    expect(prisma.document.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: DOC_ID },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it("marks vectorCleanupAt on 2xx", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .delete(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Wait for fire-and-forget .then() handler to resolve
    await flushPromises();

    // document.update called with vectorCleanupAt (D-08 marking on 2xx)
    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const vectorCleanupCall = updateCalls.find(
      (call: any) => call[0]?.data?.vectorCleanupAt,
    );
    expect(vectorCleanupCall).toBeDefined();
    expect(vectorCleanupCall[0].data.vectorCleanupAt).toBeInstanceOf(Date);
  });

  it("leaves vectorCleanupAt null on 5xx", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .delete(`/api/documents/${DOC_ID}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Wait for fire-and-forget .then() handler to resolve
    await flushPromises();

    // document.update should NOT have a call with vectorCleanupAt (D-08: null on non-2xx)
    const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
    const vectorCleanupCall = updateCalls.find(
      (call: any) => call[0]?.data?.vectorCleanupAt,
    );
    expect(vectorCleanupCall).toBeUndefined();
  });
});

describe("runVectorCleanupCycle — skip when no pending (D-08)", () => {
  it("skips when no pending", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([]);

    const result = await runVectorCleanupCycle();

    expect(result).toEqual({ purged: 0, failed: 0 });
    // No fetch calls, no document.update calls
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});
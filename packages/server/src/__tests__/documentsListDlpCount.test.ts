// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * GET /api/documents dlpEntityCount route battery — Phase 192 plan 10 Task 3
 * (Gap 3 closure).
 *
 * Proves the entities-count chip arm derives from real served data:
 *  - the route passes _count: { select: { dlpEntities: true } } to findMany
 *    (source-level derivation pinned, not just fixture passthrough)
 *  - each served row carries dlpEntityCount mapped from the Prisma _count
 *    wrapper (3 and 0 arms) and the _count wrapper itself is NEVER
 *    serialized to the client
 *  - the served shape stays additive: every previously-served Document
 *    scalar field is unchanged (UnifiedUploadPage + documentBulkDelete
 *    consumers keep their contract)
 *  - single query arm: no per-row client fan-out is needed (the count rides
 *    the same findMany)
 *
 * Postgres-free: createMockPrisma + stubbed admin chain, supertest against
 * createApp() — the documentBulkDelete.test.ts scaffold.
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
  getFeatureLimit: jest.fn(() => Infinity),
}));

jest.mock("../agent/builtinSkills", () => {});
jest.mock("../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../services/systemConfigService", () => ({
  seedConfigDefaults: jest.fn(),
  getSetting: jest.fn(() => ({ value: "false" })),
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

const WS_ID = "ws-dlp-count-1";

/** A previously-served Document scalar shape (the additive baseline). */
function docScalarFixture(id: string, name: string) {
  return {
    id,
    workspaceId: WS_ID,
    organizationId: "00000000-0000-0000-0000-000000000000",
    name,
    type: "pdf",
    status: "completed",
    statusMessage: null,
    progress: 0,
    fileSize: 1024,
    chunkCount: 5,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    createdAt: new Date("2026-09-19T00:00:00Z"),
    updatedAt: new Date("2026-09-19T00:00:00Z"),
    deletedAt: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    if (args?.where?.id === adminUser.id) return Promise.resolve(adminUser);
    return Promise.resolve(null);
  });
  // The WR-04 OR-filter resolves access through the workspace→project chain;
  // the list route itself only needs findMany — owner-by-default is enough
  // for the mocked chain to serve rows.
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
});

describe("GET /api/documents — dlpEntityCount mapping (192-10 Gap 3)", () => {
  it("passes _count: { select: { dlpEntities: true } } to findMany (source-level derivation)", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${generateTestToken(adminUser.id)}`)
      .expect(200);

    const findManyArg = (prisma.document.findMany as jest.Mock).mock.calls[0][0] as {
      include?: { _count?: { select: { dlpEntities: boolean } } };
    };
    expect(findManyArg.include).toEqual({ _count: { select: { dlpEntities: true } } });
  });

  it("served rows carry dlpEntityCount mapped from the _count delegate (3 and 0 arms); _count wrapper stripped", async () => {
    const scanned = { ...docScalarFixture("doc-scan-1", "contratto.pdf"), dlpScanState: "scanned", dlpScannedAt: new Date("2026-09-19T10:00:00Z") };
    const legacy = docScalarFixture("doc-legacy-1", "vecchio.csv");
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { ...scanned, _count: { dlpEntities: 3 } },
      { ...legacy, _count: { dlpEntities: 0 } },
    ]);

    const res = await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${generateTestToken(adminUser.id)}`)
      .expect(200);

    expect(res.body).toHaveLength(2);

    const scannedRow = res.body[0];
    expect(scannedRow.dlpEntityCount).toBe(3);
    expect(scannedRow._count).toBeUndefined();
    // Additive baseline: every previously-served scalar is unchanged.
    expect(scannedRow.id).toBe("doc-scan-1");
    expect(scannedRow.name).toBe("contratto.pdf");
    expect(scannedRow.workspaceId).toBe(WS_ID);
    expect(scannedRow.status).toBe("completed");
    expect(scannedRow.chunkCount).toBe(5);
    expect(scannedRow.fileSize).toBe(1024);
    expect(scannedRow.dlpScanState).toBe("scanned");
    expect(scannedRow.dlpScannedAt).toBe("2026-09-19T10:00:00.000Z");

    const legacyRow = res.body[1];
    expect(legacyRow.dlpEntityCount).toBe(0);
    expect(legacyRow._count).toBeUndefined();
    // Unscanned legacy row: no scan markers → the chip's zero arm keys on
    // dlpScanState first (renders nothing), whatever the count.
    expect(legacyRow.dlpScanState).toBeUndefined();
  });

  it("single query arm: one findMany call serves the counts (no N+1 / no per-row fetch)", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { ...docScalarFixture("doc-1", "a.pdf"), _count: { dlpEntities: 1 } },
      { ...docScalarFixture("doc-2", "b.pdf"), _count: { dlpEntities: 2 } },
      { ...docScalarFixture("doc-3", "c.pdf"), _count: { dlpEntities: 0 } },
    ]);

    await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${generateTestToken(adminUser.id)}`)
      .expect(200);

    expect(prisma.document.findMany).toHaveBeenCalledTimes(1);
    // No per-row secondary fetches anywhere in the route path. The mock now
    // carries a dlpEntity delegate (Phase 204 FEAT-01 re-scan arm — the deep
    // mock needed it for the document text-edit route), so the pin asserts
    // the delegate is NEVER TOUCHED by the list route instead of absent:
    // the tripwire's intent is "no per-row fetch", not "no delegate".
    expect(prisma.dlpEntity.findMany).not.toHaveBeenCalled();
    expect(prisma.dlpEntity.count).not.toHaveBeenCalled();
    expect(prisma.dlpEntity.findUnique).not.toHaveBeenCalled();
    expect(prisma.document.findUnique).not.toHaveBeenCalled();
  });

  it("no PII leakage: entity VALUES never ride the rows — counts only (T-192-31)", async () => {
    (prisma.document.findMany as jest.Mock).mockResolvedValue([
      { ...docScalarFixture("doc-1", "contratto.pdf"), _count: { dlpEntities: 7 } },
    ]);

    const res = await request(app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${generateTestToken(adminUser.id)}`)
      .expect(200);

    const serialized = JSON.stringify(res.body);
    // The count field is a bare number; no entity-class or value fields.
    expect(serialized).not.toContain("entityClass");
    expect(serialized).not.toContain("originalEncrypted");
    expect(serialized).not.toContain("placeholder");
    expect(typeof res.body[0].dlpEntityCount).toBe("number");
  });
});
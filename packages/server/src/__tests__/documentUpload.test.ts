// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

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
  getSetting: jest.fn((key: string) => {
    // Per-key mock: default ALLOW_NON_ADMIN_UPLOAD=true so existing tests
    // that don't flip the toggle are not blocked by the new D-02 gate.
    if (key === "ALLOW_NON_ADMIN_UPLOAD") return { value: "true" };
    if (key === "EMBEDDING_MODEL") return { value: "Xenova/all-MiniLM-L6-v2" };
    if (key === "OCR_DEFAULT_MODEL") return { value: "glm-ocr:latest" };
    return { value: "" };
  }),
}));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../services/eventLogService", () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../services/ragOcrService", () => ({
  extractTextFromPdf: jest.fn(),
  cleanupOcrTextFile: jest.fn(),
}));

// Phase 184 (SAAS-03): provider mock surface lives in a shared helper so the
// hoisted jest.mock factory and the per-test handles reference the same fns.
jest.mock("../services/storageProvider", () =>
  require("./helpers/mockStorageProvider").mockStorageProviderModule,
);

import request from "supertest";
import { createApp } from "../index";
import {
  generateTestToken,
  regularUser,
  noDocWriteUser,
  adminUser,
  adminWithWorkspaceAccess,
  adminWithoutWorkspaceAccess,
  regularUserWithWorkspaceAccess,
} from "./helpers/mockAuth";
import prisma from "../utils/prisma";
import { getSetting } from "../services/systemConfigService";
// Mock-surface handles (jest.mock factories hoist above the imports — the
// live handles live here and are mutated per-test).
import { mockProviderPut, mockGetStorageProvider, mockProviderDelete } from "./helpers/mockStorageProvider";

const app = createApp();

// IN-03 (plan 61): the upload route validates workspaceId as a UUID at the
// API boundary (z.string().uuid()) BEFORE the D-04 access/allowMemberUploads
// gate. Use a real UUID so requests reach the 403 gates the tests assert on,
// rather than being rejected with 400 "Invalid workspaceId".
const WS_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "proj-1";

/** Standard workspace fixture: project createdBy "other-user". */
const workspaceFixture = (allowMemberUploads: boolean) => ({
  id: WS_ID,
  projectId: PROJECT_ID,
  name: "Test Workspace",
  allowMemberUploads,
  project: { id: PROJECT_ID, createdBy: "other-user" },
});

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === noDocWriteUser.id) return Promise.resolve(noDocWriteUser);
    if (id === adminUser.id) return Promise.resolve(adminUser);
    if (id === adminWithWorkspaceAccess.id) return Promise.resolve(adminWithWorkspaceAccess);
    if (id === adminWithoutWorkspaceAccess.id) return Promise.resolve(adminWithoutWorkspaceAccess);
    if (id === regularUserWithWorkspaceAccess.id) return Promise.resolve(regularUserWithWorkspaceAccess);
    return Promise.resolve(null);
  });
  // Default: workspace exists with allowMemberUploads=true
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(true));
  // Default: no workspace access, no project access
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.document.create as jest.Mock).mockResolvedValue({ id: "doc-new", workspaceId: WS_ID });
});

describe("Document upload RBAC", () => {
  it("allows user with document:write to POST /upload", async () => {
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("workspaceId", "ws-1");

    // Not 403 — the permission check passed (may be 400 for no file)
    expect(res.status).not.toBe(403);
  });

  it("blocks user without document:write from POST /upload (403)", async () => {
    const token = generateTestToken(noDocWriteUser.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("workspaceId", "ws-1");

    expect(res.status).toBe(403);
  });

  it("allows admin to POST /upload", async () => {
    const token = generateTestToken(adminUser.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).not.toBe(403);
  });
});

describe("Document upload D-04 gate (admin requires workspace access, bypasses only allowMemberUploads)", () => {
  it("allows non-admin with access (workspaceAccess + allowMemberUploads=true) — not 403", async () => {
    // regularUserWithWorkspaceAccess has workspaceAccess to ws-1
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.userId === regularUserWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
        return Promise.resolve({ userId: regularUserWithWorkspaceAccess.id, workspaceId: WS_ID });
      }
      return Promise.resolve(null);
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(true));

    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).not.toBe(403);
  });

  it("blocks non-admin without allowMemberUploads (workspaceAccess=true, allowMemberUploads=false) — 403", async () => {
    // Phase 70 D-04: the gate is now `globalAllowed || workspace.allowMemberUploads`.
    // Default mock has ALLOW_NON_ADMIN_UPLOAD=true, so flip it to false here to
    // exercise the 403 path (both toggles false).
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { value: "false" };
      if (key === "EMBEDDING_MODEL") return { value: "Xenova/all-MiniLM-L6-v2" };
      if (key === "OCR_DEFAULT_MODEL") return { value: "glm-ocr:latest" };
      return { value: "" };
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.userId === regularUserWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
        return Promise.resolve({ userId: regularUserWithWorkspaceAccess.id, workspaceId: WS_ID });
      }
      return Promise.resolve(null);
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(false));

    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/restricted to admins/i);
  });

  it("admin bypasses allowMemberUploads (admin + workspaceAccess + allowMemberUploads=false) — not 403", async () => {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.userId === adminWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
        return Promise.resolve({ userId: adminWithWorkspaceAccess.id, workspaceId: WS_ID });
      }
      return Promise.resolve(null);
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(false));

    const token = generateTestToken(adminWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).not.toBe(403);
  });

  it("admin without workspace access blocked (admin + no workspaceAccess) — 403", async () => {
    // adminWithoutWorkspaceAccess has no workspaceAccess
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(true));

    const token = generateTestToken(adminWithoutWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });
});

// =========================================================================
// Phase 70 — SC-1b toggle OR on POST /api/documents/upload (D-04)
// D-02: assertNonAdminUploadAllowed replaces the inline :306 gate.
// D-03: fail-closed parse (value === "true").
// =========================================================================
describe("POST /api/documents/upload — SC-1b toggle OR (Phase 70 D-04)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === regularUserWithWorkspaceAccess.id) return Promise.resolve(regularUserWithWorkspaceAccess);
      if (args?.where?.id === adminWithWorkspaceAccess.id) return Promise.resolve(adminWithWorkspaceAccess);
      return Promise.resolve(null);
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(false));
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.userId === regularUserWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
        return Promise.resolve({ userId: regularUserWithWorkspaceAccess.id, workspaceId: WS_ID });
      }
      if (args?.where?.userId === adminWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
        return Promise.resolve({ userId: adminWithWorkspaceAccess.id, workspaceId: WS_ID });
      }
      return Promise.resolve(null);
    });
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.document.create as jest.Mock).mockResolvedValue({ id: "doc-new", workspaceId: WS_ID });
  });

  it("non-admin with both toggles false → 403 (body: 'Uploads are restricted to admins in this workspace')", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { value: "false" };
      if (key === "EMBEDDING_MODEL") return { value: "Xenova/all-MiniLM-L6-v2" };
      if (key === "OCR_DEFAULT_MODEL") return { value: "glm-ocr:latest" };
      return { value: "" };
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(false));

    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Uploads are restricted to admins in this workspace");
  });

  it("non-admin with ALLOW_NON_ADMIN_UPLOAD=true + allowMemberUploads=false → not 403 (OR-inclusive)", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { value: "true" };
      if (key === "EMBEDDING_MODEL") return { value: "Xenova/all-MiniLM-L6-v2" };
      if (key === "OCR_DEFAULT_MODEL") return { value: "glm-ocr:latest" };
      return { value: "" };
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(false));

    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).not.toBe(403);
  });

  it("non-admin with ALLOW_NON_ADMIN_UPLOAD=false + allowMemberUploads=true → not 403 (OR-inclusive)", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { value: "false" };
      if (key === "EMBEDDING_MODEL") return { value: "Xenova/all-MiniLM-L6-v2" };
      if (key === "OCR_DEFAULT_MODEL") return { value: "glm-ocr:latest" };
      return { value: "" };
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(true));

    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).not.toBe(403);
  });

  it("admin with both toggles false → bypasses toggle (not 403)", async () => {
    (getSetting as jest.Mock).mockImplementation((key: string) => {
      if (key === "ALLOW_NON_ADMIN_UPLOAD") return { value: "false" };
      if (key === "EMBEDDING_MODEL") return { value: "Xenova/all-MiniLM-L6-v2" };
      if (key === "OCR_DEFAULT_MODEL") return { value: "glm-ocr:latest" };
      return { value: "" };
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(false));

    const token = generateTestToken(adminWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    // admin bypasses the toggle but NOT workspace access (which admin has here)
    expect(res.status).not.toBe(403);
  });
});

// =========================================================================
// quick 260808-vzm — filename sanitization on POST /api/documents/upload
// =========================================================================
describe("POST /api/documents/upload — filename sanitization (quick 260808-vzm)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === adminWithWorkspaceAccess.id) return Promise.resolve(adminWithWorkspaceAccess);
      return Promise.resolve(null);
    });
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture(true));
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.userId === adminWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
        return Promise.resolve({ userId: adminWithWorkspaceAccess.id, workspaceId: WS_ID });
      }
      return Promise.resolve(null);
    });
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.document.create as jest.Mock).mockResolvedValue({ id: "doc-new", workspaceId: WS_ID });
  });

  it("stores the sanitized name in Document.name (spaces/parens -> dashes)", async () => {
    const token = generateTestToken(adminWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "My Report (final).txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).toBe(201);
    const createArgs = (prisma.document.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.name).toBe("My-Report-final.txt");
  });
});

// =========================================================================
// Phase 184 (SAAS-03) — seam 1: upload writes storageKey (row's-org rule,
// T-184-01), provider.put AFTER the row lands, tmp unlinked post-put
// (T-184-06 ingress contract), forwardToCollector receives the provider
// options { storageKey, organizationId }.
// =========================================================================
describe("POST /api/documents/upload — provider seam (Phase 184)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProviderPut.mockReset().mockResolvedValue({ key: "k", size: 5 });
    mockProviderDelete.mockReset().mockResolvedValue(undefined);
    mockGetStorageProvider.mockReset().mockResolvedValue({
      put: mockProviderPut,
      get: jest.fn(),
      getReadStream: jest.fn(),
      delete: mockProviderDelete,
      exists: jest.fn(),
    });
    (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === adminWithWorkspaceAccess.id) return Promise.resolve(adminWithWorkspaceAccess);
      return Promise.resolve(null);
    });
    // Workspace fixture carries organizationId (Phase 182 column) — the
    // row's-org rule derives the key prefix from IT, never client input.
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture(true),
      organizationId: "22222222-2222-4222-8222-222222222222",
    });
    // Admin with workspace access — the D-04 gate passes without the
    // ALLOW_NON_ADMIN_UPLOAD toggle
    (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.userId === adminWithWorkspaceAccess.id && args?.where?.workspaceId === WS_ID) {
        return Promise.resolve({ userId: adminWithWorkspaceAccess.id, workspaceId: WS_ID });
      }
      return Promise.resolve(null);
    });
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.document.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: "doc-new", workspaceId: WS_ID, ...args.data }),
    );
  });

  it("writes storageKey with the workspace-org prefix and uuid-safeName shape (row's-org rule, T-184-01)", async () => {
    const token = generateTestToken(adminWithWorkspaceAccess.id);
    const res = await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "report.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(res.status).toBe(201);
    const createArgs = (prisma.document.create as jest.Mock).mock.calls[0][0];
    expect(createArgs.data.storageKey).toMatch(
      /^22222222-2222-4222-8222-222222222222\/uploads\/[0-9a-f-]{36}-report\.txt$/,
    );
    // filePath stays (additive policy, D-05)
    expect(createArgs.data.filePath).toBeDefined();
  });

  it("calls provider.put with (req.file.path, storageKey) AFTER the document.create row", async () => {
    const token = generateTestToken(adminWithWorkspaceAccess.id);
    await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "report.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    expect(mockProviderPut).toHaveBeenCalledTimes(1);
    expect(mockProviderPut.mock.calls[0][1]).toBe(
      (prisma.document.create as jest.Mock).mock.calls[0][0].data.storageKey,
    );
    // Resolution went through the cascade with the row's org (D-01)
    expect(mockGetStorageProvider).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("provider.put is awaited AFTER the row create (put-after-row ordering)", async () => {
    // The put mock must see its call AFTER the create call — probe via mock
    // invocation order.
    const token = generateTestToken(adminWithWorkspaceAccess.id);
    await request(app)
      .post("/api/documents/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("hello"), { filename: "order.txt", contentType: "text/plain" })
      .field("workspaceId", WS_ID);

    const createInvoked = (prisma.document.create as jest.Mock).mock.invocationCallOrder[0]!;
    const putInvoked = mockProviderPut.mock.invocationCallOrder[0]!;
    expect(createInvoked).toBeLessThan(putInvoked);
  });

  it("mid-abort probe: put throws AFTER the row create → 500, row stays pre-forward (recoverable), tmp unlink attempted (T-184-06)", async () => {
    mockProviderPut.mockRejectedValueOnce(new Error("provider put interrupted"));
    const unlinkSpy = jest.spyOn(require("fs"), "unlinkSync").mockImplementation(() => {});

    try {
      const token = generateTestToken(adminWithWorkspaceAccess.id);
      const res = await request(app)
        .post("/api/documents/upload")
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("hello"), { filename: "abort.txt", contentType: "text/plain" })
        .field("workspaceId", WS_ID);

      expect(res.status).toBe(500);
      // Row create happened exactly once (the recoverable pending row)
      expect(prisma.document.create).toHaveBeenCalledTimes(1);
      // forwardToCollector was NOT invoked — the row remains pre-forward
      // (its status stays "pending", never corrupt/partially-written).
      // forwardToCollector's first prisma touch is document.update(status=processing);
      // the abort happened before forward, so no processing update is recorded.
      const updateCalls = (prisma.document.update as jest.Mock).mock.calls;
      expect(
        updateCalls.some((call: unknown[]) => JSON.stringify(call).includes('"processing"')),
      ).toBe(false);
      // Ingress cleanup ran for the aborted tmp (best-effort unlink in the
      // put-catch arm) — no dangling tmp beyond WR-01/WR-02.
      expect(unlinkSpy).toHaveBeenCalled();
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("unlinks the multer tmp AFTER a successful put (ingress buffer, not storage)", async () => {
    const unlinkSpy = jest.spyOn(require("fs"), "unlinkSync").mockImplementation(() => {});
    try {
      const token = generateTestToken(adminWithWorkspaceAccess.id);
      const res = await request(app)
        .post("/api/documents/upload")
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("hello"), { filename: "tmpunlink.txt", contentType: "text/plain" })
        .field("workspaceId", WS_ID);

      expect(res.status).toBe(201);
      // The tmp unlink targeted req.file.path AFTER put
      const putInvoked = mockProviderPut.mock.invocationCallOrder[0]!;
      const unlinkInvoked = unlinkSpy.mock.invocationCallOrder[0]!;
      expect(putInvoked).toBeLessThan(unlinkInvoked);
    } finally {
      unlinkSpy.mockRestore();
    }
  });
});
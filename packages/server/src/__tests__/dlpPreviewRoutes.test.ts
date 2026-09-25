// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DLP preview route tests (Phase 192 plan 04 Task 1 — tracer).
 *
 * Pins the D-10 masked-default + permission-gated unmask arm on
 * GET /api/documents/:documentId/text:
 *   - masked default (no param): joined chunkText AS STORED, shape
 *     { text, length, name, type, status } unchanged (DocumentText
 *     contract — frontend useDocuments.ts:23-29 must stay byte-compatible)
 *   - unmask gate matrix: admin/owner/editor/viewer × toggle on/off;
 *     dlp:unmask resolution goes through resolveWorkspaceRole (source
 *     assertion — no direct prisma.workspaceAccess read in the unmask arm)
 *   - unmask-miss arms fall back to the MASKED text (200 — never a 4xx
 *     oracle distinguishing permission from content; UI-SPEC: the server
 *     enforces, the UI hides)
 *   - cross-tenant negative (T-78-01 inheritance): no workspace/project
 *     access → 403 on the unmask variant exactly as on the masked view,
 *     and the entity map is NEVER loaded for forbidden users
 *   - entity-map lazy-load: buildRecompositionMap only runs post-gate
 *   - unresolvable placeholders stay literal tokens
 *   - ?unmask=banana → 400 (strict literal-union query schema, T-192-21)
 *   - 404 shape unchanged
 *
 * Mock skeleton mirrors documents.text.test.ts (createApp + supertest +
 * createMockPrisma + stubbed authMiddleware via prisma.user.findUnique).
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
jest.mock("../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));

// The single-resolver seam — the route must call THIS, never
// prisma.workspaceAccess directly (Phase 189 D-07 contract).
const mockResolveWorkspaceRole = jest.fn();

jest.mock("../middleware/rbac", () => {
  const actual = jest.requireActual("../middleware/rbac") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    resolveWorkspaceRole: (...args: unknown[]) => mockResolveWorkspaceRole(...(args as [])),
  };
});

// Entity-service seam — call-count assertions prove the lazy post-gate load.
const mockBuildRecompositionMap = jest.fn();

jest.mock("../services/dlpEntityService", () => ({
  __esModule: true,
  buildRecompositionMap: (...args: unknown[]) => mockBuildRecompositionMap(...(args as [])),
  buildPlaceholderRegex:
    jest.requireActual("../services/dlpEntityService").buildPlaceholderRegex,
}));

import request from "supertest";
import { createApp } from "../index";
import {
  generateTestToken,
  regularUser,
  regularUserWithWorkspaceAccess,
  regularUserWithoutWorkspaceAccess,
} from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

const DOC_ID = "doc-dlp-001";
const WS_ID = "ws-1";
const PROJECT_ID = "proj-1";

/** Masked document fixture — chunkText carries placeholder tokens. */
const dlpDocument = {
  id: DOC_ID,
  workspaceId: WS_ID,
  name: "contratto.md",
  type: "md",
  status: "completed",
  workspace: {
    id: WS_ID,
    projectId: PROJECT_ID,
    project: { id: PROJECT_ID, createdBy: "other-user" },
  },
  chunks: [
    { id: `${DOC_ID}-1`, chunkText: "Residenza: [ADDRESS_1]", metadata: "{}" },
    { id: `${DOC_ID}-0`, chunkText: "Il firmatario è [PERSON_1], CF [GOV_ID_1].", metadata: "{}" },
  ],
};

/** The entity map buildRecompositionMap returns when permission holds. */
const entityMap = new Map<string, string>([
  ["[PERSON_1]", "Maria Rossi"],
  ["[ADDRESS_1]", "Via Roma 1"],
  ["[GOV_ID_1]", "RSSMRA85M01H501X"],
]);

/** dlp:unmask-holding editor (the shape getEffectivePermissions reads). */
const unmaskEditor = {
  id: regularUserWithWorkspaceAccess.id,
  roles: [
    {
      role: {
        name: "editor",
        permissions: [
          { permissionName: "chat:write" },
          { permissionName: "document:read" },
          { permissionName: "dlp:unmask" },
        ],
      },
    },
  ],
};

/** Same shape WITHOUT dlp:unmask — the DEFAULT_USER_ROLE arm. */
const plainEditor = {
  id: regularUserWithWorkspaceAccess.id,
  roles: [
    {
      role: {
        name: "editor",
        permissions: [
          { permissionName: "chat:write" },
          { permissionName: "document:read" },
        ],
      },
    },
  ],
};

/** Admin fixture — mirrors the DEFAULT_ADMIN_ROLE seed spread shape. */
const adminWithDlp = {
  id: "admin-dlp-001",
  roles: [
    {
      role: {
        name: "admin",
        permissions: [
          { permissionName: "admin:settings" },
          { permissionName: "dlp:unmask" },
        ],
      },
    },
  ],
};

function toggleOn() {
  (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
    id: WS_ID,
    dlpDocumentScanEnabled: true,
  });
}

function toggleOff() {
  (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
    id: WS_ID,
    dlpDocumentScanEnabled: false,
  });
}

function resolveAs(role: string | null) {
  mockResolveWorkspaceRole.mockResolvedValue(role);
}

beforeEach(() => {
  jest.clearAllMocks();

  (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
    const id = args?.where?.id;
    // The with-access editor carries dlp:unmask by default (the gate-matrix
    // happy path); tests without the permission override this mock.
    if (id === regularUserWithWorkspaceAccess.id) return Promise.resolve(unmaskEditor);
    if (id === regularUser.id) return Promise.resolve(regularUser);
    if (id === regularUserWithoutWorkspaceAccess.id) return Promise.resolve(regularUserWithoutWorkspaceAccess);
    return Promise.resolve(null);
  });

  (prisma.document.findFirst as jest.Mock).mockResolvedValue(dlpDocument);

  (prisma.workspaceAccess.findFirst as jest.Mock).mockImplementation((args: any) => {
    const userId = args?.where?.userId;
    const workspaceId = args?.where?.workspaceId;
    if (workspaceId !== WS_ID) return Promise.resolve(null);
    return Promise.resolve(userId === regularUserWithWorkspaceAccess.id ? { userId, workspaceId } : null);
  });

  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

  toggleOn();
  resolveAs("editor");
  mockBuildRecompositionMap.mockResolvedValue(entityMap);
});

describe("GET /:documentId/text — masked default (D-10 structural inheritance)", () => {
  it("serves the joined chunkText AS STORED (placeholders intact) with the unchanged shape", async () => {
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.text).toBe(
      "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]",
    );
    expect(res.body.length).toBe(res.body.text.length);
    expect(res.body.name).toBe("contratto.md");
    expect(res.body.type).toBe("md");
    expect(res.body.status).toBe("completed");
    expect(res.body.filePath).toBeUndefined();
    // Masked default costs nothing DLP-side: no toggle read, no map load.
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("never-scanned document (plain chunkText) is byte-identical to the pre-DLP behavior", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      ...dlpDocument,
      chunks: [
        { id: `${DOC_ID}-0`, chunkText: "plain text", metadata: "{}" },
      ],
    });
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toBe("plain text");
  });
});

describe("GET /:documentId/text?unmask=true — gate matrix", () => {
  it("dlp:unmask editor + toggle-on → re-composed text, shape unchanged, length reflects served text", async () => {
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.text).toBe(
      "Il firmatario è Maria Rossi, CF RSSMRA85M01H501X.\n\nResidenza: Via Roma 1",
    );
    expect(res.body.length).toBe(res.body.text.length);
    expect(res.body.name).toBe("contratto.md");
    // Single-resolver contract: resolved through resolveWorkspaceRole.
    expect(mockResolveWorkspaceRole).toHaveBeenCalledWith(
      regularUserWithWorkspaceAccess.id,
      WS_ID,
      expect.anything(),
    );
    // Map loaded exactly once, scoped to this document.
    expect(mockBuildRecompositionMap).toHaveBeenCalledTimes(1);
    expect(mockBuildRecompositionMap).toHaveBeenCalledWith([DOC_ID]);
  });

  it("admin arm — resolveWorkspaceRole admin tier + seeded dlp:unmask → re-composed", async () => {
    (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === adminWithDlp.id) return Promise.resolve(adminWithDlp);
      return Promise.resolve(null);
    });
    // Admin still needs the D-04 access gate (workspaceAccess row).
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: adminWithDlp.id,
      workspaceId: WS_ID,
    });
    resolveAs("admin");

    const token = generateTestToken(adminWithDlp.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toContain("Maria Rossi");
  });

  it("owner arm — project owner without dlp:unmask → masked (permission is per-permission, not per-role)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue({
      ...dlpDocument,
      workspace: { ...dlpDocument.workspace, project: { id: PROJECT_ID, createdBy: regularUser.id } },
    });
    resolveAs("owner");
    const token = generateTestToken(regularUser.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toBe(
      "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]",
    );
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("editor WITHOUT dlp:unmask → masked 200 (never a 4xx entitlement oracle)", async () => {
    resolveAs("editor");
    // Override the route-visible user payload to the permission-less editor.
    (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === regularUserWithWorkspaceAccess.id) return Promise.resolve(plainEditor);
      return Promise.resolve(null);
    });
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toBe(
      "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]",
    );
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("viewer role (dlp:unmask not in DEFAULT_USER_ROLE) → masked 200", async () => {
    resolveAs("viewer");
    // Override the route-visible user payload: a viewer's role payload
    // carries no dlp:unmask (DEFAULT_USER_ROLE never gains it).
    (prisma.user.findUnique as jest.Mock).mockImplementation((args: any) => {
      if (args?.where?.id === regularUserWithWorkspaceAccess.id) return Promise.resolve(plainEditor);
      return Promise.resolve(null);
    });
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toBe(
      "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]",
    );
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("toggle OFF → masked 200, no role resolution, no map load (the toggle gates the whole surface)", async () => {
    toggleOff();
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toBe(
      "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]",
    );
    expect(mockResolveWorkspaceRole).not.toHaveBeenCalled();
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("workspace row missing → masked 200 (fail-closed)", async () => {
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toContain("[PERSON_1]");
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("empty entity map (never-scanned doc + unmask) → masked text byte-identical", async () => {
    mockBuildRecompositionMap.mockResolvedValue(new Map());
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toBe(
      "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]",
    );
  });

  it("unresolvable placeholder stays literal (partial unmask, never an error)", async () => {
    mockBuildRecompositionMap.mockResolvedValue(new Map([["[PERSON_1]", "Maria Rossi"]]));
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toBe(
      "Il firmatario è Maria Rossi, CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]",
    );
  });

  it("RACE WINDOW: re-scan replaced the entity rows between the masked fetch and the unmask fetch → stale placeholders stay literal, fresh ones resolve (192-UAT Test 4 behavioral pin)", async () => {
    // The user loaded the masked text when scan N's placeholders
    // ([PERSON_1]) were served. A concurrent re-scan rewrote the entity
    // rows with scan N+1's numbering ([PERSON_2]) BEFORE the user clicked
    // Show. The unmask request builds its map from CURRENT rows — so the
    // served chunk text's STALE [PERSON_1] token is a map miss (stays a
    // literal, never an error, never strips the token) while the fresh
    // [ADDRESS_1] row still resolves.
    mockBuildRecompositionMap.mockResolvedValue(
      new Map([
        ["[PERSON_2]", "Mario Rossi"],
        ["[ADDRESS_1]", "Via Roma 1"],
      ]),
    );
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    // [PERSON_1] is the STALE scan-N token — no current row carries it →
    // it must survive literally (graceful degradation, no 500, no
    // entitlement oracle). [ADDRESS_1] resolves normally.
    expect(res.body.text).toBe(
      "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: Via Roma 1",
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /:documentId/text?unmask=true — cross-tenant negative (T-78-01 inheritance)", () => {
  it("user with NO workspace/project access → 403, entity map NEVER loaded", async () => {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUserWithoutWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    expect(res.body.error.message).toMatch(/access denied/i);
    // The same 403 shape as the masked view — no oracle distinguishing
    // permission from content; and no decrypt work happened.
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
    expect(mockResolveWorkspaceRole).not.toHaveBeenCalled();
  });

  it("masked view (no param) for the same user → identical 403 shape", async () => {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUserWithoutWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    expect(res.body.error.message).toMatch(/access denied/i);
  });
});

describe("GET /:documentId/text — query contract + shape pins", () => {
  it("?unmask=banana → 400 (strict literal-union schema — T-192-21)", async () => {
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=banana`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
    expect(res.body.error.message).toBe("Invalid query parameter");
    expect(res.body.error.details).toBeDefined();
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("?unmask=false → masked text (explicit opt-out parses, never unmasks)", async () => {
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/${DOC_ID}/text?unmask=false`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.text).toContain("[PERSON_1]");
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });

  it("unknown documentId → 404 unchanged (unmask param irrelevant)", async () => {
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(null);
    const token = generateTestToken(regularUserWithWorkspaceAccess.id);
    const res = await request(app)
      .get(`/api/documents/nonexistent/text?unmask=true`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
    expect(res.body.error.message).toBe("Document not found");
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });
});

describe("unmask arm — wiring invariants (source assertions)", () => {
  const fs = require("fs");
  const path = require("path");
  const routeSrc = fs.readFileSync(path.resolve(__dirname, "../routes/documents.ts"), "utf8");

  it("the unmask arm sits AFTER the D-04 access gate (entity map loads only post-gate)", () => {
    const routeStart = routeSrc.indexOf('router.get("/:documentId/text"');
    const routeEnd = routeSrc.indexOf("// POST /api/documents/bulk-delete", routeStart);
    const routeBlock = routeSrc.slice(routeStart, routeEnd);
    const gate = routeBlock.indexOf("Access denied to this document");
    const mapLoad = routeBlock.indexOf("buildRecompositionMap([document.id])");
    expect(gate).toBeGreaterThan(0);
    expect(mapLoad).toBeGreaterThan(gate);
  });

  it("no direct prisma.workspaceAccess read in the unmask arm (single-resolver contract)", () => {
    const routeStart = routeSrc.indexOf('router.get("/:documentId/text"');
    const routeEnd = routeSrc.indexOf("// POST /api/documents/bulk-delete", routeStart);
    const routeBlock = routeSrc.slice(routeStart, routeEnd);
    const unmaskStart = routeBlock.indexOf("unmaskRequested = unmaskQuery.data.unmask === true;");
    const unmaskEnd = routeBlock.indexOf("res.json({", unmaskStart);
    const unmaskBlock = routeBlock.slice(unmaskStart, unmaskEnd);
    // The workspaceAccess read above belongs to the D-04 gate, NOT the
    // unmask arm — the unmask block itself must not carry one.
    expect(unmaskBlock).not.toContain("prisma.workspaceAccess");
    expect(unmaskBlock).toContain("resolveWorkspaceRole");
  });
});
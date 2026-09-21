// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 194 interaction matrix — pair 4/6: isolation × DLP.
 *
 * ONE owned test (194-CONTEXT D-01/D-02) pinning the unmask-gate seam:
 * SAME document, SAME request shape (?unmask=true on
 * GET /api/documents/:documentId/text), THREE permission arms resolved
 * through the Phase 189 single resolver's effective permissions —
 *   (1) authorized member (editor + dlp:unmask) → unredacted text;
 *   (2) viewer arm → the masked-200 fallback (never a 4xx entitlement
 *       oracle — the 192-04 contract);
 *   (3) revoked former member (no row) → masked 200.
 *
 * The ISOLATION half of the seam is structural: the gate CONSUMES
 * resolveWorkspaceRole's output (the 189 single-resolver contract — the
 * route's unmask arm has NO parallel role check; dlpPreviewRoutes pins the
 * source shape). What THIS test adds beyond dlpPreviewRoutes' gate-matrix
 * (D-02: no duplication): the role LIFECYCLES crossing the gate — the SAME
 * principal transitions editor(authorized) → viewer(downgraded) → revoked
 * and the served text tracks the resolver's output at each transition on
 * the identical request, proving the gate is resolver-driven (no cached
 * role, no parallel row read) and fails closed to masked-200.
 *
 * Postgres-free: mockPrisma + the resolver mocked at the seam exactly as
 * dlpPreviewRoutes does (the route-under-test consumes the resolver; the
 * resolver's own precedence matrix is pinned by resolveWorkspaceRole.test.ts).
 */
// @ts-nocheck
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

// The single-resolver seam — the gate must consume THIS (Phase 189 D-07);
// the mock stands in for the resolver whose precedence matrix is already
// pinned by resolveWorkspaceRole.test.ts. The role LIFECYCLE (editor →
// viewer → revoked) is modeled at this seam.
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
import { generateTestToken } from "./helpers/mockAuth";
import prisma from "../utils/prisma";

const app = createApp();

const DOC_ID = "doc-ixd-001";
const WS_ID = "ws-ixd-1";
const PROJECT_ID = "proj-ixd-1";
const MEMBER_ID = "member-ixd-001";

const MASKED_TEXT = "Il firmatario è [PERSON_1], CF [GOV_ID_1].\n\nResidenza: [ADDRESS_1]";
const UNMASKED_TEXT = "Il firmatario è Maria Rossi, CF RSSMRA85M01H501X.\n\nResidenza: Via Roma 1";

/** Masked document fixture — dlpPreviewRoutes' shape. */
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

const entityMap = new Map<string, string>([
  ["[PERSON_1]", "Maria Rossi"],
  ["[ADDRESS_1]", "Via Roma 1"],
  ["[GOV_ID_1]", "RSSMRA85M01H501X"],
]);

/** dlp:unmask-holding editor (the shape getEffectivePermissions reads). */
const editorWithUnmask = {
  id: MEMBER_ID,
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

/** The SAME payload shape post-downgrade — viewer carries NO dlp:unmask
 * (DEFAULT_USER_ROLE never gains it; the D-10 permission is per-permission). */
const viewerWithoutUnmask = {
  id: MEMBER_ID,
  roles: [
    {
      role: {
        name: "viewer",
        permissions: [
          { permissionName: "chat:read" },
          { permissionName: "document:read" },
        ],
      },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();

  (prisma.user.findUnique as jest.Mock).mockImplementation(() => {
    // The auth cache resolves the CURRENT user payload per request — the
    // role lifecycle is modeled by swapping this row between arms.
    return Promise.resolve(currentPrincipal.user);
  });

  (prisma.document.findFirst as jest.Mock).mockResolvedValue(dlpDocument);

  // The D-04 access gate (route-level) — member holds a workspaceAccess row
  // across ALL arms (the gate is binary access; the GRADING happens in the
  // resolver — that split is the seam under test).
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
    userId: MEMBER_ID,
    workspaceId: WS_ID,
  });
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

  // Workspace toggle ON — the DLP surface is live for every arm.
  (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
    id: WS_ID,
    dlpDocumentScanEnabled: true,
  });

  mockBuildRecompositionMap.mockResolvedValue(entityMap);
});

/** The role lifecycle — mutated between arms; read by the auth mock. */
const currentPrincipal: { user: Record<string, unknown> } = { user: editorWithUnmask };

function unmaskRequest() {
  return request(app)
    .get(`/api/documents/${DOC_ID}/text?unmask=true`)
    .set("Authorization", `Bearer ${generateTestToken(MEMBER_ID)}`);
}

describe("Phase 194 interaction matrix — isolation × DLP (unmask gate consumes the single resolver's lifecycle)", () => {
  it("SAME document + SAME request: editor+dlp:unmask → unredacted; downgraded viewer → masked 200; revoked former member → masked 200 — the gate rides resolveWorkspaceRole's output at every transition", async () => {
    // ── Arm 1: authorized member (editor + dlp:unmask) ──
    currentPrincipal.user = editorWithUnmask;
    mockResolveWorkspaceRole.mockResolvedValue("editor");
    const authorized = await unmaskRequest().expect(200);
    expect(authorized.body.text).toBe(UNMASKED_TEXT);
    // The gate consumed the resolver (single-resolver contract).
    expect(mockResolveWorkspaceRole).toHaveBeenCalledWith(MEMBER_ID, WS_ID, expect.anything());
    // The entity map loaded post-gate, scoped to this document.
    expect(mockBuildRecompositionMap).toHaveBeenCalledTimes(1);
    expect(mockBuildRecompositionMap).toHaveBeenCalledWith([DOC_ID]);

    // ── Arm 2: DOWNGRADED to viewer (role lifecycle transition — the SAME
    // principal, the SAME request) ──
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(viewerWithoutUnmask);
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(dlpDocument);
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: MEMBER_ID,
      workspaceId: WS_ID,
    });
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: WS_ID,
      dlpDocumentScanEnabled: true,
    });
    mockBuildRecompositionMap.mockResolvedValue(entityMap);
    mockResolveWorkspaceRole.mockResolvedValue("viewer");

    const downgraded = await unmaskRequest().expect(200);
    // Masked-200 fallback — never a 4xx entitlement oracle (192-04 contract).
    expect(downgraded.body.text).toBe(MASKED_TEXT);
    expect(downgraded.status).toBe(200);
    // The resolver still ran (the gate consumed its downgraded output)…
    expect(mockResolveWorkspaceRole).toHaveBeenCalledWith(MEMBER_ID, WS_ID, expect.anything());
    // …but the entity map NEVER loaded for the unauthorized arm.
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();

    // ── Arm 3: REVOKED former member (row gone — the isolation lifecycle) ──
    jest.clearAllMocks();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(viewerWithoutUnmask);
    (prisma.document.findFirst as jest.Mock).mockResolvedValue(dlpDocument);
    // The workspaceAccess row is GONE — but note: the route's D-04 gate
    // (binary access read) and the resolver are separate queries; the
    // resolver models the revocation (null), while the D-04 gate's binary
    // read is the route's own access check. With BOTH reads reflecting the
    // revocation the request never reaches the unmask arm (403). The
    // masked-200 fallback arm is the resolver-says-no arm: the D-04 gate
    // read still finds the stale row while the resolver (single source of
    // truth) returns null — the exact mismatch the gate must tolerate.
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: MEMBER_ID,
      workspaceId: WS_ID,
    });
    (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({
      id: WS_ID,
      dlpDocumentScanEnabled: true,
    });
    mockBuildRecompositionMap.mockResolvedValue(entityMap);
    mockResolveWorkspaceRole.mockResolvedValue(null);

    const revoked = await unmaskRequest().expect(200);
    expect(revoked.body.text).toBe(MASKED_TEXT);
    expect(revoked.status).toBe(200);
    expect(mockResolveWorkspaceRole).toHaveBeenCalledWith(MEMBER_ID, WS_ID, expect.anything());
    expect(mockBuildRecompositionMap).not.toHaveBeenCalled();
  });
});
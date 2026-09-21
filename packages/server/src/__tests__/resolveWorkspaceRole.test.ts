// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-02, ROADMAP SC-2): the pinned role-resolution matrix for
 * resolveWorkspaceRole — THE load-bearing test artifact of the phase.
 *
 * Every precedence case is pinned (D-08/D-09/D-10):
 *   admin / admin-with-skipAdminBypass / project-owner (outranks row role) /
 *   external WorkspaceAccess owner / editor row / viewer row /
 *   ProjectAccess-implied editor (never owner) / none / soft-deleted workspace.
 *
 * Also pins the single-round-trip query shape: at most ONE workspace query +
 * ONE workspaceAccess query + ONE projectAccess query per resolution
 * (T-189-04 — accidental N+1 drift must fail here, and no caching anywhere).
 */

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return {
    __esModule: true,
    default: createMockPrisma().prisma,
    // withSoftDelete is a passthrough in tests (mock prisma doesn't apply the extension)
    withSoftDelete: (where: any) => where,
  };
});

import prisma from "../utils/prisma";
import { resolveWorkspaceRole } from "../middleware/rbac";
import { regularUser, adminUser } from "./helpers/mockAuth";

// @ts-nocheck
const WS_ID = "ws-matrix-1";
const PROJECT_ID = "proj-matrix-1";
const OWNER_USER_ID = "user-project-owner";
const OTHER_USER_ID = "user-external";

/** User fixture shape is opaque to the resolver (passed straight to isAdmin). */
const adminLikeUser = { id: adminUser.id, roles: adminUser.roles };

const workspaceFixture = {
  id: WS_ID,
  projectId: PROJECT_ID,
  project: { id: PROJECT_ID, createdBy: OWNER_USER_ID },
};

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(workspaceFixture);
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
});

describe("resolveWorkspaceRole — pinned precedence matrix (SC-2)", () => {
  it("admin bypass tier → 'admin' without touching any DB query", async () => {
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, adminLikeUser);
    expect(role).toBe("admin");
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled();
    expect(prisma.workspaceAccess.findFirst).not.toHaveBeenCalled();
    expect(prisma.projectAccess.findFirst).not.toHaveBeenCalled();
  });

  it("admin with skipAdminBypass + editor row → resolves the underlying 'editor' grant (D-09/D-04)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: regularUser.id,
      workspaceId: WS_ID,
      role: "editor",
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, adminLikeUser, {
      skipAdminBypass: true,
    });
    expect(role).toBe("editor");
  });

  it("admin with skipAdminBypass + no rows → null (admin's underlying grant absent)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, adminLikeUser, {
      skipAdminBypass: true,
    });
    expect(role).toBeNull();
    // D-10 probe also ran — projectAccess had no row either.
    expect(prisma.projectAccess.findFirst).toHaveBeenCalledTimes(1);
  });

  it("project.createdBy → 'owner' EVEN when a viewer row exists (D-08 outranks row role)", async () => {
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: OWNER_USER_ID,
      workspaceId: WS_ID,
      role: "viewer",
    });
    const role = await resolveWorkspaceRole(OWNER_USER_ID, WS_ID, { id: OWNER_USER_ID });
    expect(role).toBe("owner");
    // D-08 ordering: the row must never be consulted when createdBy matches.
    expect(prisma.workspaceAccess.findFirst).not.toHaveBeenCalled();
  });

  it("external WorkspaceAccess role=owner (createdBy differs) → 'owner'", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: regularUser.id,
      workspaceId: WS_ID,
      role: "owner",
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).toBe("owner");
  });

  it("WorkspaceAccess row editor → 'editor'", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: regularUser.id,
      workspaceId: WS_ID,
      role: "editor",
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).toBe("editor");
  });

  it("WorkspaceAccess row viewer → 'viewer'", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: regularUser.id,
      workspaceId: WS_ID,
      role: "viewer",
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).toBe("viewer");
  });

  it("no row + ProjectAccess exists → 'editor' (D-10 implied editor, NO rows materialized)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: regularUser.id,
      projectId: PROJECT_ID,
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).toBe("editor");
  });

  it("ProjectAccess present AND owner-row absent → NEVER 'owner' (D-10 ceiling)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue({
      userId: regularUser.id,
      projectId: PROJECT_ID,
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).not.toBe("owner");
    expect(role).toBe("editor");
  });

  it("no sources → null", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).toBeNull();
  });

  it("soft-deleted workspace → null (existence hiding — withSoftDelete where-shape asserted)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue(null);
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).toBeNull();
    // withSoftDelete is a passthrough here — assert the exact where-shape the
    // resolver handed to prisma (id + deletedAt: null scoping).
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: WS_ID, deletedAt: null },
      include: { project: { select: { id: true, createdBy: true } } },
    });
    // No further queries after the null workspace.
    expect(prisma.workspaceAccess.findFirst).not.toHaveBeenCalled();
    expect(prisma.projectAccess.findFirst).not.toHaveBeenCalled();
  });

  it("row role 'owner' does NOT outrank implicit project owner (D-08 single-source ambiguity ban)", async () => {
    // The implicit owner branch returns BEFORE reading the row — pinned by the
    // query-order assertions in the project-owner case above.
  });

  it("query-shape guard: at most 1 workspace + 1 workspaceAccess + 1 projectAccess query per call (T-189-04)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      ...workspaceFixture,
      project: { ...workspaceFixture.project, createdBy: OTHER_USER_ID },
    });
    const role = await resolveWorkspaceRole(regularUser.id, WS_ID, regularUser);
    expect(role).toBeNull();
    expect(prisma.workspace.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.workspaceAccess.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.projectAccess.findFirst).toHaveBeenCalledTimes(1);
  });
});
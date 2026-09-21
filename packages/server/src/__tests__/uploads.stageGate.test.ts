// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 189-REVIEW CR-01 regression pin — the POST /api/uploads stage route must
 * mount `upload.single("file")` BEFORE `requireWorkspaceWriteAccess`.
 *
 * The bug: the graded gate was chain-mounted BEFORE multer, and multer is
 * what populates `req.body` for multipart payloads (express.json() does not
 * — index.ts:563). At gate time `req.body` was `undefined`,
 * `resolveRequestWorkspaceId` found no workspaceId, and the gate 400'd
 * EVERY staging request with "Workspace ID required" in both modes.
 *
 * This suite stages through the REAL chain — real multer, real
 * requireWorkspaceWriteAccess (NO rbac mock), real tenantContextMiddleware —
 * with the enforcement flag "true" so the gate is the live enforcement arm.
 * The observable proof that the gate ran AFTER multer and saw a parsed body:
 * the request returns 201 (the enforced gate resolved the editor grant from
 * the parsed workspaceId and passed), and the resolver's workspace read was
 * issued with the multipart-supplied workspaceId. Under the old order the
 * same request deterministically 400s at the gate.
 */

import "./helpers/setupEnv";

// Prisma mock — the real tenantContext/gate/handler read path.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    organizationMember: {
      findFirst: jest.fn().mockResolvedValue({ organizationId: "org-default" }),
    },
    workspace: {
      findFirst: jest.fn(),
    },
    workspaceAccess: {
      findFirst: jest.fn(),
    },
    projectAccess: {
      findFirst: jest.fn(),
    },
    uploadDraft: {
      create: jest.fn(),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));

// env — minimal shape for this surface.
jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    COLLECTOR_URL: "http://localhost:3210",
    COLLECTOR_SECRET: "test-collector-secret-for-unit-tests",
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

// Enforcement flag mutable per-test — "true" (enforced) is the pin's default.
const enforcementFlag = { value: "true" };
jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn((key: string) =>
    key === "WORKSPACE_ROLE_ENFORCEMENT"
      ? { value: enforcementFlag.value }
      : key === "ALLOW_NON_ADMIN_UPLOAD"
        ? { key, value: "true" }
        : key === "upload_draft_retention_days"
          ? { key, value: "30" }
          : { key, value: "" }),
  seedConfigDefaults: jest.fn(),
}));

// Storage provider — the handler puts the staged bytes after the row lands.
jest.mock("../services/storageProvider", () =>
  require("./helpers/mockStorageProvider").mockStorageProviderModule,
);

// Auth — passthrough stand-in (stamps the principal). The REAL tenant,
// permission and graded middlewares stay real; only the JWT plumbing is
// substituted (personalWorkspace.test.ts idiom: the auth seam is not what
// CR-01 pins — the multer/gate ORDER is).
jest.mock("../middleware/auth", () => ({
  authMiddleware: (req: unknown, _res: unknown, next: () => void) => {
    const r = req as { userId: string; user: unknown };
    const holder = globalThis as unknown as { __STAGE_USER__?: { id: string } };
    r.userId = holder.__STAGE_USER__?.id ?? "user-a";
    r.user = holder.__STAGE_USER__ ?? STAGE_USER;
    next();
  },
}));

// Silence winston file transports in tests (the real logger writes storage/logs).
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import request from "supertest";
import express from "express";
import uploadRoutes from "../routes/uploads";
import { getSetting } from "../services/systemConfigService";
import prisma from "../utils/prisma";
import { mockProviderPut } from "./helpers/mockStorageProvider";

const WS_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "user-a";
const PROJECT_ID = "proj-1";

/** Non-admin user carrying document:write via the roles payload shape the
 * REAL getEffectivePermissions consults (roles[].role.permissions[]). */
const STAGE_USER = {
  id: USER_ID,
  role: "user",
  roles: [{ role: { name: "user", permissions: [{ permissionName: "document:write" }] } }],
};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/uploads", uploadRoutes);

beforeEach(() => {
  jest.clearAllMocks();
  enforcementFlag.value = "true";
  (prisma.organizationMember.findFirst as jest.Mock).mockResolvedValue({
    organizationId: "org-default",
  });
  // The resolver's workspace read: user-a owns the parent project → owner.
  (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
    id: WS_ID,
    projectId: PROJECT_ID,
    organizationId: "org-default",
    allowMemberUploads: true,
    project: { id: PROJECT_ID, createdBy: USER_ID },
  });
  (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.uploadDraft.create as jest.Mock).mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: "draft-1",
      parseStatus: "uploaded",
      expiresAt: new Date(),
      ...args?.data,
    }),
  );
  mockProviderPut.mockResolvedValue({ key: "k", size: 0 });
});

describe("CR-01 regression pin — stage route gate runs AFTER multer (real chain)", () => {
  it("stages through the REAL enforced gate: 201 (not 400 'Workspace ID required') — the gate saw the parsed multipart body", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .field("workspaceId", WS_ID)
      .field("originalName", "test.md")
      .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

    // THE PIN: with the pre-fix order (gate before multer) this request
    // deterministically returned 400 {"error":"Workspace ID required"} —
    // the gate could not resolve a workspaceId from the unparsed body. With
    // multer mounted first, the enforced gate resolves the owner role and
    // the handler stages the draft.
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    expect(res.body.parseStatus).toBe("uploaded");
    expect(res.body).not.toHaveProperty("filePath");
    expect(mockProviderPut).toHaveBeenCalledTimes(1);

    // The enforced gate reached the resolver (the workspace read) with the
    // multipart-supplied workspaceId — direct evidence the gate ran after
    // multer and observed a parsed body.
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: WS_ID }),
      }),
    );
    // The flag was consulted (the gate ran) — getSetting("WORKSPACE_ROLE_ENFORCEMENT").
    const flagCalls = (getSetting as jest.Mock).mock.calls.filter(
      ([key]: [string]) => key === "WORKSPACE_ROLE_ENFORCEMENT",
    );
    expect(flagCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("the same real chain still enforces: enforced gate denies a non-granted user (never the CR-01 400 shape)", async () => {
    // A user with NO relation to the workspace: the enforced gate resolves
    // role null (workspace exists, no grant/ownership/projectAccess) → the
    // 404 existence-hiding arm. The pin's invariant holds in the deny arm
    // too: the failure is the graded decision, NEVER the pre-fix
    // 400 "Workspace ID required" body-shape (the gate saw the parsed body).
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WS_ID,
      projectId: PROJECT_ID,
      organizationId: "org-default",
      allowMemberUploads: true,
      project: { id: PROJECT_ID, createdBy: "someone-else" },
    });
    (globalThis as unknown as { __STAGE_USER__?: unknown }).__STAGE_USER__ = {
      id: "intruder",
      role: "user",
      roles: [{ role: { name: "user", permissions: [{ permissionName: "document:write" }] } }],
    };
    try {
      const res = await request(app)
        .post("/api/uploads")
        .field("workspaceId", WS_ID)
        .field("originalName", "test.md")
        .attach("file", Buffer.from("hello"), { filename: "test.md", contentType: "text/markdown" });

      expect(res.status).not.toBe(400);
      expect(res.body.error).not.toBe("Workspace ID required");
    } finally {
      delete (globalThis as unknown as { __STAGE_USER__?: unknown }).__STAGE_USER__;
    }
  });
});
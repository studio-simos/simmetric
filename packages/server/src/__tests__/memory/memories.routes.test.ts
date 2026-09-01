// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-01) — /api/memories CRUD + GDPR route unit tests (mocked Prisma).
 *
 * Phase 140 (EPA-02): the memory_enabled license gate + max_memories_per_user
 * cap are removed — memory CRUD is always-ON. The 402 license-gate tests were
 * removed; the GDPR "NOT license-gated" tests stay (they document the legal-
 * right invariant, which is unchanged).
 *
 * Covers the Nyquist validation gaps:
 *   - RBAC: `memory:read` required on GET routes, `memory:write` on POST/PATCH/DELETE /:id
 *   - IDOR: `where: { userId, workspaceId }` scoping
 *   - GDPR export (`GET /api/memories/export`) — all user memories across ALL workspaces
 *   - GDPR erase (`DELETE /api/memories`) — deletes all user memories
 *   - GDPR routes NOT license-gated (legal right)
 *   - Audit log called on every op (logEvent with entityType "memory")
 *   - POST uses $executeRaw INSERT (Prisma create unavailable on Unsupported vector column)
 *   - `embedding` column NEVER returned (MEMORY_SELECT excludes it)
 *
 * Pattern follows widgetCrud.test.ts: jest.mock prisma/licenseService/env/auth middleware,
 * supertest against createApp(), behavioral test names.
 */
import "../helpers/setupEnv";

jest.mock("../../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("../helpers/mockPrisma");
  const prisma = createMockPrisma().prisma;
  // Memory delegate is NOT in mockPrisma.ts — add it with the methods the route uses.
  (prisma as any).memory = {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  return { __esModule: true, default: prisma };
});

jest.mock("../../config/env", () => ({
  getEnv: jest.fn(() => ({
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../../services/licenseService", () => ({
  initLicense: jest.fn(() => ({ tier: "enterprise", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  getLicenseInfo: jest.fn(() => ({ tier: "enterprise", licensee: "Test", expiresAt: null, features: {}, valid: true })),
  isFeatureEnabled: jest.fn(() => true),
  getFeatureLimit: jest.fn(() => Infinity),
}));

jest.mock("../../agent/builtinSkills", () => {});
jest.mock("../../services/templateService", () => ({ seedTemplates: jest.fn() }));
jest.mock("../../services/systemConfigService", () => ({ seedConfigDefaults: jest.fn() }));
jest.mock("../../services/ftsService", () => ({ initPostgreSQLFTS: jest.fn() }));
jest.mock("../../agent/mcpServer", () => ({ mountMCPServer: jest.fn() }));
jest.mock("../../services/chatMessageReaperJob", () => ({
  initChatMessageReaperScheduler: jest.fn(),
}));
jest.mock("../../services/synthesisReaperJob", () => ({
  initSynthesisReaperScheduler: jest.fn(),
}));
jest.mock("../../services/uploadDraftReaperJob", () => ({
  initUploadDraftReaperScheduler: jest.fn(),
}));
jest.mock("../../services/mcpReaperJob", () => ({
  initMCPReaperScheduler: jest.fn(),
}));
jest.mock("../../services/vectorCleanupJob", () => ({
  initVectorCleanupScheduler: jest.fn(),
}));
jest.mock("../../services/mcpHealthCheckJob", () => ({
  initMCPHealthCheckScheduler: jest.fn(),
}));
jest.mock("../../agent/mcpClient", () => ({
  initializeMCPConnections: jest.fn(),
}));

// Mock eventLogService.logEvent so we can assert audit calls.
jest.mock("../../services/eventLogService", () => ({
  logEvent: jest.fn(),
}));

// Mock auth middleware: inject req.userId + req.user with configurable permissions.
// The Authorization Bearer token carries the userId; x-test-permissions header
// carries the comma-separated permission list; x-test-role=admin bypasses perm checks.
jest.mock("../../middleware/auth", () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const token = authHeader.slice("Bearer ".length);
    req.userId = token; // Use the token itself as userId for simplicity.
    const permsHeader = req.headers["x-test-permissions"];
    const permNames: string[] = permsHeader ? String(permsHeader).split(",").map((s: string) => s.trim()) : [];
    const roleHeader = req.headers["x-test-role"];
    const isAdmin = roleHeader === "admin";
    req.user = {
      id: token,
      roles: isAdmin
        ? [{ role: { name: "admin", permissions: [{ permissionName: "admin:settings" }, { permissionName: "memory:read" }, { permissionName: "memory:write" }] } }]
        : [{ role: { name: "user", permissions: permNames.map((p: string) => ({ permissionName: p })) } }],
    };
    next();
  },
  apiKeyMiddleware: (req: any, res: any, next: any) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) {
      res.status(401).json({ error: "Missing API key" });
      return;
    }
    req.userId = "service-account-001";
    req.user = { id: "service-account-001", username: "widget-service", roles: [] };
    next();
  },
}));

import request from "supertest";
import { createApp } from "../../index";
import prisma from "../../utils/prisma";
import { isFeatureEnabled, getFeatureLimit, getLicenseInfo } from "../../services/licenseService";
import { logEvent } from "../../services/eventLogService";

const app = createApp();

// ─── Helpers ──────────────────────────────────────────────────────────

/** Auth header for a regular user with the given permissions. */
function userAuth(userId: string, permissions: string[] = ["memory:read", "memory:write"]) {
  return {
    Authorization: `Bearer ${userId}`,
    "x-test-permissions": permissions.join(","),
    "x-test-role": "user",
  };
}

/** Auth header for an admin (bypasses permission checks). */
function adminAuth(userId = "admin-001") {
  return {
    Authorization: `Bearer ${userId}`,
    "x-test-role": "admin",
  };
}

const WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174001";
const MEMORY_ID = "123e4567-e89b-12d3-a456-42661417400a";

/** A sample memory row as returned by MEMORY_SELECT (no embedding column). */
function sampleMemory(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: MEMORY_ID,
    userId: "user-001",
    workspaceId: WORKSPACE_ID,
    type: "user",
    path: "preferences.theme",
    content: "prefers dark mode",
    sourceMessageId: null,
    sensitivity: "low",
    createdAt: new Date("2026-07-27T00:00:00.000Z"),
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: feature enabled, no numeric limit (Infinity = Enterprise).
  (isFeatureEnabled as jest.Mock).mockReturnValue(true);
  (getFeatureLimit as jest.Mock).mockReturnValue(Infinity);
  (getLicenseInfo as jest.Mock).mockReturnValue({ tier: "enterprise", licensee: "Test", expiresAt: null, features: {}, valid: true });
});

// ─── GDPR export ─────────────────────────────────────────────────────

describe("GET /api/memories/export (GDPR right to access)", () => {
  it("returns all the user's memories across all workspaces (JSON)", async () => {
    const memories = [
      sampleMemory({ workspaceId: "ws-a", path: "a" }),
      sampleMemory({ workspaceId: "ws-b", path: "b" }),
    ];
    (prisma.memory.findMany as jest.Mock).mockResolvedValue(memories);

    const res = await request(app)
      .get("/api/memories/export")
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.memories).toHaveLength(2);
    // findMany must be scoped by userId only (NOT workspaceId — GDPR is per-user total).
    expect(prisma.memory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-001" },
        select: expect.objectContaining({ id: true }),
        orderBy: { createdAt: "desc" },
      }),
    );
    // Audit log called.
    expect(logEvent).toHaveBeenCalledWith("memory", "user-001", "gdpr.export", "user-001", { count: 2 });
  });

  it("is NOT license-gated (legal right — works even when memory_enabled=false)", async () => {
    (isFeatureEnabled as jest.Mock).mockReturnValue(false);
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/memories/export")
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it("does NOT require memory:read permission (only authMiddleware)", async () => {
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/memories/export")
      .set(userAuth("user-001", [])); // no permissions at all

    expect(res.status).toBe(200);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get("/api/memories/export");
    expect(res.status).toBe(401);
  });

  it("returns CSV when format=csv", async () => {
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([sampleMemory()]);

    const res = await request(app)
      .get("/api/memories/export?format=csv")
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("id,userId,workspaceId");
  });
});

// ─── GDPR erase ──────────────────────────────────────────────────────

describe("DELETE /api/memories (GDPR right to erasure)", () => {
  it("deletes ALL the user's memories across all workspaces and returns count", async () => {
    (prisma.memory.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });

    const res = await request(app)
      .delete("/api/memories")
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/erased/i);
    expect(res.body.count).toBe(5);
    // deleteMany scoped by userId only (NOT workspaceId — GDPR total).
    expect(prisma.memory.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-001" } });
    expect(logEvent).toHaveBeenCalledWith("memory", "user-001", "gdpr.erase", "user-001", { count: 5 });
  });

  it("is NOT license-gated (legal right — works when memory_enabled=false)", async () => {
    (isFeatureEnabled as jest.Mock).mockReturnValue(false);
    (prisma.memory.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete("/api/memories")
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
  });

  it("does NOT require memory:write permission (only authMiddleware)", async () => {
    (prisma.memory.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete("/api/memories")
      .set(userAuth("user-001", [])); // no permissions

    expect(res.status).toBe(200);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).delete("/api/memories");
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/memories (list, workspace-scoped) ──────────────────────

describe("GET /api/memories (list)", () => {
  it("returns 200 with memories scoped to userId + workspaceId (IDOR)", async () => {
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([sampleMemory()]);
    (prisma.memory.count as jest.Mock).mockResolvedValue(1);

    const res = await request(app)
      .get(`/api/memories?workspaceId=${WORKSPACE_ID}`)
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.memories).toHaveLength(1);
    // findMany where clause MUST include both userId AND workspaceId (IDOR load-bearing).
    expect(prisma.memory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-001", workspaceId: WORKSPACE_ID },
        select: expect.objectContaining({ id: true }),
      }),
    );
  });

  it("requires memory:read permission (403 without it)", async () => {
    const res = await request(app)
      .get(`/api/memories?workspaceId=${WORKSPACE_ID}`)
      .set(userAuth("user-001", ["chat:write"])); // no memory:read

    expect(res.status).toBe(403);
  });

  it("is NOT license-gated (read is a privacy right)", async () => {
    (isFeatureEnabled as jest.Mock).mockReturnValue(false);
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.memory.count as jest.Mock).mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/memories?workspaceId=${WORKSPACE_ID}`)
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
  });

  it("returns 400 when workspaceId is missing", async () => {
    const res = await request(app)
      .get("/api/memories")
      .set(userAuth("user-001"));

    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get(`/api/memories?workspaceId=${WORKSPACE_ID}`);
    expect(res.status).toBe(401);
  });

  it("never includes the embedding column in the select", async () => {
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.memory.count as jest.Mock).mockResolvedValue(0);

    await request(app)
      .get(`/api/memories?workspaceId=${WORKSPACE_ID}`)
      .set(userAuth("user-001"));

    const call = (prisma.memory.findMany as jest.Mock).mock.calls[0][0];
    expect(call.select.embedding).toBeUndefined();
    expect(call.select).not.toHaveProperty("embedding");
  });
});

// ─── POST /api/memories (create) ─────────────────────────────────────

describe("POST /api/memories (create)", () => {
  it("creates a memory via $executeRaw INSERT + findUnique, returns 201", async () => {
    // userCanAccessWorkspace: workspace found + project owned by user.
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      project: { id: "proj-1", createdBy: "user-001" },
    });
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (prisma.memory.findUnique as jest.Mock).mockResolvedValue(sampleMemory());

    const res = await request(app)
      .post("/api/memories")
      .set(userAuth("user-001"))
      .send({
        workspaceId: WORKSPACE_ID,
        type: "user",
        path: "preferences.theme",
        content: "prefers dark mode",
        sensitivity: "low",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(MEMORY_ID);
    // POST uses $executeRaw INSERT (Prisma create unavailable on Unsupported vector column).
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.memory.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: expect.any(String) },
        select: expect.objectContaining({ id: true }),
      }),
    );
    // Audit log called.
    expect(logEvent).toHaveBeenCalledWith("memory", "user-001", "create", MEMORY_ID, expect.objectContaining({ workspaceId: WORKSPACE_ID }));
  });

  it("requires memory:write permission (403 without it)", async () => {
    const res = await request(app)
      .post("/api/memories")
      .set(userAuth("user-001", ["memory:read"])) // no memory:write
      .send({ workspaceId: WORKSPACE_ID, type: "user", content: "x" });

    expect(res.status).toBe(403);
  });

  it("returns 403 when the user cannot access the target workspace (IDOR)", async () => {
    // Workspace exists but user does not own it and has no access grants.
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      project: { id: "proj-1", createdBy: "other-user" },
    });
    (prisma.workspaceAccess.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.projectAccess.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .post("/api/memories")
      .set(userAuth("user-001"))
      .send({ workspaceId: WORKSPACE_ID, type: "user", content: "x" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  it("returns 400 on invalid body (missing content)", async () => {
    const res = await request(app)
      .post("/api/memories")
      .set(userAuth("user-001"))
      .send({ workspaceId: WORKSPACE_ID, type: "user" }); // no content

    expect(res.status).toBe(400);
  });

  it("returns 409 on unique constraint violation (P2002)", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      project: { id: "proj-1", createdBy: "user-001" },
    });
    (prisma.$executeRaw as jest.Mock).mockRejectedValue({ code: "P2002" });

    const res = await request(app)
      .post("/api/memories")
      .set(userAuth("user-001"))
      .send({ workspaceId: WORKSPACE_ID, type: "user", path: "p", content: "x" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app)
      .post("/api/memories")
      .send({ workspaceId: WORKSPACE_ID, type: "user", content: "x" });
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/memories/:id ───────────────────────────────────────────

describe("GET /api/memories/:id", () => {
  it("returns 200 with the memory if it belongs to the authenticated user", async () => {
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue(sampleMemory());

    const res = await request(app)
      .get(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(MEMORY_ID);
    // findFirst where MUST include userId (IDOR load-bearing).
    expect(prisma.memory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MEMORY_ID, userId: "user-001" },
        select: expect.objectContaining({ id: true }),
      }),
    );
  });

  it("returns 404 when the memory belongs to another user (IDOR — not 403)", async () => {
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"));

    expect(res.status).toBe(404); // 404, not 403 — avoids leaking existence.
  });

  it("requires memory:read permission (403 without it)", async () => {
    const res = await request(app)
      .get(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001", ["chat:write"]));

    expect(res.status).toBe(403);
  });

  it("is NOT license-gated (read is a privacy right)", async () => {
    (isFeatureEnabled as jest.Mock).mockReturnValue(false);
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue(sampleMemory());

    const res = await request(app)
      .get(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
  });

  it("returns 400 on invalid UUID", async () => {
    const res = await request(app)
      .get("/api/memories/not-a-uuid")
      .set(userAuth("user-001"));

    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).get(`/api/memories/${MEMORY_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─── PATCH /api/memories/:id ─────────────────────────────────────────

describe("PATCH /api/memories/:id", () => {
  it("updates a memory owned by the user and returns 200", async () => {
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue({ id: MEMORY_ID });
    (prisma.memory.update as jest.Mock).mockResolvedValue(sampleMemory({ content: "updated" }));

    const res = await request(app)
      .patch(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"))
      .send({ content: "updated" });

    expect(res.status).toBe(200);
    expect(prisma.memory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MEMORY_ID },
        data: { content: "updated" },
        select: expect.objectContaining({ id: true }),
      }),
    );
    expect(logEvent).toHaveBeenCalledWith("memory", "user-001", "update", MEMORY_ID, expect.objectContaining({ fields: ["content"] }));
  });

  it("requires memory:write permission (403 without it)", async () => {
    const res = await request(app)
      .patch(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001", ["memory:read"]))
      .send({ content: "x" });

    expect(res.status).toBe(403);
  });

  it("returns 404 when memory belongs to another user (IDOR)", async () => {
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"))
      .send({ content: "x" });

    expect(res.status).toBe(404);
  });

  it("returns 400 when no fields are provided", async () => {
    const res = await request(app)
      .patch(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"))
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 409 on path conflict (P2002)", async () => {
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue({ id: MEMORY_ID });
    (prisma.memory.update as jest.Mock).mockRejectedValue({ code: "P2002" });

    const res = await request(app)
      .patch(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"))
      .send({ path: "new.path" });

    expect(res.status).toBe(409);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app)
      .patch(`/api/memories/${MEMORY_ID}`)
      .send({ content: "x" });
    expect(res.status).toBe(401);
  });
});

// ─── DELETE /api/memories/:id ───────────────────────────────────────

describe("DELETE /api/memories/:id", () => {
  it("deletes a memory owned by the user and returns 200", async () => {
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue({ id: MEMORY_ID });
    (prisma.memory.delete as jest.Mock).mockResolvedValue({});

    const res = await request(app)
      .delete(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"));

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
    expect(prisma.memory.delete).toHaveBeenCalledWith({ where: { id: MEMORY_ID } });
    expect(logEvent).toHaveBeenCalledWith("memory", "user-001", "delete", MEMORY_ID, {});
  });

  it("requires memory:write permission (403 without it)", async () => {
    const res = await request(app)
      .delete(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001", ["memory:read"]));

    expect(res.status).toBe(403);
  });

  it("returns 404 when memory belongs to another user (IDOR)", async () => {
    (prisma.memory.findFirst as jest.Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/memories/${MEMORY_ID}`)
      .set(userAuth("user-001"));

    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid UUID", async () => {
    const res = await request(app)
      .delete("/api/memories/not-a-uuid")
      .set(userAuth("user-001"));

    expect(res.status).toBe(400);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(app).delete(`/api/memories/${MEMORY_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─── Admin bypass ────────────────────────────────────────────────────

describe("Admin role bypasses permission checks", () => {
  it("admin can GET /api/memories list without explicit memory:read permission", async () => {
    (prisma.memory.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.memory.count as jest.Mock).mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/memories?workspaceId=${WORKSPACE_ID}`)
      .set(adminAuth("admin-001"));

    expect(res.status).toBe(200);
  });

  it("admin can POST /api/memories without explicit memory:write permission", async () => {
    (prisma.workspace.findFirst as jest.Mock).mockResolvedValue({
      id: WORKSPACE_ID,
      project: { id: "proj-1", createdBy: "admin-001" },
    });
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (prisma.memory.findUnique as jest.Mock).mockResolvedValue(sampleMemory({ userId: "admin-001" }));

    const res = await request(app)
      .post("/api/memories")
      .set(adminAuth("admin-001"))
      .send({ workspaceId: WORKSPACE_ID, type: "user", content: "admin note" });

    expect(res.status).toBe(201);
  });
});
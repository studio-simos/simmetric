// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-01/MEM-04) — /api/memories IDOR + GDPR integration tests.
 *
 * Runs against a real PostgreSQL database (requires the `vector` extension).
 * Covers the Nyquist validation gaps:
 *   - IDOR: Create memory in workspace A as user1, attempt to read/modify as
 *     user2 (who has access to workspace B but NOT A) → 403/404.
 *   - GDPR export: Create memories in multiple workspaces for user1, call
 *     GET /api/memories/export → returns ALL memories across ALL workspaces.
 *   - GDPR erase: Create memories for user1, call DELETE /api/memories → all
 *     deleted, verify count is 0.
 *   - Cross-user isolation: user2's memories are NOT affected by user1's GDPR erase.
 *
 * Pattern follows auth.integration.test.ts / archives.integration.test.ts:
 * real Prisma, real JWT tokens, supertest against createApp(), cleanup in afterAll.
 *
 * RUN: `pnpm --filter server test:integration -- --testPathPatterns=memories.integration`
 * Requires a running PostgreSQL with the `vector` extension. If the DB is not
 * available, the suite is SKIPPED (not failed) — see the connectivity check below.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";

let app: ReturnType<typeof import("../index").createApp>;
let prisma: import("@prisma/client").PrismaClient;
let env: import("../config/env").Env;

let user1Id: string;
let user2Id: string;
let workspaceAId: string;
let workspaceBId: string;
let projectId: string;
let memory1Id: string;
let memory2Id: string;

const user1Password = "user1password123";
const user2Password = "user2password123";

/** Skip guard — set to true if DB connectivity fails in beforeAll. */
let dbAvailable = true;

beforeAll(async () => {
  try {
    const { createApp } = await import("../index");
    app = createApp();

    const { default: prismaClient } = await import("../utils/prisma");
    prisma = prismaClient;

    const { getEnv } = await import("../config/env");
    env = getEnv();

    // Verify DB connectivity — skip the whole suite if the DB is unreachable.
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    // Verify the vector extension is available (Memory model requires it).
    try {
      await prisma.$queryRaw`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    } catch {
      // The migration creates the extension idempotently; if it's missing the
      // POST route's $executeRaw INSERT will fail. We skip to avoid a misleading
      // test failure that's an environment issue, not a code defect.
      dbAvailable = false;
      return;
    }
    dbAvailable = true;

    // Seed two real users with the default roles (admin role for user1 so it
    // bypasses requirePermission; user role for user2 with memory:read/write
    // from the DEFAULT_USER_ROLE seed).
    const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
    const userRole = await prisma.role.findUnique({ where: { name: "user" } });

    const salt = await bcrypt.genSalt(12);

    const user1 = await prisma.user.create({
      data: {
        username: "mem_user1",
        email: "mem_user1@test.com",
        passwordHash: await bcrypt.hash(user1Password, salt),
        salt,
      },
    });
    user1Id = user1.id;

    const user2 = await prisma.user.create({
      data: {
        username: "mem_user2",
        email: "mem_user2@test.com",
        passwordHash: await bcrypt.hash(user2Password, salt),
        salt,
      },
    });
    user2Id = user2.id;

    if (adminRole) {
      await prisma.userRole.create({ data: { userId: user1.id, roleId: adminRole.id } });
    }
    if (userRole) {
      await prisma.userRole.create({ data: { userId: user2.id, roleId: userRole.id } });
    }

    // Seed a project + two workspaces. user1 owns the project (so user1 can
    // POST memories into workspace A via userCanAccessWorkspace). user2 has
    // NO access to workspace A (IDOR target).
    const project = await prisma.project.create({
      data: {
        name: "mem-test-project",
        description: "Phase 97 memory IDOR test",
        createdBy: user1Id,
      },
    });
    projectId = project.id;

    const wsA = await prisma.workspace.create({
      data: { name: "workspace-A", projectId, createdBy: user1Id },
    });
    workspaceAId = wsA.id;

    const wsB = await prisma.workspace.create({
      data: { name: "workspace-B", projectId, createdBy: user1Id },
    });
    workspaceBId = wsB.id;

    // Grant user2 explicit access to workspace B only (NOT A).
    await prisma.workspaceAccess.create({
      data: { userId: user2Id, workspaceId: workspaceBId },
    });
  } catch (err) {
    // DB unavailable — skip the suite (the (dbAvailable ? describe : describe.skip)
    // guard below handles it). Log the reason for debugging.
    dbAvailable = false;
    // eslint-disable-next-line no-console
    console.log("[memories.integration] DB unavailable — skipping suite:", (err as Error).message);
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  try {
    // Cleanup — delete memories, workspaces, project, users created by this suite.
    await prisma.memory.deleteMany({ where: { userId: { in: [user1Id, user2Id] } } });
    await prisma.workspaceAccess.deleteMany({ where: { userId: user2Id } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceAId, workspaceBId] } } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.userRole.deleteMany({ where: { userId: { in: [user1Id, user2Id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [user1Id, user2Id] } } });
  } catch {
    // Best-effort cleanup; the worker DB is dropped on globalTeardown anyway.
  }
  await prisma.$disconnect();
});

function generateToken(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: "1h" });
}

function user1Auth(): Record<string, string> {
  return { Authorization: `Bearer ${generateToken(user1Id)}` };
}

function user2Auth(): Record<string, string> {
  return { Authorization: `Bearer ${generateToken(user2Id)}` };
}

// Use describe.skip when DB is unavailable so the suite shows as skipped, not failed.
const suite = dbAvailable ? describe : describe.skip;

suite("POST /api/memories — IDOR workspace access (integration)", () => {
  it("user1 (project owner) can create a memory in workspace A", async () => {
    const res = await request(app)
      .post("/api/memories")
      .set(user1Auth())
      .send({
        workspaceId: workspaceAId,
        type: "user",
        path: "preferences.theme",
        content: "prefers dark mode",
        sensitivity: "low",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.userId).toBe(user1Id);
    expect(res.body.workspaceId).toBe(workspaceAId);
    // The embedding column must NEVER be in the response (MEMORY_SELECT excludes it).
    expect(res.body.embedding).toBeUndefined();
    memory1Id = res.body.id;
  });

  it("user2 (no access to workspace A) is denied POST into workspace A (403 IDOR)", async () => {
    const res = await request(app)
      .post("/api/memories")
      .set(user2Auth())
      .send({
        workspaceId: workspaceAId,
        type: "user",
        path: "user2.attempt",
        content: "should be rejected",
        sensitivity: "low",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });
});

suite("GET /api/memories/:id — IDOR cross-user isolation (integration)", () => {
  it("user1 can read their own memory in workspace A", async () => {
    const res = await request(app)
      .get(`/api/memories/${memory1Id}`)
      .set(user1Auth());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(memory1Id);
    expect(res.body.userId).toBe(user1Id);
  });

  it("user2 cannot read user1's memory (404 IDOR — not 403, avoids leaking existence)", async () => {
    const res = await request(app)
      .get(`/api/memories/${memory1Id}`)
      .set(user2Auth());

    expect(res.status).toBe(404);
  });
});

suite("PATCH /api/memories/:id — IDOR cross-user modify (integration)", () => {
  it("user2 cannot modify user1's memory (404 IDOR)", async () => {
    const res = await request(app)
      .patch(`/api/memories/${memory1Id}`)
      .set(user2Auth())
      .send({ content: "tampered by user2" });

    expect(res.status).toBe(404);
    // Verify user1's memory content was NOT changed.
    const check = await request(app)
      .get(`/api/memories/${memory1Id}`)
      .set(user1Auth());
    expect(check.body.content).toBe("prefers dark mode");
  });
});

suite("DELETE /api/memories/:id — IDOR cross-user delete (integration)", () => {
  it("user2 cannot delete user1's memory (404 IDOR)", async () => {
    const res = await request(app)
      .delete(`/api/memories/${memory1Id}`)
      .set(user2Auth());

    expect(res.status).toBe(404);
    // Verify the memory still exists for user1.
    const check = await request(app)
      .get(`/api/memories/${memory1Id}`)
      .set(user1Auth());
    expect(check.status).toBe(200);
  });
});

suite("GET /api/memories/export — GDPR right to access (integration)", () => {
  it("returns ALL the user's memories across ALL workspaces", async () => {
    // Create a second memory in workspace B for user1.
    const res2 = await request(app)
      .post("/api/memories")
      .set(user1Auth())
      .send({
        workspaceId: workspaceBId,
        type: "user",
        path: "preferences.language",
        content: "prefers Python",
        sensitivity: "low",
      });
    expect(res2.status).toBe(201);
    memory2Id = res2.body.id;

    const res = await request(app)
      .get("/api/memories/export")
      .set(user1Auth());

    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    expect(res.body.memories).toHaveLength(res.body.count);
    // Both workspaceA and workspaceB memories must be present (cross-workspace GDPR).
    const workspaceIds = res.body.memories.map((m: { workspaceId: string }) => m.workspaceId);
    expect(workspaceIds).toContain(workspaceAId);
    expect(workspaceIds).toContain(workspaceBId);
    // No embedding column in the export.
    for (const m of res.body.memories) {
      expect(m.embedding).toBeUndefined();
    }
  });
});

suite("DELETE /api/memories — GDPR right to erasure (integration)", () => {
  it("erases ALL of user1's memories across ALL workspaces", async () => {
    const res = await request(app)
      .delete("/api/memories")
      .set(user1Auth());

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/erased/i);
    expect(res.body.count).toBeGreaterThanOrEqual(2);

    // Verify user1's memories are gone.
    const exportRes = await request(app)
      .get("/api/memories/export")
      .set(user1Auth());
    expect(exportRes.body.count).toBe(0);
    expect(exportRes.body.memories).toHaveLength(0);
  });

  it("does NOT affect user2's memories (cross-user isolation)", async () => {
    // user2 should still have their memories (if any) — create one first to verify.
    // user2 has access to workspace B, so they can POST into it.
    const createRes = await request(app)
      .post("/api/memories")
      .set(user2Auth())
      .send({
        workspaceId: workspaceBId,
        type: "user",
        path: "user2.note",
        content: "user2's private note",
        sensitivity: "low",
      });
    // Phase 140 (EPA-02): memory is always-ON by license — the POST succeeds
    // regardless of tier. The license gate was removed; the only gates are
    // authMiddleware + requirePermission("memory:write") + IDOR workspace
    // access. user2 has access to workspace B, so the memory is created.
    expect(createRes.status).toBe(201);
    const user2Export = await request(app)
      .get("/api/memories/export")
      .set(user2Auth());
    expect(user2Export.body.count).toBeGreaterThanOrEqual(1);
    expect(user2Export.body.memories[0].userId).toBe(user2Id);
  });
});

suite("POST /api/memories — always-ON (Phase 140)", () => {
  it("succeeds (201) regardless of license tier — memory is always-ON", async () => {
    // Phase 140 (EPA-02): the memory_enabled license gate is removed —
    // memory CRUD is always-ON in community. The only gates are
    // authMiddleware + requirePermission("memory:write") + IDOR workspace
    // access. This integration test confirms the POST succeeds end-to-end.
    const res = await request(app)
      .post("/api/memories")
      .set(user1Auth())
      .send({
        workspaceId: workspaceAId,
        type: "user",
        path: "always.on.check",
        content: "memory always-on check",
        sensitivity: "low",
      });
    expect(res.status).toBe(201);
  });
});
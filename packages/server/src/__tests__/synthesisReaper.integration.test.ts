// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-04 / D-14 integration tests — SynthesisRun.expiresAt + in-process
 * setInterval reaper (mirror mcpReaperJob). The reaper flips PROCESSING rows
 * whose expiresAt < now to FAILED with the prefixed error string
 * "Aborted: orphaned PROCESSING (reaper)".
 *
 * Tests:
 *   1. PROCESSING + expiresAt < now → reaped (FAILED + error string).
 *   2. PROCESSING + expiresAt > now → untouched.
 *   3. COMPLETED/FAILED/PENDING + any expiresAt → untouched.
 *   4. getNextSynthesisJob raw SQL sets "expiresAt" = NOW() + INTERVAL '2 hours'
 *      (string assertion on synthesisTriggerService.ts source).
 *   5. runSynthesisPipeline manual-create path sets
 *      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).
 *   6. initSynthesisReaperScheduler is idempotent — second call is a no-op.
 *
 * File extension is `.integration.test.ts` to be picked up by
 * jest.config.integration.js (deviation from PLAN.md which named it
 * `.test.ts` — Rule 1: match test infrastructure, same as KB-02).
 */

import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";

// Phase 165 (Q-02): mock the jobQueue seam so Test 6 can assert pg-boss
// registration (createQueue + schedule + boss.work). The cycle-body tests
// (1-5) use real prisma and do not touch jobQueue.
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

import { getBoss, createQueue, schedule } from "../services/jobQueue";

let prisma: import("@prisma/client").PrismaClient;

let adminUserId: string;
const adminPassword = "reaper-admin-pw-9K";

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  // Seed admin user (role is seeded by global setup)
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const salt = await bcrypt.genSalt(12);
  const admin = await prisma.user.create({
    data: {
      username: "kb04_reaper_admin",
      email: "kb04_reaper_admin@test.local",
      passwordHash: await bcrypt.hash(adminPassword, salt),
      salt,
    },
  });
  adminUserId = admin.id;
  if (adminRole) {
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id },
    });
  }

  // Seed an archive so SynthesisRun.archiveId FK is valid
  const archive = await prisma.archive.create({
    data: {
      slug: "kb04-reaper-archive",
      name: "KB04 Reaper Archive",
      description: "Test archive for reaper tests",
      createdBy: adminUserId,
    },
  });
  archiveId = archive.id;
});

afterAll(async () => {
  // Cleanup: delete in FK-safe order
  await prisma.synthesisRun.deleteMany({}).catch(() => {});
  await prisma.archive.deleteMany({}).catch(() => {});
  await prisma.userRole.deleteMany({}).catch(() => {});
  await prisma.user.deleteMany({ where: { username: "kb04_reaper_admin" } }).catch(() => {});
  // Phase 165 (Q-02): the per-scheduler shutdown function was removed —
  // pg-boss stopJobQueue drains the worker. Nothing to clear here.
});

let archiveId: string;

// ── Tests ───────────────────────────────────────────────────────────────

describe("KB-04 / D-14 — SynthesisRun.expiresAt + reaper", () => {
  it("Test 1: PROCESSING + expiresAt < now → reaped (FAILED + prefixed error)", async () => {
    const run = await prisma.synthesisRun.create({
      data: {
        archiveId,
        status: "PROCESSING",
        createdBy: adminUserId,
        expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
      },
    });

    const { runSynthesisReaperCycle } = await import("../services/synthesisReaperJob");
    const result = await runSynthesisReaperCycle();

    expect(result.reaped).toBeGreaterThanOrEqual(1);

    const updated = await prisma.synthesisRun.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe("FAILED");
    expect(updated?.error).toBe("Aborted: orphaned PROCESSING (reaper)");
  });

  it("Test 2: PROCESSING + expiresAt > now → untouched (still PROCESSING)", async () => {
    const run = await prisma.synthesisRun.create({
      data: {
        archiveId,
        status: "PROCESSING",
        createdBy: adminUserId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour in the future
      },
    });

    const { runSynthesisReaperCycle } = await import("../services/synthesisReaperJob");
    const result = await runSynthesisReaperCycle();

    // This run must NOT be reaped (others from Test 1 already reaped).
    // We only assert that THIS run is still PROCESSING.
    const updated = await prisma.synthesisRun.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe("PROCESSING");
    expect(updated?.error).toBeNull();
    // result.reaped may be > 0 if other expired rows exist — we don't assert 0.
    expect(result).toHaveProperty("reaped");
  });

  it("Test 3: COMPLETED/FAILED/PENDING rows are NOT reaped regardless of expiresAt", async () => {
    const past = new Date(Date.now() - 60_000);
    const completed = await prisma.synthesisRun.create({
      data: { archiveId, status: "COMPLETED", createdBy: adminUserId, expiresAt: past },
    });
    const failed = await prisma.synthesisRun.create({
      data: { archiveId, status: "FAILED", createdBy: adminUserId, expiresAt: past },
    });
    const pending = await prisma.synthesisRun.create({
      data: { archiveId, status: "PENDING", createdBy: adminUserId, expiresAt: past },
    });

    const { runSynthesisReaperCycle } = await import("../services/synthesisReaperJob");
    await runSynthesisReaperCycle();

    const c = await prisma.synthesisRun.findUnique({ where: { id: completed.id } });
    const f = await prisma.synthesisRun.findUnique({ where: { id: failed.id } });
    const p = await prisma.synthesisRun.findUnique({ where: { id: pending.id } });

    expect(c?.status).toBe("COMPLETED");
    expect(f?.status).toBe("FAILED");
    expect(p?.status).toBe("PENDING");
  });

  it("Test 4: getNextSynthesisJob raw SQL sets expiresAt = NOW() + INTERVAL '2 hours' on claim", async () => {
    // Source-string assertion: the raw SQL in synthesisTriggerService.ts
    // must include the expiresAt assignment in the UPDATE clause.
    const sourcePath = path.resolve(__dirname, "../services/synthesisTriggerService.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain(`"expiresAt" = NOW() + INTERVAL '2 hours'`);
  });

  it("Test 5: runSynthesisPipeline manual-create path sets expiresAt: Date.now() + 2h", async () => {
    // Source-string assertion: synthesisService.ts PROCESSING-create path
    // must set expiresAt to ~2 hours from now. We verify the source includes
    // the expiresAt field in prisma.synthesisRun.create's data object with
    // the 2-hour expression.
    const sourcePath = path.resolve(__dirname, "../services/synthesisService.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000)");
  });

  it("Test 6: initSynthesisReaperScheduler is idempotent — schedule() upsert makes double-init safe (Phase 165, Q-02)", async () => {
    const { initSynthesisReaperScheduler } = await import("../services/synthesisReaperJob");
    const mockGetBoss = getBoss as jest.Mock;
    const mockCreateQueue = createQueue as jest.Mock;
    const mockSchedule = schedule as jest.Mock;
    // Stage a boss instance so init runs the pg-boss registration path.
    mockGetBoss.mockReturnValue({ work: jest.fn().mockResolvedValue("worker-id") });
    mockCreateQueue.mockClear();
    mockSchedule.mockClear();

    // Double-init: both calls resolve (schedule() upsert is idempotent —
    // ON CONFLICT DO UPDATE, no throw on the second boot).
    await expect(initSynthesisReaperScheduler()).resolves.toBeUndefined();
    await expect(initSynthesisReaperScheduler()).resolves.toBeUndefined();

    // Both calls registered the queue + schedule + work (idempotent upsert).
    expect(mockCreateQueue).toHaveBeenCalledWith("reaper_synthesis");
    expect(mockSchedule).toHaveBeenCalledWith("reaper_synthesis", "*/15 * * * *");
  });
});
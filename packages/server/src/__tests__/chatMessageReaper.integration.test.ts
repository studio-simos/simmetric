// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 84 — Plan 84-02 Task 2.
 *
 * Real-Prisma integration tests for the two-pass chat-message retention
 * reaper (SEED-002/003/004). Uses a per-file worker PostgreSQL DB whose
 * template is set up by `jest.globalSetup.js` (`prisma migrate deploy`
 * applies the 84-01 migration that adds `ChatMessage.deletedAt`).
 *
 * Cases:
 *   (default null) — value "" → Pass 1 no-op, audit emitted, 0 rows modified.
 *   (a) explicit null config — same as default but explicit upsert.
 *   (b) active chat + old message + retention=1 → Pass 1 soft-deletes it
 *       (deletedAt != null) AND the row still exists (not hard-purged —
 *       grace not elapsed). Data-safety invariant.
 *   (c) trashed chat + old message + retention=1 → Pass 1 does NOT touch
 *       it (chat:{deletedAt:null} filter excludes trashed chats), Pass 2
 *       does NOT touch it (deletedAt still null). SEED-004c.
 *   (hard-purge) — tombstoned message past grace (deletedAt = now-10d) →
 *       Pass 2 deletes the row.
 *   (audit event shape) — every tick produces exactly one EventLog row
 *       with entityType="chat", entityId="system", action="reaper.run",
 *       userId IS NULL, metadata containing softDeleted, hardPurged,
 *       retentionDays, graceDays: 7.
 *
 * NEVER partial Prisma mocks (MEMORY: rag-empty-results-diagnosis /
 * phase81-uat-bugs — partial mocks → false positives).
 */
import "./helpers/setupEnv";

import bcrypt from "bcryptjs";

let prisma: import("@prisma/client").PrismaClient;

let adminUserId: string;
let projectId: string;
let workspaceId: string;

const MS_PER_DAY = 86_400_000;

beforeAll(async () => {
  const { default: prismaClient } = await import("../utils/prisma");
  prisma = prismaClient;
  await prisma.$connect();

  // Seed admin user (admin role is seeded by global setup's `prisma db seed`).
  const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
  const salt = await bcrypt.genSalt(12);
  const admin = await prisma.user.create({
    data: {
      username: "seed004_reaper_admin",
      email: "seed004_reaper_admin@test.local",
      passwordHash: await bcrypt.hash("reaper-pw-9K", salt),
      salt,
    },
  });
  adminUserId = admin.id;
  if (adminRole) {
    await prisma.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id },
    });
  }

  // Project → Workspace (FK chain required for Chat).
  const project = await prisma.project.create({
    data: { name: "seed004-reaper-proj", createdBy: adminUserId },
  });
  projectId = project.id;
  const workspace = await prisma.workspace.create({
    data: { name: "seed004-reaper-ws", projectId },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  // FK-safe cleanup order.
  await prisma.chatMessage.deleteMany({}).catch(() => {});
  await prisma.chat.deleteMany({}).catch(() => {});
  await prisma.workspace.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
  await prisma.userRole.deleteMany({ where: { userId: adminUserId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: "seed004_reaper_admin" } }).catch(() => {});
  await prisma.eventLog.deleteMany({ where: { action: "reaper.run" } }).catch(() => {});
  await prisma.systemConfig
    .deleteMany({ where: { key: "chat_message_retention_days" } })
    .catch(() => {});

  // Phase 165 (Q-02/Q-03): the per-scheduler shutdown function was removed —
  // pg-boss stopJobQueue (wired in index.ts gracefulShutdown) drains the
  // chat-message reaper worker. No teardown call needed here; the integration
  // tests call runReaperCycle directly (the cycle body is unchanged, just
  // without the removed running-flag guard).
  await prisma.$disconnect();
});

// --- helpers ---------------------------------------------------------------

/** Set the retention config directly in the worker DB (bypasses the route). */
async function setRetention(value: string): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { key: "chat_message_retention_days" },
    create: { key: "chat_message_retention_days", value },
    update: { value },
  });
}

/** Fetch the latest reaper audit event. */
async function latestReaperAudit(): Promise<{
  entityType: string;
  entityId: string;
  action: string;
  userId: string | null;
  metadata: Record<string, unknown> | null;
}> {
  const row = await prisma.eventLog.findFirst({
    where: { action: "reaper.run", entityType: "chat" },
    orderBy: { createdAt: "desc" },
  });
  return {
    entityType: row?.entityType ?? "",
    entityId: row?.entityId ?? "",
    action: row?.action ?? "",
    userId: row?.userId ?? null,
    metadata: row?.metadata ? JSON.parse(row.metadata) : null,
  };
}

/** Create a chat + single message with backdated createdAt. */
async function seedChatWithMessage(opts: {
  chatDeletedAt?: Date;
  messageCreatedAt: Date;
  messageDeletedAt?: Date | null;
}): Promise<{ chatId: string; messageId: string }> {
  const chat = await prisma.chat.create({
    data: {
      workspaceId,
      name: `seed004-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      deletedAt: opts.chatDeletedAt ?? null,
    },
  });
  const message = await prisma.chatMessage.create({
    data: {
      chatId: chat.id,
      role: "user",
      content: "seed004 test message",
      createdAt: opts.messageCreatedAt,
      deletedAt: opts.messageDeletedAt ?? null,
    },
  });
  return { chatId: chat.id, messageId: message.id };
}

// --- tests -----------------------------------------------------------------

describe("SEED-002/003/004 — chatMessageReaper (real Prisma)", () => {
  it("(default null): value '' → Pass 1 no-op, audit emitted, 0 rows modified", async () => {
    await setRetention("");
    const { messageId } = await seedChatWithMessage({
      messageCreatedAt: new Date(Date.now() - 30 * MS_PER_DAY),
    });

    const { runReaperCycle } = await import("../services/chatMessageReaperJob");
    const beforeCount = await prisma.chatMessage.count();

    const result = await runReaperCycle();

    expect(result).toEqual({ softDeleted: 0, hardPurged: 0 });

    const afterCount = await prisma.chatMessage.count();
    expect(afterCount).toBe(beforeCount);

    // The message row is unchanged (deletedAt still null)
    const row = await prisma.chatMessage.findUnique({ where: { id: messageId } });
    expect(row?.deletedAt).toBeNull();

    // Audit emitted
    const audit = await latestReaperAudit();
    expect(audit.action).toBe("reaper.run");
    expect(audit.entityType).toBe("chat");
    expect(audit.entityId).toBe("system");
    expect(audit.userId).toBeNull();
    expect(audit.metadata).toMatchObject({
      softDeleted: 0,
      hardPurged: 0,
      retentionDays: null,
      graceDays: 7,
    });
  });

  it("(a) explicit null config → zero rows modified, audit retentionDays: null", async () => {
    await setRetention("");
    const { messageId } = await seedChatWithMessage({
      messageCreatedAt: new Date(Date.now() - 5 * MS_PER_DAY),
    });

    const { runReaperCycle } = await import("../services/chatMessageReaperJob");
    const result = await runReaperCycle();

    expect(result.softDeleted).toBe(0);

    const row = await prisma.chatMessage.findUnique({ where: { id: messageId } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeNull();

    const audit = await latestReaperAudit();
    expect(audit.metadata).toMatchObject({ retentionDays: null, graceDays: 7 });
  });

  it("(b) active chat + old message + retention=1 → soft-deleted but NOT hard-purged (invariant)", async () => {
    await setRetention("1");
    const { messageId } = await seedChatWithMessage({
      // Active chat (deletedAt: null implicit), message 2 days old (> 1 day retention)
      messageCreatedAt: new Date(Date.now() - 2 * MS_PER_DAY),
    });

    const { runReaperCycle } = await import("../services/chatMessageReaperJob");
    const result = await runReaperCycle();

    expect(result.softDeleted).toBeGreaterThanOrEqual(1);
    expect(result.hardPurged).toBe(0);

    // Soft-deleted (deletedAt set) but row STILL EXISTS (grace not elapsed)
    const row = await prisma.chatMessage.findUnique({ where: { id: messageId } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();

    const audit = await latestReaperAudit();
    expect(audit.metadata).toMatchObject({
      softDeleted: expect.any(Number),
      hardPurged: 0,
      retentionDays: 1,
      graceDays: 7,
    });
    expect((audit.metadata as { softDeleted: number }).softDeleted).toBeGreaterThanOrEqual(1);
  });

  it("(c) trashed chat + old message + retention=1 → untouched by both passes (SEED-004c)", async () => {
    await setRetention("1");
    const { messageId } = await seedChatWithMessage({
      chatDeletedAt: new Date(), // trashed chat
      messageCreatedAt: new Date(Date.now() - 30 * MS_PER_DAY), // 30 days old
    });

    const { runReaperCycle } = await import("../services/chatMessageReaperJob");
    const result = await runReaperCycle();

    // Pass 1 did NOT touch this message (chat:{deletedAt:null} filter excludes trashed chat).
    // softDeleted may be > 0 from other tests' fixtures, so assert on THIS row only.
    const row = await prisma.chatMessage.findUnique({ where: { id: messageId } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeNull(); // NOT soft-deleted by Pass 1

    // Row still exists (Pass 2 did NOT touch it — deletedAt still null)
    expect(row).not.toBeNull();
  });

  it("(hard-purge): tombstoned message past grace → row deleted by Pass 2", async () => {
    await setRetention("1");
    const { messageId } = await seedChatWithMessage({
      // Tombstoned 10 days ago — past 7-day grace
      messageCreatedAt: new Date(Date.now() - 20 * MS_PER_DAY),
      messageDeletedAt: new Date(Date.now() - 10 * MS_PER_DAY),
    });

    const { runReaperCycle } = await import("../services/chatMessageReaperJob");
    const result = await runReaperCycle();

    expect(result.hardPurged).toBeGreaterThanOrEqual(1);

    // Row is GONE
    const row = await prisma.chatMessage.findUnique({ where: { id: messageId } });
    expect(row).toBeNull();

    const audit = await latestReaperAudit();
    expect((audit.metadata as { hardPurged: number }).hardPurged).toBeGreaterThanOrEqual(1);
    expect(audit.metadata).toMatchObject({ graceDays: 7 });
  });

  it("(audit event shape): every tick produces exactly one chat.reaper.run event", async () => {
    await setRetention("");
    const beforeCount = await prisma.eventLog.count({
      where: { action: "reaper.run", entityType: "chat" },
    });

    const { runReaperCycle } = await import("../services/chatMessageReaperJob");
    await runReaperCycle();

    const afterCount = await prisma.eventLog.count({
      where: { action: "reaper.run", entityType: "chat" },
    });

    // Exactly one new audit row per tick
    expect(afterCount - beforeCount).toBe(1);

    const audit = await latestReaperAudit();
    expect(audit).toMatchObject({
      entityType: "chat",
      entityId: "system",
      action: "reaper.run",
      userId: null,
    });
    expect(audit.metadata).toHaveProperty("softDeleted");
    expect(audit.metadata).toHaveProperty("hardPurged");
    expect(audit.metadata).toHaveProperty("retentionDays");
    expect(audit.metadata).toHaveProperty("graceDays", 7);
  });
});
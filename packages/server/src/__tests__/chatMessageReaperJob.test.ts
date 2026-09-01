// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 84 — Plan 84-01 Task 3 + Plan 84-02 Task 1.
 *
 * Unit tests covering two concerns:
 *
 *  1. systemConfigService integration — SEED-001 / D-09 (from plan 84-01):
 *     - updateSettings rejects chat_message_retention_days (never writes it).
 *     - mixed batch — only the retention key is rejected; other keys update.
 *     - seedConfigDefaults idempotently seeds chat_message_retention_days = "".
 *
 *  2. chatMessageReaperJob — SEED-002/003/004 (from plan 84-02):
 *     - D-15 no-op gate (null / non-numeric / <=0): Pass 1 skipped, Pass 2 runs.
 *     - D-04 Pass 1 happy path (retention=30): updateMany with chat:{deletedAt:null}.
 *     - D-05 Pass 2 shape: deleteMany with NO chat relation filter.
 *     - D-13/D-14 audit emission: logEvent("chat","system","reaper.run", null, {...}).
 *
 * Phase 165 (Q-02/Q-03): the "T3 mutex" test (Test 7 — which asserted the
 * cycle-internal running-flag guard short-circuited a concurrent call) and
 * the "scheduler lifecycle" describe (Test 8 — which exercised the removed
 * shutdown function) were REMOVED. A new `init*Scheduler` describe block
 * asserts pg-boss registration (createQueue + schedule + boss.work) and the
 * D-02 null path. The cycle-body tests (Pass 1 / Pass 2 / SEED invariants /
 * audit) are UNCHANGED — the reaping logic was not modified by the
 * migration. The mock boundary is at `jobQueue.ts` (Pattern 3 — mock the
 * seam, not pg-boss directly); the `__mocks__/pg-boss.ts` manual mock
 * handles transitive ESM loads.
 *
 * Mock harness: prisma (systemConfig + chatMessage), licenseService, logger,
 * eventLogService.logEvent, and systemConfigService.getSetting (requireActual
 * keeps updateSettings/seedConfigDefaults real so the 84-01 cases still pass).
 */
import "./helpers/setupEnv";

// --- Prisma mock ----------------------------------------------------------
// NOTE: mock object lives INSIDE the factory to avoid TDZ under @swc/jest
// (SWC hoists ESM imports above `const`; factory runs at import-time before
// the outer const would initialize). Exposed via require() after jest.mock.
jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    systemConfig: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    chatMessage: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    // Phase 97 (MEM-04): Memory.deleteMany cascade on reaper Pass 2.
    memory: {
      deleteMany: jest.fn(),
    },
  },
  withSoftDelete: (where: unknown) => where,
}));
const mockPrisma = require("../utils/prisma").default;

// --- licenseService mock (BRANDING_* path needs isFeatureEnabled) ----------
jest.mock("../services/licenseService", () => ({
  isFeatureEnabled: jest.fn().mockReturnValue(false),
  getLicenseInfo: jest.fn().mockReturnValue({ tier: "community", features: {}, limits: {} }),
}));

// --- logger mock ----------------------------------------------------------
jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// --- eventLogService mock (logEvent spy) ----------------------------------
jest.mock("../services/eventLogService", () => ({
  __esModule: true,
  logEvent: jest.fn().mockResolvedValue(undefined),
}));

// --- systemConfigService: keep updateSettings/seedConfigDefaults real,
//     override only getSetting (the reaper's per-tick config read). ---------
jest.mock("../services/systemConfigService", () => {
  const actual = jest.requireActual("../services/systemConfigService");
  return { ...actual, getSetting: jest.fn() };
});

// Phase 165 (Pattern 3): mock the jobQueue seam — getBoss/createQueue/schedule.
// The mock boundary is jobQueue, NOT pg-boss directly. The __mocks__/pg-boss.ts
// manual mock handles transitive ESM loads (Pitfall 6). Under @swc/jest the
// factory cannot reference outer variables, so it creates its own jest.fn()
// handles; tests retrieve them via the mocked imports below.
jest.mock("../services/jobQueue", () => ({
  __esModule: true,
  getBoss: jest.fn(),
  createQueue: jest.fn().mockResolvedValue(undefined),
  schedule: jest.fn().mockResolvedValue(undefined),
}));

import { updateSettings, seedConfigDefaults, getSetting } from "../services/systemConfigService";
import { logEvent } from "../services/eventLogService";
import { logger } from "../utils/logger";
import { getBoss, createQueue, schedule } from "../services/jobQueue";
import { runReaperCycle, initChatMessageReaperScheduler } from "../services/chatMessageReaperJob";

const mockGetBoss = getBoss as jest.Mock;
const mockCreateQueue = createQueue as jest.Mock;
const mockSchedule = schedule as jest.Mock;
const mockedLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  // systemConfig defaults for the 84-01 cases
  mockPrisma.systemConfig.findMany.mockResolvedValue([]);
  mockPrisma.systemConfig.upsert.mockResolvedValue({});
  // reaper defaults: OFF (empty string), no rows touched
  (getSetting as jest.Mock).mockResolvedValue({
    key: "chat_message_retention_days",
    value: "",
    readOnly: false,
  });
  mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
  // Phase 97 (MEM-04): Pass 2 queries IDs BEFORE delete; default = no rows to
  // purge, so the short-circuit branch runs and deleteMany is NOT called.
  mockPrisma.chatMessage.findMany.mockResolvedValue([]);
  mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.memory.deleteMany.mockResolvedValue({ count: 0 });
});

// ---------------------------------------------------------------------------
// 84-01 cases — systemConfigService integration (D-09)
// ---------------------------------------------------------------------------
describe("systemConfigService integration — D-09 chat_message_retention_days", () => {
  it("Test 1: updateSettings rejects chat_message_retention_days and never upserts it", async () => {
    const result = await updateSettings([
      { key: "chat_message_retention_days", value: "30" },
    ]);

    expect(result.updated).toEqual([]);
    expect(result.rejected).toEqual(["chat_message_retention_days"]);

    const upsertCalls = mockPrisma.systemConfig.upsert.mock.calls as Array<
      [{ where: { key: string } }]
    >;
    const retentionCalls = upsertCalls.filter((c) => c[0]?.where?.key === "chat_message_retention_days");
    expect(retentionCalls).toHaveLength(0);
  });

  it("Test 2: mixed batch rejects only the retention key; other keys still update", async () => {
    const result = await updateSettings([
      { key: "chat_message_retention_days", value: "30" },
      { key: "ALLOW_NON_ADMIN_UPLOAD", value: "false" },
    ]);

    expect(result.rejected).toEqual(["chat_message_retention_days"]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]?.key).toBe("ALLOW_NON_ADMIN_UPLOAD");

    const upsertCalls = mockPrisma.systemConfig.upsert.mock.calls as Array<
      [{ where: { key: string } }]
    >;
    const nonRetention = upsertCalls.filter((c) => c[0]?.where?.key === "ALLOW_NON_ADMIN_UPLOAD");
    expect(nonRetention).toHaveLength(1);
    const retentionCalls = upsertCalls.filter((c) => c[0]?.where?.key === "chat_message_retention_days");
    expect(retentionCalls).toHaveLength(0);
  });

  it("Test 3: seedConfigDefaults idempotently seeds chat_message_retention_days = '' (update: {})", async () => {
    await seedConfigDefaults();

    const upsertCalls = mockPrisma.systemConfig.upsert.mock.calls as Array<
      [{ where: { key: string }; create: { key: string; value: string }; update: Record<string, unknown> }]
    >;
    const retentionCalls = upsertCalls.filter((c) => c[0]?.where?.key === "chat_message_retention_days");
    expect(retentionCalls.length).toBeGreaterThanOrEqual(1);
    const explicit = retentionCalls.find((c) => c[0]?.create?.value === "");
    expect(explicit).toBeDefined();
    expect(explicit![0].create).toEqual({
      key: "chat_message_retention_days",
      value: "",
    });
    expect(explicit![0].update).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 84-02 cases — chatMessageReaperJob (no-op gate, shapes, audit)
// ---------------------------------------------------------------------------
describe("chatMessageReaperJob — runReaperCycle", () => {
  it("Test 1: D-15 no-op gate — value '' skips Pass 1, Pass 2 still runs (findMany), audit emitted", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "",
      readOnly: false,
    });

    const result = await runReaperCycle();

    expect(result).toEqual({ softDeleted: 0, hardPurged: 0 });
    // Pass 1 NOT invoked
    expect(mockPrisma.chatMessage.updateMany).not.toHaveBeenCalled();
    // Phase 97: Pass 2 queries IDs first (findMany). With [] returned, deleteMany
    // short-circuits — it is NOT called (only called when purgedIds.length > 0).
    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatMessage.deleteMany).not.toHaveBeenCalled();
    // Audit emitted with retentionDays: null, graceDays: 7, memoryPurged: 0
    expect(logEvent).toHaveBeenCalledWith(
      "chat",
      "system",
      "reaper.run",
      null,
      expect.objectContaining({ softDeleted: 0, hardPurged: 0, memoryPurged: 0, retentionDays: null, graceDays: 7 }),
    );
  });

  it("Test 2: D-15 non-numeric value 'abc' — Pass 1 skipped, Pass 2 runs (findMany), retentionDays: null", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "abc",
      readOnly: false,
    });

    const result = await runReaperCycle();

    expect(result).toEqual({ softDeleted: 0, hardPurged: 0 });
    expect(mockPrisma.chatMessage.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatMessage.deleteMany).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "chat",
      "system",
      "reaper.run",
      null,
      expect.objectContaining({ retentionDays: null, graceDays: 7 }),
    );
  });

  it("Test 3: D-15 value '0' (<=0) — Pass 1 skipped, Pass 2 runs (findMany), retentionDays: null", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "0",
      readOnly: false,
    });

    const result = await runReaperCycle();

    expect(result).toEqual({ softDeleted: 0, hardPurged: 0 });
    expect(mockPrisma.chatMessage.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatMessage.deleteMany).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      "chat",
      "system",
      "reaper.run",
      null,
      expect.objectContaining({ retentionDays: null, graceDays: 7 }),
    );
  });

  it("Test 4: D-04 Pass 1 happy path — retention=30 emits updateMany with chat:{deletedAt:null}", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "30",
      readOnly: false,
    });
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 5 });
    // Phase 97: findMany returns 1 row → deleteMany called once with id:in.
    mockPrisma.chatMessage.findMany.mockResolvedValue([{ id: "purge-1" }]);
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.memory.deleteMany.mockResolvedValue({ count: 0 });

    const result = await runReaperCycle();

    expect(result).toEqual({ softDeleted: 5, hardPurged: 1 });
    expect(mockPrisma.chatMessage.updateMany).toHaveBeenCalledTimes(1);
    const call = (mockPrisma.chatMessage.updateMany.mock.calls[0] as Array<{
      where: { deletedAt: null; createdAt: { lt: Date }; chat: { deletedAt: null } };
      data: { deletedAt: Date };
    }>)[0]!;
    // Load-bearing: chat.deletedAt: null relation filter (SEED-004c)
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.chat).toEqual({ deletedAt: null });
    expect(call.where.createdAt).toHaveProperty("lt");
    expect(call.where.createdAt.lt).toBeInstanceOf(Date);
    expect(call.data.deletedAt).toBeInstanceOf(Date);
  });

  it("Test 5: D-05 Pass 2 — deleteMany with NO chat relation filter (Phase 97: query IDs then delete by id:in)", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "30",
      readOnly: false,
    });
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    // Phase 97 (MEM-04): Pass 2 now queries IDs BEFORE delete so Memory cascade
    // can use `sourceMessageId: { in: purgedIds }`. findMany returns 2 rows.
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      { id: "msg-1" },
      { id: "msg-2" },
    ]);
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.memory.deleteMany.mockResolvedValue({ count: 0 });

    await runReaperCycle();

    // findMany called once with NO chat relation filter (matches SEED-002 SQL).
    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
    const findCall = (mockPrisma.chatMessage.findMany.mock.calls[0] as Array<{
      where: { deletedAt: { not: null; lt: Date } };
      select: { id: true };
    }>)[0]!;
    expect(findCall.where).not.toHaveProperty("chat");
    expect(findCall.where.deletedAt).toHaveProperty("not", null);
    expect(findCall.where.deletedAt).toHaveProperty("lt");
    expect(findCall.where.deletedAt.lt).toBeInstanceOf(Date);
    expect(findCall.select).toEqual({ id: true });

    // deleteMany called with `where: { id: { in: [...] } }` (ids from findMany).
    expect(mockPrisma.chatMessage.deleteMany).toHaveBeenCalledTimes(1);
    const delCall = (mockPrisma.chatMessage.deleteMany.mock.calls[0] as Array<{
      where: { id: { in: string[] } };
    }>)[0]!;
    expect(delCall.where).not.toHaveProperty("chat");
    expect(delCall.where).not.toHaveProperty("deletedAt");
    expect(delCall.where.id.in).toEqual(["msg-1", "msg-2"]);

    // Memory cascade called with sourceMessageId: { in: purgedIds } (MEM-04 D-07).
    expect(mockPrisma.memory.deleteMany).toHaveBeenCalledTimes(1);
    const memCall = (mockPrisma.memory.deleteMany.mock.calls[0] as Array<{
      where: { sourceMessageId: { in: string[] } };
    }>)[0]!;
    expect(memCall.where.sourceMessageId.in).toEqual(["msg-1", "msg-2"]);
  });

  it("Test 6: D-13/D-14 audit — logEvent called exactly once per tick with full shape (Phase 97: + memoryPurged)", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "30",
      readOnly: false,
    });
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 3 });
    mockPrisma.chatMessage.findMany.mockResolvedValue([]); // no rows past grace → no-op Pass 2
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 0 });

    await runReaperCycle();

    expect(logEvent).toHaveBeenCalledTimes(1);
    const args = (logEvent as jest.Mock).mock.calls[0];
    expect(args[0]).toBe("chat");
    expect(args[1]).toBe("system");
    expect(args[2]).toBe("reaper.run");
    expect(args[3]).toBeNull();
    expect(args[4]).toMatchObject({
      softDeleted: 3,
      hardPurged: 0,
      memoryPurged: 0,
      retentionDays: 30,
      graceDays: 7,
    });
  });

  it("Test 6b: Phase 97 MEM-04 — memory.reaper.purge audit fires when Memory rows cascaded", async () => {
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "30",
      readOnly: false,
    });
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.chatMessage.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.memory.deleteMany.mockResolvedValue({ count: 1 });

    await runReaperCycle();

    // reaper.run fires once with memoryPurged: 1
    const runCall = (logEvent as jest.Mock).mock.calls.find(
      (c) => c[2] === "reaper.run",
    );
    expect(runCall).toBeDefined();
    expect(runCall[4]).toMatchObject({ hardPurged: 2, memoryPurged: 1 });
    // reaper.purge fires once (only when memoryPurged > 0) per MEM-04 SC1
    const purgeCall = (logEvent as jest.Mock).mock.calls.find(
      (c) => c[0] === "memory" && c[2] === "reaper.purge",
    );
    expect(purgeCall).toBeDefined();
    expect(purgeCall[4]).toMatchObject({ memoryPurged: 1 });
  });
});

describe("initChatMessageReaperScheduler pg-boss registration (Phase 165, Q-02)", () => {
  // Default boss instance with a work stub whose calls the tests inspect.
  const bossWork = jest.fn().mockResolvedValue("worker-id-1");

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateQueue.mockResolvedValue(undefined);
    mockSchedule.mockResolvedValue(undefined);
    bossWork.mockClear();
    bossWork.mockResolvedValue("worker-id-1");
    mockGetBoss.mockReturnValue({ work: bossWork });
    // reaper defaults: OFF (empty string), no rows touched
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "",
      readOnly: false,
    });
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.chatMessage.findMany.mockResolvedValue([]);
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.memory.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("registers queue + cron schedule + work handler", async () => {
    await initChatMessageReaperScheduler();

    // D-04: queue name matches the Phase 161 lock resource key.
    expect(mockCreateQueue).toHaveBeenCalledWith("reaper_chat-message");
    // D-05: daily 03:00 cron expression.
    expect(mockSchedule).toHaveBeenCalledWith("reaper_chat-message", "0 3 * * *");
    // boss.work registered with the queue name and a handler function.
    expect(bossWork).toHaveBeenCalledTimes(1);
    expect(bossWork.mock.calls[0][0]).toBe("reaper_chat-message");
    expect(typeof bossWork.mock.calls[0][1]).toBe("function");
    // createQueue precedes schedule (Pitfall 1 — foreign-key constraint).
    expect(mockCreateQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSchedule.mock.invocationCallOrder[0]!,
    );
  });

  it("D-02: getBoss() === null → logs warn + returns early (no createQueue/schedule/work)", async () => {
    mockGetBoss.mockReturnValue(null);

    await initChatMessageReaperScheduler();

    expect(mockCreateQueue).not.toHaveBeenCalled();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(bossWork).not.toHaveBeenCalled();
    // D-02: warn log mentions pg-boss unavailable.
    const warnCalls = mockedLogger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("pg-boss unavailable"))).toBe(true);
  });

  it("work handler calls runReaperCycle on each job (Pitfall 2 — Job[] array)", async () => {
    await initChatMessageReaperScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Stage a retention=30 + 1 soft-deleted + 1 row to purge so runReaperCycle
    // actually mutates — proves the cycle ran inside the work handler.
    (getSetting as jest.Mock).mockResolvedValue({
      key: "chat_message_retention_days",
      value: "30",
      readOnly: false,
    });
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.chatMessage.findMany.mockResolvedValue([{ id: "purge-x" }]);
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.memory.deleteMany.mockResolvedValue({ count: 0 });

    // pg-boss passes a Job[] array (Pitfall 2). The handler iterates with
    // for...of and runs the cycle once per job.
    const job = {
      id: "j1",
      data: {},
      name: "reaper_chat-message",
      expireInSeconds: 300,
      heartbeatSeconds: null,
      signal: new AbortController().signal,
    };
    await expect(handler([job])).resolves.toBeUndefined();

    // The cycle ran → Pass 1 updateMany + Pass 2 deleteMany both invoked.
    expect(mockPrisma.chatMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatMessage.deleteMany).toHaveBeenCalledTimes(1);
    // Audit emitted (D-13/D-14).
    expect(logEvent).toHaveBeenCalledWith(
      "chat",
      "system",
      "reaper.run",
      null,
      expect.objectContaining({ softDeleted: 1, hardPurged: 1 }),
    );
  });

  it("Pitfall 3: work handler catches cycle errors and resolves (no re-throw → no retry storm)", async () => {
    await initChatMessageReaperScheduler();
    const handler = bossWork.mock.calls[0][1];

    // Force runReaperCycle to throw by making getSetting reject.
    (getSetting as jest.Mock).mockRejectedValue(new Error("cycle boom"));

    // Handler must NOT re-throw — it logs and resolves (pg-boss sees success).
    await expect(handler([{ id: "j1", data: {}, name: "reaper_chat-message" }])).resolves.toBeUndefined();
    expect(mockedLogger.error).toHaveBeenCalled();
  });
});
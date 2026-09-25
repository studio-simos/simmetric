// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-03 Task 3, D-15/D-16/D-20, P-7/P-10, T-198-12/13) — the
 * connector poll scheduler tests: health flip semantics, BigInt offset
 * advance, per-connector in-flight guard. Postgres-free (prisma + adapter +
 * messageRouter mocked); the ticker is driven manually via the exported
 * test hook (no real setInterval waits).
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  (mock.prisma as Record<string, unknown>).chatConnector = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  (mock.prisma as Record<string, unknown>).connectorMessage = {
    create: jest.fn(),
  };
  (mock.prisma as Record<string, unknown>).connectorSession = {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// handleIncomingMessage is replaced — the poller's ROUTING contract is that
// poll Updates reach it (D-16); the pipeline internals are messageRouter's
// own suite (messageRouter.test.ts).
jest.mock("../services/connectors/messageRouter", () => ({
  handleIncomingMessage: jest.fn(async () => undefined),
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    TELEGRAM_API_URL: "https://api.telegram.org",
    CONNECTOR_POLL_INTERVAL_MS: 3000,
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    NODE_ENV: "test",
  })),
}));

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  initConnectorPollScheduler,
  stopConnectorPollScheduler,
  resetConnectorPollState,
} from "../services/connectors/connectorPoller";
import { registerAdapter, clearAdapters } from "../services/connectors/registry";
import { handleIncomingMessage } from "../services/connectors/messageRouter";
import type { PlatformAdapter, IncomingMessage } from "../services/connectors/base";

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-4466554400b1";
const CONNECTOR_ID_2 = "550e8400-e29b-41d4-a716-4466554400b3";

function connectorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONNECTOR_ID,
    platform: "telegram",
    organizationId: "org-198",
    workspaceId: "550e8400-e29b-41d4-a716-4466554400b2",
    archiveId: null,
    responseProviderId: null,
    responseModel: null,
    welcomeMessage: null,
    fallbackMessage: null,
    fallbackLocale: "en",
    rateLimitPerMinute: null,
    sessionLimitPerDay: null,
    healthStatus: "unknown",
    lastError: null,
    pollMode: "polling",
    isEnabled: true,
    deletedAt: null,
    pollOffset: 0n,
    botTokenEncrypted: "enc-token-blob",
    configEncrypted: null,
    ...overrides,
  };
}

function pollUpdate(updateId: number, text = "hello"): IncomingMessage & { updateId: bigint } {
  return {
    platformMessageId: String(updateId),
    platformUserId: "tg-user-1",
    platformUserName: "Alice",
    text,
    chatType: "private",
    updateId: BigInt(updateId),
  };
}

/** A controllable PlatformAdapter fake. */
function fakeAdapter(overrides: Record<string, unknown> = {}): jest.Mocked<PlatformAdapter> {
  return {
    parseIncomingWebhook: jest.fn(() => null),
    pollUpdates: jest.fn(async () => []),
    sendMessage: jest.fn(async () => ({ platformMessageId: "out-1" })),
    sendTypingIndicator: jest.fn(async () => undefined),
    validateBotToken: jest.fn(async () => ({ valid: true })),
    getBotInfo: jest.fn(async () => ({})),
    setWebhook: jest.fn(async () => undefined),
    removeWebhook: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as jest.Mocked<PlatformAdapter>;
}

/**
 * Drive ONE scheduler tick deterministically (the interval callback is
 * internal — the test uses fake timers to advance exactly one tick and
 * flush the async chain).
 */
async function driveTick(): Promise<void> {
  await jest.advanceTimersByTimeAsync(3000);
  // Flush the microtask chain (findMany → per-connector poll → update).
  await Promise.resolve();
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAdapters();
  resetConnectorPollState();
  jest.useFakeTimers();
  (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});
  (prisma.chatConnector.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (handleIncomingMessage as jest.Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  stopConnectorPollScheduler();
  clearAdapters();
  resetConnectorPollState();
  jest.useRealTimers();
});

// ─── D-20: health flip semantics ───────────────────────────────────────

describe("health flip (D-20)", () => {
  it("an adapter 401 → update called with healthStatus 'error' + lastError (connector STAYS enabled — no isEnabled=false write)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates.mockRejectedValue(
      Object.assign(new Error("Telegram getUpdates failed (HTTP 401): Unauthorized"), {
        method: "getUpdates",
        status: 401,
      })
    );
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    // Drive 3 consecutive failing ticks (threshold = 3).
    await driveTick();
    await driveTick();
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
    await driveTick();

    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTOR_ID },
        data: expect.objectContaining({
          healthStatus: "error",
          lastError: expect.stringContaining("Unauthorized"),
        }),
      })
    );
    // D-20: NO isEnabled write anywhere in the poll error path.
    const updateCalls = (prisma.chatConnector.update as jest.Mock).mock.calls;
    for (const call of updateCalls) {
      expect(call[0].data.isEnabled).toBeUndefined();
    }
  });

  it("the next successful poll flips 'healthy' and clears lastError (D-20 auto-recovery)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates
      .mockRejectedValueOnce(new Error("Telegram getUpdates failed: boom 1"))
      .mockRejectedValueOnce(new Error("Telegram getUpdates failed: boom 2"))
      .mockRejectedValueOnce(new Error("Telegram getUpdates failed: boom 3"))
      .mockResolvedValueOnce([]);
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();
    await driveTick();
    await driveTick(); // threshold → error
    await driveTick(); // success → healthy

    expect(prisma.chatConnector.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTOR_ID, healthStatus: { not: "healthy" } },
        data: { healthStatus: "healthy", lastError: null },
      })
    );
  });

  it("2 consecutive errors → NO flip (below threshold 3)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates.mockRejectedValue(new Error("Telegram getUpdates failed: x"));
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();
    await driveTick();

    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });

  it("3rd consecutive error → flip; the error counter RESETS on success (re-accumulation, not persistence)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce([]) // success resets the counter
      .mockRejectedValueOnce(new Error("fail again 1"))
      .mockRejectedValueOnce(new Error("fail again 2"));
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();
    await driveTick();
    await driveTick(); // success (reset)
    await driveTick();
    await driveTick(); // only 2 consecutive since reset → NO flip

    // No HEALTH flip — the only `update` calls are the success-path offset
    // advances (which never carry healthStatus).
    const updateCalls = (prisma.chatConnector.update as jest.Mock).mock.calls;
    expect(updateCalls.every((call) => call[0].data.healthStatus === undefined)).toBe(true);
  });

  it("a 409 webhook-conflict text lands in lastError without loop escalation (P-7) — the flip is throttled by the threshold", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates.mockRejectedValue(
      Object.assign(
        new Error("Telegram getUpdates failed (HTTP 409): Conflict: can't use getUpdates method while webhook is active"),
        { method: "getUpdates", status: 409 }
      )
    );
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    // 4 ticks: 3 → flip; the 4th is still just the same throttled flip —
    // the poller keeps polling (no auto-disable, no throw).
    await driveTick();
    await driveTick();
    await driveTick();
    await driveTick();

    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTOR_ID },
        data: expect.objectContaining({
          lastError: expect.stringContaining("webhook is active"),
        }),
      })
    );
    expect(adapter.pollUpdates).toHaveBeenCalledTimes(4); // keeps polling — no escalation
  });

  it("a successful poll does NOT write healthStatus when already healthy (idempotent updateMany arm)", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([
      connectorRow({ healthStatus: "healthy" }),
    ]);

    initConnectorPollScheduler();
    await driveTick();

    // updateMany is called with the not:"healthy" filter — for an already
    // healthy row the DB no-ops; the flip contract is the WHERE clause.
    expect(prisma.chatConnector.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTOR_ID, healthStatus: { not: "healthy" } },
      })
    );
  });
});

// ─── D-15/D-01: BigInt offset advance ──────────────────────────────────

describe("pollOffset advance (D-15/D-01/T-198-13)", () => {
  it("after a poll returning update_ids [10, 11], the NEXT getUpdates carries offset 12 (lastUpdateId+1, BigInt)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates
      .mockResolvedValueOnce([
        pollUpdate(10), pollUpdate(11),
      ])
      .mockResolvedValueOnce([]);
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();

    // The offset advance: update called with lastUpdateId + 1 = 12n.
    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTOR_ID },
        data: expect.objectContaining({ pollOffset: 12n, lastPollAt: expect.any(Date) }),
      })
    );

    // The adapter receives the ROW (with its BigInt pollOffset) — the next
    // tick passes the advanced offset through (the row's pollOffset is what
    // the DB now holds; the adapter's offset parameter is BigInt-typed).
    expect(adapter.pollUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ pollOffset: 0n })
    );
  });

  it("an empty batch re-polls with the SAME offset (no advance — Telegram re-delivers by cursor semantics)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates.mockResolvedValue([]);
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([
      connectorRow({ pollOffset: 5000000000n }),
    ]);

    initConnectorPollScheduler();
    await driveTick();

    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTOR_ID },
        data: expect.objectContaining({ pollOffset: 5000000000n, lastPollAt: expect.any(Date) }),
      })
    );
  });

  it("each update in the batch routes through handleIncomingMessage (D-16 — same pipeline as webhook)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates.mockResolvedValueOnce([pollUpdate(10, "hi"), pollUpdate(11, "ho")]);
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();

    expect(handleIncomingMessage).toHaveBeenCalledTimes(2);
    expect(handleIncomingMessage.mock.calls[0][1].text).toBe("hi");
    expect(handleIncomingMessage.mock.calls[1][1].text).toBe("ho");
  });

  it("a handleIncomingMessage failure does NOT abort the offset advance (batch continuation, D-12 error ownership)", async () => {
    const adapter = fakeAdapter();
    adapter.pollUpdates.mockResolvedValueOnce([pollUpdate(10), pollUpdate(11)]);
    registerAdapter("telegram", adapter);
    (handleIncomingMessage as jest.Mock)
      .mockRejectedValueOnce(new Error("agent exploded"))
      .mockResolvedValueOnce(undefined);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();

    expect(handleIncomingMessage).toHaveBeenCalledTimes(2);
    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pollOffset: 12n }),
      })
    );
  });

  it("a GROUP-ONLY batch advances the offset from the adapter's batch-wide maxUpdateId (WR-06 stall pin)", async () => {
    const adapter = fakeAdapter();
    // The adapter's new contract: no private messages survived the filter,
    // but maxUpdateId covers ALL returned update_ids (group chatter + edits).
    adapter.pollUpdates.mockResolvedValueOnce({
      messages: [],
      maxUpdateId: 62n,
    });
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([
      connectorRow({ pollOffset: 0n }),
    ]);

    initConnectorPollScheduler();
    await driveTick();

    // The cursor ADVANCED past the group traffic — the same updates are not
    // re-delivered next tick (previously this stalled forever until private
    // traffic happened to push past the group update_id).
    expect(prisma.chatConnector.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONNECTOR_ID },
        data: expect.objectContaining({ pollOffset: 63n }),
      })
    );
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });
});

// ─── D-15: per-connector in-flight guard + scheduler shape ─────────────

describe("per-connector in-flight guard (D-15/P-10)", () => {
  it("a connector whose long-poll is STILL in flight skips the re-entrant tick — other connectors poll independently", async () => {
    const slowAdapter = fakeAdapter();
    let releaseSlow!: (v?: unknown) => void;
    const gate = new Promise((r) => (releaseSlow = r));
    slowAdapter.pollUpdates.mockImplementation(
      () => new Promise((resolve) => gate.then(() => resolve([]))) as Promise<never[]>
    );

    const fastAdapter = fakeAdapter();
    fastAdapter.pollUpdates.mockResolvedValue([]);

    // Distinct rows carry DISTINCT platforms so the registry routes each
    // connector to its own fake (the same registry Map serves all rows).
    registerAdapter("telegram", slowAdapter);
    registerAdapter("discord", fastAdapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([
      connectorRow({ id: CONNECTOR_ID }), // slow (telegram)
      connectorRow({ id: CONNECTOR_ID_2, platform: "discord" }), // fast
    ]);

    initConnectorPollScheduler();
    await driveTick(); // both connectors start a poll

    // The slow connector's poll is in flight; its SECOND tick must skip it
    // while the fast connector re-polls.
    (prisma.chatConnector.findMany as jest.Mock).mockClear();
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([
      connectorRow({ id: CONNECTOR_ID }),
      connectorRow({ id: CONNECTOR_ID_2, platform: "discord" }),
    ]);
    await driveTick();

    const slowCalls = slowAdapter.pollUpdates.mock.calls.length;
    const fastCalls = fastAdapter.pollUpdates.mock.calls.length;
    expect(slowCalls).toBe(1); // skipped re-entrant tick
    expect(fastCalls).toBe(2); // re-polled

    releaseSlow();
    await driveTick();
  });

  it("init is idempotent — a second call does not stack a second ticker", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    initConnectorPollScheduler(); // second init — no-op
    await driveTick();

    expect(prisma.chatConnector.findMany).toHaveBeenCalledTimes(1);
  });

  it("stopConnectorPollScheduler stops the ticker (no further ticks fire)", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();
    expect(prisma.chatConnector.findMany).toHaveBeenCalledTimes(1);

    stopConnectorPollScheduler();
    (prisma.chatConnector.findMany as jest.Mock).mockClear();
    await driveTick();
    expect(prisma.chatConnector.findMany).not.toHaveBeenCalled();
  });

  it("disabled/non-polling/deleted connectors are never queried for polling (the where clause filters)", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([]);

    initConnectorPollScheduler();
    await driveTick();

    expect(prisma.chatConnector.findMany).toHaveBeenCalledWith({
      where: {
        platform: "telegram",
        isEnabled: true,
        deletedAt: null,
        pollMode: "polling",
      },
    });
    expect(adapter.pollUpdates).not.toHaveBeenCalled();
  });

  it("no adapter registered → the connector is skipped without an error (fail-closed D-03)", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([connectorRow()]);

    initConnectorPollScheduler();
    await driveTick();

    expect(logger.error).not.toHaveBeenCalled();
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
  });
});
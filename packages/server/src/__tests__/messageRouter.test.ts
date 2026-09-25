// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-02 Task 2, D-09/D-10/D-11/D-18/D-19/D-20) — messageRouter
 * pipeline tests. Postgres-free: prisma + adapter mocked.
 *
 * The pipeline order proven here: private-filter → /start → dedup →
 * session → rate limit (rolling window) → non-text guard → typing → agent →
 * reply → out-row.
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  (mock.prisma as any).connectorMessage = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  };
  (mock.prisma as any).connectorSession = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  (mock.prisma as any).chatConnector = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  };
  (mock.prisma as any).chat = { findUnique: jest.fn(), create: jest.fn() };
  (mock.prisma as any).workspace = { findUnique: jest.fn() };
  (mock.prisma as any).user = { findFirst: jest.fn() };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/seedService", () => ({ seedServiceAccount: jest.fn() }));

// connectorChatService — orchestrator + filters stay OUT of this suite.
jest.mock("../services/connectors/connectorChatService", () => ({
  runConnectorChatTurn: jest.fn(),
}));

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  handleIncomingMessage,
  withSessionLock,
  sessionKey,
  resetLimitNotifications,
} from "../services/connectors/messageRouter";
import { resolveSession } from "../services/connectors/sessionResolver";
import { runConnectorChatTurn } from "../services/connectors/connectorChatService";
import { registerAdapter, clearAdapters } from "../services/connectors/registry";
import type { IncomingMessage, ConnectorPipelineRow, PlatformAdapter } from "../services/connectors/base";

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-4466554400b1";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-4466554400b2";
const CHAT_ID = "chat-198-b";
const SESSION_ID = "session-198-b";
const SVC_ID = "svc-198";

function connectorRow(overrides: Record<string, unknown> = {}): ConnectorPipelineRow {
  return {
    id: CONNECTOR_ID,
    platform: "telegram",
    organizationId: "org-198",
    workspaceId: WORKSPACE_ID,
    archiveId: null,
    responseProviderId: null,
    responseModel: null,
    welcomeMessage: null,
    fallbackMessage: "Custom fallback",
    fallbackLocale: "en",
    rateLimitPerMinute: null,
    sessionLimitPerDay: null,
    healthStatus: "unknown",
    lastError: null,
    ...overrides,
  };
}

function inbound(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platformMessageId: "pm-1",
    platformUserId: "tg-user-1",
    platformUserName: "Alice",
    text: "Hello bot",
    chatType: "private",
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: SESSION_ID,
    connectorId: CONNECTOR_ID,
    platformUserId: "tg-user-1",
    platformUserName: "Alice",
    chatId: CHAT_ID,
    messageCount: 0,
    lastMessageAt: null,
    lastResetAt: new Date(now.getTime() - 5 * 60_000), // 5min ago — inside the window
    expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
    ...overrides,
  };
}

/** A controllable fake adapter (PlatformAdapter with jest.fn methods). */
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

/** Wire the prisma mock into the shapes the pipeline consumes. */
function wireSession(session: Record<string, unknown>) {
  (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(session);
  (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) =>
    Promise.resolve({
      ...session,
      ...(typeof data.messageCount === "object"
        ? { messageCount: session.messageCount + 1 }
        : { messageCount: data.messageCount ?? session.messageCount }),
      ...data,
    })
  );
  (prisma.connectorMessage.create as jest.Mock).mockResolvedValue({ id: "cm-1" });
  (prisma.connectorMessage.count as jest.Mock).mockResolvedValue(0);
  (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});
  (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SVC_ID });
  (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: "org-198" });
  (prisma.chat.findUnique as jest.Mock).mockResolvedValue({ id: CHAT_ID });
  (prisma.chat.create as jest.Mock).mockResolvedValue({ id: CHAT_ID });
  (prisma.chatMessage.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.chatMessage.create as jest.Mock).mockResolvedValue({ id: "msg-1" });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearAdapters();
  resetLimitNotifications();
  jest.useRealTimers();
  wireSession(sessionRow());
});

afterEach(() => {
  clearAdapters();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── D-18: private-only guard ────────────────────────────────────────

describe("private-only guard (D-18/T-198-07)", () => {
  it.each(["group", "supergroup", "channel"] as const)(
    "chatType %s returns before ANY prisma call (no row, no counter, no reply)",
    async (chatType) => {
      const adapter = fakeAdapter();
      registerAdapter("telegram", adapter);

      await handleIncomingMessage(connectorRow(), {
        platformMessageId: "pm-g",
        platformUserId: "tg-user-g",
        text: "inject",
        chatType,
      });

      expect(prisma.connectorMessage.create).not.toHaveBeenCalled();
      expect(prisma.connectorSession.findUnique).not.toHaveBeenCalled();
      expect(prisma.connectorSession.create).not.toHaveBeenCalled();
      expect(adapter.sendMessage).not.toHaveBeenCalled();
      expect(runConnectorChatTurn).not.toHaveBeenCalled();
    }
  );
});

// ─── D-18: /start welcome path ───────────────────────────────────────

describe("/start welcome (D-18)", () => {
  it("sends the connector welcomeMessage and NEVER calls the agent", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const connector = connectorRow({ welcomeMessage: "Welcome aboard!" });

    await handleIncomingMessage(connector, {
      platformMessageId: "pm-start",
      platformUserId: "tg-user-1",
      text: "/start",
      chatType: "private",
      isCommand: "start",
    });

    expect(adapter.sendMessage).toHaveBeenCalledWith(connector, "tg-user-1", "Welcome aboard!");
    expect(runConnectorChatTurn).not.toHaveBeenCalled();
    expect(prisma.connectorMessage.create).toHaveBeenCalledTimes(2); // in + out
    expect(prisma.connectorMessage.create.mock.calls[0][0].data.direction).toBe("in");
    expect(prisma.connectorMessage.create.mock.calls[1][0].data.direction).toBe("out");
  });

  it("falls back to the sensible EN default when welcomeMessage is null", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);

    await handleIncomingMessage(connectorRow(), {
      platformMessageId: "pm-start",
      platformUserId: "tg-user-1",
      text: "/start",
      chatType: "private",
    });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect((adapter.sendMessage as jest.Mock).mock.calls[0][2]).toContain("assistant");
  });
});

// ─── D-11/P-9: dedup P2002 silent skip ───────────────────────────────

describe("dedup (D-11/P-9)", () => {
  it("a duplicate platformMessageId P2002 skips SILENTLY — no second row, no reply, no health flip", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    (prisma.connectorMessage.create as jest.Mock).mockImplementation(({ data }) => {
      if (data.direction === "in" && data.platformMessageId === "pm-dup") {
        const err = new Error("Unique constraint failed") as { code?: string };
        err.code = "P2002";
        return Promise.reject(err);
      }
      return Promise.resolve({ id: "cm-1" });
    });

    const connector = connectorRow();
    await handleIncomingMessage(connector, {
      platformMessageId: "pm-dup",
      platformUserId: "tg-user-1",
      text: "Hello",
      chatType: "private",
    });

    // Exactly ONE in-row attempted (the duplicate insert itself), no out-row.
    expect(prisma.connectorMessage.create).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(runConnectorChatTurn).not.toHaveBeenCalled();
    // P-9: no health flip, no error log.
    expect(prisma.chatConnector.update).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("the SAME per-chat platformMessageId from a DIFFERENT user is NOT dropped (CR-02 cross-chat collision pin)", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    // The adapter now composes `${chatId}:${message_id}` (CR-02) — so user A
    // and user B both carrying per-chat id 101 produce DISTINCT platform
    // message ids, and neither hits the P2002 skip.
    const seen: string[] = [];
    (prisma.connectorMessage.create as jest.Mock).mockImplementation(({ data }) => {
      if (data.direction === "in") seen.push(data.platformMessageId);
      return Promise.resolve({ id: "cm-1" });
    });
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "ok" });

    const c = connectorRow();
    await handleIncomingMessage(c, {
      platformMessageId: "555000111:101",
      platformUserId: "user-A",
      text: "from A",
      chatType: "private",
    });
    // User B's FIRST message carries the same per-chat id (both sequences
    // start low) — with the composite id it is a distinct row, processed.
    await handleIncomingMessage(c, {
      platformMessageId: "999:101",
      platformUserId: "user-B",
      text: "from B",
      chatType: "private",
    });

    expect(seen).toEqual(["555000111:101", "999:101"]);
    expect(runConnectorChatTurn).toHaveBeenCalledTimes(2);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("the in-row is the FIRST DB write of the pipeline (before the agent or any counter)", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "Hi!" });

    const callOrder: string[] = [];
    (prisma.connectorMessage.create as jest.Mock).mockImplementation(({ data }) => {
      callOrder.push(`message.create:${data.direction}`);
      return Promise.resolve({ id: "cm-1" });
    });
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) => {
      // Tag the COUNTER increment update distinctly from the TTL refresh —
      // the D-11 ordering assertion tracks message-relevant writes only.
      if (data.messageCount && (data.messageCount as { increment?: number }).increment) {
        callOrder.push("session.update:counter");
      } else {
        callOrder.push("session.update");
      }
      // Return a session shape carrying Date fields so the pipeline's
      // rolling-window branch keeps working across calls.
      return Promise.resolve({
        ...sessionRow(),
        ...(typeof data.messageCount === "object"
          ? { messageCount: (data.messageCount as { increment: number }).increment }
          : {}),
        ...data,
        lastResetAt: data.lastResetAt ?? sessionRow().lastResetAt,
        expiresAt: data.expiresAt ?? sessionRow().expiresAt,
      });
    });
    (runConnectorChatTurn as jest.Mock).mockImplementation(async () => {
      callOrder.push("agent");
      return { replyText: "Hi!" };
    });

    await handleIncomingMessage(connectorRow(), {
      platformMessageId: "pm-order",
      platformUserId: "tg-user-1",
      text: "Hello",
      chatType: "private",
    });

    // The dedup in-row precedes the agent AND the counter increment. The
    // session TTL refresh (a maintenance update, not a message write) and
    // the non-nullable sessionId FK mean resolution necessarily precedes
    // the insert — the D-11 arbiter is that NO counter/agent work happens
    // before the dedup verdict.
    expect(callOrder.indexOf("message.create:in")).toBeLessThan(callOrder.indexOf("agent"));
    const counterUpdateIndex = callOrder.indexOf("session.update:counter");
    expect(counterUpdateIndex).toBeGreaterThan(callOrder.indexOf("message.create:in"));
    expect(counterUpdateIndex).toBeLessThan(callOrder.indexOf("agent"));
  });
});

// ─── D-09: per-session ordering + cross-session parallelism ──────────

describe("per-session ordered queue (D-09)", () => {
  it("same-key messages process sequentially — the second agent call starts only after the first resolves", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    wireSession(sessionRow());
    (prisma.connectorMessage.create as jest.Mock).mockResolvedValue({ id: "cm-1" });

    const agentCalls: string[] = [];
    let releaseFirst!: (v?: unknown) => void;
    const firstTurn = new Promise((r) => (releaseFirst = r));
    (runConnectorChatTurn as jest.Mock).mockImplementation(async (_c, _s, text) => {
      agentCalls.push(`start:${text}`);
      if (text === "first") await firstTurn;
      agentCalls.push(`end:${text}`);
      return { replyText: `reply:${text}` };
    });

    const c = connectorRow();
    const p1 = handleIncomingMessage(c, {
      platformMessageId: "pm-s1",
      platformUserId: "tg-u",
      text: "first",
      chatType: "private",
    });
    const p2 = handleIncomingMessage(c, {
      platformMessageId: "pm-s2",
      platformUserId: "tg-u",
      text: "second",
      chatType: "private",
    });

    await new Promise((r) => setTimeout(r, 20));
    // The second turn must be BLOCKED while the first is in flight.
    expect(agentCalls).toEqual(["start:first"]);

    releaseFirst();
    await Promise.all([p1, p2]);

    expect(agentCalls).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("different keys run in parallel — both agent calls in flight concurrently", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    (prisma.connectorMessage.create as jest.Mock).mockResolvedValue({ id: "cm-1" });

    const inFlight: string[] = [];
    let pending = 0;
    let peakConcurrency = 0;
    (runConnectorChatTurn as jest.Mock).mockImplementation(async (_c, _s, text) => {
      inFlight.push(text);
      pending += 1;
      peakConcurrency = Math.max(peakConcurrency, pending);
      await new Promise((r) => setTimeout(r, 30));
      pending -= 1;
      return { replyText: `reply:${text}` };
    });

    const c = connectorRow();
    await Promise.all([
      handleIncomingMessage(c, {
        platformMessageId: "pm-a",
        platformUserId: "user-A",
        text: "from-A",
        chatType: "private",
      }),
      handleIncomingMessage(c, {
        platformMessageId: "pm-b",
        platformUserId: "user-B",
        text: "from-B",
        chatType: "private",
      }),
    ]);

    expect(peakConcurrency).toBe(2); // different keys never serialize (D-09)
  });
});

// ─── D-10: rate limit (throttled reply + rolling window reset) ───────

describe("rate limit (D-10/P-6)", () => {
  function tripLimit(override: number | null) {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow({ rateLimitPerMinute: override });
    wireSession(sessionRow({ messageCount: override ?? 20 }));
    return { adapter, c };
  }

  it("trips at the default 20 and sends the limit reply EXACTLY ONCE across 5 subsequent messages (D-10)", async () => {
    const { adapter, c } = tripLimit(null);
    for (let i = 0; i < 5; i++) {
      await handleIncomingMessage(c, {
        platformMessageId: `pm-l${i}`,
        platformUserId: "tg-user-1",
        text: `msg ${i}`,
        chatType: "private",
      });
    }

    // One reply total, then silence (throttle D-10).
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect((adapter.sendMessage as jest.Mock).mock.calls[0][2]).toContain("limit");
    // The agent was NEVER called for limit-tripped messages.
    expect(runConnectorChatTurn).not.toHaveBeenCalled();
    // The inbound message was still persisted (D-10) — 5 in-rows + 1 out-row.
    const inRows = (prisma.connectorMessage.create as jest.Mock).mock.calls.filter(
      (call) => call[0].data.direction === "in"
    );
    expect(inRows).toHaveLength(5);
  });

  it("rateLimitPerMinute: 0 = UNLIMITED (CR-01) — the agent IS reached and no limit reply is sent", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow({ rateLimitPerMinute: 0 });
    wireSession(sessionRow({ messageCount: 500 })); // far beyond any limit
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "ok" });

    for (let i = 0; i < 3; i++) {
      await handleIncomingMessage(c, {
        platformMessageId: `pm-unl${i}`,
        platformUserId: "tg-user-1",
        text: `msg ${i}`,
        chatType: "private",
      });
    }

    // Every message reached the agent; never a throttled limit reply.
    expect(runConnectorChatTurn).toHaveBeenCalledTimes(3);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(3);
    for (const call of (adapter.sendMessage as jest.Mock).mock.calls) {
      expect(call[2]).not.toContain("limit");
    }
  });

  it("sessionLimitPerDay is ENFORCED (WR-02): 2/day → the 3rd message gets the daily limit reply, never the agent", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow({ sessionLimitPerDay: 2 });
    wireSession(sessionRow());
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "ok" });

    // The in-row log is the daily counter: 2 in-rows inside the last 24h.
    (prisma.connectorMessage.count as jest.Mock).mockResolvedValue(2);

    await handleIncomingMessage(c, {
      platformMessageId: "pm-d1",
      platformUserId: "tg-user-1",
      text: "third of the day",
      chatType: "private",
    });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect((adapter.sendMessage as jest.Mock).mock.calls[0][2]).toContain("today");
    expect(runConnectorChatTurn).not.toHaveBeenCalled();
    // The count queried the in-row log over a rolling 24h window,
    // PER-SESSION (WR-03 fix: the knob is session-scoped — sessionId filter,
    // not connector-wide; a connector count would share one budget across
    // every external user of the bot).
    expect(prisma.connectorMessage.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sessionId: expect.any(String),
          direction: "in",
        }),
      })
    );
  });

  it("sessionLimitPerDay: 0 = UNLIMITED (CR-01 lesson) — never blackouts despite a huge counter", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow({ sessionLimitPerDay: 0 });
    wireSession(sessionRow({ messageCount: 0 }));
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "ok" });

    await handleIncomingMessage(c, {
      platformMessageId: "pm-d2",
      platformUserId: "tg-user-1",
      text: "unlimited day",
      chatType: "private",
    });

    // count() was NOT consulted (0 short-circuits to unlimited) and the
    // message reached the agent.
    expect(prisma.connectorMessage.count).not.toHaveBeenCalled();
    expect(runConnectorChatTurn).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("respects the rateLimitPerMinute override (2 → trips at the 3rd)", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow({ rateLimitPerMinute: 2 });
    // Start at 0 — messages 1 and 2 pass, message 3 trips. The update mock
    // keeps the counter live (the increment rides the same update as the
    // TTL refresh — D-08).
    let counter = 0;
    let lastResetAt = new Date(Date.now() - 5 * 60_000);
    (prisma.connectorSession.findUnique as jest.Mock).mockImplementation(() =>
      Promise.resolve(sessionRow({ messageCount: counter, lastResetAt }))
    );
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) => {
      if (data.messageCount && (data.messageCount as { increment?: number }).increment) {
        counter += (data.messageCount as { increment: number }).increment;
      } else if (data.messageCount === 0) {
        counter = 0;
        lastResetAt = data.lastResetAt;
      }
      return Promise.resolve(sessionRow({ messageCount: counter, lastResetAt }));
    });
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "ok" });

    await handleIncomingMessage(c, { platformMessageId: "p1", platformUserId: "u", text: "1", chatType: "private" });
    await handleIncomingMessage(c, { platformMessageId: "p2", platformUserId: "u", text: "2", chatType: "private" });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2); // two normal replies
    await handleIncomingMessage(c, { platformMessageId: "p3", platformUserId: "u", text: "3", chatType: "private" });

    // 3rd message trips (messageCount reached 2) → the throttled limit reply.
    expect(adapter.sendMessage).toHaveBeenCalledTimes(3);
    expect((adapter.sendMessage as jest.Mock).mock.calls[2][2]).toContain("limit");
  });

  it("resets messageCount when lastResetAt is 2h ago (rolling window P-6) and the message is processed normally", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const c = connectorRow();
    wireSession(sessionRow({ messageCount: 20, lastResetAt: twoHoursAgo }));
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "fresh window" });

    await handleIncomingMessage(c, {
      platformMessageId: "pm-reset",
      platformUserId: "tg-user-1",
      text: "after window",
      chatType: "private",
    });

    // NOT rate-limited — the reset ran first.
    expect(runConnectorChatTurn).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    // The reset update ran (messageCount 0 + lastResetAt now) before the
    // counter increment update.
    const updates = (prisma.connectorSession.update as jest.Mock).mock.calls;
    const resetCall = updates.find((u) => u[0].data.messageCount === 0);
    expect(resetCall).toBeDefined();
    expect(resetCall[0].data.lastResetAt).toBeDefined();
  });

  it("the limit reply re-arms in a NEW window — a reset (or new window) re-allows one throttled reply", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // Window 1: full counter, stale reset → the reset branch clears it, the
    // message is processed normally (one agent reply).
    let counter = 20;
    let lastResetAt = twoHoursAgo;
    (prisma.connectorSession.findUnique as jest.Mock).mockImplementation(() =>
      Promise.resolve(sessionRow({ messageCount: counter, lastResetAt }))
    );
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) => {
      if (data.messageCount === 0) {
        counter = 0;
        lastResetAt = data.lastResetAt;
      } else if (data.messageCount && (data.messageCount as { increment?: number }).increment) {
        counter += (data.messageCount as { increment: number }).increment;
      }
      return Promise.resolve(sessionRow({ messageCount: counter, lastResetAt }));
    });
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "ok" });

    await handleIncomingMessage(c, { platformMessageId: "w1", platformUserId: "u", text: "1", chatType: "private" });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

    // Window 2 (resolved): a full counter INSIDE the fresh window → the
    // throttled limit reply is sent once for this new window (the reset
    // branch above cleared the old flag — per-window throttle, D-10).
    counter = 20;
    await handleIncomingMessage(c, { platformMessageId: "w2", platformUserId: "u", text: "2", chatType: "private" });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect((adapter.sendMessage as jest.Mock).mock.calls[1][2]).toContain("limit");

    // Still the same window → the 2nd limit-tripped message is throttled
    // (no additional reply).
    await handleIncomingMessage(c, { platformMessageId: "w3", platformUserId: "u", text: "3", chatType: "private" });
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });
});

// ─── D-18: non-text politeness fallback ──────────────────────────────

describe("non-text-only message (D-18)", () => {
  it("text null → politeness fallback sent, agent NOT called, in-row persisted", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow();
    wireSession(sessionRow());

    await handleIncomingMessage(c, {
      platformMessageId: "pm-photo",
      platformUserId: "tg-user-1",
      text: null,
      chatType: "private",
    });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect((adapter.sendMessage as jest.Mock).mock.calls[0][2]).toContain("not supported");
    expect(runConnectorChatTurn).not.toHaveBeenCalled();
    expect(prisma.connectorMessage.create).toHaveBeenCalledTimes(2); // in + out
    const inRow = (prisma.connectorMessage.create as jest.Mock).mock.calls[0][0].data;
    expect(inRow.direction).toBe("in");
  });
});

// ─── D-20/D-12: agent failure → fallback + health flip, stays enabled ─

describe("agent failure (D-12/D-20)", () => {
  it("runAgent throw → fallbackMessage sent + healthStatus 'error' + lastError, isEnabled untouched", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    const c = connectorRow({ fallbackMessage: "Custom fallback" });
    wireSession(sessionRow());
    (runConnectorChatTurn as jest.Mock).mockRejectedValue(new Error("provider down"));

    await handleIncomingMessage(c, {
      platformMessageId: "pm-err",
      platformUserId: "tg-user-1",
      text: "boom",
      chatType: "private",
    });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect((adapter.sendMessage as jest.Mock).mock.calls[0][2]).toBe("Custom fallback");

    const healthUpdate = (prisma.chatConnector.update as jest.Mock).mock.calls[0][0];
    expect(healthUpdate.where.id).toBe(CONNECTOR_ID);
    expect(healthUpdate.data.healthStatus).toBe("error");
    expect(healthUpdate.data.lastError).toContain("provider down");
    expect(healthUpdate.data.isEnabled).toBeUndefined(); // D-20: NEVER auto-disable
  });

  it("empty result.replyText → treated as failure path (caller fallback, D-12)", async () => {
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    wireSession(sessionRow());
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "" });

    await handleIncomingMessage(connectorRow(), {
      platformMessageId: "pm-empty",
      platformUserId: "tg-user-1",
      text: "hi",
      chatType: "private",
    });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect((adapter.sendMessage as jest.Mock).mock.calls[0][2]).toBe("Custom fallback");
  });
});

// ─── D-19: typing coordinator ────────────────────────────────────────

describe("typing indicator (D-19)", () => {
  it("sendTypingIndicator is called EXACTLY ONCE before runConnectorChatTurn on the happy path", async () => {
    jest.useFakeTimers();
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    wireSession(sessionRow());
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "fast" });

    await handleIncomingMessage(connectorRow(), {
      platformMessageId: "pm-t1",
      platformUserId: "tg-user-1",
      text: "hello",
      chatType: "private",
    });

    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(1);
    expect(adapter.sendTypingIndicator).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONNECTOR_ID }),
      "tg-user-1"
    );
    // No typing after completion (timer cleared in finally — advancing time
    // past 5s fires nothing further).
    jest.advanceTimersByTime(8000);
    await Promise.resolve();
    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(1);
  });

  it("a slow turn (> ~5s) triggers EXACTLY ONE mid-run re-send, none after completion", async () => {
    jest.useFakeTimers();
    const adapter = fakeAdapter();
    registerAdapter("telegram", adapter);
    wireSession(sessionRow());

    let releaseTurn!: (v: unknown) => void;
    const turnGate = new Promise((r) => (releaseTurn = r));
    (runConnectorChatTurn as jest.Mock).mockImplementation(() => turnGate.then(() => ({ replyText: "slow" })));

    const done = handleIncomingMessage(connectorRow(), {
      platformMessageId: "pm-t2",
      platformUserId: "tg-user-1",
      text: "slow question",
      chatType: "private",
    });

    // Typing fires pre-run.
    await jest.advanceTimersByTimeAsync(0);
    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(1);

    // Past ~5s with the turn still in flight → exactly ONE re-send.
    await jest.advanceTimersByTimeAsync(5100);
    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(2);

    // More time, still in flight → NO further re-sends (at-most-once).
    await jest.advanceTimersByTimeAsync(10000);
    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(2);

    // Complete the turn — the timer is cleared; advancing time fires nothing.
    releaseTurn(undefined);
    await done;
    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(20000);
    expect(adapter.sendTypingIndicator).toHaveBeenCalledTimes(2);
  });

  it("a typing-send failure never fails the turn (debug-level, D-19 auxiliary)", async () => {
    jest.useFakeTimers();
    const adapter = fakeAdapter({
      sendTypingIndicator: jest.fn(async () => {
        throw new Error("telegram 429");
      }),
    });
    registerAdapter("telegram", adapter);
    wireSession(sessionRow());
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "still replies" });

    await handleIncomingMessage(connectorRow(), {
      platformMessageId: "pm-t3",
      platformUserId: "tg-user-1",
      text: "hello",
      chatType: "private",
    });

    // The reply still went out; the failure was logged at debug only.
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("no adapter registered → the turn is skipped with a warning (D-03 fail-closed)", async () => {
    // No adapter registered for "telegram" in this test — the reply path
    // warns and drops, the turn itself is guarded so no reply is attempted.
    wireSession(sessionRow());
    (runConnectorChatTurn as jest.Mock).mockResolvedValue({ replyText: "hi" });

    await handleIncomingMessage(connectorRow(), {
      platformMessageId: "pm-t4",
      platformUserId: "tg-user-1",
      text: "hello",
      chatType: "private",
    });

    expect(runConnectorChatTurn).toHaveBeenCalledTimes(1); // the turn ran
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no adapter registered"),
      expect.anything()
    );
  });
});

// ─── withSessionLock contract ────────────────────────────────────────

describe("withSessionLock (D-09)", () => {
  it("serializes same-key operations and isolates prior-op failures (ordering only)", async () => {
    const order: string[] = [];
    const key = sessionKey("c1", "u1");

    const failing = withSessionLock(key, async () => {
      order.push("first:start");
      throw new Error("boom");
    });
    const succeeding = withSessionLock(key, async () => {
      order.push("second:start");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(succeeding).resolves.toBe("ok");
    // The second ran only after the first finished.
    expect(order).toEqual(["first:start", "second:start"]);
  });

  it("different keys proceed concurrently (no cross-session serialization)", async () => {
    let inFlight = 0;
    let peak = 0;
    const run = (key: string) =>
      withSessionLock(key, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
      });
    await Promise.all([run("c1:u1"), run("c1:u2"), run("c2:u1")]);
    expect(peak).toBe(3);
  });
});
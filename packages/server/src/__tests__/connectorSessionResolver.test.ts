// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 198 (198-02 Task 1, D-08) — connector session resolver tests.
 * Postgres-free: prisma mocked per the existing server-test mock layer.
 */
// @ts-nocheck
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const mock = createMockPrisma();
  (mock.prisma as any).connectorSession = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  (mock.prisma as any).chat = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  (mock.prisma as any).workspace = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/seedService", () => ({
  seedServiceAccount: jest.fn(),
}));

import prisma from "../utils/prisma";
import {
  resolveSession,
  resetServiceAccountIdCache,
} from "../services/connectors/sessionResolver";
import { withSessionLock } from "../services/connectors/messageRouter";

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-4466554400a1";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-4466554400a2";
const ORG_ID = "org-198";
const CHAT_ID = "chat-198-a";
const SERVICE_ACCOUNT_ID = "svc-account-198";

const connector = { id: CONNECTOR_ID, workspaceId: WORKSPACE_ID, platform: "telegram" };
const discordConnector = { id: CONNECTOR_ID, workspaceId: WORKSPACE_ID, platform: "discord" };

function sessionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "session-198-a",
    connectorId: CONNECTOR_ID,
    platformUserId: "tg-user-1",
    platformUserName: "Alice",
    chatId: CHAT_ID,
    messageCount: 3,
    lastMessageAt: new Date(now.getTime() - 60_000),
    lastResetAt: new Date(now.getTime() - 30 * 60_000),
    expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetServiceAccountIdCache();
  (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: SERVICE_ACCOUNT_ID });
  (prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ organizationId: ORG_ID });
});

// ─── New user: session + Chat created ────────────────────────────────

describe("resolveSession — new (connectorId, platformUserId)", () => {
  it("creates the Chat (titleSource 'user', name truncated to 80, org-stamped from the workspace) and the session (D-08)", async () => {
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.chat.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: CHAT_ID, ...data })
    );
    (prisma.connectorSession.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "session-new", ...data })
    );

    const longName = "x".repeat(100);
    const session = await resolveSession(connector, "tg-user-1", longName);

    // Chat created with D-08 pins.
    expect(prisma.chat.create).toHaveBeenCalledTimes(1);
    const chatData = (prisma.chat.create as jest.Mock).mock.calls[0][0].data;
    expect(chatData.titleSource).toBe("user"); // skips title generation
    expect(chatData.workspaceId).toBe(WORKSPACE_ID);
    expect(chatData.organizationId).toBe(ORG_ID); // resolved from the workspace row
    // Name: "Telegram: <name>" truncated to 80 (100-char input → 80 total).
    expect(chatData.name.startsWith("Telegram: ")).toBe(true);
    expect(chatData.name.length).toBe(80);
    // NO userId column exists on Chat (schema-verified) — ownership rides the
    // service account as the runAgent acting user (connectorChatService).
    expect(chatData.userId).toBeUndefined();

    // Session created pointing at the chat.
    expect(prisma.connectorSession.create).toHaveBeenCalledTimes(1);
    const sessionData = (prisma.connectorSession.create as jest.Mock).mock.calls[0][0].data;
    expect(sessionData.chatId).toBe(CHAT_ID);
    expect(sessionData.connectorId).toBe(CONNECTOR_ID);
    expect(sessionData.platformUserId).toBe("tg-user-1");
    expect(sessionData.messageCount).toBe(0);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    // Service account resolved.
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
      })
    );
  });

  it("falls back to the platform user id in the Chat name when no display name is provided", async () => {
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.chat.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: CHAT_ID, ...data })
    );
    (prisma.connectorSession.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "session-new", ...data })
    );

    await resolveSession(connector, "tg-user-2");

    const chatData = (prisma.chat.create as jest.Mock).mock.calls[0][0].data;
    expect(chatData.name).toBe("Telegram: tg-user-2");
  });
});

// ─── Existing live session: NO new rows, TTL refreshed ───────────────

describe("resolveSession — live session (fast path)", () => {
  it("refreshes expiresAt +24h from NOW and updates platformUserName without creating rows (D-08)", async () => {
    const live = sessionRow();
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(live);
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ ...live, ...data })
    );

    const before = Date.now();
    const session = await resolveSession(connector, "tg-user-1", "Renamed User");

    // NO new rows.
    expect(prisma.connectorSession.create).not.toHaveBeenCalled();
    expect(prisma.chat.create).not.toHaveBeenCalled();

    // One update: rolling TTL + lastMessageAt + platformUserName.
    expect(prisma.connectorSession.update).toHaveBeenCalledTimes(1);
    const data = (prisma.connectorSession.update as jest.Mock).mock.calls[0][0].data;
    // expiresAt ≈ now + 24h (± 1min).
    const expected = before + 24 * 60 * 60 * 1000;
    expect((data.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(expected - 60_000);
    expect((data.expiresAt as Date).getTime()).toBeLessThanOrEqual(expected + 60_000);
    expect(data.lastMessageAt).toBeDefined();
    expect(data.platformUserName).toBe("Renamed User");

    expect(session.chatId).toBe(CHAT_ID);
    expect(session.id).toBe(live.id);
  });

  it("does not rewrite platformUserName when it is unchanged", async () => {
    const live = sessionRow({ platformUserName: "Same" });
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(live);
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ ...live, ...data })
    );

    await resolveSession(connector, "tg-user-1", "Same");

    const data = (prisma.connectorSession.update as jest.Mock).mock.calls[0][0].data;
    expect(data.platformUserName).toBeUndefined();
  });
});

// ─── Expired session: SAME chatId reused (continuity D-08) ───────────

describe("resolveSession — expired session", () => {
  it("reuses the SAME chatId, zeroes the counter, and re-arms the TTL on the existing row (D-08)", async () => {
    const expired = sessionRow({ expiresAt: new Date(Date.now() - 60_000) }); // 1min ago
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(expired);
    (prisma.chat.findUnique as jest.Mock).mockResolvedValue({ id: CHAT_ID });
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ ...expired, ...data })
    );

    const session = await resolveSession(connector, "tg-user-1", "Still Same");

    // Continuity: SAME chatId, NO new chat.
    expect(prisma.chat.create).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CHAT_ID } })
    );

    // The existing row is REPLACED in place (unique-pair contract): fresh
    // TTL, zeroed counter, rolling-window reset via lastResetAt = now.
    expect(prisma.connectorSession.create).not.toHaveBeenCalled();
    const data = (prisma.connectorSession.update as jest.Mock).mock.calls[0][0].data;
    expect(data.chatId).toBe(CHAT_ID);
    expect(data.messageCount).toBe(0);
    expect(data.lastResetAt).toBeDefined();
    expect((data.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(session.chatId).toBe(CHAT_ID);
  });

  it("creates a NEW chat when the prior session's chat was deleted (chatId null via SetNull)", async () => {
    const expired = sessionRow({ expiresAt: new Date(Date.now() - 60_000), chatId: null });
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(expired);
    (prisma.chat.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "chat-fresh", ...data })
    );
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ ...expired, ...data })
    );

    const session = await resolveSession(connector, "tg-user-1");

    expect(prisma.chat.create).toHaveBeenCalledTimes(1);
    expect((prisma.connectorSession.update as jest.Mock).mock.calls[0][0].data.chatId).toBe("chat-fresh");
    expect(session.chatId).toBe("chat-fresh");
  });
});

// ─── D-09: resolution serialized under the caller's lock ─────────────

describe("resolveSession under withSessionLock (D-09 ordering)", () => {
  it("runs session resolution inside the per-session lock — two same-key resolves never overlap the create path", async () => {
    // Deferred promise held by the FIRST chat.create — the second same-key
    // resolve (queued behind the D-09 lock) cannot pass it.
    let releaseFirst!: () => void;
    const gateFirst = new Promise<void>((r) => (releaseFirst = r));

    const order: string[] = [];
    (prisma.connectorSession.findUnique as jest.Mock).mockImplementation(() => {
      order.push("session.findUnique");
      return Promise.resolve(null);
    });
    (prisma.chat.create as jest.Mock).mockImplementation(async ({ data }) => {
      order.push(`chat.create:${data.name}`);
      // The FIRST chat.create holds the gate open — while it is in flight,
      // the second same-key resolve (which awaits the lock) cannot reach
      // its own chat.create.
      if (data.name.includes("First")) await gateFirst;
      return { id: `chat-${data.name}`, ...data };
    });
    (prisma.connectorSession.create as jest.Mock).mockImplementation(({ data }) => {
      order.push(`session.create:${data.platformUserId}`);
      return Promise.resolve({ id: `session-${data.platformUserId}`, ...data });
    });

    const key = `${CONNECTOR_ID}:tg-user-lock`;

    const first = withSessionLock(key, () => resolveSession(connector, "tg-user-lock", "First"));
    const second = withSessionLock(key, () => resolveSession(connector, "tg-user-lock", "Second"));

    // Give the event loop a tick — the second resolve must NOT have started
    // (no chat.create for "Second") while the first is in flight.
    await new Promise((r) => setTimeout(r, 10));
    expect(order.filter((o) => o.startsWith("chat.create:Telegram: Second"))).toHaveLength(0);

    releaseFirst();
    await Promise.all([first, second]);

    // Both completed; the second's chat.create ran strictly after the first's.
    const chatCreates = order.filter((o) => o.startsWith("chat.create"));
    expect(chatCreates).toHaveLength(2);
    expect(chatCreates[0]).toContain("First");
    expect(chatCreates[1]).toContain("Second");
  });
});

// ─── Phase 199 (Pitfall-6 fix): platform prefix derives from connector.platform ─

describe("resolveSession — Phase 199 platform-derived chat name (Pitfall-6 fix)", () => {
  it("a platform-'discord' connector names its first-contact Chat 'Discord: <platformUserName>'", async () => {
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.chat.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: CHAT_ID, ...data })
    );
    (prisma.connectorSession.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "session-discord", ...data })
    );

    await resolveSession(discordConnector, "dm-channel-77", "Dave");

    const chatData = (prisma.chat.create as jest.Mock).mock.calls[0][0].data;
    expect(chatData.name).toBe("Discord: Dave");
  });

  it("a platform-'discord' connector falls back to the platformUserId in the Chat name when no display name is provided", async () => {
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.chat.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: CHAT_ID, ...data })
    );
    (prisma.connectorSession.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "session-discord", ...data })
    );

    await resolveSession(discordConnector, "dm-channel-88");

    const chatData = (prisma.chat.create as jest.Mock).mock.calls[0][0].data;
    expect(chatData.name).toBe("Discord: dm-channel-88");
  });

  it("telegram fixtures are byte-identical post-fix — the prefix derives from connector.platform, not a literal", async () => {
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.chat.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: CHAT_ID, ...data })
    );
    (prisma.connectorSession.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "session-new", ...data })
    );

    const session = await resolveSession(connector, "tg-user-1", "Alice");

    const chatData = (prisma.chat.create as jest.Mock).mock.calls[0][0].data;
    expect(chatData.name.startsWith("Telegram: ")).toBe(true);
    expect(session.created).toBe(true);
  });
});

// ─── Phase 199 (OQ-1/D-08): the created flag ─────────────────────────

describe("resolveSession — created flag (Phase 199 OQ-1)", () => {
  it("a first-ever create returns created === true", async () => {
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.chat.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: CHAT_ID, ...data })
    );
    (prisma.connectorSession.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ id: "session-new", ...data })
    );

    const session = await resolveSession(connector, "tg-user-1", "Alice");

    expect(session.created).toBe(true);
    expect(prisma.connectorSession.create).toHaveBeenCalledTimes(1);
  });

  it("the fast-path refresh returns created === false", async () => {
    const live = sessionRow();
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(live);
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ ...live, ...data })
    );

    const session = await resolveSession(connector, "tg-user-1", "Renamed User");

    expect(session.created).toBe(false);
    expect(prisma.connectorSession.create).not.toHaveBeenCalled();
  });

  it("the expired-session recreate path returns created === false (continuity is not a new identity)", async () => {
    const expired = sessionRow({ expiresAt: new Date(Date.now() - 60_000) });
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(expired);
    (prisma.chat.findUnique as jest.Mock).mockResolvedValue({ id: CHAT_ID });
    (prisma.connectorSession.update as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({ ...expired, ...data })
    );

    const session = await resolveSession(connector, "tg-user-1", "Returning User");

    // Recreated (update path) — but NOT a first contact.
    expect(prisma.connectorSession.create).not.toHaveBeenCalled();
    expect(session.created).toBe(false);
  });
});
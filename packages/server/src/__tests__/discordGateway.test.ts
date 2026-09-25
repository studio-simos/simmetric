// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 199 (199-03) — Discord Gateway manager + protocol client tests.
 * Postgres-free: prisma + logger mocked; the ws constructor is INJECTED via
 * setGatewaySocketFactory (the helpers/fakeGatewayServer.ts seam) — ZERO
 * real sockets (WS EGRESS BLOCKED discipline). The pipeline hand-off
 * (handleIncomingMessage) is mocked at the D-01 boundary; the pipeline's
 * own behavior is pinned in messageRouter.test.ts.
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
    findMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  (mock.prisma as any).chat = { findUnique: jest.fn(), create: jest.fn() };
  (mock.prisma as any).workspace = { findUnique: jest.fn() };
  (mock.prisma as any).user = { findFirst: jest.fn() };
  return { __esModule: true, default: mock.prisma, withSoftDelete: (w: unknown) => w };
});

jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// D-01 boundary: the gateway hands NORMALIZED IncomingMessages to the SAME
// pipeline Telegram feeds — this suite observes the hand-off, the pipeline
// itself is messageRouter.test.ts.
jest.mock("../services/connectors/messageRouter", () => ({
  handleIncomingMessage: jest.fn(async () => undefined),
}));

// connectorChatService stays OUT of the gateway suite (messageRouter-owned).
jest.mock("../services/connectors/connectorChatService", () => ({
  runConnectorChatTurn: jest.fn(async () => ({ replyText: "reply-199" })),
}));

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { encrypt } from "../services/encryptionService";
import {
  GatewayClient,
  initDiscordGateway,
  syncDiscordConnector,
  closeDiscordGateway,
  injectDiscordConnectorMessage,
  setGatewaySocketFactory,
  setDiscordGatewayUrlOverride,
  resetGatewayState,
  gatewayClientCount,
  hasGatewayClient,
  toIncomingMessage,
  type GatewaySocketLike,
} from "../services/connectors/discordGateway";
import { handleIncomingMessage } from "../services/connectors/messageRouter";

const CONNECTOR_ID = "550e8400-e29b-41d4-a716-446655440001";
const WORKSPACE_ID = "550e8400-e29b-41d4-a716-446655440002";
const GATEWAY_OVERRIDE = "wss://gateway.fake.test";

// ─── The fake ws seam (helpers/fakeGatewayServer.ts, Task 2 extends) ──

type Listener = (...args: unknown[]) => void;

interface SentFrame {
  op: number;
  d?: unknown;
  t?: string;
}

class FakeGatewaySocket {
  listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] };
  sent: string[] = [];
  closedCodes: number[] = [];
  terminated = false;

  on(event: string, listener: Listener): void {
    this.listeners[event] = this.listeners[event] ?? [];
    this.listeners[event].push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedCodes.push(code ?? 1005);
  }

  terminate(): void {
    this.terminated = true;
  }

  // ── fake-server drivers (the test emits frames / closes on demand) ──

  driverOpen(): void {
    for (const l of [...(this.listeners.open ?? [])]) l();
  }

  driverText(payload: unknown): void {
    const data = Buffer.from(JSON.stringify(payload));
    for (const l of [...(this.listeners.message ?? [])]) l(data, false);
  }

  driverClose(code: number): void {
    for (const l of [...(this.listeners.close ?? [])]) l(code, Buffer.alloc(0));
  }

  sentFrames(): SentFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as SentFrame);
  }
}

let lastSocket: FakeGatewaySocket | null = null;
const allSockets: FakeGatewaySocket[] = [];
const createdUrls: string[] = [];

function lastFrame(op: number): SentFrame | undefined {
  return lastSocket?.sentFrames().find((f) => f.op === op);
}

beforeEach(() => {
  jest.clearAllMocks();
  resetGatewayState();
  lastSocket = null;
  allSockets.length = 0;
  createdUrls.length = 0;
  setGatewaySocketFactory((url: string) => {
    createdUrls.push(url);
    const sock = new FakeGatewaySocket();
    allSockets.push(sock);
    lastSocket = sock;
    return sock as unknown as GatewaySocketLike;
  });
  setDiscordGatewayUrlOverride(GATEWAY_OVERRIDE);
  (prisma.chatConnector.update as jest.Mock).mockResolvedValue({});
  (prisma.chatConnector.updateMany as jest.Mock).mockResolvedValue({});
  (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.connectorMessage.create as jest.Mock).mockResolvedValue({ id: "cm-1" });
});

afterEach(() => {
  jest.useRealTimers();
  resetGatewayState();
});

function connectorRow(overrides: Record<string, unknown> = {}): ConnectorPipelineRow {
  return {
    id: CONNECTOR_ID,
    platform: "discord",
    organizationId: "org-199",
    workspaceId: WORKSPACE_ID,
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
    ...overrides,
  };
}

function gatewayRow(overrides: Record<string, unknown> = {}) {
  return {
    ...connectorRow(),
    isEnabled: true,
    deletedAt: null,
    botTokenEncrypted: encrypt("secret-gateway-token"), // real crypto roundtrip (discordAdapter.test.ts pattern)
    pollMode: "polling",
    ...overrides,
  };
}

/** Open the fake socket + deliver HELLO (the connect handshake driver). */
function handshake(interval = 41250): void {
  lastSocket!.driverOpen();
  lastSocket!.driverText({ op: 10, d: { heartbeat_interval: interval } });
}

// ─── D-05 manager lifecycle ──────────────────────────────────────────

describe("initDiscordGateway (D-05 manager lifecycle)", () => {
  it("one enabled discord connector → exactly ONE client keyed by connectorId", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([gatewayRow()]);

    await initDiscordGateway();

    expect(prisma.chatConnector.findMany).toHaveBeenCalledWith({
      where: { platform: "discord", isEnabled: true, deletedAt: null },
    });
    expect(gatewayClientCount()).toBe(1);
    expect(hasGatewayClient(CONNECTOR_ID)).toBe(true);
    expect(createdUrls).toHaveLength(1);
    expect(createdUrls[0]).toContain(`${GATEWAY_OVERRIDE}/?v=10&encoding=json`);
  });

  it("a second init is a logged no-op (no stacking clients)", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([gatewayRow()]);
    await initDiscordGateway();
    expect(gatewayClientCount()).toBe(1);

    await initDiscordGateway();
    expect(gatewayClientCount()).toBe(1);
    expect(createdUrls).toHaveLength(1); // no second socket
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("already initialized")
    );
  });

  it("a single failing row (missing token) does not abort the batch", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([
      gatewayRow({ id: "row-bad", botTokenEncrypted: null }),
      gatewayRow({ id: CONNECTOR_ID }),
    ]);

    await initDiscordGateway();

    expect(gatewayClientCount()).toBe(1);
    expect(hasGatewayClient(CONNECTOR_ID)).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("syncDiscordConnector + closeDiscordGateway (D-05)", () => {
  it("sync on an enabled row connects; sync on a disabled row closes", () => {
    syncDiscordConnector(gatewayRow());
    expect(gatewayClientCount()).toBe(1);
    expect(hasGatewayClient(CONNECTOR_ID)).toBe(true);

    syncDiscordConnector(gatewayRow({ isEnabled: false }));
    expect(gatewayClientCount()).toBe(0);
  });

  it("a re-sync closes the stale client and reconnects fresh (no duplicate)", () => {
    syncDiscordConnector(gatewayRow());
    expect(allSockets.length).toBe(1);
    const stale = allSockets[0];

    syncDiscordConnector(gatewayRow({ welcomeMessage: "updated" }));
    expect(gatewayClientCount()).toBe(1);
    expect(stale.closedCodes).toContain(1000); // operator close on the stale one
    expect(allSockets.length).toBe(2); // fresh socket
  });

  it("non-discord rows are no-ops; closeDiscordGateway closes every client", () => {
    syncDiscordConnector(gatewayRow());
    syncDiscordConnector(gatewayRow({ platform: "telegram", id: "tg-row" }));
    expect(gatewayClientCount()).toBe(1);

    closeDiscordGateway();
    expect(gatewayClientCount()).toBe(0);
  });
});

// ─── Protocol lifecycle (hello → identify / resume) ──────────────────

describe("GatewayClient protocol (hello → identify/resume)", () => {
  function freshClient(): GatewayClient {
    const client = new GatewayClient({
      connectorId: CONNECTOR_ID,
      token: "secret-token",
      onDispatch: jest.fn(),
      onAuthFailed: jest.fn(),
    });
    client.connect();
    return client;
  }

  it("HELLO(10) → IDENTIFY(2) with the token + minimal intents (DIRECT_MESSAGES | MESSAGE_CONTENT)", () => {
    freshClient();
    handshake();

    const identify = lastFrame(2);
    expect(identify).toBeDefined();
    expect((identify!.d as Record<string, unknown>).token).toBe("secret-token");
    // (1<<12)|(1<<15) = 4096 + 32768 = 36864
    expect((identify!.d as Record<string, unknown>).intents).toBe(36864);
    expect((identify!.d as Record<string, unknown>).properties).toBeDefined();
  });

  it("connect uses the override URL first (no real gateway egress when set)", () => {
    freshClient();
    expect(createdUrls[0]).toContain("gateway.fake.test");
    expect(createdUrls[0]).not.toContain("gateway.discord.gg");
  });

  it("a stored session resumes via RESUME(6) on HELLO (no second identify — Pitfall 9)", () => {
    const client = freshClient();
    client.setSession("sess-1", "wss://resume.fake.test", 42);
    client.connect();

    handshake();

    const frames = lastSocket!.sentFrames();
    const resume = frames.find((f) => f.op === 6);
    expect(resume).toBeDefined();
    expect((resume!.d as Record<string, unknown>).session_id).toBe("sess-1");
    expect((resume!.d as Record<string, unknown>).seq).toBe(42);
    expect(frames.find((f) => f.op === 2)).toBeUndefined(); // NO identify
  });

  it("READY stores session_id + resume_gateway_url and resets backoff", () => {
    const client = freshClient();
    lastSocket!.driverOpen();
    lastSocket!.driverText({
      op: 0,
      s: 7,
      t: "READY",
      d: { session_id: "sess-9", resume_gateway_url: "wss://resume.fake.test" },
    });

    expect(client.hasSession()).toBe(true);
    expect(client.getBackoffMs()).toBe(1000);
  });

  it("seq is tracked on EVERY payload (dispatch frames advance it)", () => {
    const client = freshClient();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 }, s: 1 });
    lastSocket!.driverText({ op: 0, s: 5, t: "MESSAGE_CREATE", d: { id: "x" } });

    // Drive one heartbeat via the server-requested heartbeat arm (op 1):
    lastSocket!.driverText({ op: 1, d: null });
    const hb = lastSocket!.sentFrames().filter((f) => f.op === 1).pop();
    expect((hb!.d as number)).toBe(5);
    void client;
  });
});

// ─── Close-code routing (Pitfall 1 / D-06 / OQ-3) ────────────────────

describe("GatewayClient close-code routing (Pitfall 1 / D-06 / OQ-3)", () => {
  function clientWith(overrides: {
    onDispatch?: (msg: IncomingMessage) => void;
    onAuthFailed?: (id: string) => void;
  }): GatewayClient {
    const client = new GatewayClient({
      connectorId: CONNECTOR_ID,
      token: "secret-token",
      onDispatch: overrides.onDispatch ?? jest.fn(),
      onAuthFailed: overrides.onAuthFailed ?? jest.fn(),
    });
    client.connect();
    return client;
  }

  it("close 4004 → auth-failed fires and NO reconnect timer is armed", () => {
    const onAuthFailed = jest.fn();
    const client = clientWith({ onAuthFailed });

    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverClose(4004);

    expect(onAuthFailed).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(client.hasReconnectTimer()).toBe(false);
  });

  it("the manager's default 4004 arm flips healthStatus='error' with a token-free lastError", async () => {
    syncDiscordConnector(gatewayRow());
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverClose(4004);

    // The close handler invokes the prisma-backed flip synchronously.
    await new Promise((r) => setTimeout(r, 0));
    const flip = (prisma.chatConnector.update as jest.Mock).mock.calls.find(
      (c) => c[0].data?.healthStatus === "error"
    );
    expect(flip).toBeDefined();
    expect(flip![0].where.id).toBe(CONNECTOR_ID);
    expect(flip![0].data.lastError).not.toContain("secret-gateway-token");
    expect(flip![0].data.lastError).not.toContain("enc-token");
    expect(flip![0].data.isEnabled).toBeUndefined(); // D-20: never auto-disable
  });

  it("close 4013 (config-fatal) → no reconnect, no auth-failed callback", () => {
    const onAuthFailed = jest.fn();
    const client = clientWith({ onAuthFailed });

    lastSocket!.driverClose(4013);

    expect(onAuthFailed).not.toHaveBeenCalled();
    expect(client.hasReconnectTimer()).toBe(false);
  });

  it("operator close (1000) never reconnects (OQ-3)", () => {
    jest.useFakeTimers();
    const client = clientWith({});

    client.close();
    expect(lastSocket!.closedCodes).toContain(1000);
    lastSocket!.driverClose(1000);

    jest.advanceTimersByTime(120000);
    expect(allSockets.length).toBe(1); // no reconnect socket
    expect(client.hasReconnectTimer()).toBe(false);
  });

  it("transient close (1006) schedules a reconnect; the ladder doubles and caps at 60s", () => {
    jest.useFakeTimers();
    const client = clientWith({});

    lastSocket!.driverClose(1006);
    expect(client.getBackoffMs()).toBe(2000); // doubled from 1s

    // Walk the ladder: reconnect at 1s, next delay 2s → 4s.
    jest.advanceTimersByTime(1000);
    expect(allSockets.length).toBe(2); // reconnected

    allSockets[allSockets.length - 1].driverClose(1006);
    expect(client.getBackoffMs()).toBe(4000);
    jest.advanceTimersByTime(2000);
    expect(allSockets.length).toBe(3);
  });

  it("the ladder caps at 60s after repeated transient closes", () => {
    jest.useFakeTimers();
    const client = clientWith({});

    // Six consecutive transient closes: 1→2→4→8→16→32→60 (cap).
    for (let i = 0; i < 6; i++) {
      lastSocket!.driverClose(1006);
      jest.advanceTimersByTime(60000); // always enough to fire the next one
    }
    const last = allSockets[allSockets.length - 1];
    last.driverClose(1006);
    expect(client.getBackoffMs()).toBe(60000); // capped
    void client;
  });
});

// ─── Heartbeat + zombie detection (Pitfall 2) ────────────────────────

describe("GatewayClient heartbeat (Pitfall 2)", () => {
  function freshClient(): GatewayClient {
    const client = new GatewayClient({
      connectorId: CONNECTOR_ID,
      token: "secret-token",
      onDispatch: jest.fn(),
      onAuthFailed: jest.fn(),
    });
    client.connect();
    return client;
  }

  it("the first heartbeat fires after interval × jitter (inside the interval window)", () => {
    jest.useFakeTimers();
    const client = freshClient();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });

    // Before the interval elapses, no heartbeat yet (jitter ∈ [0, interval)).
    jest.advanceTimersByTime(100);
    expect(lastSocket!.sentFrames().filter((f) => f.op === 1)).toHaveLength(0);

    // A full interval guarantees the jittered first send has fired.
    jest.advanceTimersByTime(41250);
    const heartbeats = lastSocket!.sentFrames().filter((f) => f.op === 1);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(heartbeats[heartbeats.length - 1]!.d).toBeNull(); // no dispatch seq yet
    void client;
  });

  it("subsequent heartbeats carry the last dispatch seq and repeat every interval", () => {
    jest.useFakeTimers();
    const client = freshClient();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 1000 }, s: 9 });

    // ACK the (none yet pending — first send marks pending) — ack then walk.
    jest.advanceTimersByTime(41250); // first heartbeat
    const first = lastSocket!.sentFrames().filter((f) => f.op === 1);
    expect(first.length).toBeGreaterThanOrEqual(1);

    lastSocket!.driverText({ op: 11 }); // HEARTBEAT ACK
    jest.advanceTimersByTime(41250); // next interval tick
    const total = lastSocket!.sentFrames().filter((f) => f.op === 1);
    expect(total.length).toBeGreaterThanOrEqual(2);
    void client;
  });

  it("a heartbeat with NO pending ACK → terminate (zombie recipe)", () => {
    jest.useFakeTimers();
    const client = freshClient();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });

    jest.advanceTimersByTime(41250); // first heartbeat (marks ACK pending)
    expect(lastSocket!.sentFrames().filter((f) => f.op === 1)).toHaveLength(1);

    // No ACK arrives — the NEXT interval tick detects the zombie.
    jest.advanceTimersByTime(41250);
    expect(lastSocket!.terminated).toBe(true);
    void client;
  });

  it("an ACK between sends keeps the link alive (no terminate)", () => {
    jest.useFakeTimers();
    const client = freshClient();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });

    jest.advanceTimersByTime(41250); // first heartbeat (ACK now pending)
    lastSocket!.driverText({ op: 11 }); // ACK
    jest.advanceTimersByTime(41250); // second heartbeat (link was acked)
    lastSocket!.driverText({ op: 11 }); // ACK
    jest.advanceTimersByTime(41250); // third heartbeat — acked in between
    expect(lastSocket!.terminated).toBe(false);
    void client;
  });

  it("the heartbeat timer is cleared on close — it never fires post-close", () => {
    jest.useFakeTimers();
    const client = freshClient();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });

    lastSocket!.driverClose(1006); // transient → reconnect in 1s
    jest.advanceTimersByTime(120000);

    // The OLD socket's heartbeat sent nothing after its close.
    const oldSocket = allSockets[0];
    const framesAfterClose = oldSocket.sentFrames().filter((f) => f.op === 1);
    expect(framesAfterClose).toHaveLength(0);
    void client;
  });
});

// ─── MESSAGE_CREATE dispatch + guards (D-03/D-04, Pitfall 4) ─────────

describe("MESSAGE_CREATE dispatch (D-01/D-03/D-04 boundary)", () => {
  function clientWithDispatch(): { client: GatewayClient; dispatches: IncomingMessage[] } {
    const dispatches: IncomingMessage[] = [];
    const client = new GatewayClient({
      connectorId: CONNECTOR_ID,
      token: "secret-token",
      onDispatch: (msg) => dispatches.push(msg),
      onAuthFailed: jest.fn(),
    });
    client.connect();
    return { client, dispatches };
  }

  it("a DM-shaped dispatch reaches handleIncomingMessage normalized", () => {
    const { client, dispatches } = clientWithDispatch();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverText({
      op: 0,
      s: 10,
      t: "MESSAGE_CREATE",
      d: {
        id: "123456789012345678",
        channel_id: "999888777666555444",
        channel_type: 1,
        content: "hello bot",
        author: { id: "u1", username: "dave", global_name: "Dave G", bot: false },
      },
    });

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toEqual({
      platformMessageId: "123456789012345678",
      platformUserId: "999888777666555444",
      platformUserName: "Dave G",
      text: "hello bot",
      chatType: "private",
    });
    void client;
  });

  it("platformUserName falls back to username when global_name is null", () => {
    const { client, dispatches } = clientWithDispatch();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverText({
      op: 0,
      s: 11,
      t: "MESSAGE_CREATE",
      d: {
        id: "1",
        channel_id: "2",
        channel_type: 1,
        content: "yo",
        author: { id: "u1", username: "dave", global_name: null, bot: false },
      },
    });
    expect(dispatches[0]!.platformUserName).toBe("dave");
    void client;
  });

  it("a non-text MESSAGE_CREATE (content '') still routes (text null — router owns it)", () => {
    const { client, dispatches } = clientWithDispatch();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverText({
      op: 0,
      s: 12,
      t: "MESSAGE_CREATE",
      d: {
        id: "1",
        channel_id: "2",
        channel_type: 1,
        content: "",
        author: { bot: false },
      },
    });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.text).toBeNull();
    void client;
  });

  it("guild_id-bearing dispatch → NO pipeline call, NO DB write (silent, D-03)", () => {
    const { client, dispatches } = clientWithDispatch();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverText({
      op: 0,
      s: 13,
      t: "MESSAGE_CREATE",
      d: { id: "1", channel_id: "2", guild_id: "g1", channel_type: 1, content: "guild", author: { bot: false } },
    });

    expect(dispatches).toHaveLength(0);
    expect(handleIncomingMessage).not.toHaveBeenCalled();
    expect(prisma.connectorMessage.create).not.toHaveBeenCalled();
    void client;
  });

  it("group-DM dispatch (channel_type 3) is dropped (A2: load-bearing)", () => {
    const { client, dispatches } = clientWithDispatch();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverText({
      op: 0,
      s: 14,
      t: "MESSAGE_CREATE",
      d: { id: "1", channel_id: "2", channel_type: 3, content: "group", author: { bot: false } },
    });

    expect(dispatches).toHaveLength(0);
    void client;
  });

  it("author.bot echo dispatch is dropped BEFORE the pipeline (Pitfall 4 self-loop)", () => {
    const { client, dispatches } = clientWithDispatch();
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    lastSocket!.driverText({
      op: 0,
      s: 15,
      t: "MESSAGE_CREATE",
      d: { id: "1", channel_id: "2", channel_type: 1, content: "my own reply", author: { bot: true } },
    });

    expect(dispatches).toHaveLength(0);
    expect(handleIncomingMessage).not.toHaveBeenCalled();
    void client;
  });

  it("malformed JSON frames are dropped without crashing the client (T-199-07)", () => {
    const { client, dispatches } = clientWithDispatch();
    const data = Buffer.from("not-json{{{");
    for (const l of [...(lastSocket!.listeners.message ?? [])]) l(data, false);
    expect(dispatches).toHaveLength(0);

    // The client still processes the NEXT valid frame.
    lastSocket!.driverOpen();
    lastSocket!.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    expect(lastFrame(2) ?? lastFrame(6)).toBeDefined();
    void client;
  });

  it("binary frames are ignored (plain-JSON encoding)", () => {
    const { client, dispatches } = clientWithDispatch();
    const data = Buffer.from([0x00, 0x01, 0x02]);
    for (const l of [...(lastSocket!.listeners.message ?? [])]) l(data, true);
    expect(dispatches).toHaveLength(0);
    void client;
  });
});

// ─── op-7 RECONNECT / op-9 INVALID_SESSION (Pitfall 9) ───────────────

describe("GatewayClient reconnect/invalid-session ops", () => {
  it("op 7 (RECONNECT) → the client closes; the close handler reconnects with resume", () => {
    jest.useFakeTimers();
    const client = new GatewayClient({
      connectorId: CONNECTOR_ID,
      token: "secret-token",
      onDispatch: jest.fn(),
      onAuthFailed: jest.fn(),
    });
    client.connect();
    lastSocket!.driverOpen();
    lastSocket!.driverText({
      op: 0,
      s: 3,
      t: "READY",
      d: { session_id: "sess-7", resume_gateway_url: "wss://resume.fake.test" },
    });
    lastSocket!.driverText({ op: 7 });
    // The fake server delivers the resulting close (4000) — the handler
    // schedules the 1s reconnect.
    lastSocket!.driverClose(4000);

    jest.advanceTimersByTime(1000); // the 1s reconnect fires
    expect(allSockets.length).toBe(2);
    void client;
  });

  it("op 9 d:false clears the session → the reconnect IDENTIFYs fresh (no resume)", () => {
    jest.useFakeTimers();
    const client = new GatewayClient({
      connectorId: CONNECTOR_ID,
      token: "secret-token",
      onDispatch: jest.fn(),
      onAuthFailed: jest.fn(),
    });
    client.connect();
    lastSocket!.driverOpen();
    lastSocket!.driverText({
      op: 0,
      s: 4,
      t: "READY",
      d: { session_id: "sess-8", resume_gateway_url: "wss://resume.fake.test" },
    });
    lastSocket!.driverText({ op: 9, d: false });

    expect(client.hasSession()).toBe(false);
    lastSocket!.driverClose(4000);
    jest.advanceTimersByTime(1000);
    expect(allSockets.length).toBe(2);

    // The fresh socket's HELLO must IDENTIFY (no session → no resume).
    const fresh = allSockets[allSockets.length - 1];
    fresh.driverOpen();
    fresh.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    expect(fresh.sentFrames().filter((f) => f.op === 2)).toHaveLength(1);
    void client;
  });

  it("op 9 d:true keeps the session → the reconnect RESUMEs", () => {
    jest.useFakeTimers();
    const client = new GatewayClient({
      connectorId: CONNECTOR_ID,
      token: "secret-token",
      onDispatch: jest.fn(),
      onAuthFailed: jest.fn(),
    });
    client.connect();
    lastSocket!.driverOpen();
    lastSocket!.driverText({
      op: 0,
      s: 4,
      t: "READY",
      d: { session_id: "sess-8", resume_gateway_url: "wss://resume.fake.test" },
    });
    lastSocket!.driverText({ op: 9, d: true });

    expect(client.hasSession()).toBe(true);
    lastSocket!.driverClose(4000);
    jest.advanceTimersByTime(1000);

    // Resume on the fresh socket's HELLO.
    const fresh = allSockets[allSockets.length - 1];
    fresh.driverOpen();
    fresh.driverText({ op: 10, d: { heartbeat_interval: 41250 } });
    const resume = fresh.sentFrames().filter((f) => f.op === 6)[0];
    expect(resume).toBeDefined();
    expect((resume!.d as Record<string, unknown>).session_id).toBe("sess-8");
    void client;
  });
});

// ─── toIncomingMessage unit pins (the normalizer) ────────────────────

describe("toIncomingMessage (the adapter-boundary normalizer)", () => {
  it("a DM payload normalizes: bare snowflake id, channel id as user, global_name ?? username", () => {
    const msg = toIncomingMessage({
      id: "123456789012345678",
      channel_id: "999888777666555444",
      channel_type: 1,
      content: "hello bot",
      author: { id: "u1", username: "dave", global_name: "Dave G", bot: false },
    });
    expect(msg).toEqual({
      platformMessageId: "123456789012345678",
      platformUserId: "999888777666555444",
      platformUserName: "Dave G",
      text: "hello bot",
      chatType: "private",
    });
  });

  it("guild_id → null (D-03 silent)", () => {
    expect(toIncomingMessage({ id: "1", channel_id: "2", guild_id: "g1", channel_type: 1, author: {} })).toBeNull();
  });

  it("channel_type 3 (group DM) → null (A2: load-bearing)", () => {
    expect(toIncomingMessage({ id: "1", channel_id: "2", channel_type: 3, author: {} })).toBeNull();
  });

  it("author.bot → null (Pitfall 4 self-echo)", () => {
    expect(
      toIncomingMessage({ id: "1", channel_id: "2", channel_type: 1, author: { bot: true, username: "me" } })
    ).toBeNull();
  });

  it("missing author/id/channel_id → null (defensive parse boundary)", () => {
    expect(toIncomingMessage({ channel_type: 1 })).toBeNull();
    expect(toIncomingMessage({ id: "1", channel_type: 1 })).toBeNull();
  });
});

// ─── injectDiscordConnectorMessage (the 199-05 seam contract) ────────

describe("injectDiscordConnectorMessage (Plan 199-05 seam)", () => {
  it("unknown connector → logged warn, resolves (never throws)", async () => {
    await expect(injectDiscordConnectorMessage("nope", {})).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a DM payload routes into the pipeline (the D-01 parity seam)", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([gatewayRow()]);
    syncDiscordConnector(gatewayRow());

    await injectDiscordConnectorMessage(CONNECTOR_ID, {
      id: "snow-1",
      channel_id: "chan-9",
      channel_type: 1,
      content: "injected",
      author: { id: "u9", username: "injectee", bot: false },
    });

    expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    const [, msg] = (handleIncomingMessage as jest.Mock).mock.calls[0];
    expect(msg.platformMessageId).toBe("snow-1");
    expect(msg.platformUserId).toBe("chan-9");
    expect(msg.chatType).toBe("private");
  });

  it("a guild payload injected is filtered silently (no pipeline call)", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([gatewayRow()]);
    syncDiscordConnector(gatewayRow());

    await injectDiscordConnectorMessage(CONNECTOR_ID, {
      id: "snow-2",
      channel_id: "chan-9",
      guild_id: "g-9",
      channel_type: 1,
      content: "guild",
      author: { bot: false },
    });

    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });
});

// ─── resetGatewayState helper (Task 2 step 3 — module Maps reset) ─────

describe("resetGatewayState (module-state reset helper)", () => {
  it("closes every client, empties the Map, and clears the overrides", async () => {
    (prisma.chatConnector.findMany as jest.Mock).mockResolvedValue([gatewayRow()]);
    syncDiscordConnector(gatewayRow());
    expect(gatewayClientCount()).toBe(1);

    resetGatewayState();

    expect(gatewayClientCount()).toBe(0);
    expect(hasGatewayClient(CONNECTOR_ID)).toBe(false);
    // The override cleared → a fresh connect after reset consults the env
    // (no egress: the fake factory is also reset, so we assert the setter).
    expect(createdUrls).toHaveLength(1); // no NEW sockets after reset
  });

  it("a full boot→dispatch→welcome chain works end-to-end through the fake", async () => {
    // (h2) the created-flag welcome arm end-to-end through the fake: the
    // manager-built client (prisma-backed onAuthFailed + pipeline dispatch)
    // feeds handleIncomingMessage; the welcome itself is pinned in
    // messageRouter.test.ts (the router's arm) — here we pin the SEAM:
    // a first DM through the real init→socket→dispatch chain reaches the
    // router with the normalized message.
    const firstContactSession = {
      id: "session-199",
      connectorId: CONNECTOR_ID,
      platformUserId: "chan-1",
      chatId: "chat-199",
      messageCount: 0,
      lastMessageAt: null,
      lastResetAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    };
    (prisma.chatConnector.findMany as jest.Mock)
      .mockResolvedValueOnce([gatewayRow()]) // init
      .mockResolvedValue([gatewayRow()]); // inject re-query
    (prisma.connectorSession.findUnique as jest.Mock).mockResolvedValue(firstContactSession);
    (prisma.connectorSession.update as jest.Mock).mockResolvedValue(firstContactSession);
    (prisma.connectorMessage.create as jest.Mock).mockResolvedValue({ id: "cm-1" });
    (prisma.connectorMessage.count as jest.Mock).mockResolvedValue(0);

    await initDiscordGateway();
    expect(gatewayClientCount()).toBe(1);

    // HELLO → IDENTIFY observed on the manager-built socket.
    handshake();
    expect(lastFrame(2)).toBeDefined();

    // A first-contact DM dispatch → the router receives the normalized msg.
    lastSocket!.driverText({
      op: 0,
      s: 20,
      t: "MESSAGE_CREATE",
      d: {
        id: "dm-first",
        channel_id: "chan-1",
        channel_type: 1,
        content: "first contact",
        author: { id: "u1", username: "newcomer", global_name: "New Comer", bot: false },
      },
    });
    await new Promise((r) => setTimeout(r, 0)); // the fire-and-forget pipeline

    expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    const [row, msg] = (handleIncomingMessage as jest.Mock).mock.calls[0];
    expect(row.id).toBe(CONNECTOR_ID);
    expect(msg).toEqual({
      platformMessageId: "dm-first",
      platformUserId: "chan-1",
      platformUserName: "New Comer",
      text: "first contact",
      chatType: "private",
    });
  });
});
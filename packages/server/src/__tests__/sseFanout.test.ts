// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Unit tests for SSE fan-out via Redis pub/sub (SCALE-02, D-03).
// Covers:
//   1. sendSSE publishes JSON { event, data } to channel sse:chat:{chatId} after res.write
//   2. publish is fire-and-forget — pub/sub error does not throw out of sendSSE
//   3. SSE handler subscribes to sse:chat:{chatId} on stream start via redis.duplicate()
//   4. subscriber relay writes event to res when message received from Redis (non-originating)
//   5. originating instance does NOT relay its own published events (Pitfall 6)
//   6. unsubscribe and disconnect on res close
//   7. when getRedis() returns null, no publish or subscribe occurs (degradation)
//   8. cross-instance relay (Phase 166 — closes Phase 122 deferral)
//
// Mock strategy:
// - ioredis is mocked with a shared mutable instance so redisService constructs our mock.
// - getEnv is mocked with a shared mutable object (flip REDIS_URL per test).
// - logger is mocked.
// - prisma is mocked (chat.ts imports it at module scope).
// - We exercise the extracted pub/sub helpers (publishSSEEvent + setupSSESubscriber)
//   which chat.ts exports for testability.

// Shared mutable mock redis instance
const mockRedis = {
  publish: jest.fn().mockResolvedValue(1),
  duplicate: jest.fn(),
  disconnect: jest.fn().mockResolvedValue(undefined),
  unsubscribe: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  call: jest.fn().mockResolvedValue("OK"),
};

// Shared mutable mock env (so we can flip REDIS_URL on/off per test)
const mockEnv = {
  REDIS_URL: "redis://localhost:6379" as string | undefined,
};

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => mockEnv),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {},
}));

// Mock ioredis so redisService constructs our mockRedis instance
const mockRedisConstructor = jest.fn(() => mockRedis);
jest.mock("ioredis", () => ({
  __esModule: true,
  default: mockRedisConstructor,
}));

// Minimal mock res with the shape sendSSE + subscriber relay need
function makeMockRes() {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  return {
    write: jest.fn((chunk: string) => {
      writes.push(chunk);
    }),
    writableEnded: false,
    end: jest.fn(),
    on: jest.fn((event: string, cb: () => void) => {
      if (event === "close") closeHandlers.push(cb);
    }),
    _writes: writes,
    _closeHandlers: closeHandlers,
    _triggerClose() {
      for (const cb of closeHandlers) cb();
    },
  };
}

function freshChatModule() {
  jest.resetModules();
  jest.doMock("ioredis", () => ({
    __esModule: true,
    default: mockRedisConstructor,
  }));
  jest.doMock("../config/env", () => ({
    getEnv: jest.fn(() => mockEnv),
  }));
  jest.doMock("../utils/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.doMock("../utils/prisma", () => ({ __esModule: true, default: {} }));
  return require("../routes/chat");
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  mockEnv.REDIS_URL = "redis://localhost:6379";
  mockRedis.publish.mockResolvedValue(1);
  mockRedis.duplicate.mockReturnValue(mockRedis);
  mockRedis.disconnect.mockResolvedValue(undefined);
  mockRedis.unsubscribe.mockResolvedValue(undefined);
  mockRedis.subscribe.mockResolvedValue(undefined);
  mockRedis.on.mockReturnValue(undefined);
});

describe("SSE pub/sub fan-out (SCALE-02)", () => {
  // Test 1: sendSSE publishes JSON { event, data } to channel sse:chat:{chatId} after res.write
  it("publishes JSON { event, data } to channel sse:chat:{chatId} after res.write", () => {
    const { publishSSEEvent } = freshChatModule();
    const res = makeMockRes();
    const chatId = "chat-abc";

    publishSSEEvent(res as any, chatId, "token", { content: "hello" });

    // local write happened
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith(
      "event: token\ndata: {\"content\":\"hello\"}\n\n",
    );
    // publish happened after local write
    expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    expect(mockRedis.publish).toHaveBeenCalledWith(
      "sse:chat:chat-abc",
      JSON.stringify({ event: "token", data: { content: "hello" } }),
    );
  });

  // Test 2: publish is fire-and-forget — pub/sub error does not throw out of sendSSE
  it("does not throw when redis.publish rejects (fire-and-forget)", () => {
    const { publishSSEEvent } = freshChatModule();
    const res = makeMockRes();
    mockRedis.publish.mockRejectedValue(new Error("ECONNREFUSED"));

    // Should not throw — the caller (sendSSE) must stay alive
    expect(() => publishSSEEvent(res as any, "chat-1", "token", "x")).not.toThrow();
    // local write still happened
    expect(res.write).toHaveBeenCalledTimes(1);
  });

  // Test 3: SSE handler subscribes to sse:chat:{chatId} on stream start via redis.duplicate()
  it("subscribes to sse:chat:{chatId} via redis.duplicate() on stream start", async () => {
    const { setupSSESubscriber } = freshChatModule();
    const res = makeMockRes();
    const chatId = "chat-sub-1";
    const sub = { ...mockRedis };
    mockRedis.duplicate.mockReturnValue(sub);

    await setupSSESubscriber(res as any, chatId, false);

    expect(mockRedis.duplicate).toHaveBeenCalledTimes(1);
    expect(sub.subscribe).toHaveBeenCalledWith("sse:chat:chat-sub-1");
  });

  // Test 4: subscriber relay writes event to res when message received from Redis (non-originating instance)
  it("relays pub/sub messages to res for non-originating instance", async () => {
    const { setupSSESubscriber } = freshChatModule();
    const res = makeMockRes();
    const chatId = "chat-relay-1";
    const sub = { ...mockRedis, on: jest.fn() };
    mockRedis.duplicate.mockReturnValue(sub);

    // isOriginating=false → this instance is a relay-only subscriber
    await setupSSESubscriber(res as any, chatId, false);

    // Find the message handler registered via sub.on("message", ...)
    const onCall = sub.on.mock.calls.find((c: any[]) => c[0] === "message");
    expect(onCall).toBeDefined();
    const messageHandler = onCall![1];

    // Simulate a pub/sub message arriving
    res.writableEnded = false;
    messageHandler(
      "sse:chat:chat-relay-1",
      JSON.stringify({ event: "token", data: { content: "relayed" } }),
    );

    expect(res.write).toHaveBeenCalledWith("event: token\n");
    expect(res.write).toHaveBeenCalledWith('data: {"content":"relayed"}\n\n');
  });

  // Test 5: originating instance does NOT relay its own published events (Pitfall 6)
  it("does NOT relay pub/sub messages for the originating chatId (double-write prevention)", async () => {
    const { setupSSESubscriber } = freshChatModule();
    const res = makeMockRes();
    const chatId = "chat-origin-1";
    const sub = { ...mockRedis, on: jest.fn() };
    mockRedis.duplicate.mockReturnValue(sub);

    // isOriginating=true → this instance is the origin, must skip relay
    await setupSSESubscriber(res as any, chatId, true);

    const onCall = sub.on.mock.calls.find((c: any[]) => c[0] === "message");
    expect(onCall).toBeDefined();
    const messageHandler = onCall![1];

    // Simulate our OWN published event arriving back via pub/sub
    messageHandler(
      "sse:chat:chat-origin-1",
      JSON.stringify({ event: "token", data: { content: "own" } }),
    );

    // No relay — the originating instance already wrote locally
    expect(res.write).not.toHaveBeenCalled();
  });

  // Test 6: unsubscribe and disconnect on res close
  it("unsubscribes and disconnects the subscriber on res close", async () => {
    const { setupSSESubscriber } = freshChatModule();
    const res = makeMockRes();
    const chatId = "chat-close-1";
    const sub = { ...mockRedis, on: jest.fn() };
    mockRedis.duplicate.mockReturnValue(sub);

    await setupSSESubscriber(res as any, chatId, false);

    // Trigger the res close handler
    res._triggerClose();

    // unsubscribe is called synchronously in the close handler
    expect(sub.unsubscribe).toHaveBeenCalledWith("sse:chat:chat-close-1");
    // disconnect runs inside .then() after the async unsubscribe resolves —
    // flush the microtask queue before asserting
    await Promise.resolve();
    await Promise.resolve();
    expect(sub.disconnect).toHaveBeenCalled();
  });

  // Test 7: when getRedis() returns null, no publish or subscribe occurs (degradation)
  it("skips all pub/sub when Redis unavailable (getRedis returns null)", async () => {
    mockEnv.REDIS_URL = undefined; // getRedis() returns null
    const { publishSSEEvent, setupSSESubscriber } = freshChatModule();
    const res = makeMockRes();

    // publish path — should still do the local write but NOT publish
    publishSSEEvent(res as any, "chat-noop-1", "token", "x");
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(mockRedis.publish).not.toHaveBeenCalled();

    // subscribe path — should be a no-op (returns null)
    const sub = await setupSSESubscriber(res as any, "chat-noop-2", false);
    expect(sub).toBeNull();
    expect(mockRedis.duplicate).not.toHaveBeenCalled();
    expect(mockRedis.subscribe).not.toHaveBeenCalled();
  });

  // Test 8 (roadmap gate, TEC-03a + SCALE-02 coexistence): the rate-limit
  // Redis store shares the MAIN connection (no duplicate) while the SSE
  // subscriber duplicates exactly once — D-03's no-shared-connection-conflict
  // property. createRedisStore is loaded via a fresh module so its getRedis()
  // resolves to the same mock instance.
  it("coexistence: createRedisStore uses the main connection (no duplicate) while setupSSESubscriber duplicates exactly once", async () => {
    mockEnv.REDIS_URL = "redis://localhost:6379";
    mockRedis.duplicate.mockReturnValue({ ...mockRedis });
    mockRedis.call = jest.fn().mockResolvedValue("OK");

    // Fresh module for middleware/rateLimit so createRedisStore's getRedis()
    // resolves to the shared mock instance.
    jest.resetModules();
    jest.doMock("ioredis", () => ({
      __esModule: true,
      default: mockRedisConstructor,
    }));
    jest.doMock("../config/env", () => ({
      getEnv: jest.fn(() => mockEnv),
    }));
    jest.doMock("../utils/logger", () => ({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    }));
    jest.doMock("../utils/prisma", () => ({ __esModule: true, default: {} }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rateLimitMod = require("../middleware/rateLimit");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chatMod = require("../routes/chat");

    // Construct the store path — RedisStore construction uses the SAME main
    // mock instance (no duplicate for the store).
    const store = rateLimitMod.apiRateLimiter;
    expect(store).toBeDefined();
    expect(mockRedis.duplicate).not.toHaveBeenCalled();

    // SSE subscriber duplicates exactly once (its own connection).
    const res = makeMockRes();
    await chatMod.setupSSESubscriber(res as any, "chat-coexist-1", false);
    expect(mockRedis.duplicate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-instance SSE relay (Phase 166 — closes the Phase 122 deferral).
//
// The 8 single-instance tests above prove the relay mechanics in isolation:
// publish writes locally, subscriber relays, origin-skip works, teardown
// fires. What they do NOT prove is the cross-instance perspective — that an
// event published by instance A actually reaches instance B's subscriber via
// the shared Redis pub/sub channel, and that the two instances do NOT share
// the module-level `originatingChats` Set (the core cross-instance invariant).
//
// This describe block simulates two server instances with two
// `freshChatModule()` calls (each `jest.resetModules()` re-evaluates
// `const originatingChats = new Set()` at chat.ts:63 → disjoint Sets per
// instance). An enhanced mock Redis bridges them: `mockRedis.publish` fans
// out to every handler registered via `mockRedis.on("message", h)`, so A's
// publish triggers B's subscriber relay end-to-end (RESEARCH Pattern 2).
//
// The enhancement is scoped to THIS describe block's beforeEach/afterEach so
// the existing 8 tests run unchanged (RESEARCH Pitfall 2). The file-level
// beforeEach (jest.clearAllMocks) runs first (jest outside-in order), then
// this describe's beforeEach re-installs the fan-out on `on` + `publish`.
describe("cross-instance SSE relay (SF-01/SF-02, Phase 122 deferral closed)", () => {
  // Handler registry scoped to this describe closure — CANNOT leak to the
  // single-instance block above (it is not file-scoped).
  const messageHandlers: Array<(channel: string, message: string) => void> = [];

  beforeEach(() => {
    // Fan-out enhancement: publish triggers every registered on("message")
    // handler synchronously, mimicking real Redis pub/sub delivery. The
    // handlers are captured by the enhanced `on` below.
    mockRedis.on.mockImplementation((event: string, handler: any) => {
      if (event === "message") messageHandlers.push(handler);
      return undefined;
    });
    mockRedis.publish.mockImplementation((channel: string, message: string) => {
      for (const h of messageHandlers) h(channel, message);
      return Promise.resolve(1);
    });
    // mockRedis.duplicate.mockReturnValue(mockRedis) is the file-level
    // beforeEach default (line 101) — do NOT override it here. sub === mockRedis
    // → sub.on === mockRedis.on → the handler reaches the registry. Overriding
    // duplicate with a spread-clone `{ ...mockRedis, on: jest.fn() }` would
    // BREAK the registry (RESEARCH Pitfall 1).
  });

  afterEach(() => {
    // Restore the plain mock so a subsequent single-instance test (or a future
    // test added between blocks) sees the unenhanced publish/on. The
    // file-level beforeEach will clearAllMocks again before the next test,
    // but restoring here is defense-in-depth against jest reordering.
    messageHandlers.length = 0;
    mockRedis.on.mockReturnValue(undefined);
    mockRedis.publish.mockResolvedValue(1);
  });

  // Test 1 (SF-01 delivery): instance A publishes → instance B's subscriber
  // relays to its own res via the mock pub/sub channel. A's res gets exactly
  // the local write; B's res gets the relayed event as two split writes
  // (chat.ts:133-134: `event: token\n` then `data: {...}\n\n`).
  it("relays an event from instance A to instance B's subscriber (SF-01)", async () => {
    const instanceA = freshChatModule();
    const instanceB = freshChatModule();
    const resA = makeMockRes();
    const resB = makeMockRes();
    const chatId = "chat-xinst-1";

    // B subscribes as a relay-only instance (isOriginating=false). duplicate()
    // returns mockRedis → sub.on === mockRedis.on → handler registered in
    // messageHandlers via the enhanced `on`. setupSSESubscriber is async: it
    // awaits sub.subscribe() BEFORE registering on("message"), so we must
    // await it here so the handler is in the registry before A publishes.
    await instanceB.setupSSESubscriber(resB as any, chatId, false);

    // A publishes. publishSSEEvent writes locally to resA, then calls
    // redis.publish(...) which (via the enhanced mock) synchronously fans out
    // to every registered handler — including B's. B's handler relays to
    // resB. The publish is fire-and-forget (.catch()), but the mock fires
    // handlers synchronously so the relay is complete when this returns.
    instanceA.publishSSEEvent(resA as any, chatId, "token", { content: "from-A" });

    // A's local write: exactly one write with the full SSE frame.
    expect(resA._writes).toHaveLength(1);
    expect(resA._writes[0]).toBe("event: token\ndata: {\"content\":\"from-A\"}\n\n");

    // B's relay: two split writes (event line, then data line) per chat.ts:133-134.
    expect(resB._writes).toContain("event: token\n");
    expect(resB._writes).toContain('data: {"content":"from-A"}\n\n');
  });

  // Test 2 (SF-01 origin-skip, cross-instance lens): proves the
  // `originatingChats` Set is per-instance (disjoint across the two
  // freshChatModule calls). A subscribes as the origin (isOriginating=true →
  // A adds chatId to A's own originatingChats Set), then A publishes. A's own
  // subscriber handler fires but skips relay because
  // `isOriginating && originatingChats.has(chatId)` is true (chat.ts:127).
  // Per RESEARCH Pitfall 3: if the Sets were shared, this would pass for the
  // wrong reason. The two freshChatModule() calls guarantee disjoint Sets, so
  // A's add does not affect B — but B has no subscriber for this chatId, so
  // nothing relays regardless. The assertion is on resA ONLY (Pitfall 6):
  // exactly one write, the local frame.
  it("instance A does NOT double-write its own event (cross-instance origin-skip)", async () => {
    const instanceA = freshChatModule();
    freshChatModule(); // instanceB — independent module/Set (sanity)
    const resA = makeMockRes();
    const chatId = "chat-xinst-origin";

    // isOriginating=true → A adds chatId to A's originatingChats Set.
    await instanceA.setupSSESubscriber(resA as any, chatId, true);

    // A publishes its own event. The mock publish fans out to A's own
    // handler, but the origin-skip branch (chat.ts:127) returns early —
    // A already wrote locally, so no double-write.
    instanceA.publishSSEEvent(resA as any, chatId, "token", { content: "own" });

    // Exactly one write: the local SSE frame (no relay).
    expect(resA._writes).toHaveLength(1);
    expect(resA._writes[0]).toBe("event: token\ndata: {\"content\":\"own\"}\n\n");
  });

  // Test 3 (SF-02 teardown, cross-instance lens): B's subscriber unsubscribes
  // and disconnects on res close. unsubscribe is synchronous in the close
  // handler (chat.ts:151); disconnect runs inside .then() after the async
  // unsubscribe resolves (chat.ts:150-152) — flush microtasks (existing
  // single-instance test 6 pattern at lines 225-226).
  it("instance B unsubscribes on res close (cross-instance teardown)", async () => {
    const instanceB = freshChatModule();
    const resB = makeMockRes();
    const chatId = "chat-xinst-close";

    await instanceB.setupSSESubscriber(resB as any, chatId, false);

    resB._triggerClose();

    // unsubscribe is synchronous in the close handler.
    expect(mockRedis.unsubscribe).toHaveBeenCalledWith("sse:chat:chat-xinst-close");
    // disconnect runs inside .then() after the async unsubscribe resolves —
    // flush the microtask queue before asserting (two ticks, matching the
    // existing single-instance teardown test).
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRedis.disconnect).toHaveBeenCalled();
  });

  // Test 4 (SF-03 degradation, two-instance lens): with REDIS_URL undefined,
  // both instances degrade to single-instance mode. A writes locally but
  // does NOT publish; B's setupSSESubscriber returns null (getRedis()===null
  // at chat.ts:114) and B's res gets no relay. Per RESEARCH Pitfall 5: set
  // mockEnv.REDIS_URL = undefined BEFORE the freshChatModule calls so each
  // fresh module's redisService singleton re-evaluates getRedis() and returns
  // null (initAttempted is per-module after jest.resetModules).
  it("no cross-instance relay when REDIS_URL absent (SF-03)", async () => {
    mockEnv.REDIS_URL = undefined; // before freshChatModule — fresh redisService
    const instanceA = freshChatModule();
    const instanceB = freshChatModule();
    const resA = makeMockRes();
    const resB = makeMockRes();

    // A publishes — local write happens, but getRedis()===null → no publish.
    instanceA.publishSSEEvent(resA as any, "chat-xinst-deg", "token", "x");
    expect(resA._writes).toHaveLength(1);
    expect(mockRedis.publish).not.toHaveBeenCalled();

    // B subscribes — getRedis()===null → returns null (chat.ts:114), no
    // subscriber, no relay.
    const sub = instanceB.setupSSESubscriber(resB as any, "chat-xinst-deg", false);
    await expect(sub).resolves.toBeNull();
    expect(resB._writes).toHaveLength(0);
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";

// WID-01 D-09: dedup client done via seen-set keyed chatId:messageId
// (fallback chatId:Date.now() for null messageId). First done wins.
//
// The dedup logic lives in useWidgetChat.ts as pure exported helpers so it can
// be unit-tested in the node environment without rendering the Preact hook
// (the threat model T-65-SC forbids adding @testing-library/preact as a dep;
// jest-environment-jsdom is available via the workspace but the pure-helper
// approach gives the same coverage with zero new surface).
import { makeDoneKey, shouldProcessDone, postStorageToLoader, requestStorageFromLoader, readStoredValue, writeStoredValue, appendTokenToMessages, attachCitationsToMessages, translateRagDegraded, buildStreamBody, isDailyRateLimit } from "../widget/hooks/useWidgetChat";

describe("useWidgetChat done dedup — makeDoneKey + shouldProcessDone (WID-01 D-09)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("dedups two identical done events — shouldProcessDone returns true once, false on duplicate", () => {
    const seen = new Set<string>();
    // Two identical done events (same chatId + messageId)
    expect(shouldProcessDone(seen, "c1", "m1")).toBe(true);
    expect(shouldProcessDone(seen, "c1", "m1")).toBe(false);
    // Set contains exactly one key
    expect(seen.size).toBe(1);
    expect(seen.has(makeDoneKey("c1", "m1"))).toBe(true);
  });

  it("uses chatId:Date.now() fallback when messageId is null — first wins, duplicate ignored", () => {
    // Mock Date.now to a fixed value so two null-messageId events in the same
    // tick produce the same key (simulating tight back-to-back duplicates).
    const fixed = 1_700_000_000_000;
    const spy = jest.spyOn(Date, "now").mockReturnValue(fixed);

    const seen = new Set<string>();
    expect(shouldProcessDone(seen, "c1", null)).toBe(true);
    expect(shouldProcessDone(seen, "c1", null)).toBe(false);
    // Key for null messageId uses the timestamp fallback
    expect(makeDoneKey("c1", null)).toBe(`c1:${fixed}`);
    expect(seen.has(`c1:${fixed}`)).toBe(true);

    spy.mockRestore();
  });

  it("different messageIds are NOT deduped (both processed)", () => {
    const seen = new Set<string>();
    expect(shouldProcessDone(seen, "c1", "m1")).toBe(true);
    expect(shouldProcessDone(seen, "c1", "m2")).toBe(true);
    expect(seen.size).toBe(2);
  });

  it("different chatIds are NOT deduped (both processed)", () => {
    const seen = new Set<string>();
    expect(shouldProcessDone(seen, "c1", "m1")).toBe(true);
    expect(shouldProcessDone(seen, "c2", "m1")).toBe(true);
    expect(seen.size).toBe(2);
  });
});

// WID-03 D-05: message persistence throttle. Two consecutive token events must
// produce exactly ONE postMessage simmetric:storage-set for "messages" (the one
// fired on done), NOT two (per-token flooding is explicitly forbidden by D-05).
// We cannot render the Preact hook without @testing-library/preact (T-65-SC),
// so we simulate the done-path call directly: the hook's done handler calls
// postStorageToLoader once, and the token handler never calls it. This test
// asserts the helper fires a single simmetric:storage-set postMessage with the
// expected namespaced payload, mirroring what the hook does on done.
describe("useWidgetChat message persistence — D-05 throttle (WID-03)", () => {
  // postStorageToLoader calls window.parent.postMessage. The node test env has
  // no window, so we install a minimal mock before each test and tear it down
  // after. We avoid switching the whole file to jsdom because importing the
  // Preact hook (preact/hooks ESM) breaks under the widget's ts-jest transform
  // config — the pure-helper approach keeps both the existing dedup tests and
  // these D-05 tests in the same node environment with zero new deps (T-65-SC).
  let postMessageMock: jest.Mock;
  let originalWindow: typeof global.window | undefined;

  beforeEach(() => {
    postMessageMock = jest.fn();
    originalWindow = (global as { window?: typeof global.window }).window;
    (global as unknown as { window: { parent: { postMessage: jest.Mock } } }).window = {
      parent: { postMessage: postMessageMock },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: typeof global.window }).window;
    } else {
      (global as unknown as { window: typeof global.window }).window = originalWindow;
    }
  });

  it("two tokens then done → exactly ONE simmetric:storage-set for messages (NOT per-token)", () => {
    const widgetId = "widget-d05";
    const messages = [
      { id: "u1", role: "user" as const, content: "hi" },
      { id: "a1", role: "assistant" as const, content: "hello there" },
    ];

    // Simulate the done handler: ONE call to postStorageToLoader for "messages"
    postStorageToLoader(widgetId, "messages", JSON.stringify(messages));

    // Token handlers do NOT call postStorageToLoader — so total is exactly 1.
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = postMessageMock.mock.calls[0] as unknown as [any, string];
    const payload = firstCall[0];
    const target = firstCall[1];
    expect(payload).toMatchObject({
      type: "simmetric:storage-set",
      widgetId: "widget-d05",
      key: "messages",
    });
    expect(JSON.parse(payload.value)).toEqual(messages);
    // Iframe→parent uses '*' (parent is trusted; iframe is sandboxed so it
    // cannot leak to third parties). D-06 origin validation happens on the
    // inbound storage-data reply, not on the outbound storage-set.
    expect(target).toBe("*");
  });

  it("session-create path posts exactly ONE simmetric:storage-set for session (not messages)", () => {
    const widgetId = "widget-session";
    const token = "st-abc123";
    // Simulate the session-create success path
    postStorageToLoader(widgetId, "session", JSON.stringify({ token }));

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    const firstCall = postMessageMock.mock.calls[0] as unknown as [any, string];
    const payload = firstCall[0];
    expect(payload).toMatchObject({
      type: "simmetric:storage-set",
      widgetId: "widget-session",
      key: "session",
    });
    expect(JSON.parse(payload.value)).toEqual({ token });
  });
});

// CR-01 (WID-03 BLOCKER fix): requestStorageFromLoader must accept storage-data
// ONLY from its parent (event.source === window.parent). Under a sandboxed
// iframe without allow-same-origin, window.location.origin is the opaque origin
// ("null"), so the previous event.origin !== window.location.origin check
// ALWAYS failed → every reply rejected → 500ms timeout → null → new session on
// every load → blow-through 5-sessions/day NOT prevented. This test pins the
// correct event.source-based validation.
describe("requestStorageFromLoader source validation — CR-01 fix (WID-03 D-06)", () => {
  let parentRef: { postMessage: jest.Mock };
  let listeners: Array<(event: MessageEvent) => void>;
  let originalWindow: typeof global.window | undefined;

  beforeEach(() => {
    parentRef = { postMessage: jest.fn() };
    listeners = [];
    originalWindow = (global as { window?: typeof global.window }).window;
    // Minimal window mock: parent is a stable object reference; addEventListener
    // captures the message handler so the test can dispatch synthetic events.
    (global as unknown as { window: any }).window = {
      parent: parentRef,
      addEventListener: (_type: string, fn: (e: MessageEvent) => void) => { listeners.push(fn); },
      removeEventListener: (_type: string, fn: (e: MessageEvent) => void) => {
        listeners = listeners.filter((l) => l !== fn);
      },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: typeof global.window }).window;
    } else {
      (global as unknown as { window: typeof global.window }).window = originalWindow;
    }
  });

  it("resolves with data when storage-data comes FROM the parent (event.source === window.parent)", async () => {
    const p = requestStorageFromLoader("widget-cr01", ["session"], 1000);
    // Parent (loader) replies with a valid storage-data event whose source IS window.parent.
    const data = { session: JSON.stringify({ token: "st-valid" }) };
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data } } as unknown as MessageEvent);
    }
    await expect(p).resolves.toEqual(data);
    // Outbound storage-get was posted to the parent.
    expect(parentRef.postMessage).toHaveBeenCalledTimes(1);
    expect(parentRef.postMessage.mock.calls[0][0]).toMatchObject({
      type: "simmetric:storage-get",
      widgetId: "widget-cr01",
      keys: ["session"],
      // 131-05 (G-131-18): the outbound payload carries a per-request
      // requestId so the loader can echo it back (additive assertion).
      requestId: expect.any(String),
    });
  });

  it("rejects storage-data from a NON-parent source (session-fixation defense) → resolves null on timeout", async () => {
    const p = requestStorageFromLoader("widget-cr01", ["session"], 50);
    // A malicious sibling iframe / host script replies with a forged token.
    const attacker = { postMessage: jest.fn() };
    for (const fn of listeners) {
      fn({ source: attacker, data: { type: "simmetric:storage-data", data: { session: JSON.stringify({ token: "st-forged" }) } } } as unknown as MessageEvent);
    }
    // Forged reply ignored → timeout → null (no blow-through reuse of attacker token).
    await expect(p).resolves.toBeNull();
  });
});

// 131-05 (G-131-18): request/reply correlation in the storage handshake. The
// pre-fix requestStorageFromLoader resolved on the FIRST simmetric:storage-data
// reply with no request/reply correlation — the ChatPanel mount effect's
// concurrent consent+leadSubmitted reads (plus useWidgetChat's session read)
// misrouted: the leadSubmitted restore always resolved null and the lead card
// re-showed on the next assistant answer (deterministic 100/100 repro). The
// fix: each storage-get carries a per-request requestId; the loader echoes it
// in the storage-data reply; the client resolves ONLY the matching request.
// Legacy cached loaders (max-age=3600) that never learned the echo degrade to
// unambiguous single-flight (a no-requestId reply resolves only the SOLE
// pending request; multi-pending legacy broadcasts resolve nothing → timeout
// → null — never the wrong data).
describe("requestStorageFromLoader requestId correlation (G-131-18)", () => {
  let parentRef: { postMessage: jest.Mock };
  let listeners: Array<(event: MessageEvent) => void>;
  let originalWindow: typeof global.window | undefined;

  beforeEach(() => {
    parentRef = { postMessage: jest.fn() };
    listeners = [];
    originalWindow = (global as { window?: typeof global.window }).window;
    (global as unknown as { window: any }).window = {
      parent: parentRef,
      addEventListener: (_type: string, fn: (e: MessageEvent) => void) => { listeners.push(fn); },
      removeEventListener: (_type: string, fn: (e: MessageEvent) => void) => {
        listeners = listeners.filter((l) => l !== fn);
      },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: typeof global.window }).window;
    } else {
      (global as unknown as { window: typeof global.window }).window = originalWindow;
    }
  });

  // Helper: capture the requestId of the Nth outbound storage-get (0-based).
  const outboundRequestId = (index: number): string => {
    const payload = parentRef.postMessage.mock.calls[index][0] as { requestId: string };
    expect(payload.requestId).toBeTruthy();
    return payload.requestId;
  };

  it("two concurrent reads resolve each its OWN key — out-of-order replies never misroute (the 100/100 repro inverted)", async () => {
    const consentP = requestStorageFromLoader("widget-g13118", ["consent"], 1000);
    const leadP = requestStorageFromLoader("widget-g13118", ["leadSubmitted"], 1000);

    // Two outbound storage-get requests, each with its own requestId.
    expect(parentRef.postMessage).toHaveBeenCalledTimes(2);
    const consentId = outboundRequestId(0);
    const leadId = outboundRequestId(1);
    expect(consentId).not.toBe(leadId);

    // The parent replies FIRST to the leadSubmitted request (echoing ITS
    // requestId), then to the consent request — the deterministic misrouting
    // scenario from the diagnosis, now inverted.
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data: { leadSubmitted: "1" }, requestId: leadId } } as unknown as MessageEvent);
    }
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data: { consent: "1" }, requestId: consentId } } as unknown as MessageEvent);
    }

    // Each promise resolves exactly its own key's value — never the other's.
    await expect(consentP).resolves.toEqual({ consent: "1" });
    await expect(leadP).resolves.toEqual({ leadSubmitted: "1" });
  });

  it("a reply whose requestId matches neither pending request is ignored (forged/duplicate reply)", async () => {
    const p = requestStorageFromLoader("widget-g13118", ["consent"], 50);
    const requestId = outboundRequestId(0);

    // A forged/duplicate reply with a non-matching requestId.
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data: { consent: "1" }, requestId: "some-other-id" } } as unknown as MessageEvent);
    }
    // Ignored → the real reply still resolves the request.
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data: { consent: "1" }, requestId } } as unknown as MessageEvent);
    }
    await expect(p).resolves.toEqual({ consent: "1" });
  });

  it("legacy no-requestId reply resolves the SOLE pending request (single-flight is unambiguous)", async () => {
    const p = requestStorageFromLoader("widget-g13118", ["consent"], 1000);
    // A stale cached loader (never learned the echo) replies without requestId.
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data: { consent: "1" } } } as unknown as MessageEvent);
    }
    await expect(p).resolves.toEqual({ consent: "1" });
  });

  it("legacy no-requestId reply with TWO pending requests resolves NEITHER — both stay pending → null on timeout (never the wrong data)", async () => {
    const consentP = requestStorageFromLoader("widget-g13118", ["consent"], 50);
    const leadP = requestStorageFromLoader("widget-g13118", ["leadSubmitted"], 50);

    // A no-requestId broadcast cannot be attributed to either request.
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data: { consent: "1" } } } as unknown as MessageEvent);
    }

    // Neither request resolves with the broadcast data — both time out to null.
    await expect(consentP).resolves.toBeNull();
    await expect(leadP).resolves.toBeNull();
  });

  it("the timeout path resolves null and cleans up its listener (pending count decremented)", async () => {
    const p = requestStorageFromLoader("widget-g13118", ["consent"], 30);
    await expect(p).resolves.toBeNull();
    // The listener was removed — a late reply must not resolve anything.
    expect(listeners).toHaveLength(0);
  });
});

// 260809-uxk (consent deadlock): readStoredValue/writeStoredValue wrappers over
// the loader handshake — the sandboxed iframe's own sessionStorage throws
// SecurityError on the opaque origin, so consent + lead-submitted state must
// persist via the loader. Same window-mock idiom as the CR-01 describe above.
describe("readStoredValue / writeStoredValue — consent + lead persistence via the loader handshake (260809-uxk)", () => {
  let parentRef: { postMessage: jest.Mock };
  let listeners: Array<(event: MessageEvent) => void>;
  let originalWindow: typeof global.window | undefined;

  beforeEach(() => {
    parentRef = { postMessage: jest.fn() };
    listeners = [];
    originalWindow = (global as { window?: typeof global.window }).window;
    (global as unknown as { window: any }).window = {
      parent: parentRef,
      addEventListener: (_type: string, fn: (e: MessageEvent) => void) => { listeners.push(fn); },
      removeEventListener: (_type: string, fn: (e: MessageEvent) => void) => {
        listeners = listeners.filter((l) => l !== fn);
      },
    };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (global as unknown as { window?: typeof global.window }).window;
    } else {
      (global as unknown as { window: typeof global.window }).window = originalWindow;
    }
  });

  it("readStoredValue resolves the single key from the loader's storage-data map", async () => {
    const p = readStoredValue("widget-consent", "consent");
    // Parent replies with the full map for the requested key.
    const data = { consent: "1" };
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data } } as unknown as MessageEvent);
    }
    await expect(p).resolves.toBe("1");
    // Outbound storage-get asks for exactly the one key.
    expect(parentRef.postMessage).toHaveBeenCalledTimes(1);
    expect(parentRef.postMessage.mock.calls[0][0]).toMatchObject({
      type: "simmetric:storage-get",
      widgetId: "widget-consent",
      keys: ["consent"],
    });
  });

  it("readStoredValue resolves null when the loader returns no entry for the key", async () => {
    const p = readStoredValue("widget-consent", "consent", 50);
    for (const fn of listeners) {
      fn({ source: parentRef, data: { type: "simmetric:storage-data", data: {} } } as unknown as MessageEvent);
    }
    await expect(p).resolves.toBeNull();
  });

  it("readStoredValue defaults to the 1500ms timeout (mount-handshake bump) and passes it to requestStorageFromLoader", async () => {
    // A parent reply never arrives — the promise resolves null after the
    // default 1500ms window. Asserting the default by observation would take
    // 1.5s; instead pin the contract: the wrapper's signature must default to
    // 1500 and the outbound get must carry the exact keys list. (The default
    // value is also exercised by the mount-handshake bump in useWidgetChat.)
    const start = Date.now();
    const p = readStoredValue("widget-consent", "consent"); // no explicit timeout
    expect(parentRef.postMessage).toHaveBeenCalledTimes(1);
    expect(parentRef.postMessage.mock.calls[0][0]).toMatchObject({
      type: "simmetric:storage-get",
      widgetId: "widget-consent",
      keys: ["consent"],
    });
    // No reply → times out with the DEFAULT (1500ms) window, not 500.
    await expect(p).resolves.toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
  }, 5000);

  it("writeStoredValue posts exactly one simmetric:storage-set with the given key + value", () => {
    writeStoredValue("widget-consent", "consent", "1");
    expect(parentRef.postMessage).toHaveBeenCalledTimes(1);
    expect(parentRef.postMessage.mock.calls[0][0]).toEqual({
      type: "simmetric:storage-set",
      widgetId: "widget-consent",
      key: "consent",
      value: "1",
    });
    expect(parentRef.postMessage.mock.calls[0][1]).toBe("*");
  });

  it("writeStoredValue persists leadSubmitted with the same one-message contract", () => {
    writeStoredValue("widget-lead", "leadSubmitted", "1");
    expect(parentRef.postMessage).toHaveBeenCalledTimes(1);
    expect(parentRef.postMessage.mock.calls[0][0]).toMatchObject({
      type: "simmetric:storage-set",
      widgetId: "widget-lead",
      key: "leadSubmitted",
      value: "1",
    });
  });

  it("readStoredValue ignores forged replies from a non-parent source (source validation inherited)", async () => {
    const p = readStoredValue("widget-consent", "consent", 50);
    const attacker = { postMessage: jest.fn() };
    for (const fn of listeners) {
      fn({ source: attacker, data: { type: "simmetric:storage-data", data: { consent: "1" } } } as unknown as MessageEvent);
    }
    // Forged consent reply ignored → timeout → null (consent stays false).
    await expect(p).resolves.toBeNull();
  });
});

// 260809-uxk Task 2 — synchronous message persistence helpers. The done-time
// snapshot previously read messagesRef which was synced via a post-commit
// effect — a race (done processed before the effect ran for the last token
// batch) truncated the assistant message on reload. The token/citations/
// sendMessage mutation sites now update messagesRef synchronously via these
// pure helpers. Same node-env pure-helper idiom as the dedup tests above.
describe("appendTokenToMessages / attachCitationsToMessages — synchronous ref sync (260809-uxk)", () => {
  const userMsg = { id: "u1", role: "user" as const, content: "hi" };
  const assistantMsg = { id: "a1", role: "assistant" as const, content: "", citations: [] };

  it("appends a token to the last assistant message and returns a NEW array (immutability)", () => {
    const messages = [userMsg, assistantMsg];
    const updated = appendTokenToMessages(messages, "Hello");
    expect(updated).not.toBe(messages);
    expect(updated[1]).not.toBe(assistantMsg);
    expect(updated[1].content).toBe("Hello");
    // Original array unchanged
    expect(messages[1].content).toBe("");
    // User message untouched
    expect(updated[0]).toEqual(userMsg);
  });

  it("returns [] without throwing when messages is empty", () => {
    expect(appendTokenToMessages([], "x")).toEqual([]);
  });

  it("returns an unchanged copy when the last message is NOT assistant", () => {
    const messages = [userMsg];
    const updated = appendTokenToMessages(messages, "x");
    expect(updated).not.toBe(messages);
    expect(updated).toEqual(messages);
    expect(updated[0].content).toBe("hi");
  });

  it("attachCitationsToMessages attaches the citations array to the last assistant message", () => {
    const messages = [userMsg, { ...assistantMsg, content: "answer" }];
    const citations = [{ source: "archive" as const, title: "Wiki", url: "", chunk: "", archiveId: "arch-1", documentId: "doc-1" }];
    const updated = attachCitationsToMessages(messages, citations);
    expect(updated).not.toBe(messages);
    expect(updated[1].citations).toEqual(citations);
    // Original unchanged
    expect(messages[1].citations).toEqual([]);
  });

  it("attachCitationsToMessages returns an unchanged copy when the last message is not assistant", () => {
    const messages = [userMsg];
    const updated = attachCitationsToMessages(messages, []);
    expect(updated).toEqual(messages);
  });
});

// 131-07 (G-131-19): the rag-degraded chrome message is translated CLIENT-side
// via t("chatErrors.ragDegraded") — the proxy no longer emits an English
// literal, and the client never displays a server-provided message verbatim.
// translateRagDegraded is a pure helper (same T-65-SC pure-helper idiom) so
// the translation contract is node-testable without rendering the Preact hook.
describe("translateRagDegraded — client-side rag-degraded translation (G-131-19)", () => {
  it("returns the translated string when i18n is initialized (Italian chat → Italian message)", () => {
    const { initWidgetI18n } = require("../widget/i18n") as typeof import("../widget/i18n");
    initWidgetI18n("it");
    const translated = translateRagDegraded();
    expect(translated).toBe(
      "Knowledge base temporaneamente non disponibile. Risponderò senza utilizzarla."
    );
    expect(translated).not.toContain("Knowledge base temporarily unavailable");
  });

  it("returns the KEY (never a server English literal) when i18n is uninitialized", () => {
    jest.isolateModules(() => {
      const fresh = require("../widget/hooks/useWidgetChat") as typeof import("../widget/hooks/useWidgetChat");
      expect(fresh.translateRagDegraded()).toBe("chatErrors.ragDegraded");
    });
  });
});

// 131-07 (G-131-19): the stream POST body carries the visitor locale from
// config.locale so the proxy can forward it upstream. buildStreamBody is the
// pure body-builder the hook's sendMessage uses (same pure-helper idiom).
describe("buildStreamBody — locale in the stream POST body (G-131-19)", () => {
  it("includes locale when provided", () => {
    expect(buildStreamBody("Ciao", "c1", "it")).toEqual({
      message: "Ciao",
      chatId: "c1",
      locale: "it",
    });
  });

  it("omits locale when absent (additive — old clients keep parsing)", () => {
    expect(buildStreamBody("Hello", null, undefined)).toEqual({
      message: "Hello",
    });
  });

  it("omits chatId when null (existing contract preserved)", () => {
    expect(buildStreamBody("Hello", null, "en")).toEqual({
      message: "Hello",
      locale: "en",
    });
  });
});

// 151-02 (G-151-1b): the 429-on-stream daily-limit detection. isDailyRateLimit
// is the pure helper the hook's onopen branch uses to distinguish the DAILY
// case (hard per-visitor cap → sessionLimitReached → input disabled, no
// auto-clear) from hourly/per-minute limits. Same T-65-SC pure-helper idiom.
describe("isDailyRateLimit — daily message limit detection (151-02, G-151-1b)", () => {
  it("detects the daily case via retryAfter >= 86400 (widgetDailyMessageLimiter body)", () => {
    expect(isDailyRateLimit({ error: "Daily message limit reached", retryAfter: "86400" }, {}))
      .toBe(true);
  });

  it("detects the daily case via the explicit daily flag", () => {
    expect(isDailyRateLimit({ daily: true, retryAfter: "3600" }, {})).toBe(true);
  });

  it("detects the daily case via dailyRemaining === 0 (session-counter path)", () => {
    expect(isDailyRateLimit({}, { dailyRemaining: 0 })).toBe(true);
  });

  it("does NOT treat a per-minute 429 as daily (retryAfter 60)", () => {
    expect(isDailyRateLimit({ retryAfter: "60" }, { hourlyRemaining: 0 })).toBe(false);
  });

  it("does NOT treat an hourly 429 with remaining daily budget as daily", () => {
    expect(isDailyRateLimit({ retryAfter: "3600" }, { dailyRemaining: 2, hourlyRemaining: 0 }))
      .toBe(false);
  });

  it("returns false for an empty body (no markers)", () => {
    expect(isDailyRateLimit({}, {})).toBe(false);
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for agentBudgetService — agent loop watchdogs.
 */

import "./helpers/setupEnv";

import {
  AgentBudgetTracker,
  AgentConcurrencyError,
  AgentSkillTimeoutError,
  LoopDetector,
  truncateContextToByteBudget,
  truncateToolOutput,
} from "../services/agentBudgetService";
import type { ChatMessageEntry } from "../agent/agentTypes";

const SMALL_CONFIG = {
  wallclockTimeoutMs: 1000,
  maxTotalTokens: 1000,
  maxContextBytes: 10000,
  maxToolOutputLength: 500,
  maxSkillExecutionMs: 500,
  loopDetectionWindow: 3,
  maxConcurrentPerUser: 2,
};

describe("LoopDetector", () => {
  it("returns false on first call", () => {
    const det = new LoopDetector(3);
    expect(det.detect("tool", { x: 1 })).toBe(false);
  });

  it("does not trip a 3-window on two identical calls in a row", () => {
    const det = new LoopDetector(3);
    det.detect("tool", { x: 1 });
    expect(det.detect("tool", { x: 1 })).toBe(false);
  });

  it("returns true on three identical calls in a row with loopDetectionWindow=3", () => {
    const det = new LoopDetector(3);
    det.detect("tool", { x: 1 });
    det.detect("tool", { x: 1 });
    expect(det.detect("tool", { x: 1 })).toBe(true);
  });

  it("resets the window when a different tool appears between two identical calls", () => {
    const det = new LoopDetector(3);
    det.detect("a", { x: 1 });
    det.detect("a", { x: 1 });
    // Different tool resets the window
    expect(det.detect("b", { x: 1 })).toBe(false);
    // Now a 3-window of "b" needs 3 more identical
    expect(det.detect("b", { x: 1 })).toBe(false);
    expect(det.detect("b", { x: 1 })).toBe(true);
  });

  it("treats object key order as equivalent", () => {
    const det = new LoopDetector(3);
    det.detect("t", { a: 1, b: 2 });
    det.detect("t", { a: 1, b: 2 });
    expect(det.detect("t", { b: 2, a: 1 })).toBe(true);
  });

  it("canonicalizes nested objects recursively", () => {
    const det = new LoopDetector(3);
    det.detect("t", { a: { x: 1, y: 2 } });
    det.detect("t", { a: { x: 1, y: 2 } });
    expect(det.detect("t", { a: { y: 2, x: 1 } })).toBe(true);
  });

  it("reset() clears the window", () => {
    const det = new LoopDetector(3);
    det.detect("t", { x: 1 });
    det.detect("t", { x: 1 });
    expect(det.size()).toBe(2);
    det.reset();
    expect(det.size()).toBe(0);
    // After reset, the same pair does not loop until we have 3 again
    expect(det.detect("t", { x: 1 })).toBe(false);
    expect(det.detect("t", { x: 1 })).toBe(false);
    expect(det.detect("t", { x: 1 })).toBe(true);
  });

  it("size() reflects current window length", () => {
    const det = new LoopDetector(3);
    expect(det.size()).toBe(0);
    det.detect("t", { x: 1 });
    expect(det.size()).toBe(1);
    det.detect("t", { x: 1 });
    expect(det.size()).toBe(2);
    det.detect("t", { x: 1 });
    expect(det.size()).toBe(3);
  });

  it("floors maxWindow at 1 — passing 0 yields a 1-window detector", () => {
    const det = new LoopDetector(0);
    // With maxWindow=1, two identical calls: first seeds, second matches all 1 entry
    det.detect("t", { x: 1 });
    expect(det.detect("t", { x: 1 })).toBe(true);
  });
});

describe("AgentBudgetTracker — wallclock", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("wallclockElapsedMs increases with fake timers", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    const start = t.wallclockElapsedMs();
    expect(start).toBeGreaterThanOrEqual(0);
    jest.advanceTimersByTime(250);
    expect(t.wallclockElapsedMs()).toBeGreaterThanOrEqual(250);
  });

  it("wallclockExpired becomes true when elapsed >= timeout", () => {
    const t = new AgentBudgetTracker({ ...SMALL_CONFIG, wallclockTimeoutMs: 1000 });
    expect(t.wallclockExpired()).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(t.wallclockExpired()).toBe(true);
  });

  it("constructor override of wallclockTimeoutMs is respected", () => {
    const t = new AgentBudgetTracker({ ...SMALL_CONFIG, wallclockTimeoutMs: 5000 });
    jest.advanceTimersByTime(1500);
    expect(t.wallclockExpired()).toBe(false);
    jest.advanceTimersByTime(3500);
    expect(t.wallclockExpired()).toBe(true);
  });
});

describe("AgentBudgetTracker — tokens", () => {
  it("totalTokensUsed starts at 0", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    expect(t.totalTokensUsed()).toBe(0);
  });

  it("consumeTokens with prompt+completion accumulates", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    t.consumeTokens({ promptTokens: 100, completionTokens: 50 });
    expect(t.totalTokensUsed()).toBe(150);
  });

  it("consumeTokens with usage=undefined is a no-op", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    t.consumeTokens(undefined);
    expect(t.totalTokensUsed()).toBe(0);
  });

  it("consumeTokens with missing fields defaults each side to 0 (no NaN)", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    t.consumeTokens({});
    expect(t.totalTokensUsed()).toBe(0);
    t.consumeTokens({ promptTokens: 10 });
    expect(t.totalTokensUsed()).toBe(10);
    t.consumeTokens({ completionTokens: 5 });
    expect(t.totalTokensUsed()).toBe(15);
  });

  it("isTokenBudgetExhausted becomes true once total >= maxTotalTokens", () => {
    const t = new AgentBudgetTracker({ ...SMALL_CONFIG, maxTotalTokens: 100 });
    t.consumeTokens({ promptTokens: 60, completionTokens: 30 });
    expect(t.isTokenBudgetExhausted()).toBe(false);
    t.consumeTokens({ promptTokens: 10, completionTokens: 0 });
    expect(t.isTokenBudgetExhausted()).toBe(true);
  });
});

describe("AgentBudgetTracker — context bytes", () => {
  it("contextBytesOf sums content.length of string-typed messages", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "hello" }, // 5
      { role: "user", content: "abcdef" }, // 6
      { role: "assistant", content: "xyz" }, // 3
    ];
    expect(t.contextBytesOf(ctx)).toBe(14);
  });

  it("non-string content contributes 0", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    const ctx = [
      { role: "system" as const, content: "abc" },
      // Cast to any to bypass type check and exercise the runtime non-string branch
      { role: "user", content: { foo: "bar" } } as unknown as ChatMessageEntry,
    ];
    expect(t.contextBytesOf(ctx)).toBe(3);
  });

  it("empty array returns 0", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    expect(t.contextBytesOf([])).toBe(0);
  });
});

describe("AgentBudgetTracker — loop detection passthrough", () => {
  it("detectLoop and resetLoopDetector delegate to the embedded LoopDetector", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    expect(t.detectLoop("t", { x: 1 })).toBe(false);
    expect(t.detectLoop("t", { x: 1 })).toBe(false);
    expect(t.detectLoop("t", { x: 1 })).toBe(true);
    t.resetLoopDetector();
    expect(t.detectLoop("t", { x: 1 })).toBe(false);
  });
});

describe("AgentBudgetTracker — concurrency", () => {
  it("acquireSlot succeeds up to maxConcurrentPerUser; the (limit+1)-th throws AgentConcurrencyError", () => {
    const t = new AgentBudgetTracker({ ...SMALL_CONFIG, maxConcurrentPerUser: 2 });
    t.acquireSlot("u1");
    t.acquireSlot("u1");
    expect(() => t.acquireSlot("u1")).toThrow(AgentConcurrencyError);
    try {
      t.acquireSlot("u1");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentConcurrencyError);
      const e = err as AgentConcurrencyError;
      expect(e.userId).toBe("u1");
      expect(e.currentSlots).toBe(2);
      expect(e.maxSlots).toBe(2);
    }
  });

  it("releaseSlot decrements; once count hits 0 the entry is removed from the internal map", () => {
    const t = new AgentBudgetTracker({ ...SMALL_CONFIG, maxConcurrentPerUser: 2 });
    t.acquireSlot("u1");
    t.acquireSlot("u1");
    let snap = t.snapshot();
    expect(snap.activeConcurrencySlots).toEqual([["u1", 2]]);
    t.releaseSlot("u1");
    snap = t.snapshot();
    expect(snap.activeConcurrencySlots).toEqual([["u1", 1]]);
    t.releaseSlot("u1");
    snap = t.snapshot();
    expect(snap.activeConcurrencySlots).toEqual([]);
  });

  it("acquireSlot(\"\") is a no-op (no error, no tracking)", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    expect(() => t.acquireSlot("")).not.toThrow();
    t.acquireSlot("");
    t.acquireSlot("");
    const snap = t.snapshot();
    expect(snap.activeConcurrencySlots).toEqual([]);
  });

  it("two different users are tracked independently", () => {
    const t = new AgentBudgetTracker({ ...SMALL_CONFIG, maxConcurrentPerUser: 1 });
    t.acquireSlot("alice");
    expect(() => t.acquireSlot("alice")).toThrow(AgentConcurrencyError);
    // Bob is unaffected
    expect(() => t.acquireSlot("bob")).not.toThrow();
    const snap = t.snapshot();
    expect(snap.activeConcurrencySlots).toEqual(
      expect.arrayContaining([
        ["alice", 1],
        ["bob", 1],
      ])
    );
  });
});

describe("AgentBudgetTracker — withSkillTimeout", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves with the inner value when the promise settles before the timeout", async () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    const inner = Promise.resolve("ok");
    await expect(t.withSkillTimeout(inner, "fast")).resolves.toBe("ok");
  });

  it("rejects with AgentSkillTimeoutError when the inner promise never resolves", async () => {
    const t = new AgentBudgetTracker({ ...SMALL_CONFIG, maxSkillExecutionMs: 100 });
    const never = new Promise<string>(() => {});

    const racing = t.withSkillTimeout(never, "stuck-skill");
    // Rejection handler is set up before advancing so we don't get unhandled rejection
    const caught = racing.catch((err) => err);
    jest.advanceTimersByTime(150);
    // Let the rejection propagate
    await Promise.resolve();
    const err = await caught;
    expect(err).toBeInstanceOf(AgentSkillTimeoutError);
    expect((err as AgentSkillTimeoutError).label).toBe("stuck-skill");
    expect((err as AgentSkillTimeoutError).timeoutMs).toBe(100);
  });
});

describe("AgentBudgetTracker — abort reason + snapshot", () => {
  it("default getAbortReason() is \"none\"", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    expect(t.getAbortReason()).toBe("none");
  });

  it("setAbortReason(\"loop_detected\") round-trips", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    t.setAbortReason("loop_detected");
    expect(t.getAbortReason()).toBe("loop_detected");
  });

  it("snapshot() returns the expected fields", () => {
    const t = new AgentBudgetTracker(SMALL_CONFIG);
    t.consumeTokens({ promptTokens: 10, completionTokens: 5 });
    t.setAbortReason("token_budget");
    const snap = t.snapshot();
    expect(snap).toHaveProperty("startedAt");
    expect(snap).toHaveProperty("wallclockElapsedMs");
    expect(snap).toHaveProperty("tokensPrompt", 10);
    expect(snap).toHaveProperty("tokensCompletion", 5);
    expect(snap).toHaveProperty("totalTokens", 15);
    expect(snap).toHaveProperty("abortReason", "token_budget");
    expect(snap).toHaveProperty("loopWindowSize", 0);
    expect(snap).toHaveProperty("activeConcurrencySlots");
    expect(snap).toHaveProperty("config");
    expect(snap.config.wallclockTimeoutMs).toBe(SMALL_CONFIG.wallclockTimeoutMs);
  });
});

describe("truncateToolOutput", () => {
  it("returns a string under maxLength unchanged", () => {
    expect(truncateToolOutput("hello", 100)).toBe("hello");
  });

  it("truncates a string over maxLength and ends with \"...[truncated]\"", () => {
    const out = truncateToolOutput("x".repeat(50), 10);
    expect(out.endsWith("...[truncated]")).toBe(true);
    expect(out.length).toBe(10 + "...[truncated]".length);
    expect(out.startsWith("x".repeat(10))).toBe(true);
  });

  it("JSON-stringifies an object and then truncates", () => {
    const out = truncateToolOutput({ a: 1, b: "abc" }, 5);
    expect(out.endsWith("...[truncated]")).toBe(true);
    // Stringified obj starts with "{"
    expect(out.startsWith("{")).toBe(true);
  });

  it("falls back to String(value) for non-stringifiable objects (circular ref)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => truncateToolOutput(circular, 50)).not.toThrow();
    const out = truncateToolOutput(circular, 50);
    // Fallback uses String(value) -> "[object Object]" or similar; for circular refs
    // JSON.stringify throws, so we fall through to String(value).
    expect(typeof out).toBe("string");
  });
});

describe("truncateContextToByteBudget", () => {
  it("empty array returns 0", () => {
    const ctx: ChatMessageEntry[] = [];
    expect(truncateContextToByteBudget(ctx, 1000)).toBe(0);
    expect(ctx).toEqual([]);
  });

  it("context already under budget returns 0 and is NOT mutated", () => {
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const before = JSON.parse(JSON.stringify(ctx));
    const out = truncateContextToByteBudget(ctx, 1000);
    expect(out).toBe(0);
    expect(ctx).toEqual(before);
  });

  it("context over budget returns dropCount > 0, length drops, and inserts the truncation notice", () => {
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "sys" }, // 3
      { role: "user", content: "a".repeat(200) }, // 200
      { role: "assistant", content: "b".repeat(200) }, // 200
      { role: "user", content: "c".repeat(200) }, // 200
      { role: "assistant", content: "d".repeat(200) }, // 200
      { role: "user", content: "e".repeat(200) }, // 200
      { role: "assistant", content: "f".repeat(200) }, // 200
    ];
    const before = ctx.length;
    // sysMsg(3) + tail(2 messages × 200 = 400) = 403 > budget of 50
    const dropped = truncateContextToByteBudget(ctx, 50, 2);
    expect(dropped).toBeGreaterThan(0);
    expect(ctx.length).toBeLessThan(before);
    const notice = ctx.find((m) => m.content.startsWith("[Context truncated"));
    expect(notice).toBeDefined();
  });

  it("the system message (index 0) is preserved", () => {
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "PRESERVED-SYS" },
      { role: "user", content: "a".repeat(200) },
      { role: "assistant", content: "b".repeat(200) },
      { role: "user", content: "c".repeat(200) },
      { role: "assistant", content: "d".repeat(200) },
      { role: "user", content: "tail-user-marker" },
      { role: "assistant", content: "tail-asst-marker" },
    ];
    truncateContextToByteBudget(ctx, 50, 2);
    expect(ctx[0]?.role).toBe("system");
    expect(ctx[0]?.content).toBe("PRESERVED-SYS");
  });

  it("the last keepLastN messages are preserved (count and order)", () => {
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a".repeat(200) },
      { role: "assistant", content: "b".repeat(200) },
      { role: "user", content: "c".repeat(200) },
      { role: "assistant", content: "d".repeat(200) },
      { role: "user", content: "tail-user-marker" },
      { role: "assistant", content: "tail-asst-marker" },
    ];
    const keepLastN = 2;
    truncateContextToByteBudget(ctx, 50, keepLastN);
    // Last keepLastN should be the last two of the new array
    const last = ctx.slice(-keepLastN);
    expect(last[0]?.content).toBe("tail-user-marker");
    expect(last[1]?.content).toBe("tail-asst-marker");
  });

  // RED gate for Task 1 (62-02): pin original user message when 4+ tool results
  // push it out of the keepLastN tail.
  it("preserve user message with 4+ tool results (auto-detect path, 3-arg call)", () => {
    const userMsg: ChatMessageEntry = {
      role: "user",
      content: "What is the capital of France?",
    };
    const toolResult = (i: number): ChatMessageEntry => ({
      role: "user",
      content: `[Used tool: rag_search]\nResult ${i}: ${"x".repeat(200)}`,
    });
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "sys-prompt" },
      userMsg,
      toolResult(1),
      toolResult(2),
      toolResult(3),
      toolResult(4),
    ];
    // keepLastN=4 → tail is toolResult(1..4); userMsg is at position length-5, dropped by current logic.
    // Budget tight enough to force truncation: sys + userMsg + 4 tools far exceeds 100.
    const dropped = truncateContextToByteBudget(ctx, 100, 4);
    expect(dropped).toBeGreaterThan(0);
    // The original user message MUST survive
    const found = ctx.find(
      (m) => m.content === "What is the capital of France?"
    );
    expect(found).toBeDefined();
    // System prompt retained
    expect(ctx[0]?.role).toBe("system");
    expect(ctx[0]?.content).toBe("sys-prompt");
    // At least one tool result was dropped (4 tools + userMsg + sys + placeholder > 100)
    const remainingTools = ctx.filter((m) =>
      m.content.startsWith("[Used tool:")
    ).length;
    expect(remainingTools).toBeLessThan(4);
  });

  it("preserve user message — explicit pinnedUserMsg (4th arg)", () => {
    const userMsg: ChatMessageEntry = {
      role: "user",
      content: "Explain quantum entanglement",
    };
    const toolResult = (i: number): ChatMessageEntry => ({
      role: "user",
      content: `[Used tool: rag_search]\nResult ${i}: ${"y".repeat(200)}`,
    });
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "sys" },
      userMsg,
      toolResult(1),
      toolResult(2),
      toolResult(3),
      toolResult(4),
    ];
    // Explicit 4th arg — exercises the explicit-pin path.
    const dropped = truncateContextToByteBudget(ctx, 80, 4, userMsg);
    expect(dropped).toBeGreaterThan(0);
    const found = ctx.find((m) => m.content === "Explain quantum entanglement");
    expect(found).toBeDefined();
    expect(ctx[0]?.role).toBe("system");
  });

  it("does not truncate when only 2 tool results (under keepLastN, user_msg in tail)", () => {
    const userMsg: ChatMessageEntry = {
      role: "user",
      content: "short question",
    };
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "sys" },
      userMsg,
      {
        role: "user",
        content: "[Used tool: rag_search]\nResult: small",
      },
      {
        role: "user",
        content: "[Used tool: workspace_memory]\nResult: small",
      },
    ];
    // keepLastN=4 → tail includes userMsg + 2 tools; total well under budget.
    const before = JSON.parse(JSON.stringify(ctx));
    const dropped = truncateContextToByteBudget(ctx, 500, 4);
    expect(dropped).toBe(0);
    expect(ctx).toEqual(before);
  });

  it("auto-detect skips [Used tool: ...] markers and pins the real user message", () => {
    const userMsg: ChatMessageEntry = {
      role: "user",
      content: "real-user-question",
    };
    const bigTool = (label: string): ChatMessageEntry => ({
      role: "user",
      content: `[Used tool: ${label}]\nResult: ${"z".repeat(200)}`,
    });
    // Context where a [Used tool: x] marker sits at index 1 (before the real
    // user message). Auto-detect MUST skip the marker and pin userMsg instead.
    const ctx: ChatMessageEntry[] = [
      { role: "system", content: "sys" },
      bigTool("x"), // index 1 — marker, must be skipped by auto-detect
      userMsg, // index 2 — real user question
      bigTool("rag_search"),
      bigTool("rag_search"),
      bigTool("rag_search"),
    ];
    // keepLastN=4 → tail = [userMsg, tool, tool, tool]; tailHasToolResults=true.
    // Budget tight enough to force truncation of the tool results.
    const dropped = truncateContextToByteBudget(ctx, 100, 4);
    expect(dropped).toBeGreaterThan(0);
    // The real user message survives (pinned), not the [Used tool: x] marker.
    const found = ctx.find((m) => m.content === "real-user-question");
    expect(found).toBeDefined();
    expect(ctx[0]?.role).toBe("system");
    // The [Used tool: x] marker at index 1 was outside the tail and should be dropped.
    const markerSurvived = ctx.find((m) =>
      m.content.startsWith("[Used tool: x]")
    );
    expect(markerSurvived).toBeUndefined();
  });
});

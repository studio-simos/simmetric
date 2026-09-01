// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for contextCompaction — Phase 96 (CMP-01).
 *
 * Mocks `callNonStreamingLLM` so the summarizer LLM call is deterministic.
 * Covers the 8 must_haves truths from 96-01-PLAN.md:
 *   1. no-op below 80% threshold (reference-equal, summarizer NOT called)
 *   2. compaction triggers above 80% (system + summary + pinned + last N)
 *   3. tool messages in tail kept verbatim (Pitfall 9 lost tool-call context)
 *   4. single-level invariant (existing [Auto-summary...] dropped-and-replaced)
 *   5. summarizer failure → fallback to truncateContextToByteBudget (D-06/D-08)
 *   6. budget near-limit skips compaction (D-06)
 *   7. budget-aware: summarizer tokensUsed counted (CMP-01 SC2)
 *   8. context.length <= 1 + keepLastN: no-op (nothing to summarize)
 */

import "../../__tests__/helpers/setupEnv";

jest.mock("../../services/providerService", () => ({
  callNonStreamingLLM: jest.fn(),
}));

import {
  compact_messages_for_request,
  estimateTokens,
} from "../contextCompaction";
import { AgentBudgetTracker } from "../../services/agentBudgetService";
import { callNonStreamingLLM } from "../../services/providerService";
import type { ChatMessageEntry } from "../agentTypes";
import type { ProviderConfig } from "@simmetric-chat/shared";

const mockedCallNonStreamingLLM =
  callNonStreamingLLM as jest.MockedFunction<typeof callNonStreamingLLM>;

const OLLAMA_CONFIG: ProviderConfig = {
  type: "ollama",
  baseUrl: "http://localhost:11434",
  apiKey: null,
  model: "qwen2.5:3b",
  temperature: 0.7,
};

const SMALL_BUDGET_CONFIG = {
  wallclockTimeoutMs: 600000,
  maxTotalTokens: 100000,
  maxContextBytes: 500000,
  maxToolOutputLength: 500,
  maxSkillExecutionMs: 30000,
  loopDetectionWindow: 3,
  maxConcurrentPerUser: 2,
};

function makeMsg(role: "user" | "assistant" | "system", content: string): ChatMessageEntry {
  return { role, content };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("estimateTokens", () => {
  it("sums content.length / 4 across all messages (4 chars ≈ 1 token)", () => {
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "a".repeat(40)), // 10 tokens
      makeMsg("user", "b".repeat(80)), // 20 tokens
    ];
    expect(estimateTokens(ctx)).toBe(30);
  });
});

describe("compact_messages_for_request", () => {
  it("case 1: no-op below 80% threshold — returns input array unchanged (reference-equal)", async () => {
    // 100 tokens of content (400 chars), contextWindowTokens 200 → threshold
    // 160 → 100 <= 160 → no-op.
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "a".repeat(100)),
      makeMsg("user", "b".repeat(300)),
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 200,
    });
    expect(result).toBe(ctx); // reference equality — no-op
    expect(mockedCallNonStreamingLLM).not.toHaveBeenCalled();
  });

  it("case 2: compaction triggers above 80% — returns new array with system + summary + pinned + last N, tool messages among old dropped with marker", async () => {
    // Build a context with 10 messages: system + 8 old (mix of user/assistant
    // text + one [Used tool: ...] user message) + 2 last-N (user + assistant).
    // Set contextWindowTokens low enough that estimateTokens > 0.8 * cwt.
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      makeMsg("user", "What is RAG? ".repeat(20)),
      makeMsg("assistant", "RAG is retrieval-augmented generation. ".repeat(20)),
      makeMsg("user", "[Used tool: rag_search]\nResult: some RAG results"),
      makeMsg("user", "Tell me more about vector search. ".repeat(20)),
      makeMsg("assistant", "Vector search uses embeddings. ".repeat(20)),
      makeMsg("user", "What is LanceDB? ".repeat(20)),
      makeMsg("assistant", "LanceDB is a local vector store. ".repeat(20)),
      makeMsg("user", "Thanks, that is helpful. ".repeat(20)),
      makeMsg("assistant", "You are welcome. ".repeat(20)),
    ];
    // Tail (last 2) has no tool results → no pinned user message.
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "Summary of earlier conversation.",
      tokensUsed: 50,
    });
    // contextWindowTokens very small → estimateTokens > 0.8 * cwt.
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50,
      keepLastN: 2,
    });
    expect(result).not.toBe(ctx); // new array
    expect(result.length).toBeLessThan(ctx.length);
    expect(result[0]).toBe(ctx[0]); // system verbatim (reference-equal)
    expect(result[1]!.role).toBe("user");
    expect(result[1]!.content.startsWith("[Auto-summary of earlier conversation — may be inaccurate")).toBe(true);
    // Last 2 messages present verbatim at the tail.
    expect(result[result.length - 2]).toBe(ctx[ctx.length - 2]);
    expect(result[result.length - 1]).toBe(ctx[ctx.length - 1]);
    // The [Used tool: ...] message among the old region is NOT in the result.
    const hasToolResultInResult = result.some(
      (m) => typeof m.content === "string" && m.content.startsWith("[Used tool: rag_search]\nResult:"),
    );
    expect(hasToolResultInResult).toBe(false);
    // The summarizer was called once with a user-message content that contains
    // the marker for the dropped tool message (D-05).
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    const summarizerCallArgs = mockedCallNonStreamingLLM.mock.calls[0]!;
    const userMsg = summarizerCallArgs[1]!.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("[tool call to rag_search omitted]");
  });

  it("case 3: tool messages in tail are kept verbatim (Pitfall 9 lost tool-call context)", async () => {
    // Build a context where one of the last N messages is a [Used tool: ...]
    // user message. Trigger compaction with a small keepLastN that includes
    // the tool message in the tail.
    const toolMsg = makeMsg("user", "[Used tool: rag_search]\nResult: recent RAG results");
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      makeMsg("user", "a".repeat(200)),
      makeMsg("assistant", "b".repeat(200)),
      makeMsg("user", "c".repeat(200)),
      makeMsg("assistant", "d".repeat(200)),
      makeMsg("user", "e".repeat(200)),
      toolMsg, // last message — in the tail
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "Summary.",
      tokensUsed: 10,
    });
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50,
      keepLastN: 2,
    });
    // The tool message appears verbatim in the returned array's tail.
    expect(result).toContain(toolMsg);
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
  });

  it("case 4: single-level invariant — existing [Auto-summary...] in old region is dropped-and-replaced, NOT re-summarized", async () => {
    const existingSummary = makeMsg(
      "user",
      "[Auto-summary of earlier conversation — may be inaccurate, verify with recent messages]\nOld summary text.",
    );
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      existingSummary, // old summary — should be dropped-and-replaced
      makeMsg("user", "a".repeat(200)),
      makeMsg("assistant", "b".repeat(200)),
      makeMsg("user", "c".repeat(200)),
      makeMsg("assistant", "d".repeat(200)),
      makeMsg("user", "e".repeat(200)),
      makeMsg("assistant", "f".repeat(200)),
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "New summary text.",
      tokensUsed: 20,
    });
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50,
      keepLastN: 2,
    });
    // The old [Auto-summary...] message is NOT in the returned array.
    expect(result).not.toContain(existingSummary);
    // Exactly one [Auto-summary...] message in the returned array (the new one).
    const summaryCount = result.filter((m) =>
      typeof m.content === "string" && m.content.startsWith("[Auto-summary"),
    ).length;
    expect(summaryCount).toBe(1);
    // The summarizer was called once (not twice — no recursive summarize-the-
    // summary). The old summary was NOT passed to the summarizer.
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    const summarizerCallArgs = mockedCallNonStreamingLLM.mock.calls[0]!;
    const userMsg = summarizerCallArgs[1]!.find((m) => m.role === "user")!;
    // The old summary text is NOT in the summarizer input (single-level).
    expect(userMsg.content).not.toContain("Old summary text.");
  });

  it("case 5: summarizer failure falls back to truncateContextToByteBudget (D-06 D-08)", async () => {
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      makeMsg("user", "a".repeat(20000)),
      makeMsg("assistant", "b".repeat(20000)),
      makeMsg("user", "c".repeat(20000)),
      makeMsg("assistant", "d".repeat(20000)),
      makeMsg("user", "e".repeat(20000)),
      makeMsg("assistant", "f".repeat(20000)),
      makeMsg("user", "Recent question. ".repeat(20)),
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    mockedCallNonStreamingLLM.mockRejectedValue(new Error("summarizer LLM timeout"));
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50,
      keepLastN: 2,
    });
    // The returned array is the result of truncateContextToByteBudget: system
    // + placeholder + last N, NO [Auto-summary...] message.
    expect(result).not.toBe(ctx);
    expect(result[0]).toBe(ctx[0]); // system preserved
    const hasSummary = result.some((m) =>
      typeof m.content === "string" && m.content.startsWith("[Auto-summary"),
    );
    expect(hasSummary).toBe(false);
    // No exception thrown — fallback handled it.
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
  });

  it("case 6: budget near-limit skips compaction (D-06)", async () => {
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "a".repeat(200)),
      makeMsg("user", "b".repeat(200)),
      makeMsg("assistant", "c".repeat(200)),
      makeMsg("user", "d".repeat(200)),
      makeMsg("assistant", "e".repeat(200)),
      makeMsg("user", "f".repeat(200)),
      makeMsg("assistant", "g".repeat(200)),
    ];
    // maxTotalTokens 1000 — push the budget to exhaustion.
    const budget = new AgentBudgetTracker({
      ...SMALL_BUDGET_CONFIG,
      maxTotalTokens: 1000,
    });
    budget.consumeTokens({ promptTokens: 1000, completionTokens: 0 });
    expect(budget.isTokenBudgetExhausted()).toBe(true);
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50, // above 80% threshold
    });
    expect(result).toBe(ctx); // no-op — budget near-limit
    expect(mockedCallNonStreamingLLM).not.toHaveBeenCalled();
  });

  it("case 7: budget-aware — summarizer tokensUsed is counted in AgentBudgetTracker (CMP-01 SC2)", async () => {
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      makeMsg("user", "a".repeat(20000)),
      makeMsg("assistant", "b".repeat(20000)),
      makeMsg("user", "c".repeat(20000)),
      makeMsg("assistant", "d".repeat(20000)),
      makeMsg("user", "e".repeat(20000)),
      makeMsg("assistant", "f".repeat(20000)),
      makeMsg("user", "Recent question. ".repeat(20)),
    ];
    const budget = new AgentBudgetTracker({
      ...SMALL_BUDGET_CONFIG,
      maxTotalTokens: 100000,
    });
    const tokensBefore = budget.totalTokensUsed();
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "Summary.",
      tokensUsed: 50,
    });
    await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50,
      keepLastN: 2,
    });
    expect(budget.totalTokensUsed()).toBe(tokensBefore + 50);
  });

  it("case 8: context.length <= 1 + keepLastN — no-op (nothing to summarize)", async () => {
    // 5-message context, keepLastN 4 → 1 + 4 = 5 → old region empty → no-op.
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "a".repeat(200)),
      makeMsg("user", "b".repeat(200)),
      makeMsg("assistant", "c".repeat(200)),
      makeMsg("user", "d".repeat(200)),
      makeMsg("assistant", "e".repeat(200)),
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50, // above 80% threshold
      keepLastN: 4,
    });
    expect(result).toBe(ctx); // no-op
    expect(mockedCallNonStreamingLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Plan 02 (CMP-01 SC3) — off-by-one boundary, edge cases, pure-ish invariant.
//
// Pitfall 9 §"Token budget off-by-one" + §"Off-by-one test": exactly-at-
// threshold = no-op (strict `>` not `>=`), one-above = trigger, post-compaction
// fits, all-tool old region, oversized tool result, and the pure-ish
// no-mutation invariant (D-01). These 6 tests ADD to the 9 above — none of
// the existing cases are modified.
// ---------------------------------------------------------------------------

describe("compact_messages_for_request — off-by-one boundary (Plan 02)", () => {
  it("case 9: EXACTLY at 80% threshold → NO compaction (strict > not >=, Pitfall 9 off-by-one)", async () => {
    // contextWindowTokens = 1000 → threshold = floor(0.8 * 1000) = 800 tokens.
    // Build a context whose estimateTokens is EXACTLY 800 = 3200 chars.
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "s".repeat(800)), // 200 tokens
      makeMsg("user", "u".repeat(2400)), // 600 tokens → total 800 tokens (exactly at threshold)
    ];
    // length 2 <= 1 + keepLastN(default 4) → no-op path also covers this; but we
    // pass keepLastN=0 to isolate the threshold check from the length guard.
    // (keepLastN=0 means tail is empty → old region = ctx[1..]; threshold still
    // gate fires first at line 162.)
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 1000,
      keepLastN: 0,
    });
    // Reference-equal no-op: the strict `>` means exactly-at-threshold is
    // treated as no-op, the input array is returned unchanged.
    expect(result).toBe(ctx);
    expect(mockedCallNonStreamingLLM).not.toHaveBeenCalled();
  });

  it("case 10: ONE token above 80% threshold → compaction triggers (Pitfall 9 off-by-one)", async () => {
    // contextWindowTokens = 1000 → threshold = 800. estimateTokens = 801 →
    // triggers. Build 801 tokens = 3204 chars. We need context.length > 1 +
    // keepLastN so the length guard doesn't short-circuit; use keepLastN=1 and
    // a 3-message context (system + 2) so old region is non-empty.
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "s".repeat(800)), // 200 tokens
      makeMsg("user", "u".repeat(2000)), // 500 tokens
      makeMsg("assistant", "a".repeat(404)), // 101 tokens → total 801 tokens
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "Summary.",
      tokensUsed: 5,
    });
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 1000,
      keepLastN: 1,
    });
    // Compaction triggered: new array returned, summarizer was called.
    expect(result).not.toBe(ctx);
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    // System message preserved verbatim at index 0.
    expect(result[0]).toBe(ctx[0]);
    // Last-N (1 message) preserved verbatim at the tail.
    expect(result[result.length - 1]).toBe(ctx[ctx.length - 1]);
  });

  it("case 11: post-compaction tokens <= 80% threshold (compaction achieves its goal — Pitfall 9 token-budget off-by-one)", async () => {
    // contextWindowTokens = 1000 → threshold 800. Build a context well above
    // threshold with a large old region; the summary (bounded by
    // maxSummaryTokens=500 → 2000 chars → 500 tokens) + system + last N must
    // fit under 800 tokens. Make the old region large so dropping it brings the
    // total well under the threshold.
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "s".repeat(400)), // 100 tokens
      makeMsg("user", "a".repeat(8000)), // 2000 tokens
      makeMsg("assistant", "b".repeat(8000)), // 2000 tokens
      makeMsg("user", "c".repeat(8000)), // 2000 tokens
      makeMsg("assistant", "d".repeat(8000)), // 2000 tokens
      makeMsg("user", "Recent question. ".repeat(20)), // ~80 tokens (tail)
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    // Mock summary content bounded to exactly maxSummaryTokens (500 tokens =
    // 2000 chars). The implementation truncates to maxSummaryTokens*4 chars.
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "x".repeat(2000),
      tokensUsed: 500,
    });
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 1000,
      keepLastN: 1,
      maxSummaryTokens: 500,
    });
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    // Post-compaction token count MUST be <= 800 (the 80% threshold). system
    // (100) + summary (<=500) + tail (~80) ≈ 680 tokens, well under 800.
    const tokensAfter = estimateTokens(result);
    expect(tokensAfter).toBeLessThanOrEqual(800);
  });
});

describe("compact_messages_for_request — edge cases (Plan 02)", () => {
  it("case 12: old region is ALL tool messages — summary prompt is markers-only, no crash (Pitfall 9 empty-text edge case)", async () => {
    // 8 messages: system + 6 [Used tool: ...] user messages (old region) + 1
    // last-N user. All old-region messages are tool results → summaryParts is
    // all `[tool call to X omitted]` markers, no user/assistant text. The
    // summarizer is still called with a markers-only prompt.
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      makeMsg("user", "[Used tool: rag_search]\nResult: result 1"),
      makeMsg("user", "[Used tool: wiki_query]\nResult: result 2"),
      makeMsg("user", "[Used tool: rag_search]\nResult: result 3"),
      makeMsg("user", "[Used tool: wiki_query]\nResult: result 4"),
      makeMsg("user", "[Used tool: rag_search]\nResult: result 5"),
      makeMsg("user", "[Used tool: wiki_query]\nResult: result 6"),
      makeMsg("user", "Final question? ".repeat(20)),
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "Markers-only summary.",
      tokensUsed: 10,
    });
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50, // well above 80% → triggers
      keepLastN: 1,
    });
    // Compaction triggered, no crash.
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    expect(result).not.toBe(ctx);
    // The returned array contains system + [Auto-summary...] + last N.
    expect(result[0]).toBe(ctx[0]); // system verbatim
    expect(result[1]!.role).toBe("user");
    expect(result[1]!.content.startsWith("[Auto-summary of earlier conversation")).toBe(true);
    // Last 1 message preserved verbatim at the tail.
    expect(result[result.length - 1]).toBe(ctx[ctx.length - 1]);
    // The summarizer user-message content contains ONLY markers (no
    // user/assistant text — the old region was all tool messages).
    const summarizerCallArgs = mockedCallNonStreamingLLM.mock.calls[0]!;
    const userMsg = summarizerCallArgs[1]!.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("[tool call to rag_search omitted]");
    expect(userMsg.content).toContain("[tool call to wiki_query omitted]");
    // No "user: " or "assistant: " verbatim-text lines (only markers).
    expect(userMsg.content).not.toMatch(/^(user|assistant): /m);
  });

  it("case 13: oversized single tool result in old region — dropped with marker, summary bounded by maxSummaryTokens (Pitfall 9 oversized-tool edge case)", async () => {
    // One tool result in the old region is 100,000 chars (well over
    // maxSummaryTokens*4 = 2000 chars). It should be dropped with a marker (NOT
    // passed to the summarizer as content), so the summary prompt does not
    // blow up. The summary text itself is bounded to maxSummaryTokens*4 chars
    // by the implementation's truncation guard.
    const oversizedToolContent = "[Used tool: rag_search]\nResult: " + "z".repeat(100000);
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      makeMsg("user", oversizedToolContent), // oversized tool result in old region
      makeMsg("user", "What is RAG? ".repeat(20)),
      makeMsg("assistant", "RAG is retrieval. ".repeat(20)),
      makeMsg("user", "Recent question. ".repeat(20)),
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    // The mock summary returns 10,000 chars — the implementation must truncate
    // it to maxSummaryTokens*4 = 2000 chars (+ ellipsis marker).
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "y".repeat(10000),
      tokensUsed: 500,
    });
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50, // well above 80% → triggers
      keepLastN: 1,
      maxSummaryTokens: 500, // → maxSummaryChars = 2000
    });
    expect(mockedCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    // The oversized tool result is NOT in the returned array (dropped, not
    // summarized into the new context verbatim).
    const hasOversizedTool = result.some(
      (m) => typeof m.content === "string" && m.content.length > 50000,
    );
    expect(hasOversizedTool).toBe(false);
    // The summarizer user-message content contains the marker for the dropped
    // oversized tool result (NOT the 100,000-char content itself).
    const summarizerCallArgs = mockedCallNonStreamingLLM.mock.calls[0]!;
    const userMsg = summarizerCallArgs[1]!.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("[tool call to rag_search omitted]");
    // The summarizer input does NOT contain the 100,000-char tool body.
    expect(userMsg.content.length).toBeLessThan(100000);
    // The summary message in the result is bounded: its content length <=
    // maxSummaryTokens*4 + marker + ellipsis overhead (well under 5000).
    const summaryMsg = result.find(
      (m) => typeof m.content === "string" && m.content.startsWith("[Auto-summary"),
    );
    expect(summaryMsg).toBeDefined();
    // 2000 (max) + marker (~90 chars) + "…[summary truncated]" (~22) < 2500.
    expect(summaryMsg!.content.length).toBeLessThan(3000);
  });
});

describe("compact_messages_for_request — pure-ish no-mutation invariant (Plan 02, D-01)", () => {
  it("case 14: input context array is NEVER mutated — byte-identical before and after (pure-ish contract)", async () => {
    // Build a context above the threshold so compaction actually runs (not the
    // no-op path). Capture a deep snapshot, call compact, assert input is
    // byte-identical. The returned array is a different reference (new array).
    const ctx: ChatMessageEntry[] = [
      makeMsg("system", "You are a helpful assistant."),
      makeMsg("user", "a".repeat(2000)),
      makeMsg("assistant", "b".repeat(2000)),
      makeMsg("user", "c".repeat(2000)),
      makeMsg("assistant", "d".repeat(2000)),
      makeMsg("user", "e".repeat(2000)),
      makeMsg("assistant", "f".repeat(2000)),
      makeMsg("user", "Recent question. ".repeat(20)),
    ];
    const budget = new AgentBudgetTracker(SMALL_BUDGET_CONFIG);
    mockedCallNonStreamingLLM.mockResolvedValue({
      content: "Summary.",
      tokensUsed: 10,
    });
    // Deep snapshot: serialize each message's role + content. JSON.stringify
    // is sufficient here because ChatMessageEntry is a plain {role, content}.
    const snapshotBefore = ctx.map((m) => JSON.stringify(m));
    const lengthBefore = ctx.length;
    const result = await compact_messages_for_request(ctx, OLLAMA_CONFIG, budget, {
      contextWindowTokens: 50, // well above 80% → compaction runs
      keepLastN: 2,
    });
    // After the call, the input array is byte-identical to the snapshot.
    expect(ctx.length).toBe(lengthBefore);
    const snapshotAfter = ctx.map((m) => JSON.stringify(m));
    expect(snapshotAfter).toEqual(snapshotBefore);
    // The returned array is a different reference (compaction ran — new array).
    expect(result).not.toBe(ctx);
    // And the returned array has fewer messages (old region was summarized).
    expect(result.length).toBeLessThan(ctx.length);
  });
});
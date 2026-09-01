// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Per-provider reasoning parser unit tests (Phase 94, Plan 94-02).
 *
 * Pure-function coverage for:
 *   - parseDeepseekTag — backtick-fence tag state machine with cross-chunk buffering (RESEARCH A1)
 *   - parseGptOssHarmony — Harmony channel state machine (special tokens, NOT XML — D-02)
 *   - parseOpenAIReasoning — field-based delta.reasoning/reasoning_content + finish_reason mapping (D-04)
 *   - parseAnthropicThinkingDelta — field-based thinking_delta + stop_reason mapping (D-04)
 *   - parseNoop — content verbatim, thinking always "" (REAS-01 SC3)
 *   - resolveReasoningFormat — provider-type-aware: ollama always ollama-thinking; non-ollama checks MODEL_OVERRIDES first (RESEARCH §registry design)
 *
 * These tests do NOT exercise streamOpenAI/streamAnthropic/parseSSEStream threading — that is
 * covered additively in packages/server/src/__tests__/llmStreaming.test.ts. The parser functions
 * are pure and tested in isolation with a ParserState object threaded across calls.
 */
import {
  parseDeepseekTag,
  parseGptOssHarmony,
  parseOpenAIReasoning,
  parseAnthropicThinkingDelta,
  parseNoop,
  resolveReasoningFormat,
  type ParserState,
} from "../llmStreaming";

// Fresh state helper — each parser call mutates the state object (cross-chunk buffer).
function freshState(): ParserState {
  return { mode: "content", buffer: "" };
}

const FENCE = "```";

// ─── parseDeepseekTag — fence tag state machine (RESEARCH A1: tag is fence, not <reasoning>/lsa) ───

describe("parseDeepseekTag", () => {
  it("separates reasoning inside fence tags from content", () => {
    const state = freshState();
    const raw = "before " + FENCE + "reasoning here" + FENCE + " after";
    const out = parseDeepseekTag(state, raw);
    // Input has a space before the opening fence and a space after the closing
    // fence, so content is "before  after" (two spaces preserved).
    expect(out.content).toBe("before  after");
    expect(out.thinking).toBe("reasoning here");
  });

  it("no-tag content passes through verbatim", () => {
    const state = freshState();
    const out = parseDeepseekTag(state, "plain content");
    expect(out.content).toBe("plain content");
    expect(out.thinking).toBe("");
  });

  it("emits reasoning text immediately when no closing-tag prefix is present", () => {
    const state = freshState();
    // chunk1: "before " + fence + "reas" — the fence is intact, opens thinking mode.
    // After opening, "reas" follows. Since "reas" has no backtick prefix,
    // it is emitted as thinking immediately (only backtick tails are held back).
    const out1 = parseDeepseekTag(state, "before " + FENCE + "reas");
    expect(out1.content).toBe("before ");
    expect(out1.thinking).toBe("reas");
    const out2 = parseDeepseekTag(state, "oning here" + FENCE + " after");
    expect(out2.content).toBe(" after");
    expect(out2.thinking).toBe("oning here");
  });

  it("buffers a fence tag literally split across chunks (single backtick held back)", () => {
    // The opening fence itself is split: "before `" then "``reasoning``` after".
    const state = freshState();
    const out1 = parseDeepseekTag(state, "before `");
    // The trailing "`" is held back (could be the start of a fence tag).
    expect(out1.content).toBe("before ");
    expect(out1.thinking).toBe("");
    const out2 = parseDeepseekTag(state, "``reasoning" + FENCE + " after");
    expect(out2.content).toBe(" after");
    expect(out2.thinking).toBe("reasoning");
  });

  it("handles multiple tag pairs in one chunk", () => {
    const state = freshState();
    const out = parseDeepseekTag(state, "a" + FENCE + "r1" + FENCE + "b" + FENCE + "r2" + FENCE + "c");
    expect(out.content).toBe("abc");
    expect(out.thinking).toBe("r1r2");
  });

  it("emits thinking for an unclosed tag (no premature drop)", () => {
    const state = freshState();
    const out = parseDeepseekTag(state, "before " + FENCE + "ongoing reasoning with no close");
    // Opening tag found → content "before " emitted, mode switches to thinking.
    // The reasoning text is emitted except for any trailing backtick-prefix
    // that could be the start of a closing fence tag. Since the tail here has
    // no backtick, the entire reasoning is emitted.
    expect(out.content).toBe("before ");
    expect(out.thinking.length).toBeGreaterThan(0);
  });
});

// ─── parseGptOssHarmony — channel state machine (NOT XML — D-02) ───

describe("parseGptOssHarmony", () => {
  it("routes analysis channel to thinking and final channel to content", () => {
    const state = freshState();
    const raw =
      "<|channel|>analysis<|message|>reasoning<|end|><|channel|>final<|message|>answer<|return|>";
    const out = parseGptOssHarmony(state, raw);
    expect(out.content).toBe("answer");
    expect(out.thinking).toBe("reasoning");
  });

  it("does NOT emit commentary channel content as content or thinking (tool-call territory — D-02)", () => {
    const state = freshState();
    const raw =
      "<|channel|>analysis<|message|>think<|end|><|channel|>commentary<|message|>tool_call_payload<|end|><|channel|>final<|message|>answer<|return|>";
    const out = parseGptOssHarmony(state, raw);
    expect(out.content).toBe("answer");
    expect(out.thinking).toBe("think");
    // commentary content is NOT in content or thinking — it's left for parseToolCall L3.
  });

  it("handles <|end|> termination and <|return|> terminal token", () => {
    const state = freshState();
    const raw = "<|channel|>final<|message|>done<|return|>";
    const out = parseGptOssHarmony(state, raw);
    expect(out.content).toBe("done");
    expect(out.thinking).toBe("");
  });

  it("buffers a <|channel|> token split across chunks (partial-token buffering)", () => {
    const state = freshState();
    // Split the "<|channel|>analysis<|message|>" token across two chunks.
    const out1 = parseGptOssHarmony(state, "<|chan");
    // Nothing certain yet — buffer holds the partial token. Nothing emitted.
    expect(out1.content).toBe("");
    expect(out1.thinking).toBe("");
    const out2 = parseGptOssHarmony(state, "nel|>analysis<|message|>reasoning<|end|>");
    expect(out2.thinking).toBe("reasoning");
    expect(out2.content).toBe("");
  });

  it("emits content only in final channel (analysis-only chunk → thinking only)", () => {
    const state = freshState();
    const out = parseGptOssHarmony(state, "<|channel|>analysis<|message|>just thinking<|end|>");
    expect(out.thinking).toBe("just thinking");
    expect(out.content).toBe("");
  });
});

// ─── parseOpenAIReasoning — field-based, no tag parsing (RESEARCH §OpenAI wire format) ───

describe("parseOpenAIReasoning", () => {
  it("reads delta.reasoning as thinking and delta.content as content", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: { reasoning: "think", content: "ans" } }],
    });
    expect(out.content).toBe("ans");
    expect(out.thinking).toBe("think");
  });

  it("reads delta.reasoning_content as thinking (DeepSeek API compatibility)", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: { reasoning_content: "think" } }],
    });
    expect(out.content).toBe("");
    expect(out.thinking).toBe("think");
  });

  it("maps finish_reason stop → doneReason stop", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    expect(out.doneReason).toBe("stop");
  });

  it("maps finish_reason length → doneReason length", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: {}, finish_reason: "length" }],
    });
    expect(out.doneReason).toBe("length");
  });

  it("maps finish_reason tool_calls → doneReason stop (normal termination — D-04)", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    });
    expect(out.doneReason).toBe("stop");
  });

  it("maps finish_reason content_filter → doneReason error (more informative for fallback — RESEARCH §done_reason)", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: {}, finish_reason: "content_filter" }],
    });
    expect(out.doneReason).toBe("error");
  });

  it("maps finish_reason function_call → doneReason stop", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: {}, finish_reason: "function_call" }],
    });
    expect(out.doneReason).toBe("stop");
  });

  it("doneReason undefined when finish_reason absent", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: { content: "ans" } }],
    });
    expect(out.doneReason).toBeUndefined();
  });

  it("no reasoning field → thinking empty (noop-like for content)", () => {
    const out = parseOpenAIReasoning({
      choices: [{ delta: { content: "just content" } }],
    });
    expect(out.content).toBe("just content");
    expect(out.thinking).toBe("");
  });
});

// ─── parseAnthropicThinkingDelta — field-based thinking_delta + stop_reason mapping ───

describe("parseAnthropicThinkingDelta", () => {
  it("reads thinking_delta as thinking", () => {
    const out = parseAnthropicThinkingDelta({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "reason" },
    });
    expect(out.content).toBe("");
    expect(out.thinking).toBe("reason");
  });

  it("reads text_delta as content", () => {
    const out = parseAnthropicThinkingDelta({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "ans" },
    });
    expect(out.content).toBe("ans");
    expect(out.thinking).toBe("");
  });

  it("maps stop_reason end_turn → doneReason stop", () => {
    const out = parseAnthropicThinkingDelta({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    });
    expect(out.doneReason).toBe("stop");
  });

  it("maps stop_reason max_tokens → doneReason length", () => {
    const out = parseAnthropicThinkingDelta({
      type: "message_delta",
      delta: { stop_reason: "max_tokens" },
    });
    expect(out.doneReason).toBe("length");
  });

  it("maps stop_reason tool_use → doneReason stop (normal termination — D-04)", () => {
    const out = parseAnthropicThinkingDelta({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    });
    expect(out.doneReason).toBe("stop");
  });

  it("maps stop_reason stop_sequence → doneReason stop", () => {
    const out = parseAnthropicThinkingDelta({
      type: "message_delta",
      delta: { stop_reason: "stop_sequence" },
    });
    expect(out.doneReason).toBe("stop");
  });

  it("doneReason undefined when stop_reason absent", () => {
    const out = parseAnthropicThinkingDelta({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "ans" },
    });
    expect(out.doneReason).toBeUndefined();
  });

  it("no thinking_delta/text_delta → empty content and thinking (noop)", () => {
    const out = parseAnthropicThinkingDelta({
      type: "content_block_start",
    });
    expect(out.content).toBe("");
    expect(out.thinking).toBe("");
    expect(out.doneReason).toBeUndefined();
  });
});

// ─── parseNoop — content verbatim, thinking always "" (REAS-01 SC3) ───

describe("parseNoop", () => {
  it("forwards content verbatim", () => {
    const state = freshState();
    const out = parseNoop(state, "anything");
    expect(out.content).toBe("anything");
    expect(out.thinking).toBe("");
  });

  it("thinking is always empty string regardless of input", () => {
    const state = freshState();
    const out = parseNoop(state, FENCE + "would-be-thinking" + FENCE + " but noop ignores it");
    expect(out.thinking).toBe("");
    expect(out.content).toBe(FENCE + "would-be-thinking" + FENCE + " but noop ignores it");
  });
});

// ─── resolveReasoningFormat — provider-type-aware registry (RESEARCH §registry design) ───

describe("resolveReasoningFormat", () => {
  it("ollama always returns ollama-thinking (even for gpt-oss model name)", () => {
    expect(resolveReasoningFormat("ollama", "gpt-oss:120b")).toBe("ollama-thinking");
  });

  it("ollama always returns ollama-thinking (even for deepseek-r1 model name)", () => {
    expect(resolveReasoningFormat("ollama", "deepseek-r1:70b")).toBe("ollama-thinking");
  });

  it("openai + gpt-oss model → gpt-oss-harmony (OpenAI-compatible needs token parser)", () => {
    expect(resolveReasoningFormat("openai", "gpt-oss-120b")).toBe("gpt-oss-harmony");
  });

  it("openrouter + gpt-oss model → gpt-oss-harmony", () => {
    expect(resolveReasoningFormat("openrouter", "gpt-oss-120b")).toBe("gpt-oss-harmony");
  });

  it("openai + deepseek-r1 model → deepseek-tag (OpenAI-compatible needs fence tag parser)", () => {
    expect(resolveReasoningFormat("openai", "deepseek-r1:70b")).toBe("deepseek-tag");
  });

  it("openai + generic model → openai-reasoning (provider-type default)", () => {
    expect(resolveReasoningFormat("openai", "gpt-4o")).toBe("openai-reasoning");
  });

  it("anthropic → anthropic-thinking-delta", () => {
    expect(resolveReasoningFormat("anthropic", "claude-3-5-sonnet")).toBe(
      "anthropic-thinking-delta",
    );
  });

  it("openrouter (generic model) → openai-reasoning (OpenAI-compatible)", () => {
    expect(resolveReasoningFormat("openrouter", "some-model")).toBe("openai-reasoning");
  });

  it("gemini → noop (no known reasoning field)", () => {
    expect(resolveReasoningFormat("gemini", "gemini-1.5-pro")).toBe("noop");
  });

  it("unknown provider → noop (no regression)", () => {
    expect(resolveReasoningFormat("unknown", "anything")).toBe("noop");
  });
});
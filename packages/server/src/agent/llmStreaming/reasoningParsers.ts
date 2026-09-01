// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Reasoning format parsers (Phase 94 / 94-02).
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).
// Each provider's reasoning wire-format maps onto the ParserState /
// ParsedChunk / DoneReason contract defined in ./types.

import type { DoneReason, ParserState, ParsedChunk, ReasoningFormat } from "./types";

// D-01 (Phase 94): provider-type-aware registry. Ollama always uses
// field-based parsing (ollama-js separates `message.thinking` internally,
// even for gpt-oss/Deepseek via Ollama). Non-Ollama providers consult
// MODEL_OVERRIDES first (Plan 94-02 adds gpt-oss/deepseek overrides). Unknown
// provider types default to `noop` (no regression).
const REASONING_FORMAT_REGISTRY: Record<string, ReasoningFormat> = {
  ollama: "ollama-thinking",
  openai: "openai-reasoning",
  openrouter: "openai-reasoning",
  anthropic: "anthropic-thinking-delta",
  gemini: "noop",
  xiaomi: "noop",
  minimax: "noop",
};

// D-01 (Phase 94, populated 94-02): model-name pattern overrides checked ONLY
// for non-Ollama providers (RESEARCH §registry design provider-type-aware).
// gpt-oss via OpenAI-compatible endpoint needs the Harmony token parser
// (via Ollama it uses ollama-thinking — Ollama parses Harmony internally).
// Deepseek-R1 via OpenAI-compatible needs the ``` tag parser (via Ollama
// it uses ollama-thinking — Ollama separates via the thinking field).
const MODEL_OVERRIDES: { pattern: RegExp; format: ReasoningFormat }[] = [
  { pattern: /gpt-oss/i, format: "gpt-oss-harmony" },
  { pattern: /deepseek.*r1/i, format: "deepseek-tag" },
];

// D-01 (Phase 94): resolve the reasoning parser for a given provider + model.
// Provider-type aware: `ollama` always returns `ollama-thinking` (Ollama
// parses Harmony internally for gpt-oss, separates Deepseek-R1 via the
// `thinking` field — RESEARCH §registry design). Non-Ollama providers
// consult MODEL_OVERRIDES first (more specific), then
// REASONING_FORMAT_REGISTRY, then `noop`.
export function resolveReasoningFormat(providerType: string, model: string): ReasoningFormat {
  if (providerType === "ollama") return "ollama-thinking";
  for (const override of MODEL_OVERRIDES) {
    if (override.pattern.test(model)) return override.format;
  }
  return REASONING_FORMAT_REGISTRY[providerType] ?? "noop";
}

// D-01 (Phase 94): no-op parser for models without reasoning. Forwards
// content verbatim, thinking always empty string (REAS-01 SC3 no
// regression). The `_state` arg is unused but kept for signature symmetry
// with tag-based parsers.
export function parseNoop(_state: ParserState, content: string): ParsedChunk {
  return { content, thinking: "" };
}

// D-01 (Phase 94): Ollama thinking-field reader. ollama-js exposes
// `chunk.message.thinking` natively — no tag parsing needed (Ollama parses
// Harmony internally for gpt-oss, separates Deepseek-R1 via `think=true`).
// Reads `done_reason` on the final chunk and maps to DoneReason (REAS-02
// SC2 enum 5 values). Unknown values → undefined (graceful).
//
// Phase 158: exported so ollamaParser.ts can call it directly (it was an
// internal helper in the original god-file; the split surfaces it for the
// per-provider module).
export function parseOllamaThinking(chunk: {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
}): ParsedChunk & { doneReason?: DoneReason } {
  const content = chunk.message?.content ?? "";
  const thinking = chunk.message?.thinking ?? "";
  let doneReason: DoneReason | undefined;
  if (chunk.done && chunk.done_reason) {
    switch (chunk.done_reason) {
      case "stop":
      case "length":
      case "unload":
      case "load":
        doneReason = chunk.done_reason;
        break;
      default:
        doneReason = undefined;
    }
  }
  return { content, thinking, doneReason };
}

// Returns the length of the longest suffix of `text` that is a prefix of
// `tag`. Used to hold back only the chars that could be the start of a
// partial tag split across chunks (avoids over-buffering when the tail
// cannot possibly be a tag start — e.g. " after" needs zero buffering for
// the "```" tag).
// Intentionally not exported — internal helper of the stream parsers below
// (Phase 180 sweep: the export had no external consumers).
function partialTagSuffixLen(text: string, tag: string): number {
  const maxLen = Math.min(text.length, tag.length - 1);
  for (let len = maxLen; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

// D-01 (Phase 94, 94-02): Deepseek ```...``` tag state machine.
// RESEARCH A1 correction: the tag is ``` (NOT `<reasoning>` or `lsa`).
// When served via OpenAI-compatible API (NOT Ollama), reasoning is wrapped
// in ```...``` inside the content field. The tag CAN split across chunks,
// so the parser buffers a tail of up to 2 chars (the longest partial ``` —
// "`" or "``") and only emits a safe prefix. The state machine toggles
// `mode` between "content" and "thinking" across chunks.
//
// The parser mutates `state` (mode + buffer) across calls — callers pass a
// persistent ParserState object for the lifetime of one stream.
export function parseDeepseekTag(state: ParserState, rawChunk: string): ParsedChunk {
  const TAG = "```";
  state.buffer += rawChunk;
  let content = "";
  let thinking = "";

  while (state.buffer.length > 0) {
    if (state.mode === "content") {
      const thinkStart = state.buffer.indexOf(TAG);
      if (thinkStart === -1) {
        const hold = partialTagSuffixLen(state.buffer, TAG);
        const safeEnd = state.buffer.length - hold;
        content += state.buffer.slice(0, safeEnd);
        state.buffer = state.buffer.slice(safeEnd);
        break;
      }
      content += state.buffer.slice(0, thinkStart);
      state.buffer = state.buffer.slice(thinkStart + TAG.length);
      state.mode = "thinking";
    } else {
      const thinkEnd = state.buffer.indexOf(TAG);
      if (thinkEnd === -1) {
        const hold = partialTagSuffixLen(state.buffer, TAG);
        const safeEnd = state.buffer.length - hold;
        thinking += state.buffer.slice(0, safeEnd);
        state.buffer = state.buffer.slice(safeEnd);
        break;
      }
      thinking += state.buffer.slice(0, thinkEnd);
      state.buffer = state.buffer.slice(thinkEnd + TAG.length);
      state.mode = "content";
    }
  }

  return { content, thinking };
}

// D-02 (Phase 94, 94-02): gpt-oss Harmony channel state machine.
// RESEARCH §gpt-oss Harmony: Harmony uses BPE special tokens (NOT XML).
// Channels: analysis → thinking, final → content, commentary → NOT emitted
// (tool-call territory — parseToolCall L3 handles it, per D-02 the Harmony
// parser is separation-only). <|end|> → outside, <|return|> → terminal.
export function parseGptOssHarmony(state: ParserState, rawChunk: string): ParsedChunk {
  let mode = state.mode;

  state.buffer += rawChunk;
  let content = "";
  let thinking = "";

  const CHANNEL_PREFIX = "<|channel|>";
  const MESSAGE_TOKEN = "<|message|>";
  const END_TOKEN = "<|end|>";
  const RETURN_TOKEN = "<|return|>";

  while (state.buffer.length > 0) {
    const channelIdx = state.buffer.indexOf(CHANNEL_PREFIX);
    const endIdx = state.buffer.indexOf(END_TOKEN);
    const returnIdx = state.buffer.indexOf(RETURN_TOKEN);

    let nearestIdx = -1;
    let nearestKind: "channel" | "end" | "return" | null = null;
    if (channelIdx !== -1) {
      nearestIdx = channelIdx;
      nearestKind = "channel";
    }
    if (endIdx !== -1 && (nearestIdx === -1 || endIdx < nearestIdx)) {
      nearestIdx = endIdx;
      nearestKind = "end";
    }
    if (returnIdx !== -1 && (nearestIdx === -1 || returnIdx < nearestIdx)) {
      nearestIdx = returnIdx;
      nearestKind = "return";
    }

    if (nearestIdx === -1 || nearestKind === null) {
      const hold = Math.min(
        state.buffer.length,
        partialTagSuffixLen(state.buffer, CHANNEL_PREFIX) ||
          partialTagSuffixLen(state.buffer, END_TOKEN) ||
          partialTagSuffixLen(state.buffer, RETURN_TOKEN) ||
          partialTagSuffixLen(state.buffer, MESSAGE_TOKEN),
      );
      const safeEnd = state.buffer.length - hold;
      const safe = state.buffer.slice(0, safeEnd);
      state.buffer = state.buffer.slice(safeEnd);
      if (mode === "thinking") thinking += safe;
      else if (mode === "content") content += safe;
      break;
    }

    const before = state.buffer.slice(0, nearestIdx);
    if (mode === "thinking") thinking += before;
    else if (mode === "content") content += before;

    if (nearestKind === "channel") {
      const afterChannel = state.buffer.slice(nearestIdx + CHANNEL_PREFIX.length);
      const messageIdx = afterChannel.indexOf(MESSAGE_TOKEN);
      if (messageIdx === -1) {
        state.buffer = state.buffer.slice(nearestIdx);
        break;
      }
      const channelName = afterChannel.slice(0, messageIdx).trim();
      state.buffer = afterChannel.slice(messageIdx + MESSAGE_TOKEN.length);
      if (channelName === "analysis") {
        mode = "thinking";
      } else if (channelName === "final") {
        mode = "content";
      } else if (channelName === "commentary") {
        mode = "commentary";
      } else {
        mode = "content";
      }
      state.mode = mode;
    } else if (nearestKind === "end") {
      state.buffer = state.buffer.slice(nearestIdx + END_TOKEN.length);
      mode = "content";
      state.mode = mode;
    } else if (nearestKind === "return") {
      state.buffer = state.buffer.slice(nearestIdx + RETURN_TOKEN.length);
      mode = "content";
      state.mode = mode;
    }
  }

  return { content, thinking };
}

// D-01 (Phase 94, 94-02): OpenAI reasoning field reader. Field-based, no tag
// parsing (RESEARCH §OpenAI wire format). Reads `delta.reasoning` OR
// `delta.reasoning_content` (some OpenAI-compatible providers like DeepSeek
// API expose the latter). Maps `finish_reason` to DoneReason:
//   stop → stop, length → length, tool_calls → stop (normal — D-04),
//   content_filter → error (more informative for fallback — RESEARCH
//   §done_reason mapping), function_call → stop. Unknown → undefined.
export function parseOpenAIReasoning(chunk: {
  choices?: Array<{
    delta?: { content?: string; reasoning?: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
}): ParsedChunk & { doneReason?: DoneReason } {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const content = delta?.content ?? "";
  const thinking = delta?.reasoning ?? delta?.reasoning_content ?? "";

  let doneReason: DoneReason | undefined;
  const finishReason = choice?.finish_reason;
  if (finishReason) {
    switch (finishReason) {
      case "stop":
        doneReason = "stop";
        break;
      case "length":
        doneReason = "length";
        break;
      case "tool_calls":
      case "function_call":
        doneReason = "stop";
        break;
      case "content_filter":
        doneReason = "error";
        break;
      default:
        doneReason = undefined;
    }
  }

  return { content, thinking, doneReason };
}

// D-01 (Phase 94, 94-02): Anthropic thinking_delta reader. Field-based, no
// tag parsing (RESEARCH §Anthropic wire format). Reads `thinking_delta`
// events as thinking, `text_delta` events as content. Maps `stop_reason`
// from `message_delta` to DoneReason: end_turn → stop, max_tokens → length,
// tool_use → stop (normal — D-04), stop_sequence → stop. Unknown → undefined.
export function parseAnthropicThinkingDelta(chunk: {
  type?: string;
  delta?: { type?: string; thinking?: string; text?: string; stop_reason?: string };
}): ParsedChunk & { doneReason?: DoneReason } {
  let content = "";
  let thinking = "";
  let doneReason: DoneReason | undefined;

  if (chunk.type === "content_block_delta" && chunk.delta) {
    if (chunk.delta.type === "thinking_delta") {
      thinking = chunk.delta.thinking ?? "";
    } else if (chunk.delta.type === "text_delta") {
      content = chunk.delta.text ?? "";
    }
  }

  if (chunk.type === "message_delta" && chunk.delta?.stop_reason) {
    switch (chunk.delta.stop_reason) {
      case "end_turn":
      case "tool_use":
      case "stop_sequence":
        doneReason = "stop";
        break;
      case "max_tokens":
        doneReason = "length";
        break;
      default:
        doneReason = undefined;
    }
  }

  return { content, thinking, doneReason };
}
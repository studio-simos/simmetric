// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Shared types for the LLM streaming layer.
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).
// Pure types — no runtime imports. AnthropicTool (originally at line 516,
// inside the toolBuilders region) lives here so toolBuilders.ts can import it
// as a type without a cross-dependency on the parser modules.

/**
 * Anthropic tool shape for native function calling (Phase 95-03 / D-08).
 * Anthropic tool shape: `{ name, description, input_schema: { type: "object",
 * properties: {...} } }`. The `input_schema` with `type: "object"` is REQUIRED by
 * the Anthropic API (unlike OpenAI which accepts tools without parameters).
 *
 * Uses a local `AnthropicTool` type (the ollama-js `Tool` type has shape
 * `{ type: "function", function: { name, description } }` which is NOT the
 * Anthropic shape). `streamAnthropic` accepts `unknown[]` for its `tools` param
 * to avoid type friction at the dispatcher seam.
 *
 * Phase 95-05: `input_schema` now carries the full schema (type, properties,
 * required) from `skill.inputSchema` verbatim when present, instead of the
 * empty-properties placeholder. The `properties` field type is widened from
 * `Record<string, never>` to `Record<string, unknown>` to accept the JSON
 * Schema property descriptors.
 */
export interface AnthropicTool {
  name: string;
  description: string;
  // Phase 95-05: opaque JSON Schema descriptor passed verbatim to the
  // Anthropic API. Typed `Record<string, unknown>` (not a structural
  // `{ type, properties }` shape) because the schema flows from
  // `skill.inputSchema` unchanged — the server does not introspect it.
  input_schema: Record<string, unknown>;
}

export interface ChatMessageEntry {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamingLLMResult {
  content: string;
  toolCall: { toolName: string; toolInput: Record<string, unknown> } | null;
  usage: { promptTokens: number; completionTokens: number };
  // D-04 (Phase 94): additive optional — per-provider normalized termination
  // reason. Ollama `done_reason`, OpenAI `finish_reason`, Anthropic
  // `stop_reason` all map to this enum. `undefined` when not mappable (old
  // clients graceful; auto-fallback uses existing heuristic per D-05).
  doneReason?: DoneReason;
}

export type OnTokenCallback = (token: string) => void;
// D-01 (Phase 94): mirror of OnTokenCallback for separated reasoning. The
// callback ALWAYS fires when a provider yields reasoning (Ollama
// `message.thinking`); chat.ts checks `include_thinking` before emitting the
// SSE `thinking` event (opt-in gate, Pitfall 4 safety net).
export type OnThinkingCallback = (thinking: string) => void;

// D-04 (Phase 94): normalized termination reason enum (5 values, REAS-02 SC2).
// Per-provider mapping table centralizes the normalization — see
// parseOllamaThinking and (Plan 94-02) parseOpenAIReasoning /
// parseAnthropicThinkingDelta. `error` covers OpenAI `content_filter`
// (more informative for auto-fallback than `stop`).
export type DoneReason = "stop" | "length" | "unload" | "load" | "error";

// D-01 (Phase 94, expanded 94-02): the reasoning format selected by the
// registry. `noop` is the default for models without reasoning (forwards
// content verbatim, thinking always "" — REAS-01 SC3 no regression).
// `ollama-thinking` reads `chunk.message.thinking` (ollama-js native —
// Ollama parses Harmony internally for gpt-oss, separates Deepseek-R1 via
// think=true). `deepseek-tag` parses ```...``` tags (RESEARCH A1: tag is
// ```, NOT `<reasoning>`/`lsa`). `gpt-oss-harmony` is the Harmony channel
// state machine (NOT XML — D-02). `openai-reasoning` reads
// `delta.reasoning`/`delta.reasoning_content`. `anthropic-thinking-delta`
// reads `thinking_delta` events.
export type ReasoningFormat =
  | "noop"
  | "ollama-thinking"
  | "deepseek-tag"
  | "gpt-oss-harmony"
  | "openai-reasoning"
  | "anthropic-thinking-delta";

// D-01 (Phase 94): parser state for cross-chunk buffering. Tag-based
// parsers (Deepseek fence, gpt-oss Harmony) use `mode` + `buffer` to hold
// partial tags across chunks. Field-based parsers (Ollama `thinking`,
// OpenAI `reasoning_content`, Anthropic `thinking_delta`) do NOT need
// state — they read the field directly. The `mode` union includes
// "commentary" for the gpt-oss Harmony parser (D-02 — commentary channel
// content is NOT emitted as content or thinking; tool-call territory).
export interface ParserState {
  mode: "content" | "thinking" | "commentary";
  buffer: string;
}

export interface ParsedChunk {
  content: string;
  thinking: string;
}
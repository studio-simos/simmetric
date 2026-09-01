// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Native tool-calls plumbing (Phase 92-05, OJ-02 + Phase 95).
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).
// buildProviderTools dispatches per-provider tool-shape builders; the
// normalize* functions map native tool_calls[] to the frozen dispatch shape.
// AnthropicTool (originally inline here) lives in ./types per the split plan.

import type { Tool } from "ollama";
import { nativeToolCallSchema } from "@simmetric-chat/shared";
import type { AnthropicTool } from "./types";

// ===== Native tool-calls plumbing (Phase 92-05, OJ-02) =====
// Additive L1/L2 path on top of the parseToolCall L3 text-parsing fallback.
// ollama-js delivers `message.tool_calls[]` with `function.arguments` already
// JSON-parsed (an object — NOT a JSON string, unlike the OpenAI path in
// planRunner.ts:184-198). normalizeNativeToolCalls maps each entry to the
// frozen dispatch shape (toolCallResolver.ts:23-26) and Zod-validates EACH
// entry individually; an invalid entry throws loud with the entry index
// (D-05). parseToolCall stays byte-identical as the L3 fallback when no
// native tool_calls are present.

/**
 * Normalize ollama-js `message.tool_calls[]` to the frozen dispatch shape
 * `{ toolName, toolInput }[]` consumed by the orchestrator. Preserves array
 * order; validates each entry individually with `nativeToolCallSchema`; throws
 * `Error("Invalid native tool call at index <i>: <issue>")` on the first
 * invalid entry (fail-loud per D-05 — the throw propagates through the 92-02
 * error boundary's generic branch, it is NOT a daemon ResponseError).
 *
 * `arguments` is used AS-IS (already an object — never JSON.parse per
 * prohibition); `arguments === undefined/null` → `{}`.
 */
export function normalizeNativeToolCalls(
  toolCalls: unknown[],
): { toolName: string; toolInput: Record<string, unknown> }[] {
  return toolCalls.map((entry, index) => {
    const e = entry as { function?: { name?: unknown; arguments?: unknown } };
    const fn = e?.function;
    const name = fn?.name;
    const rawArgs = fn?.arguments;
    // arguments arrives already-parsed (object). null/undefined → {}. A
    // non-object (string/array/number) is invalid → Zod rejects it below.
    const toolInput =
      rawArgs === null || rawArgs === undefined
        ? {}
        : (rawArgs as Record<string, unknown>);
    const candidate = { toolName: name as string, toolInput };
    const parsed = nativeToolCallSchema.safeParse(candidate);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issueMsg = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "invalid";
      throw new Error(`Invalid native tool call at index ${index}: ${issueMsg}`);
    }
    return parsed.data;
  });
}

/**
 * Build the ollama-js `Tool[]` array to advertise active skills to the daemon.
 * Maps `{ name, description }[]` → `{ type: "function", function: { name,
 * description } }`. Name + description ONLY — no `parameters` key (builtins
 * lack inputSchema; full schema authoring is Phase 95 NTV-01 per D-05).
 * Returns `[]` for empty input so the caller can omit the `tools` key
 * entirely from the chat request (no-tools behavior unchanged).
 */
export function buildOllamaTools(
  skills: { name: string; description: string }[],
): Tool[] {
  return skills.map((s) => ({
    type: "function",
    function: { name: s.name, description: s.description },
  }));
}

/**
 * Phase 95 (D-03) — per-provider tools dispatcher. The orchestrator calls
 * this instead of `buildOllamaTools` directly so the gating logic stays in
 * one place. Returns `undefined` for providers whose native-tools path is
 * not yet wired (OpenAI/Anthropic arrive in Plans 02/03; gemini/xiaomi/
 * minimax are backlog future). When the return is `undefined`, the
 * orchestrator passes `tools=undefined` to `streamLLM` → streamOllama
 * receives no `tools` key → byte-identical existing prompt-prepend ReAct
 * JSON path (Phase 92 plumbing spread at line 820 handles `undefined`/
 * empty correctly). Co-located with `buildOllamaTools` per D-03.
 *
 * Phase 95-05 (G-95-7/G-95-8 closure): the `skills` element type is
 * widened to carry an optional `inputSchema` (JSON Schema). OpenAI/
 * Anthropic tool shape builders thread it into `function.parameters` /
 * `input_schema` so cloud providers that require an explicit parameters
 * schema (gpt-4o-mini, claude-sonnet-4-5) can populate native tool
 * arguments instead of emitting empty `{}`. The Ollama path
 * (`buildOllamaTools`) is UNCHANGED — qwen2.5 infers args from the
 * description and adding `parameters` to the ollama-js Tool shape is out
 * of scope for this gap closure.
 */
export function buildProviderTools(
  providerType: string,
  skills: { name: string; description: string; inputSchema?: Record<string, unknown> }[],
): unknown[] | undefined {
  switch (providerType) {
    case "ollama":
      return buildOllamaTools(skills);
    case "openai":
    case "openrouter":
      // Plan 02 (D-08): OpenAI function-calling shape. Phase 95-05:
      // `inputSchema` is threaded into `function.parameters` (G-95-7).
      return buildOpenAITools(skills);
    case "anthropic":
      // Plan 03 (D-08): Anthropic tool_use shape — `input_schema` REQUIRED
      // by the Anthropic API. Phase 95-05: `inputSchema` is threaded into
      // `input_schema` (G-95-8); the empty-properties fallback is preserved
      // for skills without `inputSchema`.
      return buildAnthropicTools(skills);
    default:
      // gemini / xiaomi / minimax — backlog future.
      return undefined;
  }
}

/**
 * Phase 95-02 (D-08) — Build the OpenAI `tools` array for native function
 * calling. OpenAI tool shape: `{ type: "function", function: { name,
 * description, parameters } }`. `parameters` is populated from
 * `skill.inputSchema` when present (required for OpenAI gpt-4o-mini to
 * populate arguments — G-95-7 closure); falls back to
 * `{ type: "object", properties: {} }` when absent (backward-compat for
 * skills without inputSchema — OpenAI accepts an empty parameters schema).
 * Returns `[]` for empty input so the caller can omit the `tools` key
 * entirely from the request body (byte-identical no-tools behavior).
 *
 * Structural shape is identical to ollama-js `Tool[]` so the same `Tool`
 * type is reused for type-safety without introducing a parallel
 * `OpenAITool` type (Phase 92 precedent — buildOllamaTools returns
 * `Tool[]`). Phase 95-05: `parameters` is now ALWAYS included (OpenAI
 * accepts an empty parameters schema; always-including is semantically
 * more correct than conditional inclusion and matches the Anthropic-
 * required pattern).
 */
export function buildOpenAITools(
  skills: { name: string; description: string; inputSchema?: Record<string, unknown> }[],
): Tool[] {
  return skills.map((s) => ({
    type: "function",
    function: {
      name: s.name,
      description: s.description,
      parameters: s.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * Phase 95-02 (D-08 — Pitfall 2) — Normalize OpenAI `message.tool_calls[]`
 * (or the assembled `delta.tool_calls[]` from streaming) to the frozen
 * dispatch shape `{ toolName, toolInput }[]` consumed by the orchestrator.
 *
 * CRITICAL WIRE-FORMAT DIFFERENCE (Pitfall 2): OpenAI
 * `tool_calls[].function.arguments` is a JSON STRING (must `JSON.parse`
 * before Zod validation), UNLIKE Ollama's `message.tool_calls[].function.
 * arguments` which is already a parsed object (Phase 92 D-05). Precedent:
 * `planRunner.ts:184-198` uses `JSON.parse(tc.function?.arguments || "{}")`
 * for the non-streaming OpenAI path.
 *
 * Throws loud with the entry index on `JSON.parse` failure OR Zod-invalid
 * shape (fail-loud per D-05 — same error pattern as normalizeNativeToolCalls
 * line 341). The throw propagates through the streamOpenAI try/catch (D-04)
 * which falls back to `parseToolCall(content)` L3 — never throws out of the
 * ReAct loop (Pitfall 2: "Never throw out of the ReAct loop").
 */
export function normalizeOpenAIToolCalls(
  toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string } }>,
): { toolName: string; toolInput: Record<string, unknown> }[] {
  return toolCalls.map((entry, index) => {
    const fn = entry.function;
    const name = fn?.name;
    const argumentsStr = fn?.arguments ?? "";
    let toolInput: Record<string, unknown>;
    try {
      // Pitfall 2 — OpenAI arguments is a JSON STRING (not an object).
      // Empty string falls back to `{}` (mirrors planRunner.ts:184-198
      // `tc.function?.arguments || "{}"` and Plan 01 normalizeNativeToolCalls
      // null/undefined → {} pattern).
      toolInput = JSON.parse(argumentsStr || "{}") as Record<string, unknown>;
    } catch {
      throw new Error(
        `Invalid native tool call at index ${index}: arguments JSON.parse failed`,
      );
    }
    const candidate = { toolName: name as string, toolInput };
    const parsed = nativeToolCallSchema.safeParse(candidate);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issueMsg = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "invalid";
      throw new Error(`Invalid native tool call at index ${index}: ${issueMsg}`);
    }
    return parsed.data;
  });
}

/**
 * Phase 95-03 (D-08) — Anthropic tool shape for native function calling.
 * Anthropic tool shape: `{ name, description, input_schema: { type: "object",
 * properties: {...} } }`. The `input_schema` with `type: "object"` is REQUIRED by
 * the Anthropic API (unlike OpenAI which accepts tools without parameters).
 * `input_schema` is populated from `skill.inputSchema` when present (required
 * for Anthropic claude-sonnet-4-5 to populate arguments — G-95-8 closure);
 * falls back to `{ type: "object", properties: {} }` when absent (backward-
 * compat for skills without inputSchema — the original fallback shape is
 * preserved).
 *
 * Returns `[]` for empty input so the caller can omit the `tools` key entirely
 * from the request body (byte-identical no-tools behavior).
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

export function buildAnthropicTools(
  skills: { name: string; description: string; inputSchema?: Record<string, unknown> }[],
): AnthropicTool[] {
  return skills.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.inputSchema ?? { type: "object", properties: {} },
  }));
}

/**
 * Phase 95-03 (D-08 — Pitfall 4) — Normalize Anthropic `tool_use` blocks
 * (assembled from `content_block_start` + `content_block_delta` partial_json
 * fragments across chunks in parseSSEStream) to the frozen dispatch shape
 * `{ toolName, toolInput }[]` consumed by the orchestrator.
 *
 * CRITICAL WIRE-FORMAT DIFFERENCE (Pitfall 4 — verified via Context7
 * `/anthropics/anthropic-sdk-typescript`): Anthropic streams `tool_use`
 * input as `partial_json` string fragments via `content_block_delta` events
 * with `delta.type === "input_json_delta"` and `delta.partial_json`
 * (string). The `content_block_start` event has `input: {}` (empty
 * placeholder — NOT the actual input). Must accumulate `partial_json`
 * fragments by `content_block_index` in parseSSEStream and `JSON.parse` the
 * assembled string here at stream end. This is DIFFERENT from the OpenAI
 * path (single `function.arguments` JSON string per entry) and the Ollama
 * path (already-parsed object — Phase 92 D-05).
 *
 * Throws loud with the entry index on `JSON.parse` failure OR Zod-invalid
 * shape (fail-loud per D-05 — same error pattern as
 * normalizeNativeToolCalls line 341 and normalizeOpenAIToolCalls line 451).
 * The throw propagates through the parseSSEStream end handler try/catch
 * (D-04) which falls back to `parseToolCall(content)` L3 — never throws
 * out of the ReAct loop (Pitfall 2: "Never throw out of the ReAct loop").
 */
export function normalizeAnthropicToolCalls(
  toolUses: Array<{ id?: string; name?: string; inputJson: string }>,
): { toolName: string; toolInput: Record<string, unknown> }[] {
  return toolUses.map((entry, index) => {
    const name = entry.name;
    const inputJsonStr = entry.inputJson ?? "";
    let toolInput: Record<string, unknown>;
    try {
      // Pitfall 4 — Anthropic input arrives as partial_json string fragments
      // accumulated in parseSSEStream. Empty string falls back to `{}` (same
      // pattern as normalizeOpenAIToolCalls line 449 and
      // normalizeNativeToolCalls null/undefined → {}).
      toolInput = JSON.parse(inputJsonStr || "{}") as Record<string, unknown>;
    } catch {
      throw new Error(
        `Invalid Anthropic tool call at index ${index}: input JSON.parse failed`,
      );
    }
    const candidate = { toolName: name as string, toolInput };
    const parsed = nativeToolCallSchema.safeParse(candidate);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issueMsg = firstIssue
        ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
        : "invalid";
      throw new Error(`Invalid Anthropic tool call at index ${index}: ${issueMsg}`);
    }
    return parsed.data;
  });
}

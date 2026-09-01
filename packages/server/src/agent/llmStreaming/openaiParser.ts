// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// OpenAI / OpenRouter streaming + shared SSE parser.
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).
// parseSSEStream is shared with anthropicParser per D-03.

import axios, { type AxiosRequestConfig } from "axios";
import type { Tool } from "ollama";
import type { ProviderConfig } from "@simmetric-chat/shared";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import type { DoneReason, OnThinkingCallback, OnTokenCallback, StreamingLLMResult } from "./types";
import { parseOpenAIReasoning, parseAnthropicThinkingDelta } from "./reasoningParsers";
import { parseToolCall } from "./toolCallParser";
import { normalizeOpenAIToolCalls, normalizeAnthropicToolCalls } from "./toolBuilders";

/**
 * OpenAI streaming — POST /v1/chat/completions with stream: true
 * Response is SSE: data: {json}\n\n
 * Each chunk: { "choices": [{ "delta": { "content": "token" } }] }
 * Final chunk: data: [DONE]
 * Usage in the last chunk if stream_options.include_usage: true
 */
export async function streamOpenAI(
  messages: { role: string; content: string }[],
  providerConfig: ProviderConfig,
  onToken: OnTokenCallback,
  signal?: AbortSignal,
  tools?: Tool[],
  onThinking?: OnThinkingCallback,
): Promise<StreamingLLMResult> {
  const apiKey = providerConfig.apiKey;
  if (!apiKey) throw new Error("OpenAI API key not configured");

  const response = await axios.post(
    `${providerConfig.baseUrl}/v1/chat/completions`,
    {
      model: providerConfig.model,
      messages,
      temperature: providerConfig.temperature,
      stream: true,
      stream_options: { include_usage: true },
      // Plan 02 (D-08): spread `tools` ONLY when non-empty so the absent/
      // empty case produces a request body with NO `tools` key —
      // byte-identical no-tools behavior (same pattern as streamOllama
      // line 820).
      ...(tools && tools.length > 0 ? { tools } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      responseType: "stream",
      timeout: getEnv().LLM_TIMEOUT,
      signal,
    } as AxiosRequestConfig,
  );

  return parseSSEStream(response.data, onToken, "openai", onThinking, tools);
}

/**
 * Generic SSE stream parser for OpenAI and Anthropic formats.
 * Both providers send `data: {json}\n\n` lines.
 * OpenAI ends with `data: [DONE]`.
 * Anthropic sends typed `event:` lines.
 *
 * D-01 (Phase 94, 94-02): threads `onThinking` for separated reasoning
 * (OpenAI delta.reasoning/reasoning_content, Anthropic thinking_delta) and
 * captures `doneReason` from finish_reason (OpenAI) / stop_reason (Anthropic)
 * on the final chunk. Existing content accumulation + parseToolCall L3 call
 * on `end` is byte-identical (additive only — D-06).
 *
 * Plan 02 (D-08 — Pitfall 3): for the OpenAI branch, accumulates
 * `delta.tool_calls[]` fragments by `index` across chunks (the
 * `function.arguments` JSON STRING arrives in fragments — must concatenate
 * by index before JSON.parse at stream end). The 3-level fallback chain
 * (D-04) on `end`: L1 native valid → short-circuit / L2 native invalid
 * (JSON.parse OR Zod) → parseToolCall(content) / L3 no tool_calls →
 * parseToolCall(content) (legacy). `parseToolCall` is NEVER gated (D-05 —
 * Pitfall 2 HIGHEST RISK). The Anthropic branch is additive only (Plan 03
 * adds its own tool_use block accumulation) — guarded with `provider ===
 * "openai"` so the OpenAI accumulation does not interfere.
 */
export function parseSSEStream(
  stream: NodeJS.ReadableStream,
  onToken: OnTokenCallback,
  provider: "openai" | "anthropic",
  onThinking?: OnThinkingCallback,
  // Plan 02 (D-08): additive param threaded from streamOpenAI for the
  // OpenAI native-tools path. Currently consumed only by the OpenAI
  // branch's `tools`-key spread in streamOpenAI; the Anthropic branch
  // (Plan 03) will consume it for its own tool_use accumulation. Prefixed
  // `_tools` here because parseSSEStream reads `delta.tool_calls`/
  // `content[].tool_use` directly — the `tools` array is request-side
  // only and is not needed for response parsing. Widened to unknown[] in
  // Plan 03 to accept both Tool[] and AnthropicTool[] shapes.
  _tools?: unknown[],
): Promise<StreamingLLMResult> {
  return new Promise((resolve, reject) => {
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;
    let buffer = "";
    let doneReason: DoneReason | undefined;
    // Plan 02 (D-08 — Pitfall 3): OpenAI streaming sends `tool_calls` via
    // `delta.tool_calls[]` where `function.arguments` is a JSON STRING
    // arriving in FRAGMENTS across chunks. Accumulate by `index` and
    // concatenate the arguments fragments; assemble at stream end.
    const assembledToolCalls: Map<
      number,
      { id?: string; function: { name?: string; arguments: string } }
    > = new Map();
    // Plan 03 (D-08 — Pitfall 4): Anthropic streaming sends `tool_use` input
    // as `partial_json` string fragments via `content_block_delta` events
    // with `delta.type === "input_json_delta"` (verified via Context7 —
    // `InputJSONDelta { partial_json: string; type: 'input_json_delta' }`).
    // The `content_block_start` event has `input: {}` (empty placeholder —
    // NOT the actual input). Accumulate `partial_json` fragments by
    // `content_block_index` and `JSON.parse` the assembled string at stream
    // end in normalizeAnthropicToolCalls. SEPARATE from the OpenAI
    // `assembledToolCalls` map — Anthropic and OpenAI have different wire
    // formats (tool_use blocks vs delta.tool_calls).
    const toolUseBlocks: Map<
      number,
      { id?: string; name?: string; inputJson: string }
    > = new Map();

    const processOpenAIChunk = (parsed: unknown): void => {
      const parsedChunk = parseOpenAIReasoning(
        parsed as {
          choices?: Array<{
            delta?: { content?: string; reasoning?: string; reasoning_content?: string };
            finish_reason?: string;
          }>;
        },
      );
      if (parsedChunk.thinking) {
        onThinking?.(parsedChunk.thinking);
      }
      if (parsedChunk.content) {
        content += parsedChunk.content;
        onToken(parsedChunk.content);
      }
      if (parsedChunk.doneReason) {
        doneReason = parsedChunk.doneReason;
      }
      // Usage from final chunk
      const usage = (parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
        ?.usage;
      if (usage) {
        promptTokens = usage.prompt_tokens || 0;
        completionTokens = usage.completion_tokens || 0;
      }
      // Plan 02 (D-08 — Pitfall 3): accumulate OpenAI delta.tool_calls
      // fragments by index. Each chunk may carry a partial fragment of
      // `function.arguments` (a JSON STRING that arrives split across
      // multiple chunks). The `id` and `function.name` typically arrive
      // once on the first chunk for a given index. Index-spoofing → extra
      // entries → normalized[0] picks first (single tool per turn ReAct
      // contract — T-95-05). Accumulation runs regardless of whether `tools`
      // was advertised (the model may emit tool_calls unprompted, or the
      // orchestrator may have gated them — the L1/L2/L3 chain in the `end`
      // handler decides; the accumulation itself is a pure read of the
      // stream and never dispatches).
      const deltaToolCalls = (
        parsed as {
          choices?: Array<{
            delta?: {
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        }
      )?.choices?.[0]?.delta?.tool_calls;
      if (deltaToolCalls) {
        for (const dtc of deltaToolCalls) {
          const existing = assembledToolCalls.get(dtc.index) ?? {
            function: { arguments: "" },
          };
          if (dtc.id) existing.id = dtc.id;
          if (dtc.function?.name) existing.function.name = dtc.function.name;
          if (dtc.function?.arguments) {
            // CONCATENATE string fragments (Pitfall 3) — append, never
            // overwrite. The complete JSON string is reconstructed at
            // stream end before JSON.parse in normalizeOpenAIToolCalls.
            existing.function.arguments += dtc.function.arguments;
          }
          assembledToolCalls.set(dtc.index, existing);
        }
      }
    };

    const processAnthropicChunk = (parsed: unknown): void => {
      const parsedChunk = parseAnthropicThinkingDelta(
        parsed as {
          type?: string;
          delta?: { type?: string; thinking?: string; text?: string; stop_reason?: string };
        },
      );
      if (parsedChunk.thinking) {
        onThinking?.(parsedChunk.thinking);
      }
      if (parsedChunk.content) {
        content += parsedChunk.content;
        onToken(parsedChunk.content);
      }
      if (parsedChunk.doneReason) {
        doneReason = parsedChunk.doneReason;
      }
      // Usage from message_start
      const msgStart = parsed as {
        type?: string;
        message?: { usage?: { input_tokens?: number } };
      };
      if (msgStart.type === "message_start" && msgStart.message?.usage) {
        promptTokens = msgStart.message.usage.input_tokens || 0;
      }
      // Usage from message_delta
      const msgDelta = parsed as {
        type?: string;
        usage?: { output_tokens?: number };
      };
      if (msgDelta.type === "message_delta" && msgDelta.usage) {
        completionTokens = msgDelta.usage.output_tokens || 0;
      }
      // Plan 03 (D-08 — Pitfall 4): Anthropic tool_use block accumulation.
      // content_block_start creates the block (input is {} placeholder);
      // content_block_delta with delta.type === "input_json_delta" appends
      // partial_json fragments to inputJson by index. Only
      // content_block_start creates an entry — a delta for an unknown index
      // is skipped (malformed stream). Index-spoofing → extra entries →
      // normalized[0] picks first (single tool per turn ReAct contract —
      // T-95-08). Field names verified via Context7.
      const blockStart = parsed as {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
      };
      if (
        blockStart.type === "content_block_start" &&
        blockStart.index !== undefined &&
        blockStart.content_block?.type === "tool_use"
      ) {
        toolUseBlocks.set(blockStart.index, {
          id: blockStart.content_block.id,
          name: blockStart.content_block.name,
          inputJson: "",
        });
      }
      const blockDelta = parsed as {
        type?: string;
        index?: number;
        delta?: { type?: string; partial_json?: string };
      };
      if (
        blockDelta.type === "content_block_delta" &&
        blockDelta.index !== undefined &&
        blockDelta.delta?.type === "input_json_delta" &&
        typeof blockDelta.delta.partial_json === "string"
      ) {
        const existing = toolUseBlocks.get(blockDelta.index);
        if (existing) {
          // CONCATENATE partial_json fragments (Pitfall 4) — append, never
          // overwrite. The complete JSON string is reconstructed at stream
          // end before JSON.parse in normalizeAnthropicToolCalls.
          existing.inputJson += blockDelta.delta.partial_json;
        }
      }
    };

    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Keep the last incomplete line
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // SSE event type line (e.g., "event: content_block_delta")
        if (trimmed.startsWith("event:")) continue;

        // SSE data line
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);

          // OpenAI end marker
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data);
            if (provider === "openai") {
              processOpenAIChunk(parsed);
            } else {
              processAnthropicChunk(parsed);
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    });

    stream.on("end", () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed.slice(6) !== "[DONE]") {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            if (provider === "openai") {
              processOpenAIChunk(parsed);
            } else {
              processAnthropicChunk(parsed);
            }
          } catch {
            // Ignore
          }
        }
      }

      // Plan 02 (D-08 + D-04 — Pitfall 2 + Pitfall 5 guards): OpenAI native
      // tool_calls resolution. L1 success short-circuits (RETURN — Pitfall 5
      // double-dispatch guard); L2 failure (JSON.parse OR Zod) falls through
      // to parseToolCall(content); L3 (no tool_calls) goes straight to
      // parseToolCall(content). `parseToolCall` is NEVER gated (D-05 —
      // Pitfall 2 HIGHEST RISK); the conditional gating lives on the `tools`
      // arg to the provider, NOT on parseToolCall.
      if (provider === "openai" && assembledToolCalls.size > 0) {
        const assembled = [...assembledToolCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v);
        try {
          const normalized = normalizeOpenAIToolCalls(assembled);
          resolve({
            content,
            toolCall: normalized[0] ?? null,
            usage: { promptTokens, completionTokens },
            doneReason,
          });
          return; // L1 short-circuit (Pitfall 5 double-dispatch guard)
        } catch (err) {
          logger.warn(
            "[llmStreaming] OpenAI native tool_calls invalid, falling back to parseToolCall(content)",
            { provider, error: (err as Error).message },
          );
          // Fall through to parseToolCall below (L2 fallback — D-04).
        }
      }

      // Plan 03 (D-08 + D-04 — Pitfall 4 + Pitfall 2 + Pitfall 5 guards):
      // Anthropic native tool_use resolution. L1 success short-circuits
      // (RETURN — Pitfall 5 double-dispatch guard); L2 failure (JSON.parse
      // OR Zod) falls through to parseToolCall(content); L3 (no tool_use
      // blocks) goes straight to parseToolCall(content). `parseToolCall` is
      // NEVER gated (D-05 — Pitfall 2 HIGHEST RISK). The Anthropic
      // `toolUseBlocks` map is SEPARATE from the OpenAI `assembledToolCalls`
      // map — guarded with `provider === "anthropic"` to avoid
      // interference.
      if (provider === "anthropic" && toolUseBlocks.size > 0) {
        const assembled = [...toolUseBlocks.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v);
        try {
          const normalized = normalizeAnthropicToolCalls(assembled);
          resolve({
            content,
            toolCall: normalized[0] ?? null,
            usage: { promptTokens, completionTokens },
            doneReason,
          });
          return; // L1 short-circuit (Pitfall 5 double-dispatch guard)
        } catch (err) {
          logger.warn(
            "[llmStreaming] Anthropic native tool_use invalid, falling back to parseToolCall(content)",
            { provider, error: (err as Error).message },
          );
          // Fall through to parseToolCall below (L2 fallback — D-04).
        }
      }

      // L2 (native invalid fallback) OR L3 (no native tool_calls, legacy).
      // parseToolCall is always-callable — NO `if (!supportsNativeTools)`
      // gate (D-05 — Pitfall 2 HIGHEST RISK silent drift guard).
      const toolCall = parseToolCall(content);
      resolve({
        content,
        toolCall,
        usage: { promptTokens, completionTokens },
        doneReason,
      });
    });

    stream.on("error", (err: Error) => {
      // D-07: On client disconnect (abortController.abort()), resolve with an
      // estimated usage instead of rejecting so the orchestrator's
      // budget.consumeTokens gets the usage and the save-in-finally (62-03)
      // persists it. Estimate = floor(content.length / 4) completion tokens.
      const isAbortError =
        err.name === "CanceledError" ||
        (err as { code?: string }).code === "ERR_CANCELED" ||
        (err as { code?: string }).code === "ECANCELED" ||
        /abort|cancel/i.test(err.message || "");
      if (isAbortError && content.length > 0) {
        const toolCall = parseToolCall(content);
        resolve({
          content,
          toolCall,
          usage: { promptTokens: 0, completionTokens: Math.floor(content.length / 4) },
        });
        return;
      }
      reject(err);
    });
  });
}

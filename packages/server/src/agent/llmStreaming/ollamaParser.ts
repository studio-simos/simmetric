// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Ollama streaming — ollama-js client.chat({ stream: true }) async iterator.
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).

import type { Tool } from "ollama";
import type { ProviderConfig } from "@simmetric-chat/shared";
import { getOllamaClient } from "../../services/ollamaClient";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import type { DoneReason, OnThinkingCallback, OnTokenCallback, StreamingLLMResult } from "./types";
import { parseOllamaThinking } from "./reasoningParsers";
import { parseToolCall } from "./toolCallParser";
import { normalizeNativeToolCalls } from "./toolBuilders";

// The original function signature used a { role: string; content: string }[]
// shape (the dispatcher maps ChatMessageEntry[] to it). Keep the param type
// verbatim from the original — it accepts the mapped shape.

export async function streamOllama(
  messages: { role: string; content: string }[],
  providerConfig: ProviderConfig,
  onToken: OnTokenCallback,
  signal?: AbortSignal,
  tools?: Tool[],
  onThinking?: OnThinkingCallback,
): Promise<StreamingLLMResult> {
  const ollamaUrl = providerConfig.baseUrl;
  const model = providerConfig.model;
  const isCloudModel = providerConfig.type === "ollama" && providerConfig.isLocal === false;

  try {
    logger.debug(`[llmStreaming] Ollama stream: model=${model}, baseUrl=${ollamaUrl}, hasApiKey=${!!providerConfig.apiKey}, isCloud=${isCloudModel}`);

    // D-02: shared factory — the cache key carries auth-ness (Pitfall 4).
    const client = getOllamaClient(providerConfig.baseUrl, {
      timeoutMs: getEnv().LLM_TIMEOUT,
      apiKey: providerConfig.apiKey ?? undefined,
    });
    // 92-05: advertise active skills as native tools when non-empty. The
    // `tools` key is spread in ONLY when tools && tools.length > 0 so the
    // absent/empty case produces a request object with NO tools key —
    // byte-identical no-tools behavior (edge: empty, T-92-05-04). The object
    // literal is intentionally NOT annotated so TypeScript resolves the
    // `chat` overload with `stream: true` → AbortableAsyncIterator<ChatResponse>
    // (annotating with Parameters<...> picks the wrong overload).
    const stream = await client.chat({
      model,
      messages,
      stream: true,
      keep_alive: getEnv().OLLAMA_KEEP_ALIVE,
      options: {
        temperature: providerConfig.temperature,
        num_ctx: providerConfig.maxTokens || 8192,
      },
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;
    // 92-05: native tool_calls captured from the done chunk; the first
    // normalized entry feeds the frozen dispatch shape (same precedent as
    // planRunner.ts:184-198 OpenAI path). When absent/empty, the existing
    // parseToolCall(content) L3 tail decides — byte-identical L3 behavior.
    let nativeToolCalls: unknown[] | null = null;
    // D-04 (Phase 94): additive doneReason — captured on the done chunk via
    // parseOllamaThinking. Undefined when the stream aborts before the done
    // chunk (abort-estimate path) or when done_reason is absent/unknown.
    let doneReason: DoneReason | undefined;

    // Per-request abort: bridge the route signal to THIS stream's iterator
    // only — NEVER client.abort() on the shared singleton (Pitfall 2).
    const onAbort = () => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const chunk of stream) {
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count || 0;
          completionTokens = chunk.eval_count || 0;
          // D-04 (Phase 94): map done_reason → DoneReason enum on the final
          // chunk. parseOllamaThinking returns undefined for unknown values
          // (graceful — old clients ignore the field).
          const parsed = parseOllamaThinking(chunk);
          doneReason = parsed.doneReason;
        }
        // 92-05: capture native tool_calls from ANY chunk (done or not).
        // ollama-js 0.6.3 typically surfaces them on the done chunk's
        // message.tool_calls, but a content-less non-done chunk carrying
        // tool_calls must not be silently dropped. First non-empty array
        // wins; the first normalized entry is dispatched (planRunner.ts:
        // 184-198 OpenAI precedent).
        const tc = chunk.message?.tool_calls;
        if (Array.isArray(tc) && tc.length > 0 && nativeToolCalls === null) {
          nativeToolCalls = tc;
        }
        // D-01 (Phase 94): separated reasoning. ollama-js exposes
        // `chunk.message.thinking` natively (no tag parsing). The callback
        // ALWAYS fires when thinking is non-empty — chat.ts checks
        // `include_thinking` before emitting the SSE event (opt-in gate,
        // Pitfall 4). When the flag is false/absent, reasoning is silently
        // discarded at the chat.ts layer (this callback still fires).
        if (!chunk.done && chunk.message?.thinking) {
          onThinking?.(chunk.message.thinking);
        }
        if (!chunk.done && chunk.message?.content) {
          const token = chunk.message.content;
          content += token;
          onToken(token);
        }
      }
    } catch (err) {
      // D-07: On client disconnect (abortController.abort()), resolve with an
      // estimated usage instead of rejecting so the orchestrator's
      // budget.consumeTokens gets the usage and the save-in-finally (62-03)
      // persists it. Estimate = floor(content.length / 4) completion tokens.
      const isAbortError =
        (err as Error).name === "AbortError" ||
        (err as Error).name === "CanceledError" ||
        (err as { code?: string }).code === "ERR_CANCELED" ||
        (err as { code?: string }).code === "ECANCELED" ||
        /abort|cancel/i.test((err as Error).message || "");
      if (isAbortError && content.length > 0) {
        const toolCall = parseToolCall(content);
        return {
          content,
          toolCall,
          usage: { promptTokens: 0, completionTokens: Math.floor(content.length / 4) },
          // D-04: doneReason undefined on abort — the done chunk never
          // arrived, so there is no termination reason to report.
        };
      }
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    // 92-05: native tool_calls win over the L3 text-parsing fallback when
    // present (L1/L2 > L3). First normalized entry dispatched this iteration
    // — same precedent as planRunner.ts:184-198 OpenAI path. Phase 95 (D-04)
    // wraps `normalizeNativeToolCalls` in try/catch: a Zod-invalid entry
    // (malformed/adversarial — T-95-01) falls through to the L3
    // `parseToolCall(content)` fallback instead of throwing out of the ReAct
    // loop (Pitfall 2: "Never throw out of the ReAct loop"). The L1 success
    // path RETURNS (short-circuits — Pitfall 5 double-dispatch guard); only
    // L2 (invalid) and L3 (absent) reach `parseToolCall`. `parseToolCall` is
    // NEVER gated behind `if (!supportsNativeTools)` (D-05 — Pitfall 2
    // HIGHEST RISK); the conditional gating (D-03) lives on the `tools` arg
    // to the provider, NOT on `parseToolCall`.
    if (nativeToolCalls && nativeToolCalls.length > 0) {
      try {
        const normalized = normalizeNativeToolCalls(nativeToolCalls);
        return {
          content,
          toolCall: normalized[0] ?? null,
          usage: { promptTokens, completionTokens },
          doneReason,
        };
      } catch (err) {
        logger.warn(
          "[llmStreaming] native tool_calls Zod-invalid, falling back to parseToolCall(content)",
          { model, error: (err as Error).message },
        );
        // Fall through to parseToolCall below (L2 fallback — D-04).
      }
    }

    const toolCall = parseToolCall(content);
    return {
      content,
      toolCall,
      usage: { promptTokens, completionTokens },
      doneReason,
    };
  } catch (err) {
    // ollama-js ResponseError is thrown but NOT exported by the module —
    // duck-type it via err.name / err.status_code (RESEARCH Pattern 3).
    const status =
      err !== null &&
      typeof err === "object" &&
      "status_code" in err &&
      typeof (err as { status_code?: unknown }).status_code === "number"
        ? (err as { status_code: number }).status_code
        : undefined;
    if (status === 401) {
      if (providerConfig.apiKey) {
        throw new Error(
          `Model "${model}" authentication failed. The configured API key appears invalid or expired. [CLOUD_MODEL_AUTH_FAILED]`,
          { cause: err },
        );
      }
      throw new Error(
        `Model "${model}" requires authentication. Cloud models require an API key. Please add your Ollama API key in Settings > Providers. [CLOUD_MODEL_OFFLINE]`,
        { cause: err },
      );
    }
    if (status === 404) {
      throw new Error(
        `Model "${model}" not found. Run 'ollama pull ${model}' first.`,
        { cause: err },
      );
    }
    if (status === 400) {
      throw new Error(
        `Model "${model}" rejected the request (HTTP 400). The conversation may exceed the context window. Try selecting fewer messages or increasing num_ctx.`,
        { cause: err },
      );
    }
    throw new Error(`Ollama error: ${(err as Error).message}`, { cause: err });
  }
}

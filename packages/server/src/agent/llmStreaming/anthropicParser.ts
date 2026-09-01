// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Anthropic streaming — POST /v1/messages with stream: true.
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).
// parseSSEStream is imported from ./openaiParser per D-03.

import axios, { type AxiosRequestConfig } from "axios";
import type { ProviderConfig } from "@simmetric-chat/shared";
import { getEnv } from "../../config/env";
import type { OnThinkingCallback, OnTokenCallback, StreamingLLMResult } from "./types";
import { parseSSEStream } from "./openaiParser";

/**
 * Anthropic streaming — POST /v1/messages with stream: true
 * Response is SSE with typed events:
 * - event: content_block_delta, data: { "delta": { "type": "text_delta", "text": "token" } }
 * - event: message_start (contains usage.input_tokens)
 * - event: message_delta (contains usage.output_tokens)
 * - event: message_stop
 */
export async function streamAnthropic(
  messages: { role: string; content: string }[],
  providerConfig: ProviderConfig,
  onToken: OnTokenCallback,
  signal?: AbortSignal,
  // Plan 03 (D-08): additive tools param (6th, before onThinking — matches
  // streamOllama and streamOpenAI param order). Accepts unknown[] because
  // the Anthropic tool shape differs from the ollama-js Tool type (see
  // AnthropicTool interface + buildAnthropicTools).
  tools?: unknown[],
  onThinking?: OnThinkingCallback,
): Promise<StreamingLLMResult> {
  const apiKey = providerConfig.apiKey;
  if (!apiKey) throw new Error("Anthropic API key not configured");

  const systemMessage = messages.find((m) => m.role === "system")?.content;
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const response = await axios.post(
    `${providerConfig.baseUrl}/v1/messages`,
    {
      model: providerConfig.model,
      max_tokens: providerConfig.maxTokens ?? 4096,
      temperature: providerConfig.temperature,
      messages: nonSystemMessages,
      ...(systemMessage && { system: systemMessage }),
      stream: true,
      // Plan 03 (D-08): spread `tools` ONLY when non-empty so the absent/
      // empty case produces a request body with NO `tools` key —
      // byte-identical no-tools behavior (same pattern as streamOllama
      // line 820 and streamOpenAI line 1113).
      ...(tools && tools.length > 0 ? { tools } : {}),
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      responseType: "stream",
      timeout: getEnv().LLM_TIMEOUT,
      signal,
    } as AxiosRequestConfig,
  );

  return parseSSEStream(response.data, onToken, "anthropic", onThinking, tools);
}

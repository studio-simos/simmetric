// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Facade entry for the LLM streaming layer (Phase 158 / CSW-13).
// Extracted from the original llmStreaming.ts god-file. This is the
// dispatcher + re-export barrel — `llmStreaming.ts` at the original path
// re-exports everything from here so existing imports continue to work.
//
// Adding a new LLM provider = create one parser module file + add one case
// to the streamLLM dispatcher below — no god-file edit.

import type { Tool } from "ollama";
import type { ProviderConfig } from "@simmetric-chat/shared";

import type {
  ChatMessageEntry,
  OnThinkingCallback,
  OnTokenCallback,
  StreamingLLMResult,
} from "./types";

import { streamOllama } from "./ollamaParser";
import { streamOpenAI } from "./openaiParser";
import { streamAnthropic } from "./anthropicParser";
import { streamGemini } from "./geminiParser";

// Re-export the full public surface of the split modules. The order matches
// the original file's declaration order so the facade's export map is stable.
export * from "./types";
export * from "./reasoningParsers";
export * from "./toolCallParser";
export * from "./toolBuilders";

/**
 * Stream a response from the configured LLM provider.
 * Tokens are delivered via onToken callback as they arrive.
 * Returns the full result when the stream completes.
 */
export async function streamLLM(
  context: ChatMessageEntry[],
  providerConfig: ProviderConfig,
  onToken: OnTokenCallback,
  signal?: AbortSignal,
  // Plan 03: widened to unknown[] to accept both ollama-js Tool[] (Ollama/
  // OpenAI shape) and AnthropicTool[] (Anthropic shape) from
  // buildProviderTools. Cast to Tool[] at the streamOllama/streamOpenAI call
  // sites (per-provider cast, never `as any`).
  tools?: unknown[],
  onThinking?: OnThinkingCallback,
): Promise<StreamingLLMResult> {
  const messages = context.map((m) => ({
    role: m.role as string,
    content: m.content,
  }));

  switch (providerConfig.type) {
    case "ollama":
      return streamOllama(messages, providerConfig, onToken, signal, tools as Tool[] | undefined, onThinking);
    case "openai":
    case "openrouter":
      // Plan 02 (D-08): thread tools before onThinking (matches streamOllama
      // param order at line 784-791).
      return streamOpenAI(messages, providerConfig, onToken, signal, tools as Tool[] | undefined, onThinking);
    case "anthropic":
      // Plan 03 (D-08): thread tools before onThinking (matches streamOllama
      // and streamOpenAI param order). streamAnthropic accepts unknown[]
      // because the Anthropic tool shape differs from the ollama-js Tool
      // type (see AnthropicTool interface + buildAnthropicTools).
      return streamAnthropic(messages, providerConfig, onToken, signal, tools, onThinking);
    case "gemini":
      return streamGemini(context, providerConfig, onToken, signal);
    case "xiaomi":
    case "minimax":
      // Native handler pending — fail fast with a clear, actionable error
      // instead of silently falling through to the OpenAI stream path.
      throw new Error(
        `Native handler for ${providerConfig.type} not yet implemented — install the OpenAI-compatible variant or wait for the handler follow-up task`,
      );
    default:
      throw new Error(`Unsupported LLM provider: ${providerConfig.type}`);
  }
}
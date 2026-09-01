// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Streaming LLM Layer — facade (Phase 158 / CSW-13).
 *
 * This file was a 1799-line god-file containing every provider's streaming
 * parser, the tool-call parser, the tool builders, the reasoning parsers,
 * and the dispatcher. It is now a thin re-export facade mirroring the
 * chat.ts facade split convention (Phase 154 / CSW-02). The implementation
 * lives in ./llmStreaming/ — one module per concern:
 *
 *   llmStreaming.ts ← llmStreaming/index.ts          — streamLLM dispatcher + re-exports
 *   llmStreaming.ts ← llmStreaming/types.ts          — shared types (ChatMessageEntry, StreamingLLMResult, OnTokenCallback, OnThinkingCallback, DoneReason, ReasoningFormat, ParserState, ParsedChunk, AnthropicTool)
 *   llmStreaming.ts ← llmStreaming/toolCallParser.ts — parseToolCall, parseXMLElements (+ internal XML/JSON helpers)
 *   llmStreaming.ts ← llmStreaming/toolBuilders.ts   — normalizeNativeToolCalls, buildOllamaTools, buildProviderTools, buildOpenAITools, normalizeOpenAIToolCalls, buildAnthropicTools, normalizeAnthropicToolCalls
 *   llmStreaming.ts ← llmStreaming/reasoningParsers.ts — resolveReasoningFormat, parseNoop, parseOllamaThinking, parseDeepseekTag, parseGptOssHarmony, parseOpenAIReasoning, parseAnthropicThinkingDelta, partialTagSuffixLen
 *   llmStreaming.ts ← llmStreaming/ollamaParser.ts   — streamOllama
 *   llmStreaming.ts ← llmStreaming/openaiParser.ts   — streamOpenAI, parseSSEStream (shared SSE parser)
 *   llmStreaming.ts ← llmStreaming/anthropicParser.ts — streamAnthropic (imports parseSSEStream from openaiParser per D-03)
 *   llmStreaming.ts ← llmStreaming/geminiParser.ts   — streamGemini, parseGeminiSSEStream
 *
 * All existing imports (`from "./llmStreaming"` and `from "../agent/llmStreaming"`)
 * continue to work unchanged — the facade re-exports the full public surface.
 * Adding a new LLM provider means creating one parser module + one case in the
 * streamLLM dispatcher in index.ts, not editing a god-file.
 */
export * from "./llmStreaming/index";
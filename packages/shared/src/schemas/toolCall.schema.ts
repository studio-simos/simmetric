// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

// ===== Native Tool-Call Schema =====
// Phase 92-05 (OJ-02): Zod contract for ollama-js `message.tool_calls[]`
// entries after normalization to the frozen dispatch shape consumed by the
// orchestrator (toolCallResolver.ts:23-26).
//
// D-05 locks the shape: ollama-js `ToolCall.function.arguments` arrives
// ALREADY JSON-parsed (an object, NOT a JSON string — unlike the OpenAI
// path); normalizeNativeToolCalls in llmStreaming.ts maps
// `{ function: { name, arguments } }` → `{ toolName, toolInput }` and
// validates EACH entry with this schema before dispatch. Invalid entries
// throw loud with the entry index (fail-loud per D-05; the throw propagates
// through the 92-02 error boundary's generic branch).
//
// zod 4.4.3 two-arg record form: z.record(z.string(), z.unknown()).
// No runtime logic lives here (shared package rule — only schema + types).

/**
 * Dispatch-shape Zod schema for a single normalized native tool call.
 * Matches the frozen `ToolCallStreamResult.toolCall` shape
 * (toolCallResolver.ts:23-26) so the orchestrator consumes native
 * tool_calls and parseToolCall text output identically.
 */
export const nativeToolCallSchema = z.object({
  toolName: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()),
});

type NativeToolCall = z.infer<typeof nativeToolCallSchema>;
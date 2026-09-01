// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 96 (CMP-01) — smart context compaction.
 *
 * `compact_messages_for_request` is the PRIMARY context-overflow mitigation
 * path: when the estimated token count of the ReAct context exceeds 80% of
 * the model's context window, it keeps the system prompt + last N messages
 * verbatim + a single-level summary of the older messages. Tool messages
 * (`[Used tool: ...]` / `[Tool Error]`) are NEVER summarized — they are kept
 * verbatim in the tail and dropped-with-marker among old messages (Pitfall 9
 * lost tool-call context). The summary is prefixed with an untrusted marker
 * so the LLM prefers recent verbatim over the lossy summary (Pitfall 9).
 *
 * Coexists with `truncateContextToByteBudget` (D-08): compact is the smart
 * primary path (lossy + LLM cost, preserves semantics); truncate is the
 * emergency guard (blind, free, byte cap, BOT-06 pinned user). Order:
 * compact pre-LLM (>80%); truncate post-tool (byte cap). On summarizer
 * failure, compact falls back to truncate (D-06/D-08).
 *
 * Pitfall 9 invariants (one-way-doors):
 *   - Single-level summary: NEVER summarize-the-summary. An existing
 *     `[Auto-summary...]` message in the old region is dropped-and-replaced.
 *   - Tool messages verbatim: tool messages are NEVER summarized. In the
 *     tail: verbatim. Among old messages: dropped with `[tool call to X
 *     omitted]` marker in the summary prompt.
 *   - Token-based 80% trigger: NOT byte-based, NOT message-count. Strict `>`
 *     comparison (exactly-at-threshold = no-op; one-above = trigger).
 *   - Untrusted marker: summary message prefixed `[Auto-summary of earlier
 *     conversation — may be inaccurate, verify with recent messages]`.
 */

import type { ChatMessageEntry } from "./agentTypes";
import {
  AgentBudgetTracker,
  isToolResult,
  truncateContextToByteBudget,
} from "../services/agentBudgetService";
import { callNonStreamingLLM } from "../services/providerService";
import type { ProviderConfig } from "@simmetric-chat/shared";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

/**
 * Summarizer system prompt. Instructs the LLM to:
 *   - summarize user + assistant text only
 *   - treat `[tool call to X omitted]` markers as tool calls that happened
 *     but whose details are omitted (do NOT invent tool result content)
 *   - keep the summary under `maxSummaryTokens` tokens
 *   - prefer recent verbatim messages over the summary (untrusted marker)
 */
const SUMMARY_SYSTEM_PROMPT =
  "You are a conversation summarizer. Summarize the following earlier " +
  "conversation between a user and an assistant. Preserve the key facts, " +
  "decisions, and the user's intent. Lines of the form " +
  "`[tool call to X omitted]` mark tool calls that happened but whose " +
  "details are omitted — acknowledge that the tool was called, but do NOT " +
  "invent the tool result. Keep the summary concise and under the stated " +
  "token budget. This summary will be prefixed with an untrusted marker and " +
  "the downstream assistant MUST prefer recent verbatim messages over this " +
  "summary when they conflict.";

const UNTRUSTED_MARKER =
  "[Auto-summary of earlier conversation — may be inaccurate, verify with recent messages]";

/**
 * Estimate the token count of a context array using the char-count heuristic
 * (4 chars ≈ 1 token, UTF-16 code units via `string.length` for multilingual
 * consistency with `contextBytesOf` — D-02 auto token-estimation decision,
 * Pitfall 9 char-count heuristic).
 *
 * Conservative for ASCII (tends to underestimate), overestimates slightly
 * for multibyte — safe-side. No tiktoken dependency (D-02 auto discretion).
 */
export function estimateTokens(context: ReadonlyArray<ChatMessageEntry>): number {
  let totalChars = 0;
  for (const msg of context) {
    if (typeof msg.content === "string") {
      totalChars += msg.content.length;
    }
  }
  return Math.floor(totalChars / 4);
}

/**
 * Extract the tool name from a `[Used tool: X]` or `[Tool Error]` user-role
 * message, for the `[tool call to X omitted]` marker.
 */
function extractToolName(content: string): string {
  // `[Used tool: rag_search]\nResult: ...` → `rag_search`
  const usedMatch = content.match(/^\[Used tool:\s*([^\]]+)\]/);
  if (usedMatch && usedMatch[1]) return usedMatch[1].trim();
  // `[Tool Error] ...` → `unknown` (no tool name in the prefix)
  return "unknown";
}

/**
 * Detect an existing single-level summary message by its untrusted-marker
 * prefix (Pitfall 9 summarizer drift — dropped-and-replaced, NEVER
 * re-summarized).
 */
function isExistingSummary(m: ChatMessageEntry): boolean {
  return (
    typeof m.content === "string" &&
    m.content.startsWith("[Auto-summary")
  );
}

/**
 * Smart context compaction. Returns a NEW array (original untouched) when
 * the estimated token count exceeds 80% of the context window; otherwise
 * returns the input array unchanged (no-op, byte-identical existing path).
 *
 * Layout when compaction occurs:
 *   [system, summaryMessage, pinnedUserMsg?, ...lastN]
 *
 * Behavior:
 *   - Below 80% threshold → return context unchanged (reference-equal).
 *   - Budget near-limit (`isTokenBudgetExhausted`) → skip compaction, return
 *     context unchanged (D-06 — truncate remains as emergency guard).
 *   - `context.length <= 1 + keepLastN` → no old messages to summarize, return
 *     context unchanged (D-03 boundary).
 *   - System message (index 0) always verbatim (D-03).
 *   - Last N (default 4) messages verbatim, including any tool messages
 *     (D-05 tool-verbatim).
 *   - Pinned user message (BOT-06): if the tail is dominated by tool results,
 *     the first real user message (role:user, NOT a tool result) is pinned.
 *   - Old region = context[1 .. length-keepLastN] minus pinned user message.
 *   - Tool messages in old region: dropped with `[tool call to X omitted]`
 *     marker inline in the summary prompt (D-05 — NOT passed as content).
 *   - Old user/assistant text messages (NOT tool, NOT existing summary):
 *     passed to the summarizer as the user message content.
 *   - Existing `[Auto-summary...]` messages in old region: dropped-and-
 *     replaced (single-level invariant — D-04; Pitfall 9 summarizer drift).
 *   - Summary message: role user, content prefixed with the untrusted marker.
 *   - Summarizer failure (error/timeout) → fallback to
 *     `truncateContextToByteBudget` (D-06/D-08 — blind truncation better than
 *     crash).
 *   - Summarizer `tokensUsed` is counted in `AgentBudgetTracker` via
 *     `consumeTokens({promptTokens: tokensUsed, completionTokens: 0})`
 *     (CMP-01 SC2 budget-aware).
 */
export async function compact_messages_for_request(
  context: ChatMessageEntry[],
  providerConfig: ProviderConfig,
  budget: AgentBudgetTracker,
  opts?: {
    contextWindowTokens?: number;
    keepLastN?: number;
    maxSummaryTokens?: number;
  },
): Promise<ChatMessageEntry[]> {
  const keepLastN = opts?.keepLastN ?? 4;
  const maxSummaryTokens = opts?.maxSummaryTokens ?? 500;
  const contextWindowTokens =
    opts?.contextWindowTokens ??
    providerConfig.contextWindowTokens ??
    getEnv().AGENT_MAX_TOTAL_TOKENS;

  const tokensBefore = estimateTokens(context);
  const threshold = Math.floor(0.8 * contextWindowTokens);

  // Pitfall 9 off-by-one: strict `>` (exactly-at-threshold = no-op).
  if (tokensBefore <= threshold) {
    return context;
  }

  // D-06: budget near-limit → skip compaction (don't aggravate). truncate
  // remains as the emergency guard.
  if (budget.isTokenBudgetExhausted()) {
    return context;
  }

  // D-03: nothing to summarize — system + keepLastN is the whole context.
  if (context.length <= 1 + keepLastN) {
    return context;
  }

  const sysMsg = context[0]!;
  const tail = context.slice(-keepLastN);

  // BOT-06 pinned user message: pin only when the tail is dominated by tool
  // results (match truncateContextToByteBudget D-06).
  const tailHasToolResults = tail.some(isToolResult);
  let pinned: ChatMessageEntry | undefined;
  if (tailHasToolResults) {
    for (let i = 1; i < context.length - keepLastN; i++) {
      const m = context[i]!;
      if (m.role === "user" && !isToolResult(m) && !isExistingSummary(m)) {
        pinned = m;
        break;
      }
    }
  }

  // Old region = context[1 .. length-keepLastN], minus pinned (if any).
  const oldEnd = context.length - keepLastN;
  const oldRegion = context.slice(1, oldEnd);

  // Build the summarizer user-message content: user/assistant text verbatim,
  // tool messages dropped with `[tool call to X omitted]` marker, existing
  // `[Auto-summary...]` messages dropped-and-replaced (single-level — NOT
  // passed to the summarizer at all).
  const summaryParts: string[] = [];
  for (const m of oldRegion) {
    if (m === pinned) continue;
    if (isExistingSummary(m)) {
      // Single-level invariant: drop the old summary, do NOT re-summarize it.
      continue;
    }
    if (isToolResult(m)) {
      const toolName = extractToolName(m.content);
      summaryParts.push(`[tool call to ${toolName} omitted]`);
      continue;
    }
    // Regular user/assistant text — pass verbatim to the summarizer.
    summaryParts.push(`${m.role}: ${m.content}`);
  }

  // If there is nothing to summarize (e.g. all old messages were tool results
  // or existing summaries), no-op — nothing to gain from an empty summary.
  if (summaryParts.length === 0) {
    return context;
  }

  const oldMessagesText = summaryParts.join("\n\n");

  let summaryText: string;
  let tokensUsed: number;
  try {
    const result = await callNonStreamingLLM(
      providerConfig,
      [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: oldMessagesText },
      ],
      // Bounded summarizer timeout — don't block the chat indefinitely.
      Math.min(getEnv().LLM_TIMEOUT || 30000, 30000),
    );
    summaryText = result.content;
    tokensUsed = result.tokensUsed;
  } catch (err: unknown) {
    // D-06/D-08: summarizer failure → fallback to truncateContextToByteBudget
    // (blind truncation better than crash). Compaction is an optimization.
    logger.warn(
      "[contextCompaction] summarizer failed, falling back to truncateContextToByteBudget",
      { error: err instanceof Error ? err.message : String(err) },
    );
    // truncateContextToByteBudget mutates in place — clone first so the
    // caller's context is not mutated (pure-ish contract).
    const fallbackContext = context.slice();
    truncateContextToByteBudget(
      fallbackContext,
      getEnv().AGENT_MAX_CONTEXT_BYTES,
      keepLastN,
      pinned,
    );
    return fallbackContext;
  }

  // CMP-01 SC2: budget-aware — count the summarizer tokens. If tracking
  // throws (unexpected), treat as a failure → fallback to truncate.
  try {
    budget.consumeTokens({ promptTokens: tokensUsed, completionTokens: 0 });
  } catch (err: unknown) {
    logger.warn(
      "[contextCompaction] budget tracking failed, falling back to truncateContextToByteBudget",
      { error: err instanceof Error ? err.message : String(err) },
    );
    const fallbackContext = context.slice();
    truncateContextToByteBudget(
      fallbackContext,
      getEnv().AGENT_MAX_CONTEXT_BYTES,
      keepLastN,
      pinned,
    );
    return fallbackContext;
  }

  // Bound the summary to maxSummaryTokens tokens (char heuristic: 4 chars ≈ 1
  // token). Truncate with an ellipsis marker if it overflows.
  const maxSummaryChars = maxSummaryTokens * 4;
  if (summaryText.length > maxSummaryChars) {
    summaryText = summaryText.substring(0, maxSummaryChars) + "…[summary truncated]";
  }

  const summaryMessage: ChatMessageEntry = {
    role: "user",
    content: `${UNTRUSTED_MARKER}\n${summaryText}`,
  };

  const newContext: ChatMessageEntry[] = [
    sysMsg,
    summaryMessage,
    ...(pinned ? [pinned] : []),
    ...tail,
  ];

  const tokensAfter = estimateTokens(newContext);
  const messagesDropped = context.length - newContext.length;
  logger.info("[contextCompaction] compacted", {
    tokensBefore,
    tokensAfter,
    messagesDropped,
  });

  return newContext;
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Agent Budget Service — watchdogs for the ReAct agent loop.
 *
 * Replaces the previous `maxIterations` cap (which terminated the loop after N tool calls)
 * with a layered set of budget controls that block specific failure modes:
 *   1. Wallclock timeout (AGENT_WALLCLOCK_TIMEOUT_MS)
 *   2. Token budget (AGENT_MAX_TOTAL_TOKENS)
 *   3. Context size cap (AGENT_MAX_CONTEXT_BYTES)
 *   4. Tool output truncation (AGENT_MAX_TOOL_OUTPUT_LENGTH) — applied by orchestrator
 *   5. Per-skill execution timeout (AGENT_MAX_SKILL_EXECUTION_MS)
 *   6. Loop detection (AGENT_LOOP_DETECTION_WINDOW) — same (tool, input) repeated N times
 *   7. Per-user concurrency cap (CHAT_MAX_CONCURRENT_PER_USER) — partial replacement of removed chatRateLimiter
 *
 * Modeled on `synthesisBudgetService.ts:39` (`class BudgetTracker`).
 */

import { getEnv } from "../config/env";
import type { ChatMessageEntry } from "../agent/agentTypes";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentBudgetConfig {
  wallclockTimeoutMs: number;
  maxTotalTokens: number;
  maxContextBytes: number;
  maxToolOutputLength: number;
  maxSkillExecutionMs: number;
  loopDetectionWindow: number;
  maxConcurrentPerUser: number;
}

export type AbortReason =
  | "none"
  | "wallclock"
  | "token_budget"
  | "context_overflow"
  | "loop_detected"
  | "aborted"
  | "done"
  | "unknown_tool_breaker"
  | "maxIterations";

export class AgentConcurrencyError extends Error {
  readonly userId: string;
  readonly currentSlots: number;
  readonly maxSlots: number;
  constructor(userId: string, currentSlots: number, maxSlots: number) {
    super(
      `Too many concurrent chat requests for user ${userId} (${currentSlots}/${maxSlots}). Please wait for a previous request to finish.`
    );
    this.name = "AgentConcurrencyError";
    this.userId = userId;
    this.currentSlots = currentSlots;
    this.maxSlots = maxSlots;
  }
}

// ---------------------------------------------------------------------------
// Loop detector
// ---------------------------------------------------------------------------

interface LoopEntry {
  tool: string;
  inputHash: string;
  ts: number;
}

/**
 * Sliding window over recent (tool, input) pairs. When the same pair appears
 * `loopDetectionWindow` times in a row, `detect()` returns true.
 *
 * The window is reset on a different tool call to avoid false positives.
 */
export class LoopDetector {
  private window: LoopEntry[] = [];
  private readonly maxWindow: number;

  constructor(loopDetectionWindow: number = 3) {
    this.maxWindow = Math.max(1, loopDetectionWindow);
  }

  /**
   * Record a tool call and return true if it forms a loop with the previous
   * `maxWindow - 1` calls (same tool + same canonicalized input).
   */
  detect(tool: string, toolInput: unknown): boolean {
    const inputHash = canonicalize(toolInput);

    // Reset window when the tool changes
    const last = this.window[this.window.length - 1];
    if (!last || last.tool !== tool) {
      this.window = [{ tool, inputHash, ts: Date.now() }];
      return false;
    }

    this.window.push({ tool, inputHash, ts: Date.now() });

    // Truncate to maxWindow
    if (this.window.length > this.maxWindow) {
      this.window = this.window.slice(-this.maxWindow);
    }

    // All entries in window must match
    if (this.window.length < this.maxWindow) return false;
    return this.window.every((e) => e.inputHash === inputHash);
  }

  reset(): void {
    this.window = [];
  }

  size(): number {
    return this.window.length;
  }
}

// ---------------------------------------------------------------------------
// Budget tracker
// ---------------------------------------------------------------------------

export class AgentBudgetTracker {
  private readonly config: AgentBudgetConfig;
  private readonly startedAt: number;
  private tokensPrompt = 0;
  private tokensCompletion = 0;
  private abortReason: AbortReason = "none";
  private readonly loopDetector: LoopDetector;
  private readonly concurrencySlots: Map<string, number> = new Map();

  constructor(config?: Partial<AgentBudgetConfig>) {
    const env = getEnv();
    this.config = {
      wallclockTimeoutMs:
        config?.wallclockTimeoutMs ?? env.AGENT_WALLCLOCK_TIMEOUT_MS,
      maxTotalTokens: config?.maxTotalTokens ?? env.AGENT_MAX_TOTAL_TOKENS,
      maxContextBytes: config?.maxContextBytes ?? env.AGENT_MAX_CONTEXT_BYTES,
      maxToolOutputLength:
        config?.maxToolOutputLength ?? env.AGENT_MAX_TOOL_OUTPUT_LENGTH,
      maxSkillExecutionMs:
        config?.maxSkillExecutionMs ?? env.AGENT_MAX_SKILL_EXECUTION_MS,
      loopDetectionWindow:
        config?.loopDetectionWindow ?? env.AGENT_LOOP_DETECTION_WINDOW,
      maxConcurrentPerUser:
        config?.maxConcurrentPerUser ?? env.CHAT_MAX_CONCURRENT_PER_USER,
    };
    this.startedAt = Date.now();
    this.loopDetector = new LoopDetector(this.config.loopDetectionWindow);
  }

  // --- Wallclock ----------------------------------------------------------

  wallclockElapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  wallclockExpired(): boolean {
    return this.wallclockElapsedMs() >= this.config.wallclockTimeoutMs;
  }

  // --- Token budget -------------------------------------------------------

  totalTokensUsed(): number {
    return this.tokensPrompt + this.tokensCompletion;
  }

  isTokenBudgetExhausted(): boolean {
    return this.totalTokensUsed() >= this.config.maxTotalTokens;
  }

  consumeTokens(usage?: { promptTokens?: number; completionTokens?: number }): void {
    if (!usage) return;
    this.tokensPrompt += usage.promptTokens ?? 0;
    this.tokensCompletion += usage.completionTokens ?? 0;
  }

  // --- Context size -------------------------------------------------------

  /**
   * Sum of `content.length` for all messages in the context. Approximates
   * UTF-16 code units (string length counts UTF-16 code units, not bytes);
   * for memory pressure, close enough.
   *
   * NOTE (researcher Q3, BOT-06): This intentionally stays on `content.length`
   * (UTF-16 code units) rather than a UTF-8 byte count (e.g. the Node Buffer
   * byte-length helper). For multilingual content (IT/RU/etc.) a single
   * non-BMP or accented character expands more in UTF-8 than in UTF-16, so
   * switching to a UTF-8 byte count would over-trim multilingual contexts.
   * UTF-16 code units are a safe-side approximation: we keep slightly more
   * than a strict byte budget would, which is preferable to dropping the
   * user's question. Do NOT change this to a UTF-8 byte count without
   * re-evaluating the multilingual impact.
   */
  contextBytesOf(context: ReadonlyArray<ChatMessageEntry>): number {
    let total = 0;
    for (const msg of context) {
      if (typeof msg.content === "string") {
        total += msg.content.length;
      }
    }
    return total;
  }

  // --- Loop detection -----------------------------------------------------

  detectLoop(tool: string, toolInput: unknown): boolean {
    return this.loopDetector.detect(tool, toolInput);
  }

  resetLoopDetector(): void {
    this.loopDetector.reset();
  }

  // --- Concurrency --------------------------------------------------------

  /**
   * Acquire a concurrency slot for the given user. Throws
   * `AgentConcurrencyError` if the user has reached the per-user limit.
   * Always paired with `releaseSlot()` in a try/finally.
   */
  acquireSlot(userId: string): void {
    if (!userId) {
      // No user identity (e.g. internal widget). Don't track concurrency.
      return;
    }
    const current = this.concurrencySlots.get(userId) ?? 0;
    if (current >= this.config.maxConcurrentPerUser) {
      throw new AgentConcurrencyError(
        userId,
        current,
        this.config.maxConcurrentPerUser
      );
    }
    this.concurrencySlots.set(userId, current + 1);
  }

  releaseSlot(userId: string): void {
    if (!userId) return;
    const current = this.concurrencySlots.get(userId) ?? 0;
    if (current <= 1) {
      this.concurrencySlots.delete(userId);
    } else {
      this.concurrencySlots.set(userId, current - 1);
    }
  }

  // --- Skill timeout ------------------------------------------------------

  /**
   * Race a promise against a timeout. Rejects with `AgentSkillTimeoutError`
   * if the promise does not settle within `config.maxSkillExecutionMs`.
   * Clears the timer on settlement to avoid leaks.
   */
  async withSkillTimeout<T>(p: Promise<T>, label: string = "skill"): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AgentSkillTimeoutError(
              label,
              this.config.maxSkillExecutionMs
            )
          ),
        this.config.maxSkillExecutionMs
      );
    });
    try {
      return await Promise.race([p, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- Abort reason -------------------------------------------------------

  setAbortReason(reason: AbortReason): void {
    this.abortReason = reason;
  }

  getAbortReason(): AbortReason {
    return this.abortReason;
  }

  // --- Snapshot (for logs/metrics) ---------------------------------------

  snapshot() {
    return {
      startedAt: this.startedAt,
      wallclockElapsedMs: this.wallclockElapsedMs(),
      tokensPrompt: this.tokensPrompt,
      tokensCompletion: this.tokensCompletion,
      totalTokens: this.totalTokensUsed(),
      abortReason: this.abortReason,
      loopWindowSize: this.loopDetector.size(),
      activeConcurrencySlots: Array.from(this.concurrencySlots.entries()),
      config: { ...this.config },
    };
  }
}

export class AgentSkillTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`Skill "${label}" exceeded ${timeoutMs}ms timeout`);
    this.name = "AgentSkillTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a value for loop detection. Object keys are sorted recursively
 * to ensure {a:1,b:2} and {b:2,a:1} hash to the same value.
 * Returns a JSON string. Circular references are not expected from LLM
 * tool inputs but are guarded against with a try/catch.
 */
function canonicalize(value: unknown): string {
  try {
    return JSON.stringify(canonicalizeKeys(value));
  } catch {
    return String(value);
  }
}

function canonicalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeKeys(
        (value as Record<string, unknown>)[key]
      );
    }
    return sorted;
  }
  return value;
}

/**
 * Truncate a string or JSON-stringified value to a maximum length. Appends
 * an ellipsis marker if truncation occurred so the LLM knows the data is
 * incomplete.
 */
export function truncateToolOutput(
  data: unknown,
  maxLength: number
): string {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...[truncated]";
}

/**
 * Phase 96 (CMP-01 D-05) — shared tool-result detection for
 * `truncateContextToByteBudget` and `compact_messages_for_request`;
 * content-prefix check because `ChatMessageEntry` has no `tool` role (tool
 * results are user-role with prefix).
 */
export function isToolResult(m: ChatMessageEntry): boolean {
  return (
    typeof m.content === "string" &&
    (m.content.startsWith("[Used tool:") || m.content.startsWith("[Tool Error]"))
  );
}

/**
 * Truncate the context array to stay under the byte budget. Keeps the system
 * prompt (index 0), the original user message (pinned), and the last
 * `keepLastN` messages; replaces the rest with a single notice message.
 *
 * The original user message is pinned so it survives trimming even when 4+
 * tool results (pushed as `{ role: "user", content: "[Used tool: ...]" }` by
 * `orchestrator.ts`) push it out of the `keepLastN` tail. Without pinning, the
 * LLM loses the question and hallucinates or answers off-topic (BOT-06).
 *
 * The byte budget stays UTF-16 code units (`content.length`) — see
 * `contextBytesOf` documentation for the multilingual rationale.
 *
 * The 4th parameter `pinnedUserMsg` is OPTIONAL for backward compatibility:
 * existing 3-arg callers (`orchestrator.ts` lines 242, 557) still compile.
 * When omitted, the function auto-detects the original user message by
 * scanning `context` from index 1 forward for the first entry whose
 * `role === "user"` AND whose `content` does not start with `[Used tool:` or
 * `[Tool Error]` (those markers are tool-result entries pushed as user
 * messages, not the real user question).
 *
 * Returns the number of messages that were dropped.
 */
export function truncateContextToByteBudget(
  context: ChatMessageEntry[],
  byteBudget: number,
  keepLastN: number = 4,
  pinnedUserMsg?: ChatMessageEntry
): number {
  if (context.length === 0) return 0;

  const sysMsg = context[0];
  if (!sysMsg) return 0;

  // Resolve the pinned user message: explicit 4th-arg first, else auto-detect.
  // Auto-detect scans from index 1 forward for the first non-tool user entry,
  // but ONLY when the current tail (last keepLastN) is dominated by tool-result
  // entries — i.e. the bug scenario where 4+ `[Used tool: ...]` messages push
  // the real question out of the tail. In normal multi-turn chats (no tool
  // results in the tail) we preserve the old behavior of keeping the recent
  // tail intact, since the "original" user message is just an old turn that
  // SHOULD be dropped to make room for recent context.
  const initialTail = context.slice(-keepLastN);
  const tailHasToolResults = initialTail.some(isToolResult);

  let pinned: ChatMessageEntry | undefined = pinnedUserMsg;
  if (!pinned && tailHasToolResults) {
    for (let i = 1; i < context.length; i++) {
      const m = context[i];
      if (m && m.role === "user" && !isToolResult(m)) {
        pinned = m;
        break;
      }
    }
  }

  const bytes = (m: ChatMessageEntry) =>
    typeof m.content === "string" ? m.content.length : 0;

  const placeholder: ChatMessageEntry = {
    role: "user",
    content:
      "[Context truncated: earlier messages removed to stay under the byte budget]",
  };

  // Tail is the last keepLastN entries AFTER sysMsg (sysMsg is always kept
  // separately at index 0). The pinned message is NOT filtered out of the
  // tail: if it is already in the tail, it stays there and we avoid
  // duplicating it; if it is NOT in the tail, we insert it separately before
  // the tail.
  const tail = context.slice(1).slice(-keepLastN);
  const pinnedInTail =
    pinned !== undefined && tail.some((m) => m === pinned);

  // Only truncate if the rebuilt context (sysMsg + placeholder + pinned? + tail)
  // exceeds the byte budget. When pinnedInTail, pinned is already in tail, so
  // don't double-count it.
  const totalBytes =
    bytes(sysMsg) +
    bytes(placeholder) +
    (pinned && !pinnedInTail ? bytes(pinned) : 0) +
    tail.reduce((s, m) => s + bytes(m), 0);
  if (totalBytes <= byteBudget) return 0;

  // If there is nothing between sysMsg and tail (and no pinned message to
  // insert), there is nothing to drop — abort to avoid replacing the whole
  // context with a placeholder when we are already at the minimal set.
  const dropCount = context.length - (1 + keepLastN);
  if (dropCount <= 0 && !pinned) return 0;
  // If the pinned message is already in the tail and there is nothing else to
  // drop, the context is already minimal — abort.
  if (dropCount <= 0 && pinnedInTail) return 0;

  // Build the new context: [sysMsg, placeholder, pinnedUserMsg?, ...tail].
  // pinnedUserMsg is inserted only when it is NOT already in the tail (to
  // avoid duplication). If it IS in the tail, it stays in its tail position.
  const newContext: ChatMessageEntry[] = [
    sysMsg,
    placeholder,
    ...(pinned && !pinnedInTail ? [pinned] : []),
    ...tail,
  ];

  let runningBytes = newContext.reduce((s, m) => s + bytes(m), 0);

  // Drop tool-result entries from the tail front (oldest first) until under
  // budget. Only tool results (`[Used tool: ...]` / `[Tool Error] ...`) are
  // dropped — regular conversation turns in the tail are the valuable recent
  // context and are kept even if the budget is exceeded (better to be slightly
  // over budget than to lose real conversation). Never drop sysMsg, the
  // placeholder, or pinnedUserMsg.
  const pinnedOffset = pinned && !pinnedInTail ? 1 : 0;
  const tailStart = 2 + pinnedOffset;
  while (runningBytes > byteBudget && newContext.length > tailStart) {
    // Find the first tool-result entry in the tail segment (skip pinned and
    // non-tool entries).
    let dropIdx = -1;
    for (let i = tailStart; i < newContext.length; i++) {
      const candidate = newContext[i];
      if (candidate === pinned) continue;
      if (candidate && isToolResult(candidate)) {
        dropIdx = i;
        break;
      }
    }
    if (dropIdx < 0) break; // no more tool results to drop
    const droppedMsg = newContext.splice(dropIdx, 1)[0];
    if (droppedMsg) runningBytes -= bytes(droppedMsg);
  }

  // Recompute actual dropped count vs original context length.
  const actualDropped = context.length - newContext.length;
  context.length = 0;
  context.push(...newContext);
  return Math.max(actualDropped, 0);
}

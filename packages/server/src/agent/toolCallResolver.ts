// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tool Call Resolver — shared decision branch for both ReAct loops.
 *
 * Extracted from `orchestrator.ts` (plan 88-01 MOD-01) so the non-streaming
 * loop (`runAgent`) and the streaming loop (`runAgentStreaming`) call the
 * SAME tool-call resolution path (RESEARCH Pitfall 2 guard). The body is
 * the verbatim `if (!streamResult.toolCall) { resolveImplicitToolCall(...) }`
 * branch + tool dispatch + unknown-tool circuit breaker + loop-detection
 * watchdog (orchestrator.ts:216-261 / 569-627).
 *
 * Skill execution and context truncation stay in `orchestrator.ts` — they
 * differ slightly between the two loops (the streaming loop passes
 * `sendEvent: onEvent` to `skill.execute`). The decision (proceed vs
 * done vs continue vs break) is what's shared.
 */
import { resolveImplicitToolCall } from "./implicitToolCall";
import type { AgentSkillDefinition } from "./skills";
import type { AgentBudgetTracker } from "../services/agentBudgetService";
import type { ChatMessageEntry } from "./agentTypes";
import { logger } from "../utils/logger";

/** Shape of a single streamLLM iteration result (subset we read/ mutate). */
interface ToolCallStreamResult {
  content: string;
  toolCall: { toolName: string; toolInput: Record<string, unknown> } | null;
}

/**
 * Typed context-object arg (D-10): everything the resolver needs from the
 * caller. Both ReAct loops build this with their own locals so the wiring
 * stays byte-identical and `AgentRunResult` stays byte-identical.
 */
export interface ToolCallContext {
  /** The streamLLM result for this iteration. Mutated in place: when an
   *  implicit tool call is resolved, `toolCall` is set from null to the
   *  resolved call so the caller's downstream tool-dispatch sees it. */
  streamResult: ToolCallStreamResult;
  /** Active skills for this chat (already filtered for ragContext etc). */
  activeSkills: AgentSkillDefinition[];
  /** For log messages. */
  workspaceId: string;
  /** For log messages. */
  chatId: string;
  /** Current iteration counter (for the loop_detected log). */
  iterations: number;
  /** Budget tracker — mutated: `setAbortReason` on breaker / loop / done. */
  budget: AgentBudgetTracker;
  /** BOT-03 consecutive unknown-tool counter (in/out). */
  consecutiveUnknownTool: number;
  /** BOT-03 total unknown-tool counter (in/out). */
  totalUnknownTool: number;
  /** Conversation context — mutated: pushes `[Tool Error]` on unknown tool. */
  context: ChatMessageEntry[];
}

/**
 * Decision the caller acts on. The caller owns the control-flow
 * (`break` / `continue` / fall-through to skill execution) so the
 * streaming loop can still run its D-02 buffered-replay on `done`.
 */
export type ToolCallResolution = {
  /** `done` — final answer: caller breaks the loop with `finalResponse`.
   *  `break` — breaker tripped (`unknown_tool_breaker` or `loop_detected`);
   *           caller just breaks.
   *  `continue` — unknown tool (not breaker); caller continues the loop.
   *  `proceed` — tool call is valid; caller falls through to skill
   *             execution (the `toolCalls.push` / context.push happen
   *             in the caller, where the streaming-vs-non-streaming
   *             differences live). */
  action: "done" | "break" | "continue" | "proceed";
  /** Set when `action === "done"` (finalResponse for the loop). */
  finalResponse?: string;
  /** Updated counters (caller writes them back to its locals). */
  consecutiveUnknownTool: number;
  totalUnknownTool: number;
};

/**
 * Resolve one ReAct iteration's tool-call decision. Called by BOTH
 * `runAgent` (non-streaming) and `runAgentStreaming` (streaming) at the
 * same call site, so the implicit-tool-call wiring is preserved across
 * both loops (Pitfall 2 guard).
 */
export function resolveToolCall(ctx: ToolCallContext): ToolCallResolution {
  const {
    streamResult,
    activeSkills,
    workspaceId,
    chatId,
    iterations,
    budget,
    context,
  } = ctx;
  let { consecutiveUnknownTool, totalUnknownTool } = ctx;

  if (!streamResult.toolCall) {
    // Recovery for models that ignore the JSON tool-call format in the
    // system prompt and emit a generic XML-ish tag instead (e.g. Ollama
    // deepseek-v4:pro:cloud → `<search><query>...</query></search>`).
    // parseToolCall only knows structured formats (JSON, ⌜⌝,
    // <function-calls>), so a bare `<tagname>...</tagname>` slips through
    // as plain text and would be streamed raw to the user. Resolve it to
    // a real tool call BEFORE treating the content as a final answer.
    const implicit = resolveImplicitToolCall(streamResult.content, activeSkills);
    if (implicit) {
      logger.debug(`[orchestrator] implicit tool call resolved: "${implicit.toolName}"`, { workspaceId, chatId });
      streamResult.toolCall = implicit;
      // Fall through to the tool-dispatch branch below.
    } else {
      // LLM decided to respond directly — we're done. The streaming loop
      // performs its D-02 buffered-replay on this signal before breaking.
      budget.setAbortReason("done");
      return {
        action: "done",
        finalResponse: streamResult.content,
        consecutiveUnknownTool,
        totalUnknownTool,
      };
    }
  }

  // LLM wants to use a tool
  const { toolName, toolInput } = streamResult.toolCall!;
  const skill = activeSkills.find((s) => s.name === toolName);

  if (!skill) {
    const errorMsg = `Unknown tool: ${toolName}. Available tools: ${activeSkills.map((s) => s.name).join(", ")}`;
    // BOT-03 breaker (D-03): increment both counters; trip at 3-consecutive OR 5-total.
    consecutiveUnknownTool++;
    totalUnknownTool++;
    if (consecutiveUnknownTool >= 3 || totalUnknownTool >= 5) {
      budget.setAbortReason("unknown_tool_breaker");
      return { action: "break", consecutiveUnknownTool, totalUnknownTool };
    }
    context.push({ role: "user", content: `[Tool Error] ${errorMsg}` });
    return { action: "continue", consecutiveUnknownTool, totalUnknownTool };
  }

  // Existing tool found — reset the consecutive counter (D-03).
  consecutiveUnknownTool = 0;

  // Watchdog 3: loop detection
  if (budget.detectLoop(toolName, toolInput)) {
    logger.warn(`[orchestrator] loop_detected: tool=${toolName}`, { workspaceId, chatId, iterations });
    budget.setAbortReason("loop_detected");
    return { action: "break", consecutiveUnknownTool, totalUnknownTool };
  }

  return { action: "proceed", consecutiveUnknownTool, totalUnknownTool };
}
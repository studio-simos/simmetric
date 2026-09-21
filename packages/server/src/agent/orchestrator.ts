// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Agent Orchestrator — ReAct Pattern (FACADE)
 *
 * Implements a Reason + Act agent loop that:
 * 1. Receives a user message
 * 2. Decides whether to use a tool or respond directly
 * 3. Executes the chosen tool
 * 4. Observes the result
 * 5. Repeats until a final answer is reached or max iterations hit
 *
 * Security: Skills are sandboxed — no arbitrary code execution.
 * Only registered skills can be invoked, and all skill execution
 * goes through the RBAC-verified workspace context.
 *
 * Plan 88-01 MOD-01: the body was surgically split into three sub-modules
 * behind this byte-identical public facade:
 *   - `planRunner.ts` — `generatePlan` + `PLAN_*` constants + `withTimeout` +
 *     module-private `callLLM` (per RESEARCH A1: `callLLM` is used only by
 *     `generatePlan`; the ReAct loops use `streamLLM` from `llmStreaming`).
 *   - `modelFallback.ts` — `buildFallbackConfig` (env/workspace/default
 *     provider resolution fallback used by both loops).
 *   - `toolCallResolver.ts` — `resolveToolCall` shared by BOTH ReAct loops
 *     (Pitfall 2 guard: the implicit-tool-call wiring stays identical).
 *
 * The public signatures (`runAgent`, `runAgentStreaming`, `generatePlan`,
 * `AgentRunParams`, `AgentRunResult`, `TokenUsageSummary`, `ToolCallRecord`)
 * are byte-identical; `routes/chat.ts` imports them from here unchanged.
 */

import { resolveSkillsForChat, type AgentSkillDefinition, type SkillResult } from "./skills";
import { dedupeCitations, filterGroundedCitations } from "./citationDedup";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { resolveSystemPrompt, resolveSkills, getTemplateForWorkspace } from "../services/templateService";
import { resolveProviderConfig, resolveProviderConfigStrict } from "../services/providerService";
import type { ProviderConfig, AgentPlan, SourceCitation } from "@simmetric-chat/shared";
import { streamLLM, buildProviderTools, type OnTokenCallback, type OnThinkingCallback, type DoneReason } from "./llmStreaming";
import { formatPlanInjection } from "./planParser";
import { buildFallbackConfig, shouldFallbackForDoneReason } from "./modelFallback";
import { resolveToolCall } from "./toolCallResolver";
import { compact_messages_for_request } from "./contextCompaction";
import { retrieveAndInjectMemory } from "./memoryRetrieval";
import { reviewMemoryAfterTurn } from "./memoryExtraction";
// Phase 187 (WIKS-01/WIKS-02): archive-bound prompt injection (hard rule +
// advisory schemaPrompt block) — see the gated blocks in runAgent/runAgentStreaming.
import { getArchiveConfig, buildSchemaPromptBlock, HARD_RULE_RAW_SOURCES } from "../services/archiveConfigService";
// 260917-qoh: the reply-language directive — composed from the validated
// visitor locale (params.locale, enum-gated upstream by chatRequestSchema,
// T-131-15) and appended INSIDE the widget prompt block in BOTH loops.
import { buildReplyLanguageDirective } from "../services/widgetChatPrompt";

export { generatePlan } from "./planRunner";
import { generatePlan } from "./planRunner";

/**
 * Defensive last-resort iteration cap (Phase 155 / CONCERNS.md CSW-07).
 *
 * NOT the primary control — the watchdogs in agentBudgetService.ts (wallclock,
 * token budget, loop detection, unknown-tool breaker) are. This fires ONLY if
 * every watchdog fails to. Hardcoded, not env-configurable (D-11): making it
 * configurable would imply it's a primary control. The existing
 * AGENT_LOOP_DETECTION_WINDOW env var is the configurable control; this const
 * is the non-configurable backstop that should never fire in normal operation
 * (typical ReAct runs are 1-10 iterations).
 */
const MAX_ITERATIONS_BACKSTOP = 50;

/**
 * 260919 model-missing UX — typed error thrown by both ReAct loops when
 * strict model resolution cannot resolve the user-selected model. The
 * `[MODEL_NOT_AVAILABLE]` tag is the frontend's discrimination key (mirrors
 * the CLOUD_MODEL_OFFLINE / CLOUD_MODEL_AUTH_FAILED pattern): useChatStreaming
 * translates it into a "model unavailable — choose another" state and opens
 * the model palette instead of auto-falling back to a substitute.
 */
class ModelNotAvailableError extends Error {
  readonly requestedModel: string;
  constructor(requestedModel: string) {
    super(
      `Model "${requestedModel}" is not available on any enabled provider. Please choose a different model. [MODEL_NOT_AVAILABLE]`,
    );
    this.name = "ModelNotAvailableError";
    this.requestedModel = requestedModel;
  }
}

export interface AgentRunParams {
  workspaceId: string;
  userId: string;
  message: string;
  chatId: string;
  history?: ChatMessageEntry[];
  ragContext?: string; // Pre-computed RAG context (widget chat)
  providerId?: string; // Per-request provider override
  model?: string;       // Per-request model override
  archiveId?: string;   // D-08: deterministic chat-scoped archiveId (from Chat.archiveId)
  disableRagSearch?: boolean; // WID-02 D-04: filter rag_search from active skills (mirror ragContext)
  locale?: string;      // 131-07 (G-131-19): visitor locale (widget chat) — localizes the no-results sentence
  // 260917-mz6: the widget grounding system prompt — DB-resolved from the
  // Widget row by the internal widget route, NEVER client-supplied (T-Q02;
  // the admin-authored field is validated to max 4000 chars). Prepended
  // OUTERMOST around the customInstructions composition so the widget prompt
  // leads. Additive-optional: absent/undefined → byte-identical.
  widgetSystemPrompt?: string;
  // Phase 190 (SKIL-04, D-12): explicit /slug skillCall payload built SERVER-
  // SIDE in routes/chat.ts (resolveInvocableSkill → DLP-masked params →
  // compileTemplate → wrapSpotlightedTemplate). Additive-optional: requests
  // without it are byte-identical. Injected as spotlighted USER-level data
  // through buildToolResultEntry in BOTH loops — NEVER the system prompt
  // (the delimiters already ride compiledPrompt; injection site appends only).
  skillCall?: { slug: string; params: Record<string, string>; compiledPrompt: string };
  // Phase 190 (WR-02, D-13): the request's DLP masking decision (DLP_ENABLED
  // true AND no bypass role — computed by the chat route exactly like the
  // skillCall params-masking gate). Threaded into skill.execute so
  // createPromptSkillExecutor masks LLM-invoked custom-skill tool input
  // BEFORE compilation (the explicit /slug path is masked in the route).
  // Additive-optional: absent/undefined → no executor masking (byte-identical
  // with the pre-fix behavior for callers that do not set it).
  dlpMaskingEnabled?: boolean;
  // Phase 191 (KNOW-01 D-04): chat-attached wiki-archive IDs — org-validated
  // upstream by archiveAttachmentService.resolveAttachedArchives (silent
  // org-scoped filter); skills never re-validate. rag_search unions them
  // into its retrieval as archive:<id> pseudo-workspaces. Additive-optional:
  // absent/empty → byte-identical (the workspace string call is unchanged).
  attachedArchiveIds?: string[];
  /**
   * 260919 model-missing UX — strict model resolution. TRUE on user-facing
   * chat paths (chat.ts both handlers): the user-selected model must be
   * honored — a missing model throws a typed error the frontend translates
   * into a "choose a model" prompt, never a silent substitute. Absent/false
   * (widget, planRunner, non-chat callers) keeps the lenient degrade chain.
   */
  strictModelResolution?: boolean;
}

import type { ChatMessageEntry } from "./agentTypes";

export interface AgentRunResult {
  response: string;
  sources?: SourceCitation[];
  toolCalls?: ToolCallRecord[];
  iterations: number;
  tokenUsage?: TokenUsageSummary;
  providerType?: string;
  resolvedModel?: string;
  /** Why the ReAct loop exited — set by budget.setAbortReason(). Consumed
   *  by chat.ts (plan 62-05) to branch on breaker trip (D-04).
   *  Values: "none" | "wallclock" | "token_budget" | "context_overflow" |
   *  "loop_detected" | "aborted" | "done" | "unknown_tool_breaker" |
   *  "maxIterations" (Phase 155 / CSW-07 last-resort backstop). */
  abortReason?: string;
  // D-04 (Phase 94): additive optional — per-provider normalized termination
  // reason from the final-answer streamLLM call. Consumed by auto-fallback
  // (D-05, Plan 94-03) to discriminate length vs error. Undefined when the
  // fallback path (buildFallbackConfig) runs or the provider doesn't map.
  doneReason?: DoneReason;
  /** Pipeline info — describes what tools were called and whether sources
   *  were found. Used by the frontend to show the user how the answer was
   *  produced (RAG search, wiki query, memory, or direct model knowledge). */
  pipeline?: {
    toolsCalled: string[];
    sourcesFound: number;
    ragSearched: boolean;
    ragResults: number;
  };
}

interface TokenUsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
}

interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  /** Sources captured directly from SkillResult.sources at execution time.
   *  Previously the orchestrator tried to JSON.parse(tc.output) to recover
   *  sources, but tc.output is a formatted text string (not JSON), so the
   *  parse always failed and sources was always []. This field stores the
   *  sources at the point of skill execution so the post-loop extraction
   *  can read them directly. */
  sources?: SourceCitation[];
}

/**
 * Stable stringify for repeat-call comparison (sorted keys recursively —
 * mirrors the LoopDetector's canonicalization semantics so key-order
 * variants of the same arguments compare equal).
 */
function canonicalInput(value: unknown): string {
  try {
    return JSON.stringify(sortKeysDeep(value));
  } catch {
    return String(value);
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Build the user-role tool-result context entry pushed after each skill
 * execution (both ReAct loops). The `[Used tool: X]` prefix is load-bearing —
 * downstream parsers (contextCompaction.extractToolName,
 * agentBudgetService.isToolResult) match on it — so extra lines are APPENDED
 * only.
 *
 * G-131-loop (repeat-call guard): when the identical (tool, input) pair was
 * already executed in this run, append an explicit no-retry warning with the
 * arguments used. Small/weak models (observed: deepseek-v4-flash:cloud)
 * re-issue the same wiki_query call even after a successful result — the
 * LoopDetector eventually trips at window=3 and the whole run dies with
 * "loop detected". The warning gives the model an in-context reason to stop
 * BEFORE the breaker trips; identical-input retries after the warning can no
 * longer be accidental.
 */
function buildToolResultEntry(
  toolName: string,
  toolInput: Record<string, unknown>,
  resultText: string,
  toolCalls: ToolCallRecord[],
): ChatMessageEntry {
  const inputKey = canonicalInput(toolInput);
  const priorIdentical = toolCalls.filter(
    (tc) => tc.tool === toolName && canonicalInput(tc.input) === inputKey,
  ).length;

  let content = `[Used tool: ${toolName}]\nArguments used: ${inputKey}\nResult: ${resultText}`;
  if (priorIdentical > 0) {
    content += `\n\nREPEAT-CALL GUARD (call #${priorIdentical + 1} with identical arguments): this result is the same as the previous one. Do NOT call this tool again with the same arguments — answer the user from the result you now have.`;
  }
  return { role: "user", content };
}

import {
  AgentBudgetTracker,
  truncateToolOutput,
  truncateContextToByteBudget,
} from "../services/agentBudgetService";

export async function runAgent(params: AgentRunParams): Promise<AgentRunResult> {
  const { workspaceId, userId, message, chatId, history = [], ragContext, disableRagSearch } = params;

  // Load workspace agent config
  let agentConfig = await prisma.workspaceAgentConfig.findUnique({
    where: { workspaceId },
  });

  if (!agentConfig) {
    // Auto-create default config
    agentConfig = await prisma.workspaceAgentConfig.create({
      data: { workspaceId },
    });
  }

  // Parse enabled skills — resolve with template if applicable
  let enabledSkillNames: string[];
  try {
    enabledSkillNames = JSON.parse(agentConfig.enabledSkills);
  } catch {
    enabledSkillNames = ["rag_search", "workspace_memory"];
  }

  // Template resolution: override system prompt and skills
  const resolvedSystemPrompt = await resolveSystemPrompt(workspaceId, agentConfig.systemPrompt);
  enabledSkillNames = await resolveSkills(workspaceId, enabledSkillNames);

  // Fetch user's custom instructions (per D-04: prepend before workspace prompt)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { customInstructions: true },
  });

  let finalSystemPrompt = resolvedSystemPrompt;
  if (user?.customInstructions) {
    finalSystemPrompt = `${user.customInstructions}\n\n${resolvedSystemPrompt}`;
  }
  // 260917-mz6 (Phase 131 prepend pattern): the widget grounding prompt is
  // prepended OUTERMOST — widget prompt first, then user customInstructions +
  // resolved prompt. The string content is pre-baked (the internal widget
  // route resolves the admin-authored field); no client input is interpolated
  // here. 260917-qoh: the reply-language directive (built server-side from
  // the enum-validated params.locale) rides INSIDE the widget prompt block,
  // immediately after the widget prompt — the JWT path (no
  // widgetSystemPrompt) stays byte-identical.
  if (params.widgetSystemPrompt) {
    const directive = buildReplyLanguageDirective(params.locale);
    finalSystemPrompt = `${params.widgetSystemPrompt}${directive ? `\n\n${directive}` : ""}\n\n${finalSystemPrompt}`;
  }

  // Load constraints — workspace agent config takes priority over template.
  // The workspace constraints are set by the user in Settings > Workspace;
  // the template constraints are defaults from the workspace's template.
  // Merge: workspace overrides template, template fills gaps.
  const template = await getTemplateForWorkspace(workspaceId);
  const templateConstraints = template?.constraints || {};
  let workspaceConstraints: Record<string, unknown> = {};
  try {
    workspaceConstraints = JSON.parse(agentConfig.constraints || "{}");
  } catch {
    workspaceConstraints = {};
  }
  const constraints = { ...templateConstraints, ...workspaceConstraints };
  const isLocalLLMOnly = constraints.localLLMOnly === true;
  const isCitationRequired = constraints.citationRequired === true;
  const isHybridSearchForced = constraints.hybridSearchForced === true;

  const skills = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames, { userId: params.userId });
  const env = getEnv();

  // Resolve provider config: per-request override > workspace config > default > env fallback
  // 260919 model-missing UX: strict resolution on user-facing chat paths —
  // a user-selected model that cannot be resolved throws a typed error the
  // frontend turns into a "choose a model" prompt (no silent substitute).
  let providerConfig: ProviderConfig;
  if (params.strictModelResolution) {
    const { config, requestedModel } = await resolveProviderConfigStrict(params.providerId, params.model);
    if (!config) {
      throw new ModelNotAvailableError(requestedModel ?? params.model ?? "default");
    }
    providerConfig = config;
  } else {
    const resolved = await resolveProviderConfig(params.providerId, params.model);
    if (resolved && resolved.model) {
      providerConfig = resolved;
      // Workspace-level model override (only if no per-request override)
      if (!params.model && agentConfig.model && agentConfig.model !== "default") {
        providerConfig.model = agentConfig.model;
      }
      providerConfig.temperature = agentConfig.temperature ?? 0.7;
    } else {
      providerConfig = buildFallbackConfig(env, params.model || agentConfig.model || "gemma4:latest", agentConfig.temperature ?? 0.7);
    }
  }

  // Enforce localLLMOnly constraint (Medical template)
  if (isLocalLLMOnly && providerConfig.type !== "ollama") {
    return {
      response: "This workspace requires a local LLM for privacy compliance. Please configure Ollama as the LLM provider.",
      iterations: 0,
    };
  }

  // Enforce hybridSearchForced constraint: inject a mandatory-search
  // instruction into the system prompt so the LLM must use rag_search
  // (or wiki_query) before answering any factual question.
  if (isHybridSearchForced && !ragContext) {
    finalSystemPrompt += "\n\nMANDATORY SEARCH RULE: You MUST call rag_search (or wiki_query if available) to retrieve documents from the knowledge base BEFORE answering any factual question. Do NOT answer from your training knowledge. If search returns no results, state that no information was found.";
  }

  // Phase 187 (WIKS-01/WIKS-02): archive-bound chats only. The hard rule is
  // ALWAYS appended (raw_sources immutability is code-enforced via
  // validateWritablePath — this is the prompt-layer mirror, WIKS-02/D-06b);
  // the advisory schemaPrompt block only when the archive config carries one
  // (WIKS-01/D-03). Injected AFTER the MANDATORY SEARCH RULE block, BEFORE
  // the systemPrompt ternary — do NOT touch buildSystemPrompt (blocks land
  // upstream on finalSystemPrompt). Injected in BOTH loop variants.
  if (params.archiveId) {
    const archiveConfig = await getArchiveConfig(params.archiveId);
    finalSystemPrompt += HARD_RULE_RAW_SOURCES;
    const advisory = buildSchemaPromptBlock(archiveConfig);
    if (advisory) {
      finalSystemPrompt += advisory;
    }
  }

  // Build the ReAct prompt (using template-resolved system prompt)
  // When ragContext is provided (widget chat), inject it into system prompt
  // and remove rag_search from skills to prevent redundant search
  const systemPrompt = ragContext
    ? `${finalSystemPrompt}\n\nYou have the following pre-retrieved documents from the knowledge base:\n\n${ragContext}\n\nUse the above documents to answer the user's question. You do not need to use the rag_search tool. Always cite your sources when referencing the provided documents.`
    : buildSystemPrompt(finalSystemPrompt, skills, params.locale);

  // 131-07 (G-131-19): rag_search SURVIVES the degraded filter when an
  // archive is bound — its archive fallback (builtinSkills.ts:59-61) is the
  // degraded path's only archive-capable skill, so stripping it would make
  // the archive unreachable exactly when the workspace search failed.
  const activeSkills = (ragContext || (disableRagSearch && !params.archiveId))
    ? skills.filter(s => s.name !== "rag_search")
    : skills;
  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;
  let finalResponse = "";

  // BOT-03 unknown-tool circuit breaker counters (plan 62-05, D-03).
  // consecutiveUnknownTool resets to 0 when the model uses an existing tool;
  // totalUnknownTool is monotonic for the run. Trip at 3-consecutive OR 5-total.
  let consecutiveUnknownTool = 0;
  let totalUnknownTool = 0;

  // Pinned original user message — passed to truncateContextToByteBudget as
  // the 4th arg (BOT-06 caller-site wiring, per checker B3) so the budget
  // trimmer can preserve the originating question even when mid-conversation
  // tool results would otherwise push it out of the byte window.
  const pinnedUserMsg: ChatMessageEntry = { role: "user", content: message };

  // Build conversation context
  let context: ChatMessageEntry[] = [
    { role: "system", content: systemPrompt },
    ...history.slice(-10), // Last 10 messages for context
    pinnedUserMsg,
  ];

  // Phase 190 (SKIL-04, D-12): explicit skillCall injection — ONE spotlighted
  // user-level entry through buildToolResultEntry (never the system prompt,
  // never a hand-rolled object — Pitfall 1: the "[Used tool: custom_" prefix
  // contract keeps agentBudgetService.isToolResult / contextCompaction
  // classification intact). Recorded in toolCalls (A6) so message metadata
  // shows the invocation. Runs BEFORE the first streamLLM iteration.
  if (params.skillCall) {
    const toolName = `custom_${params.skillCall.slug}`;
    context.push(
      buildToolResultEntry(
        toolName,
        params.skillCall.params ?? {},
        params.skillCall.compiledPrompt, // spotlight delimiters already wrapped in chat.ts
        toolCalls, // repeat-guard sees no prior → clean first call
      ),
    );
    toolCalls.push({
      tool: toolName,
      input: params.skillCall.params ?? {},
      output: params.skillCall.compiledPrompt,
      sources: [],
    });
  }

  // Agent budget tracker (replaces the old maxIterations cap).
  // The ReAct loop runs `while (true)` and exits via the budget watchdogs.
  const budget = new AgentBudgetTracker();
  budget.acquireSlot(userId);
  // D-04 (Phase 94): captured from the final-answer streamResult on the
  // "done" branch. Stays undefined when the loop exits via watchdog/abort.
  let finalDoneReason: DoneReason | undefined;

  // Always pass native tools to the LLM when skills are available, regardless
  // of the provider's nativeToolsReliable flag. The LLM may or may not use
  // them; if it doesn't, parseToolCall still recovers JSON-formatted tool calls
  // from the response text (the ReAct fallback path). This avoids the
  // maintenance burden of manually listing every model in NATIVE_TOOLS_OVERRIDES.
  const nativeToolsActive = activeSkills.length > 0;
  let parseToolCallCount = 0;

  // Single-call ReAct loop (BOT-02): one streamLLM call per iteration IS the
  // decision call — streamLLM returns { content, toolCall, usage }, the
  // toolCall field (parsed from the stream buffer in llmStreaming) drives the
  // tool-vs-response branch. No callLLM + streamLLM double call.
  // runAgent is the non-streaming variant: pass a no-op onToken since this
  // variant does not forward tokens to any SSE consumer.
  const noopOnToken: OnTokenCallback = () => {};

  try {
    // ReAct loop
    while (true) {
      iterations++;

      // Watchdog 1: wallclock
      if (budget.wallclockExpired()) {
        budget.setAbortReason("wallclock");
        break;
      }

      // Watchdog 2: token budget
      if (budget.isTokenBudgetExhausted()) {
        budget.setAbortReason("token_budget");
        break;
      }

      // Phase 155 / CSW-07 (D-09, D-10): last-resort iteration backstop. Fires
      // ONLY if every watchdog above (wallclock, token budget) AND the
      // loop_detector / unknown_tool_breaker inside resolveToolCall all fail
      // to break the loop. Hardcoded (D-11) — not env-configurable. The
      // `iterations++` above already incremented, so this reads the
      // post-increment value. Normal ReAct runs are 1-10 iterations, so 50 is
      // far above the typical ceiling.
      if (iterations >= MAX_ITERATIONS_BACKSTOP) {
        budget.setAbortReason("maxIterations");
        break;
      }

      // Single LLM call per iteration — the streaming call IS the decision
      // call. toolCall is parsed from the accumulated stream buffer.
      // Phase 95 (D-03): advertise active skills as native `tools` ONLY when
      // the resolved provider config flags `nativeToolsReliable === true` AND
      // there are active skills to advertise. When the flag is undefined/false
      // OR `activeSkills` is empty → `tools = undefined` → streamOllama
      // receives no `tools` key → byte-identical existing prompt-prepend ReAct
      // JSON path (Pitfall 2 guard: parseToolCall stays always-callable L3).
      // Phase 95-04 (D-05): `nativeToolsActive` is hoisted to the loop top
      // (declared above the try block) so it is available for the post-loop
      // advisory parseToolCall-count warning.
      const tools = nativeToolsActive ? buildProviderTools(providerConfig.type, activeSkills) : undefined;
      // Phase 97 (MEM-02 D-04): pre-LLM memory retrieval hook — runs BEFORE
      // compact_messages_for_request so memories in the system message are
      // preserved verbatim by compaction (Phase 96). Best-effort: collector
      // failure → original system message unchanged. Per-user-per-workspace
      // (Pitfall 3). Phase 140 (EPA-02): the memory_enabled LICENSE gate is
      // removed — memory retrieval is always-ON (Community users now get
      // memory). Only runs once per request (first iteration) — the
      // injected block persists across ReAct iterations and is stripped+
      // recomposed fresh on the next user turn by the stripMemoryBlock helper.
      // WR-03 (Phase 187 code review): the guard shipped as `iterations === 0`
      // but the loop increments BEFORE this check, so the hook never fired
      // (dead since Phase 97). The first pass after the increment is 1.
      if (iterations === 1 && context[0]?.role === "system") {
        try {
          context[0] = {
            ...context[0],
            content: await retrieveAndInjectMemory({
              userId,
              workspaceId,
              messages: context,
              systemMessageContent: context[0].content,
            }),
          };
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          logger.warn(`[orchestrator] memoryRetrieval hook skipped (best-effort): ${m}`, { workspaceId, chatId });
        }
      }
      // Phase 96 (CMP-01 D-07): smart context compaction pre-streamLLM check.
      // Trigger when estimated tokens > 80% of context window (token-based,
      // NOT byte-based — Pitfall 9 off-by-one). No-op below threshold (byte-
      // identical existing path). Coexists with truncateContextToByteBudget
      // (emergency byte-cap guard, runs post-tool-result — D-08).
      const contextBeforeCompact = context;
      context = await compact_messages_for_request(context, providerConfig, budget);
      if (context !== contextBeforeCompact) {
        logger.info("[orchestrator] context_compacted", { workspaceId, chatId, iterations });
      }
      const streamResult = await streamLLM(context, providerConfig, noopOnToken, undefined, tools);
      budget.consumeTokens(streamResult.usage);

      // Phase 95-04 (D-05 — Pitfall 2 warning sign): increment the
      // parseToolCall-count proxy when parseToolCall was definitely the source
      // (`!nativeToolsActive`) OR when no tool call was found at all
      // (`!streamResult.toolCall`). 100% native L1 success leaves the counter
      // at 0 → the post-loop warning fires after N=3 turns.
      if (!nativeToolsActive || !streamResult.toolCall) parseToolCallCount++;

      // Shared tool-call decision branch (D-10): the same resolveToolCall
      // is called by BOTH loops so the implicit-tool-call wiring stays
      // identical (Pitfall 2 guard).
      const resolution = resolveToolCall({
        streamResult,
        activeSkills,
        workspaceId,
        chatId,
        iterations,
        budget,
        consecutiveUnknownTool,
        totalUnknownTool,
        context,
      });
      consecutiveUnknownTool = resolution.consecutiveUnknownTool;
      totalUnknownTool = resolution.totalUnknownTool;

      if (resolution.action === "done") {
        finalResponse = resolution.finalResponse ?? "";
        finalDoneReason = streamResult.doneReason;
        break;
      }
      if (resolution.action === "break") {
        break;
      }
      if (resolution.action === "continue") {
        continue;
      }

      // resolution.action === "proceed": execute the skill (with per-skill
      // execution timeout). The skill lookup is repeated here (after
      // resolveToolCall confirmed the skill exists) so the streaming-vs-
      // non-streaming differences (sendEvent) stay local to each loop.
      const { toolName, toolInput } = streamResult.toolCall!;
      const skill = activeSkills.find((s) => s.name === toolName)!;

      let result: SkillResult;
      try {
        result = await budget.withSkillTimeout(
          skill.execute({
            workspaceId,
            userId,
            query: toolInput.query as string | undefined,
            content: toolInput.content as string | undefined,
            filePath: toolInput.filePath as string | undefined,
            archiveId: params.archiveId,
            locale: params.locale,
            metadata: toolInput,
            // WR-02/D-13: thread the request's DLP masking decision so the
            // prompt-skill executor masks LLM-supplied tool input (see
            // createPromptSkillExecutor).
            dlpMaskingEnabled: params.dlpMaskingEnabled,
            // Phase 191 (D-04): chat-attached archives → rag_search union
            // (additive-optional — absent stays byte-identical).
            ...(params.attachedArchiveIds?.length ? { attachedArchiveIds: params.attachedArchiveIds } : {}),
          }),
          toolName
        );
      } catch (err: unknown) {
        result = { success: false, error: `Skill execution error: ${(err instanceof Error ? err.message : String(err))}` };
      }

      const resultText = result.success
        ? truncateToolOutput(result.data, getEnv().AGENT_MAX_TOOL_OUTPUT_LENGTH)
        : `Error: ${result.error}`;

      // DEBUG: check sources from skill result
      if (toolName === "rag_search") {
        logger.info(`[DEBUG] rag_search result.sources length: ${result.sources?.length ?? 0}`);
        if (result.sources && result.sources.length > 0) {
          logger.info(`[DEBUG] first source chunkText length: ${(result.sources[0]?.chunkText?.length ?? 0)}`);
        }
      }

      toolCalls.push({
        tool: toolName,
        input: toolInput,
        output: resultText,
        sources: result.sources,
      });

      // Watchdog 4: context size cap (BOT-06 caller-side: pass pinnedUserMsg
      // as 4th arg so the original question survives trimming).
      const dropped = truncateContextToByteBudget(
        context,
        getEnv().AGENT_MAX_CONTEXT_BYTES,
        4,
        pinnedUserMsg
      );
      if (dropped > 0) {
        logger.warn(`[orchestrator] context_truncated: dropped=${dropped}`, { workspaceId, chatId, iterations });
        budget.setAbortReason("context_overflow");
        // We continue — the loop can still produce a final answer on the
        // truncated context. If it doesn't, the wallclock/token check
        // will eventually trip.
      }

      // Add tool result to context for next iteration.
      // Using role: "user" maintains proper user/assistant alternation
      // which strict APIs (DeepSeek, Anthropic) require.
      // G-131-loop: entry now carries the arguments used + a repeat-call
      // guard warning when identical (tool, input) already ran (see
      // buildToolResultEntry).
      context.push(buildToolResultEntry(toolName, toolInput, resultText, toolCalls));

      // If the LLM used rag_search, include sources in the final result
      if (toolName === "rag_search" && result.sources) {
        // The LLM will use this in its final response
      }

      // Loop re-iterates naturally with a fresh streamLLM call — no second
      // callLLM. If the LLM wants another tool, the next iteration's
      // streamResult.toolCall will be non-null; if it's ready to answer,
      // toolCall will be null and we break above.
    }
  } finally {
    budget.releaseSlot(userId);

    // BOT-01: persist token usage on ALL exit paths (success, wallclock,
    // token-budget, context-overflow, abort, exception). The finally block
    // fires regardless of how the loop exited. Use budget.snapshot() as the
    // single source of truth (NOT dead-code `let` accumulators).
    const snap = budget.snapshot();
    if (snap.totalTokens > 0) {
      prisma.workspaceTokenUsage.create({
        data: {
          userId,
          workspaceId,
          model: providerConfig.model,
          modelDisplayName: providerConfig.displayName || null,
          promptTokens: snap.tokensPrompt,
          completionTokens: snap.tokensCompletion,
          totalTokens: snap.totalTokens,
        },
      }).catch((err: unknown) => {
        logger.warn(`[orchestrator] Failed to save token usage: ${(err instanceof Error ? err.message : String(err))}`);
      });
    }
  }

  // Phase 95-04 (D-05 — Pitfall 2 warning sign): advisory parseToolCall
  // dead-code detection. When native tools are active, the loop ran ≥ 3 turns,
  // AND parseToolCall was never the source of a dispatched toolCall (count = 0),
  // the fallback path is untested/dead for this model. The warning is ADVISORY
  // — it does NOT abort the loop or change behavior (D-05). Threshold N=3 is
  // hardcoded (D-05 discretion — configurable in a future quick task).
  if (nativeToolsActive && iterations >= 3 && parseToolCallCount === 0) {
    logger.warn(
      "[orchestrator] parseToolCall call count = 0 after N turns with native tools active — fallback may be dead code",
      { workspaceId, chatId, iterations, model: providerConfig.model },
    );
  }

  if (!finalResponse) {
    const reason = budget.getAbortReason();
    const reasonLabel: Record<typeof reason, string> = {
      none: "incomplete",
      wallclock: "wallclock timeout exceeded",
      token_budget: "token budget exhausted",
      context_overflow: "context size budget exceeded",
      loop_detected: "loop detected (same tool called repeatedly)",
      aborted: "request aborted",
      done: "incomplete",
      unknown_tool_breaker: "unknown tool breaker tripped (model hallucinated nonexistent tools repeatedly)",
      maxIterations: "max iterations backstop reached (watchdog failure suspected)",
    };
    finalResponse = `I couldn't complete the analysis: ${reasonLabel[reason]} (${toolCalls.length} tools used: ${toolCalls.map(tc => tc.tool).join(", ")}). Please try rephrasing your question to be more specific.`;
  }

  // Extract sources from tool calls. Sources are captured directly from
  // SkillResult.sources at execution time (tc.sources), NOT by JSON-parsing
  // tc.output (which is a formatted text string, not JSON — the old parse
  // always failed and returned []). Also includes memory_search and
  // web_search sources, not just rag_search.
  // Phase 151 (RAG-02): wiki_query is included in the source filter and the
  // assembled list is deduplicated at the citation layer (wiki page wins,
  // subsumed chunk dropped — D-05). 260829-w5z: filterGroundedCitations then
  // keeps only citations the final response actually grounds on (per-doc cap
  // of 2 + lexical overlap; wiki/archive pass through).
  const sources = filterGroundedCitations(
    dedupeCitations(
      toolCalls
        .filter((tc) => tc.tool === "rag_search" || tc.tool === "memory_search" || tc.tool === "web_search" || tc.tool === "wiki_query")
        .flatMap((tc) => tc.sources || []),
    ),
    finalResponse,
  );

  // DEBUG: check extracted sources
  logger.info(`[DEBUG] runAgent extracted ${sources.length} sources from ${toolCalls.length} toolCalls`);
  if (sources.length > 0) {
    logger.info(`[DEBUG] first source: docId=${sources[0]?.documentId}, chunkText length=${(sources[0]?.chunkText?.length ?? 0)}`);
  }

  // Enforce citationRequired constraint — if any search/retrieval tool was
  // called but no sources were found, append a disclaimer. Covers rag_search,
  // wiki_query, memory_search, and web_search — not just rag_search.
  const SEARCH_TOOLS = new Set(["rag_search", "wiki_query", "memory_search", "web_search"]);
  if (isCitationRequired && sources.length === 0 && toolCalls.some((tc) => SEARCH_TOOLS.has(tc.tool))) {
    finalResponse += "\n\n---\n*No supporting evidence found in the available documents for this response.*";
  }

  // Phase 97 (MEM-03 D-06): fire-and-forget memory extraction. Runs every
  // AGENT_MEMORY_REVIEW_INTERVAL turns (default 10) post-done. Non-blocking —
  // never throws to the SSE stream. Gated by userId non-null (Pitfall 3
  // anonymous widget guard). Phase 140 (EPA-02): the memory_enabled LICENSE
  // gate is removed — memory extraction is always-ON. Budget-aware skip
  // happens inside reviewMemoryAfterTurn.
  if (userId) {
    const memoryInterval = getEnv().AGENT_MEMORY_REVIEW_INTERVAL;
    if (memoryInterval > 0 && iterations % memoryInterval === 0) {
      setImmediate(() => {
        reviewMemoryAfterTurn({
          userId,
          workspaceId,
          providerConfig,
          messages: context,
          turnCount: iterations,
          budgetTracker: budget,
          sourceMessageId: null,
        }).catch((e: unknown) => {
          logger.error("[memory] review_memory_after_turn failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        });
      });
    }
  }

  const finalSnap = budget.snapshot();
  const ragToolCalls = toolCalls.filter((tc) => tc.tool === "rag_search");
  return {
    response: finalResponse,
    sources,
    toolCalls,
    iterations,
    tokenUsage: finalSnap.totalTokens > 0 ? {
      promptTokens: finalSnap.tokensPrompt,
      completionTokens: finalSnap.tokensCompletion,
      totalTokens: finalSnap.totalTokens,
      model: env.LLM_PROVIDER,
    } : undefined,
    providerType: providerConfig.type,
    resolvedModel: providerConfig.model,
    abortReason: budget.getAbortReason(),
    doneReason: finalDoneReason,
    pipeline: {
      toolsCalled: [...new Set(toolCalls.map((tc) => tc.tool))],
      sourcesFound: sources.length,
      ragSearched: ragToolCalls.length > 0,
      ragResults: ragToolCalls.length,
    },
  };
}

/**
 * Streaming variant of runAgent.
 * Instead of returning the full result at once, it:
 * 1. Calls onStatus() during tool execution (e.g., "Searching documents...")
 * 2. Streams the final LLM response token-by-token via onToken()
 * 3. Returns the complete result when done
 *
 * D-02 buffered-replay (per CONTEXT.md D-02 RESOLUTION, approach C):
 * Tool-call iterations buffer tokens internally and discard them (NOT
 * streamed to the user); only the final-answer iteration replays the buffer
 * token-by-token to the real onToken (which is the D-01 progressive DLP
 * flush in chat.ts, plan 62-04). The real onToken applies tail-holdback +
 * scanContent + sendSSE per replayed token — so the user sees tokens appear
 * token-by-token (with DLP holdback), NOT a single block flush, NOT true
 * live (latency to first token = generation time of the final iteration).
 * Backend-only: no frontend touch, no new SSE event.
 */
export async function runAgentStreaming(
  params: AgentRunParams,
  onToken: OnTokenCallback,
  onStatus: (message: string) => void,
  signal?: AbortSignal,
  onEvent?: (event: string, data: unknown) => void,
  onPlan?: (plan: AgentPlan) => void,
  onThinking?: OnThinkingCallback,
): Promise<AgentRunResult> {
  const { workspaceId, userId, message, chatId, history = [], ragContext, disableRagSearch } = params;

  // Load workspace agent config
  let agentConfig = await prisma.workspaceAgentConfig.findUnique({
    where: { workspaceId },
  });

  if (!agentConfig) {
    agentConfig = await prisma.workspaceAgentConfig.create({
      data: { workspaceId },
    });
  }

  let enabledSkillNames: string[];
  try {
    enabledSkillNames = JSON.parse(agentConfig.enabledSkills);
  } catch {
    enabledSkillNames = ["rag_search", "workspace_memory"];
  }

  const resolvedSystemPrompt = await resolveSystemPrompt(workspaceId, agentConfig.systemPrompt);
  enabledSkillNames = await resolveSkills(workspaceId, enabledSkillNames);

  // Fetch user's custom instructions (per D-04: prepend before workspace prompt)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { customInstructions: true },
  });

  let finalSystemPrompt = resolvedSystemPrompt;
  if (user?.customInstructions) {
    finalSystemPrompt = `${user.customInstructions}\n\n${resolvedSystemPrompt}`;
  }
  // 260917-mz6: same widget grounding prepend as runAgent (OUTERMOST — the
  // widget prompt leads). Pre-baked string, no client interpolation.
  // 260917-qoh: the reply-language directive rides INSIDE the widget prompt
  // block (after the widget prompt) in this loop too — the JWT path (no
  // widgetSystemPrompt) stays byte-identical.
  if (params.widgetSystemPrompt) {
    const directive = buildReplyLanguageDirective(params.locale);
    finalSystemPrompt = `${params.widgetSystemPrompt}${directive ? `\n\n${directive}` : ""}\n\n${finalSystemPrompt}`;
  }

  // Load constraints — workspace agent config takes priority over template.
  const template = await getTemplateForWorkspace(workspaceId);
  const templateConstraints = template?.constraints || {};
  let workspaceConstraints: Record<string, unknown> = {};
  try {
    workspaceConstraints = JSON.parse(agentConfig.constraints || "{}");
  } catch {
    workspaceConstraints = {};
  }
  const constraints = { ...templateConstraints, ...workspaceConstraints };
  const isLocalLLMOnly = constraints.localLLMOnly === true;
  const isCitationRequired = constraints.citationRequired === true;
  const isHybridSearchForced = constraints.hybridSearchForced === true;

  const skills = await resolveSkillsForChat(workspaceId, chatId, enabledSkillNames, { userId: params.userId });
  const env = getEnv();

  // Resolve provider config: per-request override > workspace config > default > env fallback
  // 260919 model-missing UX: streaming twin of the runAgent strict arm.
  let providerConfig: ProviderConfig;
  if (params.strictModelResolution) {
    const { config, requestedModel } = await resolveProviderConfigStrict(params.providerId, params.model);
    if (!config) {
      throw new ModelNotAvailableError(requestedModel ?? params.model ?? "default");
    }
    providerConfig = config;
  } else {
    const resolved = await resolveProviderConfig(params.providerId, params.model);
    if (resolved && resolved.model) {
      providerConfig = resolved;
      // Workspace-level model override (only if no per-request override)
      if (!params.model && agentConfig.model && agentConfig.model !== "default") {
        providerConfig.model = agentConfig.model;
      }
      providerConfig.temperature = agentConfig.temperature ?? 0.7;
    } else {
      providerConfig = buildFallbackConfig(env, params.model || agentConfig.model || "gemma4:latest", agentConfig.temperature ?? 0.7);
    }
  }

  if (isLocalLLMOnly && providerConfig.type !== "ollama") {
    const msg = "This workspace requires a local LLM for privacy compliance. Please configure Ollama as the LLM provider.";
    onToken(msg);
    return { response: msg, iterations: 0 };
  }

  // Enforce hybridSearchForced constraint (streaming path)
  if (isHybridSearchForced && !ragContext) {
    finalSystemPrompt += "\n\nMANDATORY SEARCH RULE: You MUST call rag_search (or wiki_query if available) to retrieve documents from the knowledge base BEFORE answering any factual question. Do NOT answer from your training knowledge. If search returns no results, state that no information was found.";
  }

  // Phase 187 (WIKS-01/WIKS-02): archive-bound chats only — streaming twin of
  // the runAgent injection (the streaming seam is separately load-bearing).
  // Hard rule always (WIKS-02/D-06b); advisory schemaPrompt block only when
  // present (WIKS-01/D-03). Before the systemPrompt ternary, in BOTH variants.
  if (params.archiveId) {
    const archiveConfig = await getArchiveConfig(params.archiveId);
    finalSystemPrompt += HARD_RULE_RAW_SOURCES;
    const advisory = buildSchemaPromptBlock(archiveConfig);
    if (advisory) {
      finalSystemPrompt += advisory;
    }
  }

  const systemPrompt = ragContext
    ? `${finalSystemPrompt}\n\nYou have the following pre-retrieved documents from the knowledge base:\n\n${ragContext}\n\nUse the above documents to answer the user's question. You do not need to use the rag_search tool. Always cite your sources when referencing the provided documents.`
    : buildSystemPrompt(finalSystemPrompt, skills, params.locale);

  // 131-07 (G-131-19): rag_search SURVIVES the degraded filter when an
  // archive is bound — its archive fallback (builtinSkills.ts:59-61) is the
  // degraded path's only archive-capable skill, so stripping it would make
  // the archive unreachable exactly when the workspace search failed.
  const activeSkills = (ragContext || (disableRagSearch && !params.archiveId))
    ? skills.filter(s => s.name !== "rag_search")
    : skills;

  // ── Plan mode (two-phase orchestrator) ───────────────────────────────
  // When the workspace has planMode enabled, run a synchronous planning
  // call FIRST: the LLM emits a structured plan (no tools), we forward it
  // to the client as an SSE `plan` event, then inject the plan into the
  // execute-phase system prompt so the ReAct loop follows it. On any
  // failure (timeout, malformed output, LLM refusal) we silently fall
  // back to direct execution — zero overhead vs. the normal path.
  let executeSystemPrompt = systemPrompt;
  if (agentConfig.planMode && onPlan) {
    onStatus("Planning...");
    const plan = await generatePlan(message, history, activeSkills, providerConfig);
    if (plan) {
      onPlan(plan);
      executeSystemPrompt = `${systemPrompt}\n\n${formatPlanInjection(plan)}`;
    } else {
      logger.info("[orchestrator] plan_mode: fallback to direct execution", { workspaceId, chatId });
    }
  }

  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;
  let finalResponse = "";

  // BOT-03 unknown-tool circuit breaker counters (plan 62-05, D-03).
  let consecutiveUnknownTool = 0;
  let totalUnknownTool = 0;

  // Pinned original user message — passed to truncateContextToByteBudget as
  // the 4th arg (BOT-06 caller-site wiring, per checker B3).
  const pinnedUserMsg: ChatMessageEntry = { role: "user", content: message };

  let context: ChatMessageEntry[] = [
    { role: "system", content: executeSystemPrompt },
    ...history.slice(-10),
    pinnedUserMsg,
  ];

  // Phase 190 (SKIL-04, D-12): explicit skillCall injection — streaming twin
  // of the runAgent block (same buildToolResultEntry entry, same toolCalls
  // record). One spotlighted user-level entry BEFORE the first streamLLM;
  // NEVER the system prompt (SC-4 five-point pin).
  if (params.skillCall) {
    const toolName = `custom_${params.skillCall.slug}`;
    context.push(
      buildToolResultEntry(
        toolName,
        params.skillCall.params ?? {},
        params.skillCall.compiledPrompt, // spotlight delimiters already wrapped in chat.ts
        toolCalls, // repeat-guard sees no prior → clean first call
      ),
    );
    toolCalls.push({
      tool: toolName,
      input: params.skillCall.params ?? {},
      output: params.skillCall.compiledPrompt,
      sources: [],
    });
  }

  // Agent budget tracker (replaces the old maxIterations cap).
  const budget = new AgentBudgetTracker();
  budget.acquireSlot(userId);
  // D-04 (Phase 94): captured from the final-answer streamResult on the
  // "done" branch. Stays undefined when the loop exits via watchdog/abort
  // (no final-answer iteration) or the fallback path runs.
  let finalDoneReason: DoneReason | undefined;
  // Always pass native tools to the LLM when skills are available, regardless
  // of the provider's nativeToolsReliable flag. The LLM may or may not use
  // them; if it doesn't, parseToolCall still recovers JSON-formatted tool calls
  // from the response text (the ReAct fallback path).
  const nativeToolsActive = activeSkills.length > 0;
  let parseToolCallCount = 0;
  // Phase 96 (CMP-01 D-07): guard against infinite compaction retry on
  // doneReason=length. If compaction already happened once and the retry
  // still returns length, break (the emergency truncate guard will catch it
  // on the next iteration if needed). Prevents summarize-then-length-then-
  // summarize loops.
  let compactedOnce = false;
  try {
    // ReAct loop — single streamLLM call per iteration (BOT-02).
    // D-02 buffered-replay: each iteration buffers tokens via a local
    // bufferingOnToken (NO SSE forwarding during the call). After streamLLM
    // resolves: toolCall !== null → discard buffer (tool-call iteration,
    // onStatus already provides "Using tool: ..." feedback); toolCall === null
    // → replay the buffer token-by-token to the real onToken (D-01 progressive
    // DLP flush in chat.ts, plan 62-04).
    while (true) {
      iterations++;

      // Watchdog 1: wallclock
      if (budget.wallclockExpired()) {
        budget.setAbortReason("wallclock");
        break;
      }

      // Watchdog 2: token budget
      if (budget.isTokenBudgetExhausted()) {
        budget.setAbortReason("token_budget");
        break;
      }

      // Phase 155 / CSW-07 (D-09, D-10): last-resort iteration backstop (mirror
      // of the runAgent check above). Fires ONLY if every watchdog fails.
      if (iterations >= MAX_ITERATIONS_BACKSTOP) {
        budget.setAbortReason("maxIterations");
        break;
      }

      // D-02 buffered-replay: accumulate tokens emitted by streamLLM into a
      // per-iteration buffer (array preserves token granularity for replay).
      const iterationTokens: string[] = [];
      const bufferingOnToken: OnTokenCallback = (token: string) => {
        iterationTokens.push(token);
      };

      // Single LLM call per iteration — the streaming call IS the decision
      // call. toolCall is parsed from the accumulated stream buffer.
      // 92-05: advertise active skills as native tools to the Ollama daemon
      // (additive; non-Ollama providers ignore the 5th param per D-01).
      // D-01 (Phase 94): onThinking threaded as 6th arg — the callback fires
      // when the provider yields reasoning (Ollama `message.thinking`); chat.ts
      // checks `include_thinking` before emitting the SSE event. The
      // bufferingOnToken pattern is NOT applied to thinking — reasoning is
      // streaming-only and not buffered (per RESEARCH: reasoning is
      // streaming-only, no D-02 replay needed since thinking is not part of
      // the tool-call decision).
      // Phase 95 (D-03) — same conditional gating as runAgent (see above).
      // `nativeToolsReliable === true && activeSkills.length > 0` → advertise
      // native `tools`; else `undefined` (prompt-prepend ReAct JSON path).
      // Phase 95-04 (D-05): `nativeToolsActive` is hoisted to the loop top
      // (declared above the try block) so it is available for the post-loop
      // advisory parseToolCall-count warning.
      const tools = nativeToolsActive ? buildProviderTools(providerConfig.type, activeSkills) : undefined;
      // Phase 97 (MEM-02 D-04): pre-LLM memory retrieval hook — streaming path.
      // Mirror of the runAgent hook (above). Runs BEFORE
      // compact_messages_for_request so the injected `<memory_context>` block
      // in the system message is preserved verbatim by compaction (Phase 96).
      // Best-effort: collector failure → original system message unchanged.
      // Per-user-per-workspace (Pitfall 3). Phase 140 (EPA-02): the
      // memory_enabled LICENSE gate is removed — memory retrieval is
      // always-ON. Only runs once per request (first iteration) — the
      // injected block persists across ReAct iterations and is stripped+
      // recomposed fresh on the next user turn.
      // WR-03 (Phase 187 code review): same dead-guard fix as runAgent —
      // `iterations === 0` never fired because the loop increments first.
      if (iterations === 1 && context[0]?.role === "system") {
        try {
          context[0] = {
            ...context[0],
            content: await retrieveAndInjectMemory({
              userId,
              workspaceId,
              messages: context,
              systemMessageContent: context[0].content,
            }),
          };
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          logger.warn(`[orchestrator] memoryRetrieval hook skipped (best-effort): ${m}`, { workspaceId, chatId });
        }
      }
      // Phase 96 (CMP-01 D-07): smart context compaction pre-streamLLM check
      // (same as runAgent above). Trigger when estimated tokens > 80% of
      // context window (token-based, NOT byte-based — Pitfall 9 off-by-one).
      // No-op below threshold (byte-identical existing path). Coexists with
      // truncateContextToByteBudget (emergency byte-cap guard — D-08).
      const contextBeforeCompact = context;
      context = await compact_messages_for_request(context, providerConfig, budget);
      if (context !== contextBeforeCompact) {
        logger.info("[orchestrator] context_compacted", { workspaceId, chatId, iterations });
      }
      const streamResult = await streamLLM(
        context,
        providerConfig,
        bufferingOnToken,
        signal,
        tools,
        onThinking,
      );
      budget.consumeTokens(streamResult.usage);

      // Phase 95-04 (D-05 — Pitfall 2 warning sign): increment the
      // parseToolCall-count proxy. See runAgent (above) for the full
      // rationale.
      if (!nativeToolsActive || !streamResult.toolCall) parseToolCallCount++;

      // Shared tool-call decision branch (D-10): the same resolveToolCall
      // is called by BOTH loops so the implicit-tool-call wiring stays
      // identical (Pitfall 2 guard). The streaming loop performs its D-02
      // buffered-replay on the "done" signal BEFORE breaking.
      const resolution = resolveToolCall({
        streamResult,
        activeSkills,
        workspaceId,
        chatId,
        iterations,
        budget,
        consecutiveUnknownTool,
        totalUnknownTool,
        context,
      });
      consecutiveUnknownTool = resolution.consecutiveUnknownTool;
      totalUnknownTool = resolution.totalUnknownTool;

      if (resolution.action === "done") {
        // Final-answer iteration — REPLAY the buffered tokens token-by-token
        // to the real onToken (D-01 progressive DLP flush in chat.ts). This is
        // NOT a single-block flush; each buffered token is forwarded
        // individually so the DLP tail-holdback + scanContent runs per token.
        onStatus("Generating response...");
        for (const t of iterationTokens) {
          onToken(t);
        }
        finalResponse = resolution.finalResponse ?? "";
        // D-04 (Phase 94): capture doneReason from the final-answer stream.
        finalDoneReason = streamResult.doneReason;
        // D-05 (Phase 94, Plan 94-03): additive doneReason consumption. The
        // auto-fallback discriminates `length` vs `error` vs `stop`/`unload`/
        // `load`/`undefined`. This is ADDITIVE in the existing path — no new
        // branch introduced (D-05). Today we only LOG the discriminator:
        //   - length  → context fallback (Phase 96 compaction future; log only)
        //   - error   → model fallback (the existing error-handling path
        //               already covers provider/model errors; the helper
        //               surfaces this as `reason: "model"` for future wiring)
        //   - stop    → normal termination (no fallback)
        //   - unload  → log, no model fallback (same model re-loadable — RESEARCH §Q2)
        //   - load    → log, no fallback (transient)
        //   - undefined → existing heuristic (backward compat)
        // The `log` string (set for `unload`/`load`) is surfaced via
        // `logger.warn`. Context-fallback triggering is deferred to Phase 96
        // (CMP-01); model-fallback triggering is handled by the existing
        // error/fallback paths in chat.ts (RC-2 handleFallback on SSE error).
        const doneReasonDecision = shouldFallbackForDoneReason(finalDoneReason);
        if (doneReasonDecision.log) {
          logger.warn(`[orchestrator] doneReason=${finalDoneReason}: ${doneReasonDecision.log}`, {
            workspaceId,
            chatId,
            iterations,
            doneReason: finalDoneReason,
            reason: doneReasonDecision.reason,
          });
        } else if (doneReasonDecision.reason === "context") {
          // Phase 96 (CMP-01 D-07): doneReason=length → context fallback.
          // Phase 94 signaled context-too-long; CMP-01 provides the action.
          if (!compactedOnce) {
            const contextBeforeCompact = context;
            context = await compact_messages_for_request(context, providerConfig, budget);
            if (context !== contextBeforeCompact) {
              logger.info("[orchestrator] doneReason=length → compacted, retrying", { workspaceId, chatId, iterations });
              compactedOnce = true;
              continue; // retry streamLLM with compacted context
            }
          }
          logger.warn("[orchestrator] doneReason=length: context window exceeded (compaction exhausted, continuing with existing behavior)", { workspaceId, chatId, iterations, doneReason: finalDoneReason });
        }
        // reason === "model" (error) and reason === "none" (stop/load/unload/
        // undefined) produce no log here — the existing error/fallback paths
        // in chat.ts (SSE error → handleFallback, RC-2) handle model errors,
        // and normal/undefined termination needs no fallback action.
        break;
      }
      if (resolution.action === "break") {
        break;
      }
      if (resolution.action === "continue") {
        continue;
      }

      // resolution.action === "proceed": tool-call iteration — DISCARD the
      // buffered tokens (D-02: tool-call iterations do NOT stream tokens to
      // the user). The onStatus callback already provides "Using tool: ..."
      // feedback. (iterationTokens falls out of scope and is discarded.)
      const { toolName, toolInput } = streamResult.toolCall!;
      const skill = activeSkills.find((s) => s.name === toolName)!;

      // Notify the client about tool execution
      onStatus(`Using tool: ${skill.displayName || toolName}...`);

      let result: SkillResult;
      try {
        result = await budget.withSkillTimeout(
          skill.execute({
            workspaceId,
            userId,
            query: toolInput.query as string | undefined,
            content: toolInput.content as string | undefined,
            filePath: toolInput.filePath as string | undefined,
            archiveId: params.archiveId,
            locale: params.locale,
            metadata: toolInput,
            sendEvent: onEvent,
            // WR-02/D-13: thread the request's DLP masking decision so the
            // prompt-skill executor masks LLM-supplied tool input (see
            // createPromptSkillExecutor).
            dlpMaskingEnabled: params.dlpMaskingEnabled,
            // Phase 191 (D-04): chat-attached archives → rag_search union
            // (additive-optional — absent stays byte-identical).
            ...(params.attachedArchiveIds?.length ? { attachedArchiveIds: params.attachedArchiveIds } : {}),
          }),
          toolName
        );
      } catch (err: unknown) {
        result = { success: false, error: `Skill execution error: ${(err instanceof Error ? err.message : String(err))}` };
      }

      const resultText = result.success
        ? truncateToolOutput(result.data, getEnv().AGENT_MAX_TOOL_OUTPUT_LENGTH)
        : `Error: ${result.error}`;

      // DEBUG: check sources from skill result (streaming path)
      if (toolName === "rag_search") {
        logger.info(`[DEBUG] runAgentStreaming rag_search result.sources length: ${result.sources?.length ?? 0}`);
        if (result.sources && result.sources.length > 0) {
          logger.info(`[DEBUG] runAgentStreaming first source: docId=${result.sources[0]?.documentId}, chunkText length=${(result.sources[0]?.chunkText?.length ?? 0)}`);
        }
      }

      toolCalls.push({
        tool: toolName,
        input: toolInput,
        output: resultText,
        sources: result.sources,
      });

      // Watchdog 4: context size cap (BOT-06 caller-side: pass pinnedUserMsg
      // as 4th arg so the original question survives trimming).
      const dropped = truncateContextToByteBudget(
        context,
        getEnv().AGENT_MAX_CONTEXT_BYTES,
        4,
        pinnedUserMsg
      );
      if (dropped > 0) {
        logger.warn(`[orchestrator] context_truncated: dropped=${dropped}`, { workspaceId, chatId, iterations });
        budget.setAbortReason("context_overflow");
      }

      // G-131-loop: entry carries the arguments used + a repeat-call guard
      // warning when identical (tool, input) already ran (see
      // buildToolResultEntry — shared with the non-streaming loop).
      context.push(buildToolResultEntry(toolName, toolInput, resultText, toolCalls));

      // Loop re-iterates naturally with a fresh streamLLM call + fresh
      // iterationTokens buffer on the next pass. No second callLLM, no
      // streamLLM re-call — the next iteration's streamResult.toolCall
      // decides tool-vs-response.
    }
  } finally {
    budget.releaseSlot(userId);

    // BOT-01: persist token usage on ALL exit paths (success, wallclock,
    // token-budget, context-overflow, abort, exception). Use budget.snapshot()
    // as the single source of truth.
    const snap = budget.snapshot();
    if (snap.totalTokens > 0) {
      prisma.workspaceTokenUsage.create({
        data: {
          userId,
          workspaceId,
          model: providerConfig.model,
          modelDisplayName: providerConfig.displayName || null,
          promptTokens: snap.tokensPrompt,
          completionTokens: snap.tokensCompletion,
          totalTokens: snap.totalTokens,
        },
      }).catch((err: unknown) => {
        logger.warn(`[orchestrator] Failed to save token usage: ${(err instanceof Error ? err.message : String(err))}`);
      });
    }
  }

  // Phase 95-04 (D-05 — Pitfall 2 warning sign): advisory parseToolCall
  // dead-code detection for the streaming loop. See runAgent (above) for the
  // full rationale. The warning is ADVISORY — it does NOT abort the loop or
  // change behavior (D-05), and it is NOT a field in the `done` SSE event
  // (D-07 — Pitfall 4 widget break avoided).
  if (nativeToolsActive && iterations >= 3 && parseToolCallCount === 0) {
    logger.warn(
      "[orchestrator] parseToolCall call count = 0 after N turns with native tools active — fallback may be dead code",
      { workspaceId, chatId, iterations, model: providerConfig.model },
    );
  }

  if (!finalResponse) {
    const reason = budget.getAbortReason();
    const reasonLabel: Record<typeof reason, string> = {
      none: "incomplete",
      wallclock: "wallclock timeout exceeded",
      token_budget: "token budget exhausted",
      context_overflow: "context size budget exceeded",
      loop_detected: "loop detected (same tool called repeatedly)",
      aborted: "request aborted",
      done: "incomplete",
      unknown_tool_breaker: "unknown tool breaker tripped (model hallucinated nonexistent tools repeatedly)",
      maxIterations: "max iterations backstop reached (watchdog failure suspected)",
    };
    finalResponse = `I couldn't complete the analysis: ${reasonLabel[reason]} (${toolCalls.length} tools used: ${toolCalls.map(tc => tc.tool).join(", ")}). Please try rephrasing your question to be more specific.`;
    onToken(finalResponse);
  }

  // Extract sources from tool calls. Sources are captured directly from
  // SkillResult.sources at execution time (tc.sources), NOT by JSON-parsing
  // tc.output (which is a formatted text string, not JSON — the old parse
  // always failed and returned []). Also includes memory_search and
  // web_search sources, not just rag_search.
  // Phase 151 (RAG-02): wiki_query is included in the source filter and the
  // assembled list is deduplicated at the citation layer (wiki page wins,
  // subsumed chunk dropped — D-05). 260829-w5z: filterGroundedCitations then
  // keeps only citations the final response actually grounds on (per-doc cap
  // of 2 + lexical overlap; wiki/archive pass through).
  const sources = filterGroundedCitations(
    dedupeCitations(
      toolCalls
        .filter((tc) => tc.tool === "rag_search" || tc.tool === "memory_search" || tc.tool === "web_search" || tc.tool === "wiki_query")
        .flatMap((tc) => tc.sources || []),
    ),
    finalResponse,
  );

  // DEBUG: check extracted sources (streaming path)
  logger.info(`[DEBUG] runAgentStreaming extracted ${sources.length} sources from ${toolCalls.length} toolCalls`);
  if (sources.length > 0) {
    logger.info(`[DEBUG] runAgentStreaming first source: docId=${sources[0]?.documentId}, chunkText length=${(sources[0]?.chunkText?.length ?? 0)}`);
  }

  // Enforce citationRequired constraint (streaming path) — covers all
  // search/retrieval tools, not just rag_search.
  const SEARCH_TOOLS_STREAM = new Set(["rag_search", "wiki_query", "memory_search", "web_search"]);
  if (isCitationRequired && sources.length === 0 && toolCalls.some((tc) => SEARCH_TOOLS_STREAM.has(tc.tool))) {
    const disclaimer = "\n\n---\n*No supporting evidence found in the available documents for this response.*";
    finalResponse += disclaimer;
  }

  // Phase 97 (MEM-03 D-06): fire-and-forget memory extraction (streaming path —
  // mirror of the runAgent trigger). Runs every AGENT_MEMORY_REVIEW_INTERVAL
  // turns post-done. Non-blocking — never throws to the SSE stream. Gated by
  // userId non-null (Pitfall 3 anonymous widget guard). Phase 140 (EPA-02):
  // the memory_enabled LICENSE gate is removed — memory extraction is
  // always-ON. Budget-aware skip happens inside reviewMemoryAfterTurn.
  if (userId) {
    const memoryInterval = getEnv().AGENT_MEMORY_REVIEW_INTERVAL;
    if (memoryInterval > 0 && iterations % memoryInterval === 0) {
      setImmediate(() => {
        reviewMemoryAfterTurn({
          userId,
          workspaceId,
          providerConfig,
          messages: context,
          turnCount: iterations,
          budgetTracker: budget,
          sourceMessageId: null,
        }).catch((e: unknown) => {
          logger.error("[memory] review_memory_after_turn failed (streaming)", {
            error: e instanceof Error ? e.message : String(e),
          });
        });
      });
    }
  }

  const finalSnap = budget.snapshot();
  const ragToolCalls = toolCalls.filter((tc) => tc.tool === "rag_search");
  return {
    response: finalResponse,
    sources,
    toolCalls,
    iterations,
    tokenUsage: finalSnap.totalTokens > 0 ? {
      promptTokens: finalSnap.tokensPrompt,
      completionTokens: finalSnap.tokensCompletion,
      totalTokens: finalSnap.totalTokens,
      model: env.LLM_PROVIDER,
    } : undefined,
    providerType: providerConfig.type,
    resolvedModel: providerConfig.model,
    abortReason: budget.getAbortReason(),
    doneReason: finalDoneReason,
    pipeline: {
      toolsCalled: [...new Set(toolCalls.map((tc) => tc.tool))],
      sourcesFound: sources.length,
      ragSearched: ragToolCalls.length > 0,
      ragResults: ragToolCalls.length,
    },
  };
}

/**
 * Build the system prompt with available tools description.
 *
 * 131-07 (G-131-19): locale-aware no-results rule. When the chat carries a
 * visitor locale (widget chat), rule 3's no-results sentence is emitted in
 * that language (the const map below — en/it/ru/de/fr/es/zh, with the
 * pre-existing Italian string as the it entry and an English default). The
 * locale can only select one of these 7 pre-baked sentences — never
 * interpolated raw (T-131-15). When locale is absent, the existing default
 * sentence is kept byte-identical (backward-compat: workspace chats with no
 * locale keep today's exact prompt).
 *
 * CRITICAL — the custom-prompt conflict: finalSystemPrompt is the workspace's
 * RESOLVED prompt (resolveSystemPrompt returns the DB custom prompt verbatim
 * when it differs from the default), so a custom prompt can carry its OWN
 * no-results sentence in another language (Elegregio's DB prompt mirrors
 * general.json's Italian sentence). For locale-carrying chats, rule 3 appends
 * an explicit supersede instruction so the model never emits the base
 * prompt's foreign-language sentence.
 */
const NO_RESULTS_SENTENCES: Record<string, string> = {
  en: "no information was found in the workspace documents. Verify that the relevant files have been uploaded and indexed.",
  it: "Non ho trovato informazioni su questo argomento nei documenti del workspace. Verifica che i file pertinenti siano stati caricati e indicizzati.",
  ru: "информация по этой теме в документах рабочего пространства не найдена. Проверьте, что соответствующие файлы загружены и проиндексированы.",
  de: "zu diesem Thema wurden keine Informationen in den Workspace-Dokumenten gefunden. Überprüfen Sie, ob die relevanten Dateien hochgeladen und indiziert wurden.",
  fr: "aucune information sur ce sujet n'a été trouvée dans les documents de l'espace de travail. Vérifiez que les fichiers pertinents ont été téléchargés et indexés.",
  es: "no se ha encontrado información sobre este tema en los documentos del espacio de trabajo. Verifique que los archivos pertinentes se hayan cargado e indexado.",
  zh: "在工作区文档中未找到有关此主题的信息。请检查相关文件是否已上传并建立索引。",
};

const LOCALE_SUPERSEDE_RULE =
  "If the system prompt above contains a no-results sentence in a different language, that sentence is superseded by this rule: respond with the no-results sentence in the user's language.";

function buildSystemPrompt(basePrompt: string, skills: AgentSkillDefinition[], locale?: string): string {
  const toolDescriptions = skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  // 131-07 (G-131-19): locale-aware rule 3. Known WIDGET_LOCALES value →
  // localized sentence + supersede instruction; absent/unknown → the
  // pre-existing default sentence (byte-identical for workspace chats).
  const noResultsSentence = locale && NO_RESULTS_SENTENCES[locale]
    ? NO_RESULTS_SENTENCES[locale]
    : "Non ho trovato informazioni su questo argomento nei documenti del workspace. Verifica che i file pertinenti siano stati caricati e indicizzati.";

  const localeRule = locale && NO_RESULTS_SENTENCES[locale]
    ? `3. If the tools return no relevant information, respond ONLY with: "${noResultsSentence}"\n   ${LOCALE_SUPERSEDE_RULE}`
    : `3. If the tools return no relevant information, respond ONLY with: "${noResultsSentence}"`;

  // Phase 151 (RAG-03): skill-conditional tool-selection affordance (D-08/D-09).
  // Short imperative sentences emitted only when the corresponding skill is in
  // the resolved skill list — no mention of absent tools (avoids inviting
  // hallucinated tool calls on small models). Additive to the MANDATORY SEARCH
  // RULE blocks; must not contradict the skill descriptions at
  // builtinSkills.ts (rag_search :35, wiki_query :560).
  const hasRagSearch = skills.some((s) => s.name === "rag_search");
  const hasWikiQuery = skills.some((s) => s.name === "wiki_query");
  const toolSelectionRules: string[] = [];
  if (hasRagSearch) {
    toolSelectionRules.push(
      "Use rag_search to search uploaded documents in the workspace knowledge base (hybrid vector + full-text search).",
    );
  }
  if (hasWikiQuery) {
    toolSelectionRules.push(
      "Use wiki_query to read synthesized wiki pages of the bound archive (page search + linked-page traversal).",
    );
  }
  if (hasRagSearch && hasWikiQuery) {
    toolSelectionRules.push(
      "When both tools return overlapping content, cite the wiki page once — do not duplicate the citation from rag_search.",
    );
  }
  const toolSelectionBlock =
    toolSelectionRules.length > 0
      ? `\n\nTOOL SELECTION RULES:\n${toolSelectionRules.map((r) => `- ${r}`).join("\n")}`
      : "";

  return `${basePrompt}

You have access to the following tools:
${toolDescriptions}

To use a tool, respond with a JSON object in this exact format:
{"tool": "tool_name", "input": {"query": "your search query or relevant params"}}

RESPONSE FORMAT — STRICT:
- Your ENTIRE response for a turn MUST be EITHER a single tool-call JSON object OR the final answer to the user. Nothing else.
- Do NOT output preamble, narration, or announcements like "Let me search...", "I will now check...", or "Let me start by...". These waste a turn and prevent the tool from running.
- When you decide to use a tool, the tool-call JSON MUST be the FIRST thing you output, with no preceding text.
- Do NOT wrap the tool-call JSON in markdown code fences or prose. Output the raw JSON object only.

CRITICAL ANTI-HALLUCINATION RULES:
1. When the user asks about any factual topic, you MUST use rag_search (and wiki_query if available) BEFORE responding.
2. You MUST base your response EXCLUSIVELY on the information returned by these tools.
${localeRule}
4. NEVER use your training knowledge to answer factual questions — only use tool-retrieved information.
5. Always cite source document names for every factual statement you make.

TOOL USAGE RULES:
6. After receiving tool results, respond to the user if you have useful information. Only call another tool if the first one returned empty or irrelevant results.
7. Do NOT repeat the same tool call with the same query — it will produce the same result.
8. When a tool result contains the marker [WIKI_NO_CONTENT] or explicitly states no content was found, do NOT call that tool again — respond immediately with the no-information sentence.
9. You have enough iterations to be thorough, but aim to use 1-2 tools per response unless the topic is very broad.${toolSelectionBlock}`;
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Plan Runner — two-phase orchestrator planning helpers.
 *
 * Extracted from `orchestrator.ts` (plan 88-01 MOD-01) so the planning phase
 * can be unit-tested in isolation. The ReAct loops (`runAgent` /
 * `runAgentStreaming`) do NOT use `callLLM` — they use `streamLLM` from
 * `llmStreaming.ts`. `callLLM` is the non-streaming variant used only by
 * `generatePlan` (per RESEARCH A1 correction). It stays module-private
 * here; only `generatePlan` is exported.
 *
 * No heavy imports beyond the shared `AgentPlan` type, the parser, and
 * the LLM streaming module's `parseToolCall` helper (used to detect a
 * native tool call embedded in the plan output).
 */
import axios, { AxiosError } from "axios";
import type { AgentPlan, ProviderConfig } from "@simmetric-chat/shared";

import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { getOllamaClient } from "../services/ollamaClient";
import { parsePlan } from "./planParser";
import { parseToolCall } from "./llmStreaming";
import type { AgentSkillDefinition } from "./skills";
import type { ChatMessageEntry } from "./agentTypes";

// Intentionally not exported — internal planning-phase constants (Phase 180
// sweep: the orchestrator facade re-export had no consumers).
const PLAN_SYSTEM_PROMPT = `You are in PLANNING mode. Your ONLY task is to create a structured plan.
Do NOT execute any tools. Do NOT answer the user's question.
Output ONLY a JSON object with this exact structure:

{
  "goal": "<one-line summary of what you'll accomplish>",
  "steps": [
    { "step": 1, "action": "<what you'll do>", "tool": "<tool_name or null>" }
  ]
}

Rules:
- Max 5 steps
- First step should usually be a tool call (rag_search, wiki_query)
- Last step should be the final response (tool: null)
- Be specific about what you'll search for
- Output the JSON object and NOTHING else (no markdown fences, no prose).`;

/** Planning-phase timeout (ms). On expiry we fall back to direct execution. */
const PLAN_TIMEOUT_MS = 15000;
/** Number of LLM attempts before giving up on planning. */
const PLAN_MAX_ATTEMPTS = 2;

/**
 * Run the planning phase: a single synchronous LLM call that returns a
 * structured plan (no tool execution). Returns null when the LLM refuses
 * the format after PLAN_MAX_ATTEMPTS, on timeout, or on any LLM error —
 * the caller then falls back to direct execution.
 *
 * Exported for unit testing (mock the LLM by spying on `callLLM` is not
 * possible since it's module-private; tests import `generatePlan` and
 * inject a provider config, exercising the parse/fallback paths via the
 * real `callLLM` against a mocked axios).
 */
export async function generatePlan(
  message: string,
  history: ChatMessageEntry[],
  skills: AgentSkillDefinition[],
  providerConfig: ProviderConfig,
): Promise<AgentPlan | null> {
  const toolHint = skills.length > 0
    ? `\nAvailable tools: ${skills.map((s) => s.name).join(", ")}`
    : "";

  const planContext: ChatMessageEntry[] = [
    { role: "system", content: `${PLAN_SYSTEM_PROMPT}${toolHint}` },
    ...history.slice(-6),
    { role: "user", content: message },
  ];

  // Lower temperature for deterministic, well-formed JSON.
  const planProviderConfig: ProviderConfig = { ...providerConfig, temperature: 0.2 };

  for (let attempt = 0; attempt < PLAN_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(callLLM(planContext, planProviderConfig), PLAN_TIMEOUT_MS);
      const plan = parsePlan(result.content);
      if (plan) return plan;
      logger.warn(`[orchestrator] plan_mode: malformed plan (attempt ${attempt + 1}/${PLAN_MAX_ATTEMPTS})`);
    } catch (err) {
      const label = err instanceof Error && err.message === "plan_timeout" ? "timeout" : "error";
      logger.warn(`[orchestrator] plan_mode: ${label} (attempt ${attempt + 1}/${PLAN_MAX_ATTEMPTS})`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

/** Race a promise against a timeout, rejecting with a labelled error. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("plan_timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Call the configured LLM provider.
 * Returns either a direct response or a tool call.
 */
async function callLLM(
  context: ChatMessageEntry[],
  providerConfig: ProviderConfig,
): Promise<{ content: string; toolCall?: { toolName: string; toolInput: Record<string, unknown> }; usage?: { promptTokens: number; completionTokens: number } }> {
  const messages = context.map((m) => ({
    role: m.role as string,
    content: m.content,
  }));

  let responseText: string;
  let promptTokens = 0;
  let completionTokens = 0;

  switch (providerConfig.type) {
    case "ollama": {
      logger.debug(`[orchestrator] Ollama call: model=${providerConfig.model}, baseUrl=${providerConfig.baseUrl}, hasApiKey=${!!providerConfig.apiKey}, isCloud=${providerConfig.isLocal === false}`);
      try {
        // D-02: shared factory — the cache key carries auth-ness (Pitfall 4).
        const client = getOllamaClient(providerConfig.baseUrl, {
          timeoutMs: getEnv().LLM_TIMEOUT,
          apiKey: providerConfig.apiKey ?? undefined,
        });
        const response = await client.chat({
          model: providerConfig.model,
          messages,
          stream: false,
          keep_alive: getEnv().OLLAMA_KEEP_ALIVE,
          options: { temperature: providerConfig.temperature },
        });

        responseText = response.message?.content || "";
        promptTokens = response.prompt_eval_count || 0;
        completionTokens = response.eval_count || 0;
      } catch (err) {
        // ollama-js ResponseError is thrown but NOT exported by the module —
        // duck-type it via err.status_code (RESEARCH Pattern 3).
        const status =
          err !== null &&
          typeof err === "object" &&
          "status_code" in err &&
          typeof (err as { status_code?: unknown }).status_code === "number"
            ? (err as { status_code: number }).status_code
            : undefined;
        if (status === 400) {
          const apiError =
            (err !== null &&
            typeof err === "object" &&
            "error" in err &&
            typeof (err as { error?: unknown }).error === "string"
              ? (err as { error: string }).error
              : undefined) || (err instanceof Error ? err.message : String(err));
          throw new Error(
            `Model "${providerConfig.model}" rejected the request (HTTP 400). The conversation may exceed the context window. API error: ${apiError}`,
            { cause: err },
          );
        }
        if (status === 401) {
          if (providerConfig.apiKey) {
            throw new Error(
              `Model "${providerConfig.model}" authentication failed. The configured API key appears invalid or expired. [CLOUD_MODEL_AUTH_FAILED]`,
              { cause: err },
            );
          }
          throw new Error(
            `Model "${providerConfig.model}" requires authentication. Cloud models require an API key. Please add your Ollama API key in Settings > Providers. [CLOUD_MODEL_OFFLINE]`,
            { cause: err },
          );
        }
        throw err;
      }
      break;
    }
    case "openai":
    case "openrouter": {
      const apiKey = providerConfig.apiKey;
      if (!apiKey) throw new Error(`${providerConfig.type === "openrouter" ? "OpenRouter" : "OpenAI"} API key not configured`);

      try {
        const response = await axios.post(`${providerConfig.baseUrl}/v1/chat/completions`, {
          model: providerConfig.model,
          messages,
          temperature: providerConfig.temperature,
        }, {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: getEnv().LLM_TIMEOUT,
        });

        const choice = response.data.choices?.[0];
        responseText = choice?.message?.content || "";
        promptTokens = response.data.usage?.prompt_tokens || 0;
        completionTokens = response.data.usage?.completion_tokens || 0;

        // Check for native OpenAI tool_calls first (model uses built-in function calling)
        const nativeToolCalls = choice?.message?.tool_calls;
        if (nativeToolCalls && nativeToolCalls.length > 0) {
          const tc = nativeToolCalls[0];
          const toolName = tc.function?.name;
          let toolInput: Record<string, unknown> = {};
          try {
            toolInput = JSON.parse(tc.function?.arguments || "{}");
          } catch {
            // Leave toolInput as empty object
          }
          if (toolName) {
            return { content: responseText, toolCall: { toolName, toolInput }, usage: { promptTokens, completionTokens } };
          }
        }
      } catch (err) {
        if (err instanceof AxiosError && err.response?.status === 400) {
          const apiError = (err instanceof Error ? err.message : String(err));
          throw new Error(
            `Model "${providerConfig.model}" rejected the request (HTTP 400). The conversation may exceed the context window or the message format is invalid. API error: ${apiError}`,
            { cause: err },
          );
        }
        throw err;
      }
      break;
    }
    case "anthropic": {
      const apiKey = providerConfig.apiKey;
      if (!apiKey) throw new Error("Anthropic API key not configured");

      try {
        const response = await axios.post(`${providerConfig.baseUrl}/v1/messages`, {
          model: providerConfig.model,
          max_tokens: providerConfig.maxTokens ?? 4096,
          temperature: providerConfig.temperature,
          messages: messages.filter((m) => m.role !== "system"),
          system: messages.find((m) => m.role === "system")?.content,
        }, {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          timeout: getEnv().LLM_TIMEOUT,
        });

        responseText = response.data.content?.[0]?.text || "";
        promptTokens = response.data.usage?.input_tokens || 0;
        completionTokens = response.data.usage?.output_tokens || 0;
      } catch (err) {
        if (err instanceof AxiosError && err.response?.status === 400) {
          const apiError = (err instanceof Error ? err.message : String(err));
          throw new Error(
            `Model "${providerConfig.model}" rejected the request (HTTP 400). The conversation may exceed the context window or the message format is invalid. API error: ${apiError}`,
            { cause: err },
          );
        }
        throw err;
      }
      break;
    }
    default:
      throw new Error(`Unsupported LLM provider: ${providerConfig.type}`);
  }

  // Check if the response contains a tool call (JSON format)
  const toolCall = parseToolCall(responseText);
  if (toolCall) {
    return { content: responseText, toolCall, usage: { promptTokens, completionTokens } };
  }

  return { content: responseText, usage: { promptTokens, completionTokens } };
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Model Fallback — provider config resolution fallback.
 *
 * Extracted from `orchestrator.ts` (plan 88-01 MOD-01). Used by both ReAct
 * loops (`runAgent` / `runAgentStreaming`) when `resolveProviderConfig`
 * returns no usable provider — builds a `ProviderConfig` from env vars and
 * the requested model/temperature. The loops import `buildFallbackConfig`
 * directly; `orchestrator.ts` re-exports nothing here (the helper is
 * module-internal to the agent layer).
 *
 * Plan 94-03 (D-05): `shouldFallbackForDoneReason` discriminates the LLM
 * termination reason returned by `streamLLM` (and threaded through
 * `AgentRunResult.doneReason`) into an auto-fallback decision:
 *   - `length`  → context fallback (Phase 96 compaction future; logged here)
 *   - `error`   → model fallback (provider/model error → try a different one)
 *   - `stop`    → no fallback (normal termination)
 *   - `unload`  → no model fallback (Ollama model unloaded mid-stream; log,
 *                 same model can be re-loaded on next request — RESEARCH §Q2)
 *   - `load`    → no fallback (Ollama model loading; transient)
 *   - undefined → no fallback (existing heuristic handles backward compat)
 * The helper is pure and side-effect-free; callers (orchestrator) decide
 * whether to act on `fallback` and how to surface `log`. This is additive
 * in the existing fallback path — no new branch introduced (D-05).
 */
import type { ProviderConfig } from "@simmetric-chat/shared";

import { getEnv } from "../config/env";
import { deriveCapabilities } from "../services/providerService";
import type { DoneReason } from "./llmStreaming";

export function buildFallbackConfig(env: ReturnType<typeof getEnv>, model: string, temperature: number): ProviderConfig {
  const type = (env.LLM_PROVIDER || "ollama") as ProviderConfig["type"];
  const isOllamaCloud = type === "ollama" && model.endsWith(":cloud");
  // Phase 95 (D-01) — capability flag lives in capability derivation, not DB.
  // The env-var fallback path threads `nativeToolsReliable` so the same
  // gating applies whether the provider came from DB resolution or env
  // defaults. First-class providers (ollama/openai/anthropic NOT in
  // PROVIDER_PRESETS per RESEARCH A3) → preset flag `undefined` (registry-only).
  const baseUrl =
    env.OLLAMA_BASE_URL ||
    (type === "openai" ? "https://api.openai.com"
      : type === "anthropic" ? "https://api.anthropic.com"
      : type === "openrouter" ? env.OPENROUTER_BASE_URL
      : isOllamaCloud ? "https://ollama.com"
      : "http://ollama:11434");
  const nativeToolsReliable = deriveCapabilities(model, type, isOllamaCloud).includes("nativeTools");
  return {
    type,
    baseUrl,
    apiKey: type === "openai" ? (env.OPENAI_API_KEY || env.LLM_API_KEY || null) : type === "anthropic" ? (env.ANTHROPIC_API_KEY || env.LLM_API_KEY || null) : type === "openrouter" ? (env.OPENROUTER_API_KEY || env.LLM_API_KEY || null) : (env.OLLAMA_API_KEY || null),
    model: model || env.LLM_MODEL || (type === "openrouter" ? env.OPENROUTER_MODEL : null) || "gemma4:latest",
    displayName: undefined,
    temperature,
    isLocal: type === "ollama" ? !isOllamaCloud : false,
    nativeToolsReliable,
  };
}

/**
 * D-05 (Phase 94): discriminate `doneReason` into an auto-fallback decision.
 *
 * The helper is pure — it returns a descriptor and the caller decides how to
 * act on `reason` and whether to surface `log` via `logger.warn`. There is
 * intentionally NO "model fallback" branch separate from `error`; the
 * orchestrator's existing fallback path already handles provider/model
 * errors, and `length` is a *context* fallback (Phase 96 future) which the
 * orchestrator logs but does NOT trigger today (per RESEARCH §Auto-fallback
 * consumption — context compaction is Phase 96 future, for now we log and
 * continue with existing behavior).
 *
 * Values:
 *   - `length`  → `{ fallback: true,  reason: "context" }`
 *   - `error`   → `{ fallback: true,  reason: "model" }`
 *   - `stop`    → `{ fallback: false, reason: "none" }`
 *   - `unload` → `{ fallback: false, reason: "none", log: <string> }`
 *   - `load`   → `{ fallback: false, reason: "none", log: <string> }`
 *   - undefined → `{ fallback: false, reason: "none" }` (existing heuristic)
 *
 * @returns an object with `fallback` (whether to trigger fallback), `reason`
 *          (the discriminator: "context" | "model" | "none"), and optional
 *          `log` (a warning string the caller should `logger.warn` when set).
 */
export function shouldFallbackForDoneReason(
  doneReason: DoneReason | undefined,
): { fallback: boolean; reason: "context" | "model" | "none"; log?: string } {
  switch (doneReason) {
    case "length":
      // Context too long — context fallback / future compaction (Phase 96).
      // Per RESEARCH: for now we log and continue with existing behavior
      // (the caller logs the warning; no model fallback triggered today).
      return { fallback: true, reason: "context" };
    case "error":
      // Provider/model error — model fallback (try a different provider/model).
      return { fallback: true, reason: "model" };
    case "stop":
      // Normal termination — no fallback.
      return { fallback: false, reason: "none" };
    case "unload":
      // Ollama model unloaded mid-stream (memory pressure). Anomalous but NOT
      // an error — the same model can be re-loaded on the next request. Log,
      // do NOT trigger model fallback (RESEARCH open question 2 resolved).
      return {
        fallback: false,
        reason: "none",
        log: "Ollama model unloaded mid-stream (doneReason: unload) — re-load same model on next request, no model fallback",
      };
    case "load":
      // Ollama model loading — transient, no fallback.
      return {
        fallback: false,
        reason: "none",
        log: "Ollama model loading (doneReason: load) — transient, no fallback",
      };
    default:
      // undefined (or any future enum value not yet handled) — backward
      // compat: the existing heuristic in the orchestrator handles this.
      return { fallback: false, reason: "none" };
  }
}
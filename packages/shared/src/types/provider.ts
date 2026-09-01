// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

export interface Provider {
  id: string;
  name: string;
  type: "ollama" | "openai" | "anthropic" | "openrouter" | "gemini" | "xiaomi" | "minimax";
  baseUrl: string;
  apiKey: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  lastError: string | null;
  lastSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  models?: ProviderModel[];
}

export interface ProviderModel {
  id: string;
  providerId: string;
  name: string;
  displayName: string | null;
  isLocal: boolean;
  isEnabled: boolean;
  isAvailable: boolean;
  isEmbedding: boolean;
  isOcr: boolean;
  temperature: number | null;
  maxTokens: number | null;
  createdAt: Date;
  updatedAt: Date;
  provider?: Provider;
}

export interface ProviderConfig {
  type: "ollama" | "openai" | "anthropic" | "openrouter" | "gemini" | "xiaomi" | "minimax";
  baseUrl: string;
  apiKey: string | null;
  model: string;
  displayName?: string | null;
  temperature: number;
  maxTokens?: number;
  isLocal?: boolean;
  /**
   * Phase 95 (D-01) — per-model capability flag, additive + optional.
   * `true`  → the orchestrator advertises active skills as native `tools` to
   * the provider (ollama-js `tools` / OpenAI / Anthropic function-calling).
   * `false` / `undefined` → existing prompt-prepend ReAct JSON path
   * (byte-identical to pre-95 behavior). The flag is derived in
   * `deriveCapabilities` (pure function, registry pattern-match + preset
   * data flag) and cached here at provider-resolution time; it is NOT a DB
   * field on `ProviderModel` (no Prisma migration — D-01). Default `false`
   * (opt-in; D-01 conservative default — new models stay "interpreter only"
   * until D-06 integration tests in Plan 04 flip the flag to `true`).
   */
  nativeToolsReliable?: boolean;
  /**
   * Phase 96 (CMP-01 D-01) — additive optional per-model context window size
   * in tokens; fallback `AGENT_MAX_TOTAL_TOKENS` (200000) when undefined.
   * Populated by the orchestrator at call time (NOT by providerService.
   * resolveProviderConfig — that function stays unchanged). The compaction
   * path reads `providerConfig.contextWindowTokens ?? getEnv().AGENT_MAX_TOTAL_TOKENS`
   * per D-01 auto context-window-source decision.
   */
  contextWindowTokens?: number;
}

/**
 * Catalog preset row (mirrors the Prisma `ProviderPreset` model and the
 * `PROVIDER_PRESETS` constant shape). Used by the server catalog routes and
 * the frontend catalog UI.
 */
export interface ProviderPreset {
  id: string;
  slug: string;
  name: string;
  type: Provider["type"];
  baseUrl: string | null;
  defaultModel: string | null;
  authMethod: "bearer" | "x-api-key" | "none" | "oauth";
  docsUrl: string;
  requiresOAuth: boolean;
  category: string;
  description: string | null;
  /**
   * Phase 95 (D-01) — catalog-level default for the per-model capability flag.
   * Additive + optional; default `false` (D-01 conservative default — no preset
   * is flagged reliable in Plan 01; Plan 04 D-06 integration tests flip presets
   * `true` after verifying the real-provider wire format). `deriveCapabilities`
   * reads this field when no `NATIVE_TOOLS_OVERRIDES` registry entry overrides
   * the model — preset flagged `true` → all of the preset's models emit the
   * `nativeTools` capability by default (registry overrides per-model quirk).
   */
  nativeToolsReliable?: boolean;
  isInstalled?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ProviderWithModels extends Provider {
  models: ProviderModel[];
}
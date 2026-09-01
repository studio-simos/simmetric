// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Provider capability registries + preset lookup helper.
 *
 * Extracted from `providerService.ts` (Phase 158 / CSW-14) so that adding a
 * model capability override edits a typed data file, not a 938-line service
 * file. The registries are data; the service is logic.
 *
 * Consumers (`isEmbeddingModel`, `deriveCapabilities`, `listAvailableProviders`
 * in `providerService.ts`) import these symbols — behavior is byte-identical
 * to the previous inline definitions.
 */

export const EMBEDDING_PATTERNS: RegExp[] = [
  /embed/i, /bge/i, /e5/i, /nomic/i, /mxbai/i,
  /text-embedding/i, /all-MiniLM/i, /all-mpnet/i,
  /gte/i, /stella/i, /multilingual-e5/i,
];

export const CAPABILITY_OVERRIDES: Record<string, string[]> = {
  "o1": ["reasoning", "smartest"],
  "o3": ["reasoning", "smartest"],
  "claude-3-opus": ["smartest"],
  "claude-3-5-sonnet": ["reasoning"],
  "gpt-4o-mini": ["fastest"],
  "gpt-4o": ["smartest"],
  "haiku": ["fastest"],
};

/**
 * Phase 95 (D-02) — per-model native-tools reliability registry. Sibling of
 * `CAPABILITY_OVERRIDES`; same pattern-match mechanism (case-insensitive
 * `modelName.includes(pattern)`). First-match-wins semantics:
 *   - registry entry present → its value (`true`/`false`) is authoritative;
 *   - registry entry absent → fall back to the preset data flag
 *     (`findPresetNativeToolsReliable`, threaded as the 4th arg of
 *     `deriveCapabilities`);
 *   - neither → no `nativeTools` tag (D-01 default `false`).
 * `false` overrides are explicit (Pitfall 2 example: `gemma4` is NOT
 * reliable). Plans 02/03 seeds OpenAI/Anthropic reliable models so the
 * registry is not re-touched; Plan 04 D-06 integration tests verify the
 * real-provider wire format before any preset is flipped to `true`.
 */
export const NATIVE_TOOLS_OVERRIDES: Record<string, boolean> = {
  // Ollama path (Plan 01 — qwen2.5 is the canonical reliable model per
  // RESEARCH Open Question 3; gemma4 is the explicit-unreliable override).
  "qwen": true,
  "gemma4": false,
  // deepseek models (deepseek-v4-flash:cloud, deepseek-chat, deepseek-reasoner)
  // support native tool calling through Ollama cloud / OpenAI-compatible API.
  "deepseek": true,
  "kimi": true,
  // OpenAI path (Plan 02 — gpt-4o family + o1/o3 reasoning models).
  "gpt": true,
  "o1": true,
  "o3": true,
  // Anthropic path (Plan 03 — claude-3-5-sonnet + claude-3-opus).
  "claude": true,
};

/**
 * Phase 95 (D-02) — look up a provider preset's catalog-level
 * `nativeToolsReliable` flag by `providerType` and `baseUrl`. First-class
 * providers (ollama / openai / anthropic NOT present in `PROVIDER_PRESETS`
 * per RESEARCH A3) return `undefined` (registry-only — no preset default).
 * Catalog providers return the preset's `nativeToolsReliable` value (or
 * `undefined` when the field is absent — backward-compat with presets not
 * yet updated). Inline helper (D-02 discretion: <30 presets — no dedicated
 * file). The match key is `type` + `baseUrl` (both must match — preset
 * `baseUrl` is nullable for OAuth-manual entries, which never match a
 * resolved provider's non-null baseUrl).
 */
export function findPresetNativeToolsReliable(providerType: string, baseUrl: string | null): boolean | undefined {
  // Lazy import via require (CommonJS) to avoid pulling the full shared
  // barrel eagerly at module-load time — `providerPresets` is pure data but
  // importing it at the top of providerService.ts would drag the whole
  // `@simmetric-chat/shared` barrel into the initial module graph. Keeping the
  // require local to this lookup means unrelated code paths don't pay the
  // cost. `require` is the project's module system (server = CommonJS).
  const { PROVIDER_PRESETS } = require("@simmetric-chat/shared") as typeof import("@simmetric-chat/shared");
  for (const preset of PROVIDER_PRESETS) {
    if (preset.type !== providerType) continue;
    if (baseUrl === null) {
      // OAuth-manual presets carry baseUrl: null — only match when the
      // caller also passes null (used by tests; production providers have a
      // non-null baseUrl).
      if (preset.baseUrl === null) return preset.nativeToolsReliable;
    } else if (preset.baseUrl === baseUrl) {
      return preset.nativeToolsReliable;
    }
  }
  return undefined;
}
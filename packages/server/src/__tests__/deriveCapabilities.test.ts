// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * deriveCapabilities — Phase 95 (D-02) capability detection unit tests.
 *
 * Covers NTV-01 SC1: `deriveCapabilities` emits the `nativeTools` tag for
 * models whose name matches the `NATIVE_TOOLS_OVERRIDES` registry (case-
 * insensitive pattern match, first-match-wins) OR whose preset's
 * `nativeToolsReliable` flag is `true` (4th arg, when no registry entry
 * matches). The registry override beats the preset flag (per-model quirk
 * wins over catalog-level default). Default `false` (D-01 conservative
 * default — unknown models emit no `nativeTools` tag).
 */
import "./helpers/setupEnv";

import { deriveCapabilities } from "../services/providerService";

describe("deriveCapabilities — Phase 95 nativeTools tag (D-02)", () => {
  it("qwen2.5 model emits nativeTools tag (registry true override)", () => {
    expect(deriveCapabilities("qwen2.5:3b", "ollama", false).includes("nativeTools")).toBe(true);
  });

  it("gemma4 model does NOT emit nativeTools (explicit false override — Pitfall 2 example)", () => {
    expect(deriveCapabilities("gemma4:latest", "ollama", false).includes("nativeTools")).toBe(false);
  });

  it("unknown model does NOT emit nativeTools (default false — D-01 conservative default)", () => {
    expect(deriveCapabilities("some-unknown-model", "ollama", false).includes("nativeTools")).toBe(false);
  });

  it("gpt-4o-mini emits nativeTools (OpenAI registry entry — Plan 02 seed)", () => {
    expect(deriveCapabilities("gpt-4o-mini", "openai", true).includes("nativeTools")).toBe(true);
  });

  it("claude-3-5-sonnet emits nativeTools (Anthropic registry entry — Plan 03 seed)", () => {
    expect(deriveCapabilities("claude-3-5-sonnet-20241022", "anthropic", true).includes("nativeTools")).toBe(true);
  });

  it("preset flag true + no registry override → emits nativeTools (catalog-level default)", () => {
    // `deepseek-chat` is not in NATIVE_TOOLS_OVERRIDES → the 4th-arg preset
    // flag is consulted; preset true → nativeTools emitted.
    expect(deriveCapabilities("deepseek-chat", "openai", true, true).includes("nativeTools")).toBe(true);
  });

  it("registry false override beats preset true (per-model override wins — D-02)", () => {
    // `gemma4` is in NATIVE_TOOLS_OVERRIDES as `false`; even with a preset
    // flag of `true`, the registry override is authoritative (per-model
    // quirk wins over catalog-level default — D-02).
    expect(deriveCapabilities("gemma4", "ollama", false, true).includes("nativeTools")).toBe(false);
  });
});
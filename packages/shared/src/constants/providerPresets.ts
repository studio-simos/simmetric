// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * @fileoverview Provider preset catalog constants.
 *
 * Pure data — no business logic (per shared package boundary). Each entry
 * describes an LLM provider that can be installed one-click from the
 * Settings → Providers catalog. Entries are seeded into the `ProviderPreset`
 * Prisma table by `packages/server/prisma/seed.ts`.
 *
 * Classification (per CONTEXT D-04, verified against public endpoints):
 *   - OpenAI-compatible (`type: "openai"`, authMethod "bearer"):
 *       DeepSeek, Mistral, Kimi/Moonshot, NVIDIA NIM, OpenAI Codex,
 *       OpenCode Go, OpenCode Zen, Qwen (api-key), xAI (api-key),
 *       Z.AI/GLM, Nous Portal, MiniMax, MiniMax China, LM Studio (local).
 *   - Native (`type: "gemini" | "xiaomi"`): Gemini, Xiaomi MiMo.
 *     Gemini's native runtime handler (discover/stream/non-stream) shipped in
 *     quick 260723-uzf. Xiaomi MiMo's handler is still pending. The enum value
 *     `minimax` is declared in `providerTypeSchema` for future use, but NO
 *     preset uses it today — MiniMax exposes an OpenAI-compatible chat
 *     completions endpoint and is therefore classified as `type: "openai"`
 *     above. When a future MiniMax native endpoint diverges from the
 *     OpenAI-compatible one, a `type: "minimax"` preset can be added here and
 *     the native handler follow-up task will implement it.
 *   - OAuth (manual references, `requiresOAuth: true`, `baseUrl: null`):
 *       GitHub Copilot, Copilot ACP, Qwen OAuth, xAI Grok OAuth.
 *     These appear in the catalog as documented manual references; install is
 *     disabled (422 at the route).
 *
 * Best-effort baseUrls (verified where possible, may surface as non-fatal
 * `lastError` on install if wrong): OpenCode Go, OpenCode Zen, Nous Portal,
 * Xiaomi MiMo. Z.AI/Zhipu base URL is the documented
 * `https://open.bigmodel.cn/api/paas/v4` (the plan's `api.z.ai` was incorrect).
 */

const PROVIDER_PRESET_CATEGORIES = [
  "OpenAI-compatible",
  "Cloud (api-key)",
  "Local",
  "Native",
  "OAuth (manual)",
] as const;

export type ProviderPresetCategory = (typeof PROVIDER_PRESET_CATEGORIES)[number];

export const PROVIDER_PRESETS = [
  // ── OpenAI-compatible ────────────────────────────────────────────────
  {
    id: "deepseek",
    name: "DeepSeek",
    type: "openai" as const,
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    authMethod: "bearer" as const,
    docsUrl: "https://api-docs.deepseek.com/",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "DeepSeek chat & reasoning models (deepseek-chat, deepseek-reasoner). OpenAI-compatible API.",
    nativeToolsReliable: false,
  },
  {
    id: "mistral",
    name: "Mistral",
    type: "openai" as const,
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    authMethod: "bearer" as const,
    docsUrl: "https://docs.mistral.ai/",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "Mistral AI large, medium, small, and embedding models. OpenAI-compatible base URL.",
    nativeToolsReliable: false,
  },
  {
    id: "kimi-moonshot",
    name: "Kimi / Moonshot",
    type: "openai" as const,
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-128k",
    authMethod: "bearer" as const,
    docsUrl: "https://platform.moonshot.cn/docs",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "Moonshot Kimi long-context models (128k/8k/32k). OpenAI-compatible.",
    nativeToolsReliable: false,
  },
  {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    type: "openai" as const,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    defaultModel: "meta/llama-3.1-405b-instruct",
    authMethod: "bearer" as const,
    docsUrl: "https://docs.nvidia.com/nim/large-language-models/latest/getting-started.html",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "NVIDIA NIM hosted open models (Llama, Mistral, Qwen). OpenAI-compatible.",
    nativeToolsReliable: false,
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    type: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "codex-latest",
    authMethod: "bearer" as const,
    docsUrl: "https://platform.openai.com/docs/api-reference",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "OpenAI Codex / GPT models. OpenAI-compatible.",
    nativeToolsReliable: false,
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    type: "openai" as const,
    baseUrl: "https://api.opencode.ai/v1",
    defaultModel: "opencode-go-latest",
    authMethod: "bearer" as const,
    docsUrl: "https://opencode.ai/docs",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "OpenCode Go coding assistant (best-effort endpoint). OpenAI-compatible.",
    nativeToolsReliable: false,
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    type: "openai" as const,
    baseUrl: "https://api.opencode.ai/v1",
    defaultModel: "opencode-zen-latest",
    authMethod: "bearer" as const,
    docsUrl: "https://opencode.ai/docs",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "OpenCode Zen reasoning model (best-effort endpoint). OpenAI-compatible.",
    nativeToolsReliable: false,
  },
  {
    id: "qwen-apikey",
    name: "Qwen (api-key)",
    type: "openai" as const,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    authMethod: "bearer" as const,
    docsUrl: "https://help.aliyun.com/zh/dashscope/developer-reference/compatibility-of-openai-with-dashscope",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "Alibaba Qwen via DashScope OpenAI-compatible mode. Use this if you have a DashScope API key.",
    nativeToolsReliable: false,
  },
  {
    id: "xai-apikey",
    name: "xAI (api-key)",
    type: "openai" as const,
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4",
    authMethod: "bearer" as const,
    docsUrl: "https://docs.x.ai/docs/overview",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "xAI Grok models via API key. OpenAI-compatible.",
    nativeToolsReliable: false,
  },
  {
    id: "zai-glm",
    name: "Z.AI / GLM",
    type: "openai" as const,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
    authMethod: "bearer" as const,
    docsUrl: "https://docs.bigmodel.cn/en/guide/develop/http/introduction",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "Zhipu BigModel GLM-4 / GLM-5 series. OpenAI-compatible chat completions at /api/paas/v4.",
    nativeToolsReliable: false,
  },
  {
    id: "nous-portal",
    name: "Nous Portal",
    type: "openai" as const,
    baseUrl: "https://inference.nousportal.com/v1",
    defaultModel: "nous-hermes-2",
    authMethod: "bearer" as const,
    docsUrl: "https://docs.nousresearch.com/",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "Nous Research Hermes models via Nous Portal (best-effort endpoint). OpenAI-compatible.",
    nativeToolsReliable: false,
  },
  {
    id: "minimax",
    name: "MiniMax",
    type: "openai" as const,
    baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-Text-01",
    authMethod: "bearer" as const,
    docsUrl: "https://platform.minimaxi.com/document/ChatCompletion",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "MiniMax Text-01 / abab models (international endpoint). OpenAI-compatible chat completions.",
    nativeToolsReliable: false,
  },
  {
    id: "minimax-china",
    name: "MiniMax (China)",
    type: "openai" as const,
    baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-Text-01",
    authMethod: "bearer" as const,
    docsUrl: "https://platform.minimaxi.com/document/ChatCompletion",
    requiresOAuth: false,
    category: "OpenAI-compatible" as const,
    description: "MiniMax Text-01 / abab models (China endpoint mirror). OpenAI-compatible chat completions.",
    nativeToolsReliable: false,
  },
  // ── Local ────────────────────────────────────────────────────────────
  {
    id: "lm-studio",
    name: "LM Studio",
    type: "openai" as const,
    baseUrl: "http://localhost:1234/v1",
    defaultModel: null,
    authMethod: "none" as const,
    docsUrl: "https://lmstudio.ai/docs/api/openai-api",
    requiresOAuth: false,
    category: "Local" as const,
    description: "Local LM Studio OpenAI-compatible server. Start LM Studio and enable the local server before installing.",
    nativeToolsReliable: false,
  },
  // ── Native (dedicated type; runtime handler pending — install stores the record, refresh/stream surface a clear error) ──
  {
    id: "gemini",
    name: "Gemini (Google native)",
    type: "gemini" as const,
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-1.5-pro",
    authMethod: "bearer" as const,
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    requiresOAuth: false,
    category: "Native" as const,
    description: "Google Gemini via the native Generative Language API (v1beta REST). Native runtime handler shipped — model discovery, streaming, and non-streaming chat are supported.",
    nativeToolsReliable: false,
  },
  {
    id: "xiaomi-mimo",
    name: "Xiaomi MiMo",
    type: "xiaomi" as const,
    baseUrl: "https://api.xiaomi.com/mimo/v1",
    defaultModel: "mimo-7b",
    authMethod: "bearer" as const,
    docsUrl: "https://www.xiaomi.com/mimo",
    requiresOAuth: false,
    category: "Native" as const,
    description: "Xiaomi MiMo reasoning models via the native endpoint (best-effort). Native handler pending — install stores the provider but chat will fail until the handler ships.",
    nativeToolsReliable: false,
  },
  // ── OAuth (manual references — install disabled, docs link only) ─────
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    type: "openai" as const,
    baseUrl: null,
    defaultModel: null,
    authMethod: "oauth" as const,
    docsUrl: "https://docs.github.com/copilot",
    requiresOAuth: true,
    category: "OAuth (manual)" as const,
    description: "GitHub Copilot requires OAuth — manual configuration required. See docs.",
    nativeToolsReliable: false,
  },
  {
    id: "copilot-acp",
    name: "Copilot ACP",
    type: "openai" as const,
    baseUrl: null,
    defaultModel: null,
    authMethod: "oauth" as const,
    docsUrl: "https://docs.github.com/copilot/acp",
    requiresOAuth: true,
    category: "OAuth (manual)" as const,
    description: "GitHub Copilot Agentic Context Protocol requires OAuth — manual configuration required. See docs.",
    nativeToolsReliable: false,
  },
  {
    id: "qwen-oauth",
    name: "Qwen (OAuth)",
    type: "openai" as const,
    baseUrl: null,
    defaultModel: null,
    authMethod: "oauth" as const,
    docsUrl: "https://help.aliyun.com/zh/dashscope/oauth",
    requiresOAuth: true,
    category: "OAuth (manual)" as const,
    description: "Qwen via Alibaba OAuth — manual configuration required. Use the api-key variant for one-click install.",
    nativeToolsReliable: false,
  },
  {
    id: "xai-grok-oauth",
    name: "xAI Grok (OAuth)",
    type: "openai" as const,
    baseUrl: null,
    defaultModel: null,
    authMethod: "oauth" as const,
    docsUrl: "https://docs.x.ai/oauth",
    requiresOAuth: true,
    category: "OAuth (manual)" as const,
    description: "xAI Grok via OAuth — manual configuration required. Use the api-key variant for one-click install.",
    nativeToolsReliable: false,
  },
] as const;

type ProviderPresetConstant = (typeof PROVIDER_PRESETS)[number];
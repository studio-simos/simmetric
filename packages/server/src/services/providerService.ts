// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { encrypt, decrypt } from "./encryptionService";
import { logger } from "../utils/logger";
import axios from "axios";
import { getEnv } from "../config/env";
import { getOllamaClient } from "./ollamaClient";
import type { AbortableAsyncIterator, ProgressResponse } from "ollama";
import type { ProviderConfig } from "@simmetric-chat/shared";
import {
  EMBEDDING_PATTERNS,
  CAPABILITY_OVERRIDES,
  NATIVE_TOOLS_OVERRIDES,
  findPresetNativeToolsReliable,
} from "./providerCapabilities";
/**
 * Resolve the effective Ollama base URL at runtime.
 *
 * When the stored baseUrl is a placeholder (localhost, 127.0.0.1, or the Docker
 * service name "ollama:11434"), replace it with the OLLAMA_BASE_URL environment
 * variable so the correct Ollama instance is used in each runtime environment
 * (host vs Docker container network).
 */
export function resolveOllamaUrl(baseUrl: string): string {
  const envUrl = process.env.OLLAMA_BASE_URL;
  if (!envUrl) return baseUrl;
  if (
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("ollama:11434")
  ) {
    return envUrl;
  }
  return baseUrl;
}

function resolveOllamaEndpoint(baseUrl: string, _isLocal: boolean): string {
  // Both local AND cloud (":cloud") Ollama models are served through the local
  // Ollama daemon, which transparently proxies cloud models to ollama.com using
  // its own cloud login (no per-request API key needed). Routing cloud models
  // directly to https://ollama.com returned 404/401 because that host does not
  // expose /api/chat as a public endpoint. The local daemon is the single
  // gateway — verified: `POST <daemon>/api/chat {"model":"X:cloud"}` → 200.
  // (Previously this special-cased cloud models to "https://ollama.com", which
  //  was introduced by commit 98b612c0b and broke cloud chat — see memory.)
  return resolveOllamaUrl(baseUrl);
}

/**
 * @public — stable model-classification predicate (Phase 180 reviewed-keep:
 * tested directly in providerService.test.ts and referenced by the
 * providerCapabilities capability-derivation contract).
 */
export function isEmbeddingModel(name: string): boolean {
  return EMBEDDING_PATTERNS.some((pattern) => pattern.test(name));
}

export function deriveCapabilities(
  modelName: string,
  providerType: string,
  isCloud = false,
  presetNativeToolsReliable?: boolean,
): string[] {
  const caps: string[] = [];
  if (providerType === "ollama") {
    caps.push(isCloud ? "cloud" : "local-only");
  }
  for (const [pattern, tags] of Object.entries(CAPABILITY_OVERRIDES)) {
    if (modelName.toLowerCase().includes(pattern.toLowerCase())) {
      caps.push(...tags);
    }
  }
  // Phase 95 (D-02) — per-model native-tools reliability tag. Registry
  // override (first-match-wins) beats the preset flag; preset flag beats the
  // default `false`. When the value is `true`, emit `nativeTools`; when
  // `false`, emit nothing (an explicit-unreliable override = "no tag", same
  // shape as absent — D-02). `[...new Set(caps)]` below dedups repeats.
  const lowerName = modelName.toLowerCase();
  let nativeTools = false;
  let registryHit = false;
  for (const [pattern, value] of Object.entries(NATIVE_TOOLS_OVERRIDES)) {
    if (lowerName.includes(pattern.toLowerCase())) {
      nativeTools = value;
      registryHit = true;
      break; // first-match-wins
    }
  }
  if (!registryHit) {
    nativeTools = presetNativeToolsReliable === true;
  }
  if (nativeTools) {
    caps.push("nativeTools");
  }
  return [...new Set(caps)];
}

// ===== CRUD =====

export async function listProviders() {
  return prisma.provider.findMany({
    include: { models: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function listAvailableProviders() {
  const providers = await prisma.provider.findMany({
    where: { isEnabled: true },
    include: { models: { where: { isEnabled: true, isAvailable: true }, orderBy: { name: "asc" } } },
    orderBy: { name: "asc" },
  });
  return providers.map((p) => {
    const isOllamaCloud = p.type === "ollama" && !!p.apiKey;
    const presetNativeTools = findPresetNativeToolsReliable(p.type, p.baseUrl);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      isDefault: p.isDefault,
      models: p.models.map((m) => ({
        id: m.id,
        name: m.name,
        displayName: m.displayName,
        isLocal: m.isLocal,
        isDefault: m.isDefault,
        capabilities: deriveCapabilities(m.name, p.type, isOllamaCloud && !m.isLocal, presetNativeTools),
      })),
    };
  });
}

export async function getProvider(id: string) {
  return prisma.provider.findUnique({
    where: { id },
    include: { models: true },
  });
}

export async function createProvider(data: {
  name: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
}) {
  const encryptedKey = data.apiKey ? encrypt(data.apiKey) : null;
  const provider = await prisma.provider.create({
    data: {
      name: data.name,
      type: data.type,
      baseUrl: data.baseUrl,
      apiKey: encryptedKey,
    },
  });

  // Auto-discover models
  try {
    await refreshModels(provider.id);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[provider] Model discovery failed for ${provider.id}: ${message}`);
    await prisma.provider.update({
      where: { id: provider.id },
      data: { lastError: message },
    });
  }

  return getProvider(provider.id);
}

export async function updateProvider(id: string, data: {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  isEnabled?: boolean;
}) {
  const updateData: Record<string, any> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.baseUrl !== undefined) updateData.baseUrl = data.baseUrl;
  if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
  if (data.apiKey !== undefined) {
    updateData.apiKey = data.apiKey ? encrypt(data.apiKey) : null;
  }

  return prisma.provider.update({
    where: { id },
    data: updateData,
    include: { models: true },
  });
}

// ===== Ollama Local Cleanup =====

async function deleteOllamaModelLocally(baseUrl: string, modelName: string) {
  const resolvedBaseUrl = resolveOllamaUrl(baseUrl);
  try {
    await getOllamaClient(resolvedBaseUrl, { timeoutMs: 30000 }).delete({ model: modelName });
    logger.info(`[provider] Deleted Ollama model: ${modelName} from ${resolvedBaseUrl}`);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[provider] Failed to delete Ollama model ${modelName} at ${resolvedBaseUrl}: ${message}`);
    // Non-blocking: if Ollama is unreachable or model not found, we still delete from DB
  }
}

async function deleteAllOllamaModelsLocally(baseUrl: string) {
  const resolvedBaseUrl = resolveOllamaUrl(baseUrl);
  try {
    const response = await getOllamaClient(resolvedBaseUrl, { timeoutMs: 15000 }).list();
    const models: Array<{ name: string }> = response.models || [];
    for (const model of models) {
      await getOllamaClient(resolvedBaseUrl, { timeoutMs: 30000 }).delete({ model: model.name });
      logger.info(`[provider] Deleted Ollama model: ${model.name} from ${resolvedBaseUrl}`);
    }
    logger.info(`[provider] Dropped all Ollama models from ${resolvedBaseUrl} (count: ${models.length})`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[provider] Failed to drop all Ollama models at ${resolvedBaseUrl}: ${message}`);
    // Non-blocking: if Ollama is unreachable, we still delete the provider from DB
  }
}

// ===== CRUD =====

export async function deleteProvider(id: string) {
  const provider = await prisma.provider.findUnique({
    where: { id },
    include: { models: true },
  });
  if (!provider) throw new Error("Provider not found");

  // Clean up all Ollama models from the Docker instance
  if (provider.type === "ollama") {
    await deleteAllOllamaModelsLocally(provider.baseUrl);
  }

  return prisma.provider.delete({ where: { id } });
}

export async function deleteModel(modelId: string) {
  const model = await prisma.providerModel.findUnique({
    where: { id: modelId },
    include: { provider: true },
  });
  if (!model) throw new Error("Model not found");

  // Clean up locally downloaded Ollama model
  if (model.provider.type === "ollama") {
    await deleteOllamaModelLocally(model.provider.baseUrl, model.name);
  }

  return prisma.providerModel.delete({ where: { id: modelId } });
}

// ===== Model Discovery =====

interface DiscoveredModel {
  name: string;
  isLocal: boolean;
}

async function discoverOllamaModels(baseUrl: string, apiKey?: string | null): Promise<DiscoveredModel[]> {
  const response = await getOllamaClient(baseUrl, { timeoutMs: 15000, apiKey: apiKey ?? undefined }).list();
  const models: Array<{ name: string }> = response.models || [];
  return models.map((m) => ({ name: m.name, isLocal: !m.name.endsWith(":cloud") }));
}

async function discoverOpenAIModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  // Strip a trailing /v1 (or /v1/) from baseUrl so the final URL is always
  // `<root>/v1/models`, never `<root>/v1/v1/models`. This accepts both
  // `https://api.openai.com` and `https://api.openai.com/v1` and the
  // OpenRouter default `https://openrouter.ai/api/v1` without 404.
  const normalizedBase = baseUrl.replace(/\/v1\/?$/, "");
  const response = await axios.get(`${normalizedBase}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: 15000,
  });
  const models: Array<{ id: string }> = response.data.data || [];
  return models.map((m) => ({ name: m.id, isLocal: false }));
}

async function discoverAnthropicModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const response = await axios.get(`${baseUrl}/v1/models`, {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    timeout: 15000,
  });
  const models: Array<{ id: string }> = response.data.data || [];
  return models.map((m) => ({ name: m.id, isLocal: false }));
}

// Gemini (Google Generative Language API) — native REST handler.
// GET /v1beta/models returns objects shaped as
//   { name: "models/gemini-1.5-pro", supportedGenerationMethods: ["generateContent", ...] }
// We keep only models that support `generateContent` and strip the `models/`
// prefix so the stored ProviderModel.name is the bare model id.
async function discoverGeminiModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const response = await axios.get(`${baseUrl}/v1beta/models`, {
    headers: { "x-goog-api-key": apiKey },
    timeout: 15000,
  });
  const models: Array<{ name: string; supportedGenerationMethods?: string[] }> =
    response.data.models || [];
  return models
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods!.includes("generateContent"))
    .map((m) => ({
      name: m.name.replace(/^models\//, ""),
      isLocal: false,
    }));
}

export async function refreshModels(providerId: string): Promise<number> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { models: true },
  });
  if (!provider) throw new Error("Provider not found");

  const apiKey = provider.apiKey ? decrypt(provider.apiKey) : null;
  let discovered: DiscoveredModel[];

  try {
    switch (provider.type) {
      case "ollama":
        discovered = await discoverOllamaModels(
          resolveOllamaUrl(provider.baseUrl),
          apiKey,
        );
        break;
      case "openrouter":
      case "openai":
        if (!apiKey)
          throw new Error(
            `API key required for ${provider.type === "openrouter" ? "OpenRouter" : "OpenAI"} model discovery`,
          );
        discovered = await discoverOpenAIModels(provider.baseUrl, apiKey);
        break;
      case "anthropic":
        if (!apiKey)
          throw new Error("API key required for Anthropic model discovery");
        discovered = await discoverAnthropicModels(provider.baseUrl, apiKey);
        break;
      case "gemini":
        if (!apiKey)
          throw new Error("API key required for Gemini model discovery");
        discovered = await discoverGeminiModels(provider.baseUrl, apiKey);
        break;
      case "xiaomi":
      case "minimax":
        throw new Error(
          `Native handler for ${provider.type} not yet implemented — install the OpenAI-compatible variant or wait for the handler follow-up task`,
        );
      default:
        throw new Error(`Unknown provider type: ${provider.type}`);
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    await prisma.provider.update({
      where: { id: providerId },
      data: { lastError: message, lastSyncAt: new Date() },
    });
    throw err;
  }

  const discoveredNames = new Set(discovered.map((d) => d.name));

  // Upsert discovered models — idempotent to prevent race-condition duplicates
  for (const model of discovered) {
    const isEmbedding = isEmbeddingModel(model.name);
    await prisma.providerModel.upsert({
      where: {
        providerId_name: {
          providerId,
          name: model.name,
        },
      },
      update: {
        isLocal: model.isLocal,
        isAvailable: true,
        isEmbedding,
      },
      create: {
        providerId,
        name: model.name,
        isLocal: model.isLocal,
        isAvailable: true,
        isEmbedding,
      },
    });
  }

  // Mark absent models as unavailable
  for (const existing of provider.models) {
    if (!discoveredNames.has(existing.name) && existing.isAvailable) {
      await prisma.providerModel.update({
        where: { id: existing.id },
        data: { isAvailable: false },
      });
    }
  }

  // Clear error on success
  await prisma.provider.update({
    where: { id: providerId },
    data: { lastError: null, lastSyncAt: new Date() },
  });

  return discovered.length;
}

// ===== Missing exports needed by routes/providers.ts =====

export async function setDefaultProvider(id: string) {
  return prisma.$transaction([
    prisma.provider.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    prisma.provider.update({ where: { id }, data: { isDefault: true } }),
  ]);
}

export async function setDefaultModel(modelId: string) {
  return prisma.$transaction([
    prisma.providerModel.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    prisma.providerModel.update({ where: { id: modelId }, data: { isDefault: true } }),
  ]);
}

export async function listModels(providerId: string) {
  return prisma.providerModel.findMany({
    where: { providerId },
    orderBy: { name: "asc" },
  });
}

export async function updateModel(modelId: string, data: {
  displayName?: string | null;
  isEnabled?: boolean;
  isEmbedding?: boolean;
  isOcr?: boolean;
  temperature?: number | null;
  maxTokens?: number | null;
}) {
  const updateData: Record<string, any> = {};
  if (data.displayName !== undefined) updateData.displayName = data.displayName;
  if (data.isEnabled !== undefined) updateData.isEnabled = data.isEnabled;
  if (data.isEmbedding !== undefined) updateData.isEmbedding = data.isEmbedding;
  if (data.isOcr !== undefined) updateData.isOcr = data.isOcr;
  if (data.temperature !== undefined) updateData.temperature = data.temperature;
  if (data.maxTokens !== undefined) updateData.maxTokens = data.maxTokens;

  return prisma.providerModel.update({
    where: { id: modelId },
    data: updateData,
  });
}

// ===== Model Lookup =====

export async function getModelById(modelId: string) {
  return prisma.providerModel.findUnique({ where: { id: modelId } });
}

// ===== Ollama Model Availability Validation =====

/**
 * Validates that an Ollama model actually exists on the Ollama server.
 * Used as a pre-flight check before allowing isEmbedding to be toggled on.
 *
 * - Non-Ollama providers: returns immediately (no-op)
 * - Ollama providers: lists models via ollama-js, checks model name in response
 * - Model not found: throws with actionable error including docker exec pull command
 * - Network error/timeout: throws with "Cannot verify model availability" message
 */
export async function validateOllamaModelAvailability(providerId: string, modelName: string): Promise<void> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider || provider.type !== "ollama") {
    return; // Non-Ollama provider — no validation needed
  }

  const resolvedBaseUrl = resolveOllamaUrl(provider.baseUrl);

  try {
    const response = await getOllamaClient(resolvedBaseUrl, { timeoutMs: 5000 }).list();
    const models: Array<{ name: string }> = response.models || [];
    const found = models.some((m) => m.name === modelName);

    if (!found) {
      throw new Error(
        `Ollama embedding model '${modelName}' not found on the Ollama server. ` +
        `Pull it first: docker exec simmetric-chat-ollama ollama pull ${modelName}`,
      );
    }
  } catch (err: unknown) {
    // If it's already our "not found" error, re-throw it
    if (err instanceof Error && err.message.includes("not found on the Ollama server")) {
      throw err;
    }
    // Network errors, timeouts, etc. The factory's AbortSignal.timeout surfaces
    // a DOMException named "TimeoutError" (RESEARCH Pattern 3).
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("Cannot verify model availability on Ollama: request timed out after 5 seconds", { cause: err });
    }
    throw new Error(`Cannot verify model availability on Ollama: ${message}`, { cause: err });
  }
}

// ===== Model Pulling =====

interface OllamaPullStream {
  provider: { id: string; baseUrl: string };
  modelName: string;
  // 92-02: ollama-js pull iterator (was NodeJS.ReadableStream NDJSON). The
  // single sanctioned type change — consumed only by routes/providers.ts.
  stream: AbortableAsyncIterator<ProgressResponse>;
}

export async function startOllamaPull(providerId: string, modelName: string): Promise<OllamaPullStream> {
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) throw new Error("Provider not found");
  if (provider.type !== "ollama") throw new Error("Model pulling is only supported for Ollama providers");

  const resolvedBaseUrl = resolveOllamaUrl(provider.baseUrl);
  logger.info(`[provider] Pulling Ollama model: ${modelName} from ${resolvedBaseUrl}`);

  const apiKey = provider.apiKey ? decrypt(provider.apiKey) : null;

  try {
    // timeoutMs: 0 — pulls are unbounded (same as the old axios timeout: 0).
    const stream = await getOllamaClient(resolvedBaseUrl, {
      timeoutMs: 0,
      apiKey: apiKey ?? undefined,
    }).pull({ model: modelName, stream: true });

    return {
      provider: { id: provider.id, baseUrl: provider.baseUrl },
      modelName,
      stream,
    };
  } catch (err: unknown) {
    // ollama-js ResponseError is thrown but NOT exported by the module —
    // duck-type it via err.status_code (RESEARCH Pattern 3). Connection
    // failures surface as TypeError("fetch failed") with the errno on
    // err.cause.code (undici).
    const errAny = err as { message?: string; code?: string; cause?: { code?: string }; status_code?: number };
    const message = errAny.message || String(err);
    const code = errAny.cause?.code || errAny.code || "";
    let userMessage = `Ollama is unreachable at ${resolvedBaseUrl}: ${message} (${code})`;

    if (typeof errAny.status_code === "number") {
      const status = errAny.status_code;
      if (status === 404) {
        userMessage = `Model "${modelName}" not found. Please check the spelling and try again.`;
      } else {
        userMessage = `Ollama returned HTTP ${status}: ${message}`;
      }
    }

    logger.error(`[provider] Ollama pull failed at ${resolvedBaseUrl}`, { code, message, status: errAny.status_code });
    throw new Error(userMessage, { cause: err });
  }
}

// ===== Resolution =====

export async function resolveProviderConfig(
  providerId?: string,
  model?: string,
): Promise<ProviderConfig | null> {
  // 1. Try explicit provider
  if (providerId) {
    const provider = await prisma.provider.findUnique({
      where: { id: providerId },
      include: { models: true },
    });
    if (provider && provider.isEnabled) {
      const apiKey = provider.apiKey ? decrypt(provider.apiKey) : null;
      const resolvedModel = model
        ? provider.models.find((m) => m.name === model)
        : provider.models.find((m) => m.isEnabled && m.isAvailable);
      if (resolvedModel) {
        const isOllamaCloud = provider.type === "ollama" && !!apiKey;
        const presetNativeTools = findPresetNativeToolsReliable(provider.type, provider.baseUrl);
        const nativeToolsReliable = deriveCapabilities(
          resolvedModel.name,
          provider.type,
          isOllamaCloud,
          presetNativeTools,
        ).includes("nativeTools");
        return {
          type: provider.type as ProviderConfig["type"],
          baseUrl: provider.type === "ollama" ? resolveOllamaEndpoint(provider.baseUrl, resolvedModel.isLocal) : provider.baseUrl,
          apiKey,
          model: resolvedModel.name,
          displayName: resolvedModel.displayName || null,
          temperature: resolvedModel.temperature ?? 0.7,
          maxTokens: resolvedModel.maxTokens ?? undefined,
          isLocal: resolvedModel.isLocal ?? true,
          nativeToolsReliable,
        };
      }
    }
  }

  // 2. Try default provider
  const defaultProvider = await prisma.provider.findFirst({
    where: { isDefault: true, isEnabled: true },
    include: { models: { where: { isEnabled: true, isAvailable: true } } },
  });
  if (defaultProvider) {
    const apiKey = defaultProvider.apiKey ? decrypt(defaultProvider.apiKey) : null;
    const resolvedModel = model
      ? defaultProvider.models.find((m) => m.name === model)
      : defaultProvider.models[0];
    if (resolvedModel) {
      const isOllamaCloud = defaultProvider.type === "ollama" && !!apiKey;
      const presetNativeTools = findPresetNativeToolsReliable(defaultProvider.type, defaultProvider.baseUrl);
      const nativeToolsReliable = deriveCapabilities(
        resolvedModel.name,
        defaultProvider.type,
        isOllamaCloud,
        presetNativeTools,
      ).includes("nativeTools");
      return {
        type: defaultProvider.type as ProviderConfig["type"],
        baseUrl: defaultProvider.type === "ollama" ? resolveOllamaEndpoint(defaultProvider.baseUrl, resolvedModel.isLocal) : defaultProvider.baseUrl,
        apiKey,
        model: resolvedModel.name,
        displayName: resolvedModel.displayName || null,
        temperature: resolvedModel.temperature ?? 0.7,
        maxTokens: resolvedModel.maxTokens ?? undefined,
        isLocal: resolvedModel.isLocal ?? true,
        nativeToolsReliable,
      };
    }
  }

  // 3. Try any enabled provider
  const anyProvider = await prisma.provider.findFirst({
    where: { isEnabled: true },
    include: { models: { where: { isEnabled: true, isAvailable: true } } },
  });
  if (anyProvider) {
    const apiKey = anyProvider.apiKey ? decrypt(anyProvider.apiKey) : null;
    const resolvedModel = model
      ? anyProvider.models.find((m) => m.name === model)
      : anyProvider.models[0];
    if (resolvedModel) {
      const isOllamaCloud = anyProvider.type === "ollama" && !!apiKey;
      const presetNativeTools = findPresetNativeToolsReliable(anyProvider.type, anyProvider.baseUrl);
      const nativeToolsReliable = deriveCapabilities(
        resolvedModel.name,
        anyProvider.type,
        isOllamaCloud,
        presetNativeTools,
      ).includes("nativeTools");
      return {
        type: anyProvider.type as ProviderConfig["type"],
        baseUrl: anyProvider.type === "ollama" ? resolveOllamaEndpoint(anyProvider.baseUrl, resolvedModel.isLocal) : anyProvider.baseUrl,
        apiKey,
        model: resolvedModel.name,
        displayName: resolvedModel.displayName || null,
        temperature: resolvedModel.temperature ?? 0.7,
        maxTokens: resolvedModel.maxTokens ?? undefined,
        isLocal: resolvedModel.isLocal ?? true,
        nativeToolsReliable,
      };
    }
  }

  // 4. No providers in DB — return null (caller falls back to env vars)
  return null;
}

// ============================================================================
// callNonStreamingLLM — multi-provider non-streaming LLM call utility
// ============================================================================

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface NonStreamingResult {
  content: string;
  tokensUsed: number;
}

export async function callNonStreamingLLM(
  providerConfig: ProviderConfig,
  messages: LLMMessage[],
  timeoutMs?: number,
): Promise<NonStreamingResult> {
  const timeout = timeoutMs ?? getEnv().LLM_TIMEOUT;

  switch (providerConfig.type) {
    // ── Ollama ──────────────────────────────────────────────────
    case "ollama": {
      const baseUrl = resolveOllamaUrl(providerConfig.baseUrl);
      // 92-02: ollama-js via the shared factory (D-02). NO apiKey is passed —
      // the pre-migration code sent no Authorization header on this path
      // (parity, plan prohibition).
      const client = getOllamaClient(baseUrl, { timeoutMs: timeout });
      const response = await client.chat({
        model: providerConfig.model,
        messages,
        stream: false,
        keep_alive: getEnv().OLLAMA_KEEP_ALIVE,
      });
      const content: string = response.message?.content || "";
      const tokensUsed: number =
        (response.prompt_eval_count || 0) +
        (response.eval_count || 0);
      return { content, tokensUsed };
    }

    // ── OpenAI / OpenRouter ─────────────────────────────────────
    case "openai":
    case "openrouter": {
      // Normalize: strip trailing /v1 so we always build `<root>/v1/chat/completions`,
      // not `<root>/v1/v1/chat/completions`.
      const rawBase = providerConfig.type === "openrouter"
        ? providerConfig.baseUrl || "https://openrouter.ai/api"
        : providerConfig.baseUrl;
      const baseUrl = rawBase.replace(/\/v1\/?$/, "");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${providerConfig.apiKey}`,
      };
      const response = await axios.post(
        `${baseUrl}/v1/chat/completions`,
        {
          model: providerConfig.model,
          messages,
          max_tokens: providerConfig.maxTokens,
        },
        { headers, timeout },
      );
      const content: string =
        response.data.choices?.[0]?.message?.content || "";
      const tokensUsed: number = response.data.usage?.total_tokens || 0;
      return { content, tokensUsed };
    }

    // ── Anthropic ───────────────────────────────────────────────
    case "anthropic": {
      const systemMessage = messages.find((m) => m.role === "system")?.content;
      const nonSystemMessages = messages.filter((m) => m.role !== "system");
      const response = await axios.post(
        `${providerConfig.baseUrl}/v1/messages`,
        {
          model: providerConfig.model,
          messages: nonSystemMessages,
          max_tokens: providerConfig.maxTokens || 4096,
          ...(systemMessage && { system: systemMessage }),
        },
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": providerConfig.apiKey,
            "anthropic-version": "2023-06-01",
          },
          timeout,
        },
      );
      const content: string = response.data.content?.[0]?.text || "";
      const tokensUsed: number =
        (response.data.usage?.input_tokens || 0) +
        (response.data.usage?.output_tokens || 0);
      return { content, tokensUsed };
    }

    // ── Gemini (Google native Generative Language API) ───────────────────────
    case "gemini": {
      const body = buildGeminiRequestBody(messages, providerConfig);
      const response = await axios.post(
        `${providerConfig.baseUrl}/v1beta/models/${providerConfig.model}:generateContent`,
        body,
        {
          headers: {
            "x-goog-api-key": providerConfig.apiKey,
            "Content-Type": "application/json",
          },
          timeout,
        },
      );
      const content: string = extractGeminiText(response.data);
      const usage = response.data?.usageMetadata || {};
      const tokensUsed: number =
        (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
      return { content, tokensUsed };
    }

    // ── Native types (handler pending — fail fast, no silent OpenAI fallthrough) ──
    case "xiaomi":
    case "minimax":
      throw new Error(
        `Native handler for ${providerConfig.type} not yet implemented — install the OpenAI-compatible variant or wait for the handler follow-up task`,
      );

    default:
      throw new Error(`Unsupported provider type: ${(providerConfig as unknown as Record<string, unknown>).type}`);
  }
}

// ============================================================================
// Native-type guard for the non-streaming path. The gemini/xiaomi/minimax
// runtime handlers are deferred to a follow-up quick task; until they ship,
// calls of these types fail with a clear, actionable error instead of
// silently falling through to the OpenAI handler.
// ============================================================================

/**
 * Build the Gemini REST request body from the unified `LLMMessage[]` array.
 * Gemini diverges from OpenAI/Anthropic: the system prompt lives in a separate
 * `systemInstruction` field (not as the first message), and the assistant role
 * is named `"model"`. Multi-part text parts are merged at extraction time.
 */
export function buildGeminiRequestBody(
  messages: LLMMessage[],
  providerConfig: ProviderConfig,
): Record<string, unknown> {
  const systemMessage = messages.find((m) => m.role === "system")?.content;
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body: Record<string, unknown> = { contents };
  if (systemMessage) {
    body.systemInstruction = { parts: [{ text: systemMessage }] };
  }
  const generationConfig: Record<string, unknown> = {};
  if (providerConfig.maxTokens) {
    generationConfig.maxOutputTokens = providerConfig.maxTokens;
  }
  if (typeof providerConfig.temperature === "number") {
    generationConfig.temperature = providerConfig.temperature;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  return body;
}

/**
 * Extract the concatenated text from a Gemini `generateContent` /
 * `streamGenerateContent` response object. Gemini may split the answer across
 * multiple `parts` within `candidates[0].content`.
 */
export function extractGeminiText(data: unknown): string {
  const candidate = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    ?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("");
}

/**
 * Returns true when `type` is a declared native type whose runtime handler
 * is not yet implemented. Gemini's native handlers shipped (quick 260723-uzf);
 * xiaomi and minimax remain pending.
 */
export function isNativeHandlerPending(type: string): boolean {
  return type === "xiaomi" || type === "minimax";
}

// NOTE (Phase 180 dead-code sweep): the NATIVE_HANDLER_PENDING_MESSAGE
// template string was REMOVED — its only consumer (routes/providerPresets.ts)
// renders its own inline message and never imported the constant.
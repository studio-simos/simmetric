// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { z } from "zod";

export const providerTypeSchema = z.enum([
  "ollama",
  "openai",
  "anthropic",
  "openrouter",
  // Native types — declared so Provider records of these types can be stored.
  // Runtime handlers (discover/stream/non-stream) are being added incrementally;
  // until they ship, refreshModels / streamLLM / callNonStreamingLLM throw an
  // explicit "Native handler not yet implemented" error rather than silently
  // falling through to the OpenAI handler.
  "gemini",
  "xiaomi",
  "minimax",
]);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const createProviderSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  type: providerTypeSchema,
  baseUrl: z.string().url("Invalid URL").min(1, "Base URL is required"),
  apiKey: z.string().optional(),
});
type CreateProviderInput = z.infer<typeof createProviderSchema>;

export const updateProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  isEnabled: z.boolean().optional(),
});
type UpdateProviderInput = z.infer<typeof updateProviderSchema>;

export const updateProviderModelSchema = z.object({
  displayName: z.string().max(100).nullable().optional(),
  isEnabled: z.boolean().optional(),
  isEmbedding: z.boolean().optional(),
  isOcr: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional(),
});
type UpdateProviderModelInput = z.infer<typeof updateProviderModelSchema>;

const chatModelOverrideSchema = z.object({
  providerId: z.string().uuid().optional(),
  model: z.string().optional(),
});
type ChatModelOverride = z.infer<typeof chatModelOverrideSchema>;


// Phase 203 (MCC-01/02, D1/D3): per-model pricing + cost contracts.
// inputCostPerToken/outputCostPerToken are PER-TOKEN Decimal values in the
// DB; the UI inputs per-1M-token and converts client-side (perToken =
// perMillion / 1_000_000). Nonnegative + finite (Edge E2 — no NaN/Infinity
// in money columns). currency: ISO 4217 subset per spec §2.7.
export const updateModelPricingSchema = z.object({
  inputCostPerToken: z.number().nonnegative().finite().optional(),
  outputCostPerToken: z.number().nonnegative().finite().optional(),
  currency: z.enum(["USD", "EUR", "GBP", "JPY", "CNY", "INR"]).optional(),
});
/** @latentByDesign — paired inferred type of updateModelPricingSchema (the
 * server consumes the SCHEMA inline; the type is the deferred-UI contract,
 * see costSchema). */
export type UpdateModelPricingInput = z.infer<typeof updateModelPricingSchema>;

/** @latentByDesign — Phase 203 reset contract; the server reset route
 * validates inline today, the deferred UI (ModelPricingDialog reset button)
 * is the named consumer. */
export const resetModelPricingSchema = z.object({}).strict();

/** @latentByDesign — Phase 203 shipped the shared cost contract ahead of the
 * UI wiring: the server (providers.ts PUT/GET/RESET + routes/chatCost.ts)
 * validates and builds these shapes inline today; the deferred 203-04/03 UI
 * (Costi tab + chat badge + pricing dialog) is the named consumer
 * (TODO/MODEL_COST_CONTROL_SPEC.md §2.7). */
export const costSchema = z.object({
  promptCost: z.number().nullable(),
  completionCost: z.number().nullable(),
  totalCost: z.number().nullable(),
  currency: z.string().nullable(),
});
/** @latentByDesign — paired inferred type of costSchema. */
export type CostBreakdown = z.infer<typeof costSchema>;

/** @latentByDesign — see costSchema (Phase 203 deferred UI consumer). */
export const chatCostResponseSchema = z.object({
  costs: z.array(costSchema.partial({ currency: true }).extend({ currency: z.string().nullable() })),
  totalByCurrency: z.record(z.string(), z.number()),
  breakdown: z.array(z.object({
    messageId: z.string(),
    promptCost: z.number().nullable(),
    completionCost: z.number().nullable(),
    totalCost: z.number().nullable(),
    currency: z.string().nullable(),
  })),
});
/** @latentByDesign — paired inferred type of chatCostResponseSchema. */
export type ChatCostResponse = z.infer<typeof chatCostResponseSchema>;

/** @latentByDesign — see costSchema (Phase 203 deferred UI consumer). */
export const todayCostResponseSchema = z.object({
  totalByCurrency: z.record(z.string(), z.number()),
});
/** @latentByDesign — paired inferred type of todayCostResponseSchema. */
export type TodayCostResponse = z.infer<typeof todayCostResponseSchema>;

// Provider preset catalog — param + install body validation.
export const providerPresetIdParamSchema = z.object({
  presetId: z.string().uuid("Invalid preset ID"),
});
type ProviderPresetIdParam = z.infer<typeof providerPresetIdParamSchema>;

export const installProviderPresetSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  apiKey: z.string().optional(),
});
type InstallProviderPresetInput = z.infer<typeof installProviderPresetSchema>;
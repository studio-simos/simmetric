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
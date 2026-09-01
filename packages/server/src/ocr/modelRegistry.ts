// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { logger } from "../utils/logger";

export interface OcrModelConfig {
  name: string;
  namePattern: string;
  /** Ollama API endpoint to use: /api/generate (default) or /api/chat */
  apiEndpoint: "generate" | "chat";
  inputMode: "single_image" | "multi_image" | "base64_array";
  supportedModes: Array<"text" | "table" | "figure" | "generic">;
  promptTemplate: "deepseek-ocr" | "glm-ocr" | "generic";
  contextWindow: number;
  specialTokens?: string[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function patternToRegex(pattern: string): RegExp {
  const regexStr = "^" + escapeRegex(pattern).replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(regexStr);
}

export const OCR_MODEL_REGISTRY: readonly OcrModelConfig[] = [
  // glm-ocr: the Ollama-packaged glm-ocr model has no stop tokens and a bare
  // `{{ .Prompt }}` template, so it never emits done=true via /api/generate.
  // It loops infinitely (~4000+ tokens in 90s on CPU) until the client aborts,
  // producing the "Did not receive done or success response in stream" error.
  // Route it to the chat endpoint which handles EOS detection differently.
  {
    name: "glm-ocr:latest",
    namePattern: "glm-ocr:latest",
    apiEndpoint: "chat",
    inputMode: "base64_array",
    supportedModes: ["text", "table", "figure", "generic"],
    promptTemplate: "glm-ocr",
    contextWindow: 4096,
  },
  {
    name: "glm-ocr:*",
    namePattern: "glm-ocr:*",
    apiEndpoint: "chat",
    inputMode: "base64_array",
    supportedModes: ["text", "table", "figure", "generic"],
    promptTemplate: "glm-ocr",
    contextWindow: 4096,
  },
  {
    name: "deepseek-ocr*",
    namePattern: "deepseek-ocr*",
    apiEndpoint: "chat",
    inputMode: "single_image",
    supportedModes: ["text", "generic"],
    promptTemplate: "deepseek-ocr",
    contextWindow: 8192,
    specialTokens: ["<|grounding|>"],
  },
  {
    name: "deepseek-ocr:*",
    namePattern: "deepseek-ocr:*",
    apiEndpoint: "chat",
    inputMode: "single_image",
    supportedModes: ["text", "generic"],
    promptTemplate: "deepseek-ocr",
    contextWindow: 8192,
    specialTokens: ["<|grounding|>"],
  },
  {
    name: "generic",
    namePattern: "*",
    apiEndpoint: "generate",
    inputMode: "base64_array",
    supportedModes: ["generic"],
    promptTemplate: "generic",
    contextWindow: 4096,
  },
];

export function resolveModelConfig(modelName: string): OcrModelConfig {
  // 1. Exact match
  for (const config of OCR_MODEL_REGISTRY) {
    if (config.namePattern === modelName) {
      return config;
    }
  }

  // 2. Wildcard match
  for (const config of OCR_MODEL_REGISTRY) {
    if (config.namePattern === "*") continue; // skip fallback here
    const regex = patternToRegex(config.namePattern);
    if (regex.test(modelName)) {
      return config;
    }
  }

  // 3. Generic fallback
  logger.warn("[ocr] Unknown OCR model, using generic fallback config", { modelName });
  return OCR_MODEL_REGISTRY[OCR_MODEL_REGISTRY.length - 1]!;
}

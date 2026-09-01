// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import axios from "axios";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";
import { getOllamaClient } from "./ollamaClient";

/**
 * Predefined topic categories for widget conversation classification (per D-07).
 * The "general" category is the fallback when classification fails or is unavailable.
 */
export const TOPIC_CATEGORIES = ["pricing", "support", "product", "technical", "general"] as const;
type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

const CLASSIFICATION_PROMPT = `Classify the following user query into exactly one of these categories: pricing, support, product, technical, general. Reply with ONLY the category name, nothing else.

User query:`;

const CLASSIFICATION_TIMEOUT_MS = 3000;
const MAX_QUERY_LENGTH = 500;

/**
 * Classify a user query into a topic category using the configured LLM provider.
 * Falls back to "general" on any failure (timeout, error, unexpected response).
 * Non-blocking per D-04 and Pitfall 2 — analytics must not break chat flow.
 */
export async function classifyTopic(query: string): Promise<string> {
  // Truncate query to mitigate prompt injection (per T-05-03)
  const truncatedQuery = query.slice(0, MAX_QUERY_LENGTH);

  try {
    const env = getEnv();
    const provider = env.LLM_PROVIDER;

    let responseText: string;

    if (provider === "ollama") {
      responseText = await classifyWithOllama(truncatedQuery, env);
    } else if (provider === "openai" || provider === "openrouter") {
      responseText = await classifyWithOpenAI(truncatedQuery, env);
    } else if (provider === "anthropic") {
      responseText = await classifyWithAnthropic(truncatedQuery, env);
    } else {
      logger.warn("[topicClassification] Unknown LLM provider, falling back to general", { provider });
      return "general";
    }

    // Validate response against TOPIC_CATEGORIES (per T-05-03)
    const normalized = responseText.trim().toLowerCase();
    if ((TOPIC_CATEGORIES as readonly string[]).includes(normalized)) {
      return normalized;
    }

    logger.warn("[topicClassification] LLM returned unexpected category, falling back to general", {
      raw: responseText.trim(),
    });
    return "general";
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    const errorMessage = err instanceof Error ? message : "Unknown error";
    logger.warn("[topicClassification] Classification failed, falling back to general", { error: errorMessage });
    return "general";
  }
}

async function classifyWithOllama(query: string, env: ReturnType<typeof getEnv>): Promise<string> {
  const baseUrl = env.OLLAMA_BASE_URL || "http://ollama:11434";
  const model = env.OLLAMA_MODEL || env.LLM_MODEL;

  const response = await getOllamaClient(baseUrl, { timeoutMs: CLASSIFICATION_TIMEOUT_MS }).generate({
    model,
    prompt: `${CLASSIFICATION_PROMPT}\n${query}`,
    stream: false,
    keep_alive: env.OLLAMA_KEEP_ALIVE,
    options: { temperature: 0 },
  });

  return response.response || "general";
}

async function classifyWithOpenAI(query: string, env: ReturnType<typeof getEnv>): Promise<string> {
  const apiKey = env.OPENAI_API_KEY || env.LLM_API_KEY;
  const model = env.OPENAI_MODEL || env.LLM_MODEL;
  const baseUrl = env.LLM_API_BASE_URL || "https://api.openai.com";

  const response = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [
        { role: "system", content: "You are a topic classifier. Reply with exactly one category name." },
        { role: "user", content: `${CLASSIFICATION_PROMPT}\n${query}` },
      ],
      temperature: 0,
      max_tokens: 10,
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: CLASSIFICATION_TIMEOUT_MS,
    },
  );

  return response.data?.choices?.[0]?.message?.content || "general";
}

async function classifyWithAnthropic(query: string, env: ReturnType<typeof getEnv>): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY || env.LLM_API_KEY;
  const model = env.ANTHROPIC_MODEL || env.LLM_MODEL;

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model,
      max_tokens: 10,
      messages: [
        { role: "user", content: `${CLASSIFICATION_PROMPT}\n${query}` },
      ],
    },
    {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      timeout: CLASSIFICATION_TIMEOUT_MS,
    },
  );

  return response.data?.content?.[0]?.text || "general";
}
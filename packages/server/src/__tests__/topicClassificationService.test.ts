// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { classifyTopic, TOPIC_CATEGORIES } from "../services/topicClassificationService";

jest.mock("../config/env", () => ({
  __esModule: true,
  getEnv: jest.fn(),
}));

jest.mock("../services/ollamaClient", () => ({
  __esModule: true,
  getOllamaClient: jest.fn(() => ({
    generate: jest.fn(),
  })),
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getEnv } from "../config/env";
import { getOllamaClient } from "../services/ollamaClient";
import axios from "axios";
import { logger } from "../utils/logger";

const mockGetEnv = getEnv as jest.Mock;
const mockGetOllamaClient = getOllamaClient as jest.Mock;
const mockAxiosPost = (axios as unknown as { post: jest.Mock }).post;
const mockLogger = logger as unknown as { warn: jest.Mock; info: jest.Mock; error: jest.Mock; debug: jest.Mock };

const MAX_QUERY_LENGTH = 500;

function baseEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    LLM_PROVIDER: "ollama",
    LLM_MODEL: "test-model",
    OLLAMA_BASE_URL: "http://ollama:11434",
    OLLAMA_MODEL: undefined,
    OLLAMA_KEEP_ALIVE: "10m",
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
    LLM_API_KEY: undefined,
    LLM_API_BASE_URL: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: undefined,
    ...overrides,
  };
}

describe("TOPIC_CATEGORIES", () => {
  test("contains the 5 categories", () => {
    expect(TOPIC_CATEGORIES).toEqual(["pricing", "support", "product", "technical", "general"]);
  });
});

describe("classifyTopic", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns 'general' on unknown provider", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "banana" }));
    const result = await classifyTopic("hello");
    expect(result).toBe("general");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[topicClassification] Unknown LLM provider, falling back to general",
      expect.any(Object),
    );
    expect(mockGetOllamaClient).not.toHaveBeenCalled();
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  test("truncates query to 500 chars before calling the LLM", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "ollama" }));
    const generate = jest.fn().mockResolvedValue({ response: "general" });
    mockGetOllamaClient.mockReturnValue({ generate });

    const longQuery = "a".repeat(600);
    await classifyTopic(longQuery);

    expect(generate).toHaveBeenCalledTimes(1);
    const promptArg = generate.mock.calls[0]![0].prompt as string;
    const userQueryPart = promptArg.split("\n").pop()!;
    expect(userQueryPart.length).toBe(MAX_QUERY_LENGTH);
  });

  test("ollama path: validates response against TOPIC_CATEGORIES", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "ollama" }));
    const generate = jest.fn().mockResolvedValue({ response: "support" });
    mockGetOllamaClient.mockReturnValue({ generate });

    const result = await classifyTopic("I need help with pricing");
    expect(result).toBe("support");
    expect(mockGetOllamaClient).toHaveBeenCalled();
  });

  test("ollama path: LLM returns invalid category -> 'general', logger.warn", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "ollama" }));
    const generate = jest.fn().mockResolvedValue({ response: "banana" });
    mockGetOllamaClient.mockReturnValue({ generate });

    const result = await classifyTopic("query");
    expect(result).toBe("general");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[topicClassification] LLM returned unexpected category, falling back to general",
      expect.any(Object),
    );
  });

  test("openai path: extracts choices[0].message.content", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "openai", LLM_API_KEY: "sk-test" }));
    mockAxiosPost.mockResolvedValue({
      data: { choices: [{ message: { content: "pricing" } }] },
    });

    const result = await classifyTopic("how much");
    expect(result).toBe("pricing");
    expect(mockAxiosPost).toHaveBeenCalled();
  });

  test("openrouter path: uses axios like openai", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "openrouter", LLM_API_KEY: "sk-or" }));
    mockAxiosPost.mockResolvedValue({
      data: { choices: [{ message: { content: "technical" } }] },
    });
    const result = await classifyTopic("api error");
    expect(result).toBe("technical");
  });

  test("anthropic path: extracts content[0].text", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "an-key" }));
    mockAxiosPost.mockResolvedValue({
      data: { content: [{ text: "product" }] },
    });
    const result = await classifyTopic("tell me about the product");
    expect(result).toBe("product");
  });

  test("falls back to 'general' on error (ollama rejects)", async () => {
    mockGetEnv.mockReturnValue(baseEnv({ LLM_PROVIDER: "ollama" }));
    const generate = jest.fn().mockRejectedValue(new Error("ollama down"));
    mockGetOllamaClient.mockReturnValue({ generate });

    const result = await classifyTopic("query");
    expect(result).toBe("general");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[topicClassification] Classification failed, falling back to general",
      expect.any(Object),
    );
  });
});
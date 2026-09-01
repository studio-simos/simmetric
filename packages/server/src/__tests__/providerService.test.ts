// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ProviderService unit tests
 */
jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});
jest.mock("../services/encryptionService", () => ({
  encrypt: (t: string) => `enc:${t}`,
  decrypt: (t: string) => t.replace("enc:", ""),
}));
jest.mock("../utils/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock axios for the Gemini non-streaming handler test.
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: mockAxiosPost, get: mockAxiosGet },
}));

// Re-import after mocks
import prisma from "../utils/prisma";
const {
  isEmbeddingModel,
  resolveProviderConfig,
  callNonStreamingLLM,
  buildGeminiRequestBody,
  extractGeminiText,
  isNativeHandlerPending,
} = jest.requireActual("../services/providerService");
import type { ProviderConfig } from "@simmetric-chat/shared";

describe("isEmbeddingModel", () => {
  it("detects Xenova/all-MiniLM-L6-v2 as embedding", () => {
    expect(isEmbeddingModel("Xenova/all-MiniLM-L6-v2")).toBe(true);
  });

  it("detects text-embedding-3-small as embedding", () => {
    expect(isEmbeddingModel("text-embedding-3-small")).toBe(true);
  });

  it("detects bge-large-en-v1.5 as embedding", () => {
    expect(isEmbeddingModel("bge-large-en-v1.5")).toBe(true);
  });

  it("does not detect gemma4:latest as embedding", () => {
    expect(isEmbeddingModel("gemma4:latest")).toBe(false);
  });

  it("does not detect gpt-4 as embedding", () => {
    expect(isEmbeddingModel("gpt-4")).toBe(false);
  });

  it("detects nomic-embed-text as embedding", () => {
    expect(isEmbeddingModel("nomic-embed-text")).toBe(true);
  });
});

describe("resolveProviderConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reads temperature and maxTokens from the resolved ProviderModel", async () => {
    const mockProvider = {
      id: "p1",
      type: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "enc:sk-test",
      isEnabled: true,
      models: [
        {
          id: "m1",
          name: "gpt-4",
          isEnabled: true,
          isAvailable: true,
          temperature: 0.5,
          maxTokens: 2048,
        },
      ],
    };
    (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider);

    const config = await resolveProviderConfig("p1", "gpt-4");

    expect(config).not.toBeNull();
    expect(config!.temperature).toBe(0.5);
    expect(config!.maxTokens).toBe(2048);
    expect(config!.model).toBe("gpt-4");
  });

  it("falls back to 0.7 and undefined when model fields are null", async () => {
    const mockProvider = {
      id: "p1",
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: null,
      isEnabled: true,
      models: [
        {
          id: "m1",
          name: "gemma4:latest",
          isEnabled: true,
          isAvailable: true,
          temperature: null,
          maxTokens: null,
        },
      ],
    };
    (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider);

    const config = await resolveProviderConfig("p1", "gemma4:latest");

    expect(config).not.toBeNull();
    expect(config!.temperature).toBe(0.7);
    expect(config!.maxTokens).toBeUndefined();
  });

  it("resolves from default provider when no explicit providerId is given", async () => {
    const mockProvider = {
      id: "p2",
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "enc:key",
      isDefault: true,
      isEnabled: true,
      models: [
        {
          id: "m2",
          name: "claude-sonnet-4-20250514",
          isEnabled: true,
          isAvailable: true,
          temperature: 0.3,
          maxTokens: 4096,
        },
      ],
    };
    (prisma.provider.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider);

    const config = await resolveProviderConfig(undefined, "claude-sonnet-4-20250514");

    expect(config).not.toBeNull();
    expect(config!.temperature).toBe(0.3);
    expect(config!.maxTokens).toBe(4096);
  });
});

describe("isNativeHandlerPending", () => {
  it("returns false for gemini (native handler shipped in quick 260723-uzf)", () => {
    expect(isNativeHandlerPending("gemini")).toBe(false);
  });

  it("returns true for xiaomi and minimax (still pending)", () => {
    expect(isNativeHandlerPending("xiaomi")).toBe(true);
    expect(isNativeHandlerPending("minimax")).toBe(true);
  });

  it("returns false for the OpenAI-compatible / legacy types", () => {
    expect(isNativeHandlerPending("openai")).toBe(false);
    expect(isNativeHandlerPending("ollama")).toBe(false);
    expect(isNativeHandlerPending("anthropic")).toBe(false);
    expect(isNativeHandlerPending("openrouter")).toBe(false);
  });
});

describe("buildGeminiRequestBody", () => {
  const config: ProviderConfig = {
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "sk-gemini",
    model: "gemini-1.5-pro",
    temperature: 0.4,
    maxTokens: 1024,
  } as ProviderConfig;

  it("maps system message to systemInstruction and assistant role to 'model'", () => {
    const body = buildGeminiRequestBody(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
      config,
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are helpful." }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello!" }] },
      { role: "user", parts: [{ text: "How are you?" }] },
    ]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 1024, temperature: 0.4 });
  });

  it("omits systemInstruction when there is no system message", () => {
    const body = buildGeminiRequestBody([{ role: "user", content: "Hi" }], config);
    expect(body.systemInstruction).toBeUndefined();
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Hi" }] }]);
  });

  it("omits generationConfig when temperature and maxTokens are absent", () => {
    const minimalConfig = { ...config, temperature: undefined as unknown as number, maxTokens: undefined };
    const body = buildGeminiRequestBody([{ role: "user", content: "Hi" }], minimalConfig);
    expect(body.generationConfig).toBeUndefined();
  });
});

describe("extractGeminiText", () => {
  it("concatenates text across multiple parts", () => {
    const data = {
      candidates: [{ content: { parts: [{ text: "Hello " }, { text: "world" }] } }],
    };
    expect(extractGeminiText(data)).toBe("Hello world");
  });

  it("returns empty string when there are no candidates", () => {
    expect(extractGeminiText({})).toBe("");
    expect(extractGeminiText({ candidates: [] })).toBe("");
  });
});

describe("callNonStreamingLLM (gemini)", () => {
  beforeEach(() => {
    mockAxiosPost.mockReset();
  });

  it("POSTs to generateContent with x-goog-api-key and returns merged text + tokens", async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        candidates: [{ content: { parts: [{ text: "Answer" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      },
    });

    const config: ProviderConfig = {
      type: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "sk-gemini",
      model: "gemini-1.5-pro",
      temperature: 0.7,
      maxTokens: 512,
    } as ProviderConfig;

    const result = await callNonStreamingLLM(
      config,
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Ping" },
      ],
      5000,
    );

    expect(result.content).toBe("Answer");
    expect(result.tokensUsed).toBe(8);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    const [url, body, opts] = mockAxiosPost.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be brief." }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Ping" }] }]);
    expect(opts.headers).toEqual({
      "x-goog-api-key": "sk-gemini",
      "Content-Type": "application/json",
    });
  });
});

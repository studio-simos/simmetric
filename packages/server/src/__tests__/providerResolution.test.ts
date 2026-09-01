// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Provider resolution tests — resolveProviderConfig function
 */
import "./helpers/setupEnv";

jest.mock("../services/encryptionService", () => ({
  encrypt: jest.fn((val: string) => `encrypted:${val}`),
  decrypt: jest.fn((val: string) => val),
}));

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  return { __esModule: true, default: createMockPrisma().prisma };
});

import prisma from "../utils/prisma";
import { resolveProviderConfig } from "../services/providerService";

const OLLAMA_PROVIDER = {
  id: "prov-ollama-001",
  name: "Ollama Local",
  type: "ollama" as const,
  baseUrl: "http://ollama:11434",
  apiKey: null,
  isEnabled: true,
  isDefault: false,
  models: [
    {
      name: "gemma4:latest",
      isEnabled: true,
      isAvailable: true,
      temperature: 0.8,
      maxTokens: 4096,
    },
    {
      name: "mistral",
      isEnabled: true,
      isAvailable: true,
      temperature: null,
      maxTokens: null,
    },
  ],
};

const OPENAI_PROVIDER = {
  id: "prov-openai-001",
  name: "OpenAI",
  type: "openai" as const,
  baseUrl: "https://api.openai.com",
  apiKey: "sk-test-key",
  isEnabled: true,
  isDefault: true,
  models: [
    { name: "gpt-4o", isEnabled: true, isAvailable: true, temperature: 1.0, maxTokens: 16384 },
    { name: "gpt-4", isEnabled: true, isAvailable: true, temperature: 0.5, maxTokens: 8192 },
    { name: "gpt-3.5", isEnabled: false, isAvailable: true, temperature: null, maxTokens: null },
  ],
};

const DISABLED_PROVIDER = {
  id: "prov-disabled-001",
  name: "Disabled Provider",
  type: "anthropic" as const,
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-ant-test",
  isEnabled: false,
  isDefault: false,
  models: [
    { name: "claude-sonnet", isEnabled: true, isAvailable: true, temperature: null, maxTokens: null },
  ],
};

function mockProvider(provider: any) {
  return {
    ...provider,
    models: provider.models.map((m: any) => ({
      id: `${provider.id}-model-${m.name}`,
      providerId: provider.id,
      displayName: null,
      isLocal: provider.type === "ollama",
      isEmbedding: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...m,
    })),
    lastError: null,
    lastSyncAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("resolveProviderConfig", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("explicit providerId", () => {
    it("resolves config from explicit providerId", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(OPENAI_PROVIDER.id, "gpt-4o");

      expect(result).not.toBeNull();
      expect(result!.type).toBe("openai");
      expect(result!.baseUrl).toBe("https://api.openai.com");
      expect(result!.apiKey).toBe("sk-test-key");
      expect(result!.model).toBe("gpt-4o");
      expect(prisma.provider.findUnique).toHaveBeenCalledWith({
        where: { id: OPENAI_PROVIDER.id },
        include: { models: true },
      });
    });

    it("resolves with model temperature and maxTokens", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(OPENAI_PROVIDER.id, "gpt-4o");

      expect(result!.temperature).toBe(1.0);
      expect(result!.maxTokens).toBe(16384);
    });

    it("defaults temperature to 0.7 when model has no temperature", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OLLAMA_PROVIDER));

      const result = await resolveProviderConfig(OLLAMA_PROVIDER.id, "mistral");

      expect(result!.temperature).toBe(0.7);
      expect(result!.maxTokens).toBeUndefined();
    });

    it("picks first available model when no model override given", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OLLAMA_PROVIDER));

      const result = await resolveProviderConfig(OLLAMA_PROVIDER.id);

      expect(result!.model).toBe("gemma4:latest");
    });

    it("returns null when the requested model exists in no provider", async () => {
      // When an explicit model name is requested, every tier of the chain
      // (explicit provider → default provider → any enabled provider) requires
      // that exact model to exist. If it does nowhere, the function returns
      // null and the caller falls back to environment-variable configuration.
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(OPENAI_PROVIDER.id, "nonexistent-model");

      expect(result).toBeNull();
    });
  });

  describe("disabled provider", () => {
    it("skips disabled provider and falls back to default", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(DISABLED_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(DISABLED_PROVIDER.id);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("openai");
      expect(prisma.provider.findFirst).toHaveBeenCalled();
    });

    it("falls back to any enabled provider when default is also disabled", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(DISABLED_PROVIDER));
      (prisma.provider.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // default provider query
        .mockResolvedValueOnce(mockProvider(OLLAMA_PROVIDER)); // any provider query

      const result = await resolveProviderConfig(DISABLED_PROVIDER.id);

      expect(result).not.toBeNull();
      expect(result!.type).toBe("ollama");
    });
  });

  describe("fallback to default provider", () => {
    it("uses default provider when no providerId given", async () => {
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig();

      expect(result).not.toBeNull();
      expect(result!.type).toBe("openai");
      expect(result!.model).toBe("gpt-4o");
      expect(prisma.provider.findFirst).toHaveBeenCalledWith({
        where: { isDefault: true, isEnabled: true },
        include: { models: { where: { isEnabled: true, isAvailable: true } } },
      });
    });

    it("resolves specific model from default provider", async () => {
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(undefined, "gpt-4");

      expect(result!.model).toBe("gpt-4");
      expect(result!.temperature).toBe(0.5);
      expect(result!.maxTokens).toBe(8192);
    });
  });

  describe("fallback to any enabled provider", () => {
    it("uses any enabled provider when no default exists", async () => {
      (prisma.provider.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // no default provider
        .mockResolvedValueOnce(mockProvider(OLLAMA_PROVIDER)); // any enabled

      const result = await resolveProviderConfig();

      expect(result).not.toBeNull();
      expect(result!.type).toBe("ollama");
      expect(result!.model).toBe("gemma4:latest");
    });
  });

  describe("no providers in DB", () => {
    it("returns null when zero providers exist", async () => {
      (prisma.provider.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // default
        .mockResolvedValueOnce(null); // any

      const result = await resolveProviderConfig();

      expect(result).toBeNull();
    });

    it("returns null when explicit providerId not found and no fallbacks", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.provider.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      const result = await resolveProviderConfig("nonexistent-id");

      expect(result).toBeNull();
    });
  });
});

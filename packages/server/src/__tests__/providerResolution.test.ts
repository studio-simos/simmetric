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
import { resolveProviderConfig, resolveProviderConfigStrict } from "../services/providerService";

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
      // 260917-mz6 UPDATE: with the graceful-degradation arms in place, a
      // named model that exists NOWHERE still returns null only when the
      // providers it lands on carry zero available models. The test below
      // pins that zero-available-provider case (the "no model anywhere"
      // outcome); the degrade cases live in the new describes.
      // Providers whose models are all disabled/unavailable → degradation
      // finds nothing → null.
      const noAvailableProvider = {
        ...OPENAI_PROVIDER,
        models: OPENAI_PROVIDER.models.map((m) => ({ ...m, isAvailable: false })),
      };
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(noAvailableProvider));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(noAvailableProvider));

      const result = await resolveProviderConfig(OPENAI_PROVIDER.id, "nonexistent-model");

      expect(result).toBeNull();
    });

    // 260917-mz6 (widget error fix): a named-but-missing model must degrade
    // to the provider's first available model instead of hard-failing —
    // unpinned widget chats land on Chat.model's schema default
    // ("qwen2.5:3b"), which may have no ProviderModel row on any provider.
    it("degrades a missing model to the provider's first available model (explicit providerId arm)", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(OPENAI_PROVIDER.id, "missing-model");

      expect(result).not.toBeNull();
      expect(result!.model).toBe("gpt-4o"); // first available model on the provider
      expect(result!.type).toBe("openai");
    });

    it("degrades a missing model on the default-provider arm to its first available model", async () => {
      // No explicit provider; the default provider lacks the requested model
      // but has available models → degrade instead of null.
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.provider.findFirst as jest.Mock)
        .mockResolvedValueOnce(mockProvider(OPENAI_PROVIDER)) // default provider query
        .mockResolvedValueOnce(mockProvider(OPENAI_PROVIDER)); // any enabled (unused)

      const result = await resolveProviderConfig(undefined, "missing-model");

      expect(result).not.toBeNull();
      expect(result!.model).toBe("gpt-4o");
      expect(result!.type).toBe("openai");
    });

    it("degradation logs an info line naming the requested + degraded models (observable, never silent)", async () => {
      const { logger } = await import("../utils/logger");
      const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => logger);
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(OPENAI_PROVIDER.id, "missing-model");

      expect(result).not.toBeNull();
      const degradedCall = infoSpy.mock.calls.find((c) =>
        String(c[0]).includes("degrading to available model"),
      );
      expect(degradedCall).toBeDefined();
      expect(String(degradedCall![0])).toContain("missing-model");
      expect(String(degradedCall![0])).toContain("gpt-4o");
      expect(String(degradedCall![0])).toContain("OpenAI");
      infoSpy.mockRestore();
    });

    it("byte-identical selection when the named model IS found (no degrade, no log)", async () => {
      const { logger } = await import("../utils/logger");
      const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => logger);
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const result = await resolveProviderConfig(OPENAI_PROVIDER.id, "gpt-4o");

      expect(result).not.toBeNull();
      expect(result!.model).toBe("gpt-4o"); // exact model, not the first available
      const degradedCall = infoSpy.mock.calls.find((c) =>
        String(c[0]).includes("degrading to available model"),
      );
      expect(degradedCall).toBeUndefined();
      infoSpy.mockRestore();
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

  // 260919 model-missing UX: strict resolution for user-facing chat paths —
  // a user-selected model that cannot be resolved reports NOT-FOUND instead
  // of silently substituting a different model (the OCR-degrade regression).
  describe("resolveProviderConfigStrict", () => {
    it("degrades to the first NON-OCR, NON-embedding model (skips isOcr/isEmbedding)", async () => {
      const ocrFirstProvider = {
        ...OLLAMA_PROVIDER,
        models: [
          { name: "deepseek-ocr:latest", isEnabled: true, isAvailable: true, isOcr: true, temperature: null, maxTokens: null },
          { name: "gemma4:latest", isEnabled: true, isAvailable: true, temperature: null, maxTokens: null },
        ],
      };
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(ocrFirstProvider));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(ocrFirstProvider));

      const result = await resolveProviderConfig(OLLAMA_PROVIDER.id, "missing-model");

      expect(result).not.toBeNull();
      expect(result!.model).toBe("gemma4:latest");
      expect(result!.degradedFrom).toBe("missing-model");
    });

    it("strict: found model passes through verbatim (no degradedFrom)", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const { config, requestedModel } = await resolveProviderConfigStrict(OPENAI_PROVIDER.id, "gpt-4o");

      expect(requestedModel).toBeUndefined();
      expect(config).not.toBeNull();
      expect(config!.model).toBe("gpt-4o");
      expect(config!.degradedFrom).toBeUndefined();
    });

    it("strict: missing named model reports not-found instead of serving the degraded substitute", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const { config, requestedModel } = await resolveProviderConfigStrict(OPENAI_PROVIDER.id, "dead-model");

      expect(config).toBeNull();
      expect(requestedModel).toBe("dead-model");
    });

    it("strict: no explicit model delegates to the lenient resolver (workspace/default arm)", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const { config, requestedModel } = await resolveProviderConfigStrict(OPENAI_PROVIDER.id, undefined);

      expect(requestedModel).toBeUndefined();
      expect(config).not.toBeNull();
      expect(config!.model).toBe("gpt-4o");
    });

    it("strict: missing model everywhere reports not-found (not-found is distinct from null-provider)", async () => {
      (prisma.provider.findUnique as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));
      (prisma.provider.findFirst as jest.Mock).mockResolvedValue(mockProvider(OPENAI_PROVIDER));

      const lenient = await resolveProviderConfig(OPENAI_PROVIDER.id, "dead-model");
      expect(lenient).not.toBeNull(); // lenient serves the substitute
      expect(lenient!.degradedFrom).toBe("dead-model");

      const strict = await resolveProviderConfigStrict(OPENAI_PROVIDER.id, "dead-model");
      expect(strict.config).toBeNull(); // strict refuses the substitute
    });
  });
});

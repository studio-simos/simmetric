// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KB-04 / D-15 PHI gate unit tests — pre-egress abort when an archive's
 * ArchiveConfig.config.localLLMOnly is true AND the resolved provider is
 * NOT ollama (PHI would leak to an external LLM endpoint).
 *
 * Tests:
 *   4. Medical + OpenAI  → throws BEFORE callNonStreamingLLM (zero outbound).
 *   5. Medical + Ollama  → proceeds normally, callNonStreamingLLM IS called.
 *   6. Generic + OpenAI  → gate does not apply (localLLMOnly=false), proceeds.
 *
 * The gate lives at the TOP of callSynthesisLLM — before any prompt/messages
 * construction (RESEARCH Pitfall 1). The flag is populated by Task 3's
 * propagation in production (Test 7 in archiveLocalLLMOnlyPropagation tests).
 */

import "./helpers/setupEnv";

// ── Mocks ────────────────────────────────────────────────────────────────

jest.mock("../utils/prisma", () => {
  return {
    __esModule: true,
    default: {
      archiveConfig: {
        findUnique: jest.fn(),
      },
      synthesisRun: {
        create: jest.fn(),
        update: jest.fn(),
      },
    },
  };
});

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn(() => ({
    SYNTHESIS_LLM_MODEL: "test-synth-model",
    LLM_MODEL: "test-llm-model",
    OLLAMA_BASE_URL: "http://ollama-test:11434",
    JWT_SECRET: "test-jwt-secret-for-unit-tests-32ch",
    SERVER_PORT: 3000,
    SESSION_EXPIRY: 86400000,
    NODE_ENV: "test",
    ALLOW_REGISTRATION: true,
  })),
}));

jest.mock("../services/providerService", () => ({
  callNonStreamingLLM: jest.fn(),
  resolveProviderConfig: jest.fn(),
}));

jest.mock("../services/archiveConfigService", () => ({
  getSynthesisOverrides: jest.fn().mockResolvedValue(null),
}));

jest.mock("../services/systemConfigService", () => ({
  getSetting: jest.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────

import prisma from "../utils/prisma";
import { callNonStreamingLLM, resolveProviderConfig } from "../services/providerService";
import { callSynthesisLLM } from "../services/synthesisService";

const mockedFindUnique = (prisma as any).archiveConfig.findUnique as jest.MockedFunction<any>;
const mockedCallNonStreamingLLM = callNonStreamingLLM as jest.MockedFunction<typeof callNonStreamingLLM>;
const mockedResolveProviderConfig = resolveProviderConfig as jest.MockedFunction<typeof resolveProviderConfig>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no ArchiveConfig row → gate skipped
  mockedFindUnique.mockResolvedValue(null);
  mockedResolveProviderConfig.mockResolvedValue(null);
  mockedCallNonStreamingLLM.mockResolvedValue({ content: "synthetic LLM response", tokensUsed: 5 });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("KB-04 / D-15 — PHI gate (pre-egress)", () => {
  it("Test 4: Medical archive (localLLMOnly:true) + OpenAI provider → throws before callNonStreamingLLM (zero outbound)", async () => {
    mockedFindUnique.mockResolvedValue({ config: { localLLMOnly: true } });
    mockedResolveProviderConfig.mockResolvedValue({
      type: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-4",
      displayName: "GPT-4",
      temperature: 0.7,
      maxTokens: undefined,
      isLocal: false,
    } as any);

    // Mock systemConfigService.getSetting via dynamic require
    const { getSetting } = require("../services/systemConfigService");
    (getSetting as jest.Mock).mockResolvedValue({ value: "provider-openai-id" });

    await expect(callSynthesisLLM("prompt containing PHI", undefined, "archive-medical"))
      .rejects.toThrow(/Archive template requires local LLM; external provider configured \(PHI gate\)/);

    // Zero outbound LLM calls — the gate must abort BEFORE callNonStreamingLLM
    expect(mockedCallNonStreamingLLM).not.toHaveBeenCalled();
  });

  it("Test 5: Medical archive (localLLMOnly:true) + Ollama provider → proceeds, callNonStreamingLLM IS called", async () => {
    mockedFindUnique.mockResolvedValue({ config: { localLLMOnly: true } });
    mockedResolveProviderConfig.mockResolvedValue({
      type: "ollama",
      baseUrl: "http://ollama:11434",
      apiKey: null,
      model: "med-vlm:latest",
      displayName: "Med VLM",
      temperature: 0.7,
      maxTokens: undefined,
      isLocal: true,
    } as any);

    const { getSetting } = require("../services/systemConfigService");
    (getSetting as jest.Mock).mockResolvedValue({ value: "provider-ollama-id" });

    const result = await callSynthesisLLM("prompt", undefined, "archive-medical");

    expect(result.content).toBe("synthetic LLM response");
    expect(mockedCallNonStreamingLLM).toHaveBeenCalled();
  });

  it("Test 6: Generic archive (localLLMOnly:false) + OpenAI provider → gate does not apply, proceeds normally", async () => {
    mockedFindUnique.mockResolvedValue({ config: { localLLMOnly: false } });
    mockedResolveProviderConfig.mockResolvedValue({
      type: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-4",
      displayName: "GPT-4",
      temperature: 0.7,
      maxTokens: undefined,
      isLocal: false,
    } as any);

    const { getSetting } = require("../services/systemConfigService");
    (getSetting as jest.Mock).mockResolvedValue({ value: "provider-openai-id" });

    const result = await callSynthesisLLM("prompt", undefined, "archive-generic");

    expect(result.content).toBe("synthetic LLM response");
    expect(mockedCallNonStreamingLLM).toHaveBeenCalled();
  });

  it("Test 6b: Archive without ArchiveConfig row + OpenAI provider → gate does not apply (no flag = no constraint)", async () => {
    mockedFindUnique.mockResolvedValue(null);
    mockedResolveProviderConfig.mockResolvedValue({
      type: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
      model: "gpt-4",
      displayName: "GPT-4",
      temperature: 0.7,
      maxTokens: undefined,
      isLocal: false,
    } as any);

    const { getSetting } = require("../services/systemConfigService");
    (getSetting as jest.Mock).mockResolvedValue({ value: "provider-openai-id" });

    const result = await callSynthesisLLM("prompt", undefined, "archive-no-config");

    expect(result.content).toBe("synthetic LLM response");
    expect(mockedCallNonStreamingLLM).toHaveBeenCalled();
  });

  it("Test 6c: callSynthesisLLM without archiveId → gate skipped (backward compat for callers not passing archiveId)", async () => {
    // No archiveConfig lookup should happen when archiveId is undefined
    const result = await callSynthesisLLM("prompt", undefined);

    expect(result.content).toBe("synthetic LLM response");
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });
});
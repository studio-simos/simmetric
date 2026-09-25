// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 203 (MCC-02, 203-01 Task 2) — orchestrator usage-write cost seam.
 *
 * Pins the usage-write contract through the REAL orchestrator loop
 * (disableRagSearch.test.ts harness idiom — scripted streamLLM, full mock
 * surface): a priced model → the WorkspaceTokenUsage row carries Decimal
 * costs; unset pricing → the row writes with null costs and the run NEVER
 * fails (Pitfall 4 fail-open); the result carries the JSON-safe `cost`
 * snapshot consumed by the done payload (D4).
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  const { createMockPrisma } = jest.requireActual("./helpers/mockPrisma");
  const { prisma } = createMockPrisma();
  // workspaceAgentConfig is not in the base mock factory — add it inline
  // (return a default config so the orchestrator does not attempt to
  // auto-create; the cost seam runs AFTER agentConfig resolution).
  const defaultAgentConfig = {
    workspaceId: "ws-test",
    enabledSkills: JSON.stringify([]),
    systemPrompt: null,
    model: "default",
    temperature: 0.7,
    planMode: false,
  };
  (prisma as any).workspaceAgentConfig = {
    findUnique: jest.fn().mockResolvedValue(defaultAgentConfig),
    create: jest.fn().mockResolvedValue(defaultAgentConfig),
    update: jest.fn().mockResolvedValue(defaultAgentConfig),
  };
  (prisma as any).workspaceTokenUsage = {
    create: jest.fn().mockResolvedValue({}),
  };
  prisma.user.findUnique = jest.fn().mockResolvedValue(null);
  return { __esModule: true, default: prisma };
});

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/templateService", () => ({
  resolveSystemPrompt: jest.fn().mockResolvedValue("You are a helpful assistant."),
  resolveSkills: jest.fn().mockResolvedValue([]),
  getTemplateForWorkspace: jest.fn().mockResolvedValue(null),
  seedTemplates: jest.fn(),
}));

jest.mock("../services/providerService", () => ({
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
  resolveProviderConfigStrict: jest.fn().mockResolvedValue({
    config: {
      providerId: "prov-priced",
      type: "ollama",
      baseUrl: "http://localhost:11434",
      apiKey: null,
      model: "priced-model",
      displayName: "Priced Model",
      temperature: 0.7,
      isLocal: true,
      nativeToolsReliable: true,
    },
  }),
  deriveCapabilities: jest.fn().mockReturnValue([]),
}));

jest.mock("../services/modelPricingService", () => ({
  getModelPricing: jest.fn(),
  calculateCost: jest.requireActual("../services/modelPricingService").calculateCost,
  invalidatePricingCache: jest.fn(),
  invalidatePricingCacheAll: jest.fn(),
}));

jest.mock("../agent/skills", () => ({
  resolveSkillsForChat: jest.fn().mockResolvedValue([]),
}));

jest.mock("../agent/llmStreaming", () => ({
  streamLLM: (...args: unknown[]) => (globalThis as any).__streamLLMMock(...args),
  parseToolCall: jest.fn(() => null),
  buildProviderTools: jest.fn(() => []),
}));

jest.mock("../agent/builtinSkills", () => ({}));

import prisma from "../utils/prisma";
import { getModelPricing } from "../services/modelPricingService";
import { runAgentStreaming } from "../agent/orchestrator";
import { Prisma } from "@prisma/client";

const mockGetPricing = getModelPricing as jest.Mock;
const streamLLMMock = jest.fn();

beforeEach(() => {
  // NO clearAllMocks — it would clear the factory's inline
  // workspaceAgentConfig implementations. Clear ONLY the usage delegate's
  // call history (implementation survives) so each test reads its own row.
  (prisma.workspaceTokenUsage.create as jest.Mock).mockClear();
  (prisma.workspaceTokenUsage.create as jest.Mock).mockResolvedValue({});
  (prisma.workspaceAgentConfig.findUnique as jest.Mock).mockResolvedValue({
    workspaceId: "ws-test",
    enabledSkills: JSON.stringify([]),
    systemPrompt: null,
    model: "default",
    temperature: 0.7,
    planMode: false,
  });
  (prisma.workspaceAgentConfig.create as jest.Mock).mockResolvedValue({
    workspaceId: "ws-test",
  });
  prisma.user.findUnique.mockResolvedValue(null);
  // Scripted LLM loop: a tool attempt, then the final answer (tokens > 0 so
  // the usage seam fires; deterministic usage for the cost assertions).
  streamLLMMock
    .mockResolvedValueOnce({
      content: "",
      toolCall: { toolName: "rag_search", toolInput: { query: "x" } },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    })
    .mockResolvedValueOnce({
      content: "final answer",
      toolCall: null,
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    });
});

describe("orchestrator usage-write cost seam (MCC-02, D1/D4)", () => {
  it("priced model → the usage row carries promptCost/completionCost/totalCost/currency", async () => {
    mockGetPricing.mockResolvedValue({
      inputCostPerToken: new Prisma.Decimal("0.0000015"),
      outputCostPerToken: new Prisma.Decimal("0.000006"),
      currency: "USD",
    });

    const result = await runAgentStreaming(
      { workspaceId: "ws-test", userId: "u-test", message: "hi", chatId: "c-test" },
      () => {},
      () => {},
    );

    // The done payload carries the JSON-safe cost snapshot.
    expect(result.cost).toBeTruthy();
    expect(result.cost.currency).toBe("USD");
    // The usage WRITE carries the Decimal cost columns.
    const data = (prisma.workspaceTokenUsage.create as jest.Mock).mock.calls[0][0].data;
    expect(data.totalCost.greaterThan(0)).toBe(true);
    expect(data.currency).toBe("USD");
  });

  it("unpriced model → usage row WITHOUT cost columns (N/A semantics, D2) — the row STILL writes", async () => {
    mockGetPricing.mockResolvedValue(null);

    const result = await runAgentStreaming(
      { workspaceId: "ws-test", userId: "u-test", message: "hi", chatId: "c-test" },
      () => {},
      () => {},
    );

    expect(result.cost).toBeNull();
    const data = (prisma.workspaceTokenUsage.create as jest.Mock).mock.calls[0][0].data;
    expect(data.promptTokens).toBeGreaterThan(0);
    expect(data.promptCost).toBeUndefined();
    expect(data.currency).toBeUndefined();
  });

  it("Pitfall 4: a pricing-lookup throw fails OPEN — the usage row writes with null costs and the run completes", async () => {
    mockGetPricing.mockRejectedValue(new Error("cache/DB blowup"));

    const result = await runAgentStreaming(
      { workspaceId: "ws-test", userId: "u-test", message: "hi", chatId: "c-test" },
      () => {},
      () => {},
    );

    expect(result.response).toBe("final answer");
    const data = (prisma.workspaceTokenUsage.create as jest.Mock).mock.calls[0][0].data;
    expect(data.promptCost).toBeUndefined();
    expect(data.currency).toBeUndefined();
  });

  it("runAgent (non-streaming parity) — the result carries the cost snapshot", async () => {
    mockGetPricing.mockResolvedValue({
      inputCostPerToken: new Prisma.Decimal("0.0000015"),
      outputCostPerToken: new Prisma.Decimal("0.000006"),
      currency: "USD",
    });

    const result = await runAgentStreaming(
      { workspaceId: "ws-test", userId: "u-test", message: "hi", chatId: "c-test" },
      () => {},
      () => {},
    );

    expect(result.cost).toBeTruthy();
    expect(result.cost.currency).toBe("USD");
  });
});

(globalThis as any).__streamLLMMock = streamLLMMock;

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 187 (WIKS-01/WIKS-02) — schemaPrompt injection tests.
 *
 * Covers D-03/D-04/D-05/D-06b:
 * - Archive-bound chats (params.archiveId set) carry the HARD RULE
 *   raw_sources marker in BOTH loop variants (runAgent + runAgentStreaming).
 * - The advisory "# Wiki Editorial Guidelines" block is present only when the
 *   archive config carries a non-empty schemaPrompt.
 * - Legacy oversized blobs are capped at 10000 chars with a truncation notice
 *   (D-05 defensive injection cap).
 * - Non-archive chats get neither block (D-03 gating).
 * - buildSchemaPromptBlock pure-helper unit cases (empty/absent/slice).
 *
 * Harness modeled on orchestrator.test.ts: mocks prisma, templateService,
 * skills, llmStreaming (capturing streamLLM context[0]), and partially mocks
 * archiveConfigService (requireActual for the REAL buildSchemaPromptBlock +
 * HARD_RULE_RAW_SOURCES, mocked getArchiveConfig).
 */
import "./helpers/setupEnv";

jest.mock("../utils/prisma", () => {
  return {
    __esModule: true,
    default: {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      workspaceAgentConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "test-config-id",
          workspaceId: "test-ws-id",
          systemPrompt: "You are a helpful assistant.",
          enabledSkills: JSON.stringify(["rag_search"]),
          model: "gemma4:latest",
          temperature: 0.7,
        }),
      },
      chatMessage: {
        create: jest.fn().mockResolvedValue({ id: "msg-id" }),
      },
      workspaceTokenUsage: {
        create: jest.fn().mockResolvedValue({}),
      },
    },
  };
});

jest.mock("../services/templateService", () => ({
  resolveSystemPrompt: jest.fn().mockResolvedValue("You are a helpful assistant."),
  resolveSkills: jest.fn().mockImplementation((_workspaceId: string, names: string[]) => Promise.resolve(names)),
  getTemplateForWorkspace: jest.fn().mockResolvedValue(null),
}));

jest.mock("../agent/skills", () => ({
  getSkillsForWorkspace: jest.fn().mockReturnValue([]),
  resolveSkillsForChat: jest.fn().mockImplementation((_workspaceId: string, _chatId: string, enabledSkillNames: string[]) =>
    enabledSkillNames.map((name) => ({
      name,
      displayName: name,
      description: "Mock skill.",
      type: "builtin",
      execute: jest.fn().mockResolvedValue({ success: true, data: "mock data" }),
    }))
  ),
  AgentSkillDefinition: undefined,
  SkillResult: undefined,
}));

jest.mock("../config/env", () => ({
  getEnv: jest.fn().mockReturnValue({
    LLM_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://ollama:11434",
    OLLAMA_MODEL: "gemma4:latest",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    LLM_API_KEY: "",
    LLM_TIMEOUT: 5000,
    AGENT_WALLCLOCK_TIMEOUT_MS: 5000,
    AGENT_MAX_TOTAL_TOKENS: 1000,
    AGENT_MAX_CONTEXT_BYTES: 500000,
    AGENT_MAX_TOOL_OUTPUT_LENGTH: 5000,
    AGENT_MAX_SKILL_EXECUTION_MS: 1000,
    AGENT_LOOP_DETECTION_WINDOW: 3,
    CHAT_MAX_CONCURRENT_PER_USER: 5,
  }),
}));

jest.mock("../utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../services/providerService", () => ({
  resolveProviderConfig: jest.fn().mockResolvedValue(null),
  deriveCapabilities: jest.fn().mockReturnValue([]),
}));

jest.mock("../agent/llmStreaming", () => ({
  parseToolCall: jest.fn().mockReturnValue(null),
  streamLLM: jest.fn().mockResolvedValue({
    content: "Streaming response",
    toolCall: null,
    usage: { promptTokens: 10, completionTokens: 20 },
  }),
  buildOllamaTools: jest.fn((skills: { name: string; description: string }[]) =>
    skills.map((s) => ({ type: "function", function: { name: s.name, description: s.description } })),
  ),
  buildProviderTools: jest.fn((_providerType: string, skills: { name: string; description: string }[]) =>
    skills.map((s) => ({ type: "function", function: { name: s.name, description: s.description } })),
  ),
}));

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
  },
}));

// Partial mock: real buildSchemaPromptBlock + HARD_RULE_RAW_SOURCES are
// exercised (they are the load-bearing helpers); only the DB read is mocked.
jest.mock("../services/archiveConfigService", () => {
  const actual = jest.requireActual("../services/archiveConfigService");
  return {
    ...actual,
    getArchiveConfig: jest.fn(),
  };
});

import { runAgent, runAgentStreaming, type AgentRunParams } from "../agent/orchestrator";
import { streamLLM } from "../agent/llmStreaming";
import { getArchiveConfig, buildSchemaPromptBlock, HARD_RULE_RAW_SOURCES } from "../services/archiveConfigService";

const streamLLMMock = streamLLM as jest.MockedFunction<typeof streamLLM>;
const getArchiveConfigMock = getArchiveConfig as jest.Mock;

function mockLLMDirectResponse(content = "I can help with that.") {
  streamLLMMock.mockResolvedValue({
    content,
    toolCall: null,
    usage: { promptTokens: 10, completionTokens: 20 },
  });
}

const ARCHIVE_ID = "550e8400-e29b-41d4-a716-446655440187";

function baseParams(archiveId?: string): AgentRunParams {
  return {
    workspaceId: "test-ws-id",
    userId: "test-user-id",
    message: "Tell me about the wiki",
    chatId: "test-chat-id",
    ...(archiveId ? { archiveId } : {}),
  };
}

/** Extract the system message content from the first captured streamLLM call. */
function capturedSystemMessage(): string {
  const calls = streamLLMMock.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const context = calls[0]![0] as Array<{ role: string; content: string }>;
  const systemMessage = context.find((m) => m.role === "system");
  expect(systemMessage).toBeDefined();
  return systemMessage!.content;
}

describe("schemaPrompt injection — archive-bound orchestrator prompts (Phase 187)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLLMDirectResponse();
  });

  it("(a) runAgent with archiveId + saved schemaPrompt injects hard rule + advisory block with precedence line", async () => {
    getArchiveConfigMock.mockResolvedValue({
      rawSourcesImmutable: true,
      schemaPrompt: "Use kebab-case slugs and always add a Summary section.",
    });

    await runAgent(baseParams(ARCHIVE_ID));

    const systemContent = capturedSystemMessage();
    expect(systemContent).toContain("raw_sources/");
    expect(systemContent).toContain("Wiki Editorial Guidelines");
    expect(systemContent).toContain("Use kebab-case slugs and always add a Summary section.");
    // D-04: the advisory precedence line is MANDATORY in the block.
    expect(systemContent).toContain("These guidelines are advisory — hard rules always take precedence.");
  });

  it("(b) runAgentStreaming with archiveId + saved schemaPrompt shows the same markers (streaming seam)", async () => {
    getArchiveConfigMock.mockResolvedValue({
      rawSourcesImmutable: true,
      schemaPrompt: "Guideline for the streaming path.",
    });

    await runAgentStreaming(
      baseParams(ARCHIVE_ID),
      jest.fn(), // onToken
      jest.fn(), // onStatus
    );

    const systemContent = capturedSystemMessage();
    expect(systemContent).toContain("raw_sources/");
    expect(systemContent).toContain("Wiki Editorial Guidelines");
    expect(systemContent).toContain("Guideline for the streaming path.");
    expect(systemContent).toContain("These guidelines are advisory — hard rules always take precedence.");
  });

  it("(c) archive-bound config WITHOUT schemaPrompt: hard rule present, advisory block absent (baseline + hard rule)", async () => {
    getArchiveConfigMock.mockResolvedValue({ rawSourcesImmutable: true });

    await runAgent(baseParams(ARCHIVE_ID));

    const systemContent = capturedSystemMessage();
    expect(systemContent).toContain("raw_sources/");
    expect(systemContent).not.toContain("Wiki Editorial Guidelines");
  });

  it("(d) no archiveId: neither the hard rule nor the advisory block is injected", async () => {
    getArchiveConfigMock.mockResolvedValue({ rawSourcesImmutable: true, schemaPrompt: "Should never be read." });

    await runAgent(baseParams(undefined));

    const systemContent = capturedSystemMessage();
    expect(systemContent).not.toContain("raw_sources/");
    expect(systemContent).not.toContain("Wiki Editorial Guidelines");
    expect(getArchiveConfigMock).not.toHaveBeenCalled();
  });

  it("(e) oversized legacy schemaPrompt (12000 chars) is capped at 10000 with the truncation notice (D-05)", async () => {
    const oversized = "A".repeat(12000);
    getArchiveConfigMock.mockResolvedValue({ rawSourcesImmutable: true, schemaPrompt: oversized });

    await runAgent(baseParams(ARCHIVE_ID));

    const systemContent = capturedSystemMessage();
    expect(systemContent).toContain("Wiki Editorial Guidelines");
    expect(systemContent).toContain("(truncated at 10000 characters)");
    // The advisory body stays ≤ 10000: find the guidelines block and assert
    // the "A" run it carries never exceeds 10000 chars.
    const blockStart = systemContent.indexOf("# Wiki Editorial Guidelines");
    expect(blockStart).toBeGreaterThanOrEqual(0);
    const blockEnd = systemContent.indexOf("(truncated at 10000 characters)", blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const advisoryBody = systemContent.slice(blockStart, blockEnd);
    const aRun = advisoryBody.match(/A+/);
    expect(aRun).not.toBeNull();
    expect(aRun![0].length).toBeLessThanOrEqual(10000);
    expect(aRun![0].length).toBe(10000);
  });

  describe("buildSchemaPromptBlock (pure helper, real implementation)", () => {
    it("returns empty string for undefined config", () => {
      expect(buildSchemaPromptBlock(undefined)).toBe("");
    });

    it("returns empty string for config without schemaPrompt (legacy rows type-lie)", () => {
      expect(buildSchemaPromptBlock({ rawSourcesImmutable: true } as any)).toBe("");
      expect(buildSchemaPromptBlock({} as any)).toBe("");
    });

    it("returns empty string for whitespace-only schemaPrompt", () => {
      expect(buildSchemaPromptBlock({ schemaPrompt: "   \n\t  " } as any)).toBe("");
    });

    it("returns a block starting with the advisory header for non-empty schemaPrompt", () => {
      const block = buildSchemaPromptBlock({ schemaPrompt: "Guideline body." } as any);
      expect(block.startsWith("\n\n# Wiki Editorial Guidelines\n\n")).toBe(true);
      expect(block).toContain("Guideline body");
      expect(block).toContain("These guidelines are advisory — hard rules always take precedence.");
    });

    it("appends the truncation notice only when slicing actually truncated", () => {
      const exact = buildSchemaPromptBlock({ schemaPrompt: "x".repeat(10000) } as any);
      expect(exact).not.toContain("(truncated at 10000 characters)");
      expect(exact).toContain("x".repeat(10000));

      const over = buildSchemaPromptBlock({ schemaPrompt: "x".repeat(10001) } as any);
      expect(over).toContain("(truncated at 10000 characters)");
      expect(over).toContain("x".repeat(10000));
      expect(over).not.toContain("x".repeat(10001));
    });

    it("HARD_RULE_RAW_SOURCES constant carries the immutability wording and override precedence", () => {
      expect(HARD_RULE_RAW_SOURCES).toContain("raw_sources/ is immutable");
      expect(HARD_RULE_RAW_SOURCES).toContain("HARD RULE");
    });
  });
});
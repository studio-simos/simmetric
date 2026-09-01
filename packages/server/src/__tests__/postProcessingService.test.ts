// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  generateAutoTitle,
  generateTagsAndFollowUps,
  generateBatchedTitleTagsAndFollowUps,
} from "../services/postProcessingService";

jest.mock("../utils/prisma", () => ({
  __esModule: true,
  default: {
    chat: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    chatMessage: {
      count: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../services/systemConfigService", () => ({
  __esModule: true,
  getSetting: jest.fn(),
}));

jest.mock("../services/providerService", () => ({
  __esModule: true,
  callNonStreamingLLM: jest.fn(),
  resolveProviderConfig: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import prisma from "../utils/prisma";
import { getSetting } from "../services/systemConfigService";
import { callNonStreamingLLM, resolveProviderConfig } from "../services/providerService";
import { logger } from "../utils/logger";

const mockPrisma = prisma as unknown as {
  chat: { findUnique: jest.Mock; updateMany: jest.Mock };
  chatMessage: { count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
};
const mockGetSetting = getSetting as jest.Mock;
const mockCallNonStreamingLLM = callNonStreamingLLM as jest.Mock;
const mockResolveProviderConfig = resolveProviderConfig as jest.Mock;
const mockLogger = logger as unknown as { warn: jest.Mock; info: jest.Mock };

const CHAT_ID = "chat-123";
const USER_MSG = "What is TypeScript?";
const ASSISTANT_MSG = "TypeScript is a typed superset of JavaScript...";

function setupDefaultGates() {
  mockGetSetting.mockImplementation((key: string) => {
    if (key === "auto_title_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
    if (key === "auto_title_model") return Promise.resolve({ key, value: "", readOnly: false });
    return Promise.resolve({ key, value: "", readOnly: false });
  });
  mockPrisma.chat.findUnique.mockResolvedValue({ titleSource: "auto" });
  mockPrisma.chatMessage.count.mockResolvedValue(1);
  mockResolveProviderConfig.mockResolvedValue({
    type: "ollama",
    baseUrl: "http://localhost:11434",
    apiKey: null,
    model: "qwen2.5:3b",
    temperature: 0.7,
    maxTokens: undefined,
    isLocal: true,
    nativeToolsReliable: false,
  });
  mockCallNonStreamingLLM.mockResolvedValue({ content: "TypeScript Basics Explained", tokensUsed: 50 });
  mockPrisma.chat.updateMany.mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupDefaultGates();
});

describe("generateAutoTitle", () => {
  it("skips when auto_title_enabled is false (no LLM call, no Chat.update)", async () => {
    mockGetSetting.mockImplementation((key: string) =>
      key === "auto_title_enabled"
        ? Promise.resolve({ key, value: "false", readOnly: false })
        : Promise.resolve({ key, value: "", readOnly: false }),
    );
    await generateAutoTitle(CHAT_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("skips when titleSource === 'user' (user renamed, Pitfall 10)", async () => {
    mockPrisma.chat.findUnique.mockResolvedValue({ titleSource: "user" });
    await generateAutoTitle(CHAT_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("skips when assistant message count > 1 (not first exchange, D-03)", async () => {
    mockPrisma.chatMessage.count.mockResolvedValue(2);
    await generateAutoTitle(CHAT_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("calls callNonStreamingLLM with 10s timeout and updates Chat.name when all gates pass", async () => {
    await generateAutoTitle(CHAT_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    const [, messages, timeout] = mockCallNonStreamingLLM.mock.calls[0];
    expect(timeout).toBe(10_000);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("max 6 words");
    expect(messages[1].content).toContain(USER_MSG);
    expect(messages[1].content).toContain(ASSISTANT_MSG);
    expect(mockPrisma.chat.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT_ID, titleSource: "auto" },
      data: { name: "TypeScript Basics Explained" },
    });
  });

  it("truncates title to 80 chars and strips surrounding quotes", async () => {
    const longQuotedTitle = '"' + "A".repeat(100) + '"';
    mockCallNonStreamingLLM.mockResolvedValue({ content: longQuotedTitle, tokensUsed: 50 });
    await generateAutoTitle(CHAT_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockPrisma.chat.updateMany).toHaveBeenCalledTimes(1);
    const updateData = mockPrisma.chat.updateMany.mock.calls[0][0];
    expect(updateData.data.name.length).toBe(80);
    expect(updateData.data.name.startsWith('"')).toBe(false);
  });

  it("logs warning and does NOT throw on LLM call failure (fire-and-forget silent failure, D-02)", async () => {
    mockCallNonStreamingLLM.mockRejectedValue(new Error("LLM timeout"));
    await expect(generateAutoTitle(CHAT_ID, USER_MSG, ASSISTANT_MSG)).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("does NOT update Chat.name if titleSource changed to 'user' between check and update (race prevention, Pitfall 10)", async () => {
    mockPrisma.chat.updateMany.mockResolvedValue({ count: 0 });
    await generateAutoTitle(CHAT_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockPrisma.chat.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT_ID, titleSource: "auto" },
      data: { name: "TypeScript Basics Explained" },
    });
    // count: 0 means titleSource changed to "user" between check and update
    // → silent skip, no error, no retry
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      "[post-proc] Auto title generation failed",
      expect.anything(),
    );
  });
});

const MSG_ID = "msg-456";
const TAGS_JSON = JSON.stringify({
  tags: ["typescript", "programming", "javascript"],
  followUps: ["What is TypeScript used for?", "How to install TypeScript?"],
});

function setupTagsGates() {
  mockGetSetting.mockImplementation((key: string) => {
    if (key === "auto_tags_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
    if (key === "auto_title_model") return Promise.resolve({ key, value: "", readOnly: false });
    return Promise.resolve({ key, value: "", readOnly: false });
  });
  mockPrisma.chatMessage.count.mockResolvedValue(1);
  mockResolveProviderConfig.mockResolvedValue({
    type: "ollama",
    baseUrl: "http://localhost:11434",
    apiKey: null,
    model: "qwen2.5:3b",
    temperature: 0.7,
    maxTokens: undefined,
    isLocal: true,
    nativeToolsReliable: false,
  });
  mockCallNonStreamingLLM.mockResolvedValue({ content: TAGS_JSON, tokensUsed: 80 });
  mockPrisma.chatMessage.findUnique.mockResolvedValue({ metadata: null });
  mockPrisma.chatMessage.update.mockResolvedValue({});
}

describe("generateTagsAndFollowUps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupTagsGates();
  });

  it("skips when auto_tags_enabled is false (no LLM call, no metadata update)", async () => {
    mockGetSetting.mockImplementation((key: string) =>
      key === "auto_tags_enabled"
        ? Promise.resolve({ key, value: "false", readOnly: false })
        : Promise.resolve({ key, value: "", readOnly: false }),
    );
    await generateTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
  });

  it("skips when assistant message count > 1 (not first exchange)", async () => {
    mockPrisma.chatMessage.count.mockResolvedValue(2);
    await generateTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
  });

  it("calls callNonStreamingLLM, parses JSON, and updates ChatMessage.metadata with tags + followUps", async () => {
    await generateTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatMessage.update).toHaveBeenCalledTimes(1);
    const updateArgs = mockPrisma.chatMessage.update.mock.calls[0][0];
    const metadata = JSON.parse(updateArgs.data.metadata);
    expect(metadata.tags).toEqual(["typescript", "programming", "javascript"]);
    expect(metadata.followUps).toEqual(["What is TypeScript used for?", "How to install TypeScript?"]);
  });

  it("skips silently on JSON parse failure (LLM returns non-JSON)", async () => {
    mockCallNonStreamingLLM.mockResolvedValue({ content: "not valid json", tokensUsed: 10 });
    await generateTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[post-proc] Tag gen JSON parse failed",
      expect.anything(),
    );
  });

  it("skips silently on Zod validation failure (tags > 5)", async () => {
    mockCallNonStreamingLLM.mockResolvedValue({
      content: JSON.stringify({ tags: ["a", "b", "c", "d", "e", "f"], followUps: [] }),
      tokensUsed: 10,
    });
    await generateTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[post-proc] Tag gen Zod validation failed",
      expect.anything(),
    );
  });

  it("logs warning and does NOT throw on LLM call failure", async () => {
    mockCallNonStreamingLLM.mockRejectedValue(new Error("LLM timeout"));
    await expect(
      generateTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG),
    ).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
  });

  it("merges with existing metadata (does not overwrite sources/toolCalls)", async () => {
    const existingMeta = JSON.stringify({ sources: [{ title: "doc1" }], toolCalls: [] });
    mockPrisma.chatMessage.findUnique.mockResolvedValue({ metadata: existingMeta });
    await generateTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    const updateArgs = mockPrisma.chatMessage.update.mock.calls[0][0];
    const metadata = JSON.parse(updateArgs.data.metadata);
    expect(metadata.sources).toEqual([{ title: "doc1" }]);
    expect(metadata.toolCalls).toEqual([]);
    expect(metadata.tags).toEqual(["typescript", "programming", "javascript"]);
    expect(metadata.followUps).toEqual(["What is TypeScript used for?", "How to install TypeScript?"]);
  });
});

// Phase 157 (CSW-12): batched title + tags + follow-ups in one LLM call.
const BATCHED_JSON = JSON.stringify({
  title: "TS Basics",
  tags: ["typescript", "js"],
  followUps: ["How to install TS?"],
});

function setupBatchedGates() {
  mockGetSetting.mockImplementation((key: string) => {
    if (key === "auto_batch_title_tags") return Promise.resolve({ key, value: "true", readOnly: false });
    if (key === "auto_title_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
    if (key === "auto_tags_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
    if (key === "auto_title_model") return Promise.resolve({ key, value: "", readOnly: false });
    return Promise.resolve({ key, value: "", readOnly: false });
  });
  mockPrisma.chat.findUnique.mockResolvedValue({ titleSource: "auto" });
  mockPrisma.chatMessage.count.mockResolvedValue(1);
  mockResolveProviderConfig.mockResolvedValue({
    type: "ollama",
    baseUrl: "http://localhost:11434",
    apiKey: null,
    model: "qwen2.5:3b",
    temperature: 0.7,
    maxTokens: undefined,
    isLocal: true,
    nativeToolsReliable: false,
  });
  mockCallNonStreamingLLM.mockResolvedValue({ content: BATCHED_JSON, tokensUsed: 90 });
  mockPrisma.chat.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.chatMessage.findUnique.mockResolvedValue({ metadata: null });
  mockPrisma.chatMessage.update.mockResolvedValue({});
}

describe("generateBatchedTitleTagsAndFollowUps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupBatchedGates();
  });

  it("Test 1: skips when auto_batch_title_tags is unset (no LLM call, no DB update)", async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === "auto_batch_title_tags") return Promise.resolve({ key, value: "", readOnly: false });
      if (key === "auto_title_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
      if (key === "auto_tags_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
      if (key === "auto_title_model") return Promise.resolve({ key, value: "", readOnly: false });
      return Promise.resolve({ key, value: "", readOnly: false });
    });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
  });

  it("Test 2: skips when only title enabled (auto_tags_enabled=false, D-06)", async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === "auto_batch_title_tags") return Promise.resolve({ key, value: "true", readOnly: false });
      if (key === "auto_title_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
      if (key === "auto_tags_enabled") return Promise.resolve({ key, value: "false", readOnly: false });
      if (key === "auto_title_model") return Promise.resolve({ key, value: "", readOnly: false });
      return Promise.resolve({ key, value: "", readOnly: false });
    });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("Test 3: skips when only tags enabled (auto_title_enabled=false, D-06)", async () => {
    mockGetSetting.mockImplementation((key: string) => {
      if (key === "auto_batch_title_tags") return Promise.resolve({ key, value: "true", readOnly: false });
      if (key === "auto_title_enabled") return Promise.resolve({ key, value: "false", readOnly: false });
      if (key === "auto_tags_enabled") return Promise.resolve({ key, value: "true", readOnly: false });
      if (key === "auto_title_model") return Promise.resolve({ key, value: "", readOnly: false });
      return Promise.resolve({ key, value: "", readOnly: false });
    });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("Test 4: skips when not first exchange (assistantCount=2)", async () => {
    mockPrisma.chatMessage.count.mockResolvedValue(2);
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("Test 5: skips when titleSource='user' (Pitfall 10, no overwrite)", async () => {
    mockPrisma.chat.findUnique.mockResolvedValue({ titleSource: "user" });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
  });

  it("Test 6: happy path — single LLM call (10s timeout), Chat.name updated, metadata merged", async () => {
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockCallNonStreamingLLM).toHaveBeenCalledTimes(1);
    const [, messages, timeout] = mockCallNonStreamingLLM.mock.calls[0];
    expect(timeout).toBe(10_000);
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain(USER_MSG);
    expect(messages[1].content).toContain(ASSISTANT_MSG);
    expect(mockPrisma.chat.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT_ID, titleSource: "auto" },
      data: { name: "TS Basics" },
    });
    expect(mockPrisma.chatMessage.update).toHaveBeenCalledTimes(1);
    const updateArgs = mockPrisma.chatMessage.update.mock.calls[0][0];
    const metadata = JSON.parse(updateArgs.data.metadata);
    expect(metadata.tags).toEqual(["typescript", "js"]);
    expect(metadata.followUps).toEqual(["How to install TS?"]);
  });

  it("Test 7: JSON parse failure → logger.warn, no DB update (fire-and-forget)", async () => {
    mockCallNonStreamingLLM.mockResolvedValue({ content: "not json", tokensUsed: 5 });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[post-proc] Batched gen JSON parse failed",
      expect.anything(),
    );
  });

  it("Test 8: Zod validation failure (tags > 5) → logger.warn, no DB update", async () => {
    mockCallNonStreamingLLM.mockResolvedValue({
      content: JSON.stringify({ title: "T", tags: ["a", "b", "c", "d", "e", "f"], followUps: [] }),
      tokensUsed: 5,
    });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[post-proc] Batched gen Zod validation failed",
      expect.anything(),
    );
  });

  it("Test 9: LLM call failure → logger.warn, no DB update, resolves undefined (no throw)", async () => {
    mockCallNonStreamingLLM.mockRejectedValue(new Error("LLM timeout"));
    await expect(
      generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG),
    ).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockPrisma.chat.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
  });

  it("Test 10: race prevention — updateMany count=0 → silent skip, no metadata update", async () => {
    mockPrisma.chat.updateMany.mockResolvedValue({ count: 0 });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    expect(mockPrisma.chat.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT_ID, titleSource: "auto" },
      data: { name: "TS Basics" },
    });
    expect(mockPrisma.chatMessage.update).not.toHaveBeenCalled();
  });

  it("Test 11: merges tags+followUps into existing metadata preserving sources/toolCalls", async () => {
    const existingMeta = JSON.stringify({ sources: [{ title: "doc1" }], toolCalls: [{ name: "search" }] });
    mockPrisma.chatMessage.findUnique.mockResolvedValue({ metadata: existingMeta });
    await generateBatchedTitleTagsAndFollowUps(CHAT_ID, MSG_ID, USER_MSG, ASSISTANT_MSG);
    const updateArgs = mockPrisma.chatMessage.update.mock.calls[0][0];
    const metadata = JSON.parse(updateArgs.data.metadata);
    expect(metadata.sources).toEqual([{ title: "doc1" }]);
    expect(metadata.toolCalls).toEqual([{ name: "search" }]);
    expect(metadata.tags).toEqual(["typescript", "js"]);
    expect(metadata.followUps).toEqual(["How to install TS?"]);
  });
});
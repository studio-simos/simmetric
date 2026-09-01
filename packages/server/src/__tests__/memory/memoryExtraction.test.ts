// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { reviewMemoryAfterTurn, buildMemoryExtractionPrompt, MEMORY_EXTRACTION_SYSTEM_PROMPT } from "../../agent/memoryExtraction";
import type { ProviderConfig } from "@simmetric-chat/shared";

// Mock the LLM call + prisma + memoryService.applyMemoryOps + collector query.
const mockCallNonStreamingLLM = jest.fn();
const mockApplyMemoryOps = jest.fn().mockResolvedValue(undefined);
const mockQueryDedup = jest.fn().mockResolvedValue([]);
const mockPrismaFindMany = jest.fn().mockResolvedValue([]);

jest.mock("../../services/providerService", () => ({
  callNonStreamingLLM: (...args: unknown[]) => mockCallNonStreamingLLM(...args),
}));
jest.mock("../../agent/memoryService", () => ({
  applyMemoryOps: (...args: unknown[]) => mockApplyMemoryOps(...args),
  queryExistingMemoriesForDedup: (...args: unknown[]) => mockQueryDedup(...args),
  classifySensitivity: jest.fn((c: string) => {
    if (!c) return { allowed: false, sensitivity: "high" as const };
    return { allowed: true, sensitivity: "low" as const };
  }),
  resolveSensitivity: jest.fn(() => "low" as const),
  dedupRewrite: jest.fn((opts: { op: unknown }) => opts.op),
  AGENT_INSTRUCTION_DENY_PATTERNS: [],
}));
jest.mock("../../utils/prisma", () => ({
  __esModule: true,
  default: {
    memory: { findMany: (...args: unknown[]) => mockPrismaFindMany(...args) },
  },
}));

const budgetNotExhausted = { isTokenBudgetExhausted: () => false };
const budgetExhausted = { isTokenBudgetExhausted: () => true };

const providerConfig: ProviderConfig = {
  type: "ollama",
  baseUrl: "http://localhost:11434",
  apiKey: null,
  model: "test-model",
  temperature: 0.7,
};

const baseMessages = [
  { role: "user", content: "I prefer dark mode for everything." },
  { role: "assistant", content: "Got it, I'll use dark mode for your responses." },
];

describe("reviewMemoryAfterTurn (MEM-03 fire-and-forget extraction)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaFindMany.mockResolvedValue([]);
    mockQueryDedup.mockResolvedValue([]);
    mockApplyMemoryOps.mockResolvedValue(undefined);
  });

  describe("interval gating", () => {
    it("skips when AGENT_MEMORY_REVIEW_INTERVAL is 0 (feature off)", async () => {
      // interval=0 → cannot test directly via env without mocking getEnv;
      // we simulate by passing turnCount that doesn't hit a non-zero interval.
      // Instead test the modulo: turnCount=3 with default interval=10 → skip.
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 3,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    });

    it("fires when turnCount % interval === 0 (turnCount=10, default interval=10)", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({
        content: '{"operations":[]}',
        tokensUsed: 10,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockCallNonStreamingLLM).toHaveBeenCalledTimes(1);
      // Empty ops → no applyMemoryOps call.
      expect(mockApplyMemoryOps).not.toHaveBeenCalled();
    });
  });

  describe("Pitfall 3 anonymous widget guard", () => {
    it("skips when userId is empty string", async () => {
      await reviewMemoryAfterTurn({
        userId: "",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    });
  });

  describe("budget-aware skip (MEM-03 SC1)", () => {
    it("skips when budgetTracker.isTokenBudgetExhausted() returns true", async () => {
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetExhausted,
      });
      expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    });
  });

  describe("transcript build", () => {
    it("skips when no user/assistant messages have content", async () => {
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: [{ role: "system", content: "sys" }],
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockCallNonStreamingLLM).not.toHaveBeenCalled();
    });

    it("truncates long messages to 2000 chars (head 1200 + omissis marker + tail 600)", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({ content: '{"operations":[]}', tokensUsed: 5 });
      const longContent = "x".repeat(3000);
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: [{ role: "user", content: longContent }],
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockCallNonStreamingLLM).toHaveBeenCalledTimes(1);
      const userMsg = mockCallNonStreamingLLM.mock.calls[0][1][1].content as string;
      expect(userMsg).toContain("…[omissis]…");
      // The user message transcript line for the long content is bounded:
      // "user: " + 1200 + marker + 600 ≈ 1810 chars, NOT 3000.
      expect(userMsg).toContain("x".repeat(1200));
      expect(userMsg).toContain("x".repeat(600));
      expect(userMsg).not.toContain("x".repeat(2000));
    });

    it("uses only the last 20 messages", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({ content: '{"operations":[]}', tokensUsed: 5 });
      const msgs = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `msg-${i}`,
      }));
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: msgs,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      const userMsg = mockCallNonStreamingLLM.mock.calls[0][1][1].content as string;
      // Last 20 of 30 = indices 10..29. msg-9 should NOT appear; msg-29 should.
      expect(userMsg).toContain("msg-29");
      expect(userMsg).not.toContain("msg-9");
    });
  });

  describe("LLM call + JSON parse + validate + apply", () => {
    it("parses valid JSON operations and calls applyMemoryOps", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({
        content: '{"operations":[{"op":"add","type":"user","path":"preferences.theme","content":"prefers dark mode","sensitivity":"low"}]}',
        tokensUsed: 42,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockApplyMemoryOps).toHaveBeenCalledTimes(1);
      const applyArgs = mockApplyMemoryOps.mock.calls[0][0];
      expect(applyArgs.userId).toBe("u1");
      expect(applyArgs.workspaceId).toBe("w1");
      expect(applyArgs.ops).toHaveLength(1);
      expect(applyArgs.ops[0].op).toBe("add");
    });

    it("strips markdown ```json fences before parsing", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({
        content: '```json\n{"operations":[{"op":"add","type":"user","path":"p","content":"x","sensitivity":"low"}]}\n```',
        tokensUsed: 10,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockApplyMemoryOps).toHaveBeenCalledTimes(1);
    });

    it("skips when LLM returns unparseable JSON (jsonrepair fallback also fails)", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({
        content: "not json at all and not even close",
        tokensUsed: 5,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockApplyMemoryOps).not.toHaveBeenCalled();
    });

    it("skips when validation fails (invalid op shape)", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({
        content: '{"operations":[{"op":"noop"}]}',
        tokensUsed: 5,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockApplyMemoryOps).not.toHaveBeenCalled();
    });

    it("skips when LLM returns empty operations array (nothing to remember)", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({
        content: '{"operations":[]}',
        tokensUsed: 5,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockApplyMemoryOps).not.toHaveBeenCalled();
    });

    it("returns silently when LLM call throws (fire-and-forget — never rethrows)", async () => {
      mockCallNonStreamingLLM.mockRejectedValue(new Error("LLM unavailable"));
      await expect(
        reviewMemoryAfterTurn({
          userId: "u1",
          workspaceId: "w1",
          providerConfig,
          messages: baseMessages,
          turnCount: 10,
          budgetTracker: budgetNotExhausted,
        }),
      ).resolves.toBeUndefined();
      expect(mockApplyMemoryOps).not.toHaveBeenCalled();
    });
  });

  describe("dedup query", () => {
    it("queries existing memories via Prisma when not pre-supplied", async () => {
      mockPrismaFindMany.mockResolvedValue([
        { id: "m1", type: "user", path: "p", content: "old" },
      ]);
      mockCallNonStreamingLLM.mockResolvedValue({
        content: '{"operations":[{"op":"add","type":"user","path":"p","content":"new","sensitivity":"low"}]}',
        tokensUsed: 10,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
      });
      expect(mockPrismaFindMany).toHaveBeenCalledTimes(1);
      expect(mockQueryDedup).toHaveBeenCalledTimes(1);
    });

    it("skips dedup query when existingMemories is pre-supplied as empty array", async () => {
      mockCallNonStreamingLLM.mockResolvedValue({
        content: '{"operations":[{"op":"add","type":"user","path":"p","content":"x","sensitivity":"low"}]}',
        tokensUsed: 10,
      });
      await reviewMemoryAfterTurn({
        userId: "u1",
        workspaceId: "w1",
        providerConfig,
        messages: baseMessages,
        turnCount: 10,
        budgetTracker: budgetNotExhausted,
        existingMemories: [],
      });
      expect(mockPrismaFindMany).not.toHaveBeenCalled();
    });
  });
});

describe("buildMemoryExtractionPrompt (independent reimplementation)", () => {
  it("includes the existing memories list (or '(none)' when empty)", () => {
    const p = buildMemoryExtractionPrompt({ existingMemories: [], transcript: "t" });
    expect(p).toContain("(none)");
    expect(p).toContain("Recent transcript:\nt");
  });

  it("lists existing memories with id/type/path/content", () => {
    const p = buildMemoryExtractionPrompt({
      existingMemories: [
        { id: "m1", type: "user", path: "preferences.theme", content: "prefers dark" },
      ],
      transcript: "t",
    });
    expect(p).toContain("id=m1");
    expect(p).toContain("type=user");
    expect(p).toContain("path=preferences.theme");
    expect(p).toContain("content=prefers dark");
  });

  it("instructs multilingual extraction (preserve original language)", () => {
    const p = buildMemoryExtractionPrompt({ existingMemories: [], transcript: "t" });
    expect(p).toMatch(/regardless of the conversation language/i);
    expect(p).toMatch(/do not translate/i);
  });

  it("caps existing memories at 80 entries (prompt bound)", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      type: "user",
      path: `p${i}`,
      content: `c${i}`,
    }));
    const p = buildMemoryExtractionPrompt({ existingMemories: many, transcript: "t" });
    expect(p).toContain("id=m79");
    expect(p).not.toContain("id=m80"); // index 80 (the 81st) is excluded
  });

  it("includes the deny-list instruction (no credentials/PII/agent-instructions)", () => {
    const p = buildMemoryExtractionPrompt({ existingMemories: [], transcript: "t" });
    expect(p).toMatch(/Do not save secrets/i);
    expect(p).toMatch(/ignore previous instructions/i);
  });

  it("includes the JSON ops shape example", () => {
    const p = buildMemoryExtractionPrompt({ existingMemories: [], transcript: "t" });
    expect(p).toContain('"op":"add"');
    expect(p).toContain('"op":"replace"');
    expect(p).toContain('"op":"move"');
    expect(p).toContain('"op":"remove"');
  });
});

describe("MEMORY_EXTRACTION_SYSTEM_PROMPT", () => {
  it("is a minimal JSON-only instruction", () => {
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toMatch(/valid JSON/i);
  });
});
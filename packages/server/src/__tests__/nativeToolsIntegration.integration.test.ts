// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 95-04 (D-06) — Native function calling integration tests per reliable
 * model.
 *
 * These tests call REAL provider wire formats (not mocked) with skip-conditional
 * strategy for CI-friendliness. Each suite skips when its env var is absent:
 *  - Ollama qwen2.5  → requires OLLAMA_BASE_URL
 *  - OpenAI          → requires OPENAI_API_KEY
 *  - Anthropic       → requires ANTHROPIC_API_KEY
 *
 * Assertions per D-06: (a) `streamResult.toolCall` is not null, (b)
 * `toolCall.toolName === "rag_search"`, (c) `toolCall.toolInput.query`
 * contains the sent query substring. The tests do NOT assert the RAG result
 * (that is covered by existing RAG tests) — focus is on the native function
 * calling dispatch path.
 *
 * This file matches the `*.integration.test.ts` pattern in
 * `jest.config.integration.js` (real PostgreSQL + per-file worker DB). The
 * provider API keys and OLLAMA_BASE_URL are read from `process.env` directly
 * — they may be in `.env.test` OR the test environment. If absent, the suite
 * skips.
 */
import "./helpers/setupEnv";
import { streamLLM, buildProviderTools, type ChatMessageEntry } from "../agent/llmStreaming";
import type { ProviderConfig } from "@simmetric-chat/shared";

const ollamaAvailable = !!process.env.OLLAMA_BASE_URL;
const openaiAvailable = !!process.env.OPENAI_API_KEY;
const anthropicAvailable = !!process.env.ANTHROPIC_API_KEY;

const SKILLS = [
  {
    name: "rag_search",
    description: "Search the knowledge base for relevant documents by query.",
    // Phase 95-05 (G-95-7/G-95-8 closure): declare the query property in the
    // inputSchema so buildProviderTools emits a parameters/input_schema that
    // OpenAI gpt-4o-mini and Anthropic claude-sonnet-4-5 can populate against
    // (instead of emitting empty {} arguments).
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
      },
      required: ["query"],
    },
  },
];

const MESSAGES: ChatMessageEntry[] = [
  { role: "system", content: "You are a helpful assistant. Use the rag_search tool to find documents when asked to search." },
  { role: "user", content: "Search the knowledge base for information about quantum computing." },
];

const QUERY_SUBSTRING = "quantum";

const TIMEOUT_MS = 60000;

function assertToolCall(
  result: { toolCall: { toolName: string; toolInput: Record<string, unknown> } | null },
): void {
  expect(result.toolCall).not.toBeNull();
  expect(result.toolCall!.toolName).toBe("rag_search");
  const query = result.toolCall!.toolInput.query;
  expect(typeof query).toBe("string");
  expect(query as string).toEqual(expect.stringContaining(QUERY_SUBSTRING));
}

(ollamaAvailable ? describe : describe.skip)("nativeTools integration — Ollama qwen2.5", () => {
  it("emits valid native tool_calls for rag_search query", async () => {
    const config: ProviderConfig = {
      type: "ollama",
      baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      apiKey: null,
      model: "qwen2.5:3b",
      temperature: 0.7,
      nativeToolsReliable: true,
    };
    const tools = buildProviderTools("ollama", SKILLS);
    const result = await streamLLM(MESSAGES, config, () => {}, undefined, tools);
    assertToolCall(result);
  }, TIMEOUT_MS);
});

(openaiAvailable ? describe : describe.skip)("nativeTools integration — OpenAI gpt-4o-mini", () => {
  it("emits valid native tool_calls for rag_search query", async () => {
    const config: ProviderConfig = {
      type: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: process.env.OPENAI_API_KEY!,
      model: "gpt-4o-mini",
      temperature: 0.7,
      nativeToolsReliable: true,
    };
    const tools = buildProviderTools("openai", SKILLS);
    const result = await streamLLM(MESSAGES, config, () => {}, undefined, tools);
    assertToolCall(result);
  }, TIMEOUT_MS);
});

(anthropicAvailable ? describe : describe.skip)("nativeTools integration — Anthropic claude-sonnet-4-5", () => {
  it("emits valid native tool_calls for rag_search query", async () => {
    const config: ProviderConfig = {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: process.env.ANTHROPIC_API_KEY!,
      // Phase 95-05 (G-95-8 secondary defect): replace the retired
      // claude-3-5-sonnet model id (Anthropic 404 not_found_error) with the
      // current available model on the test key. Configurable via
      // ANTHROPIC_MODEL env var so operators can target a different model
      // without code changes.
      model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929",
      temperature: 0.7,
      nativeToolsReliable: true,
    };
    const tools = buildProviderTools("anthropic", SKILLS);
    const result = await streamLLM(MESSAGES, config, () => {}, undefined, tools);
    assertToolCall(result);
  }, TIMEOUT_MS);
});
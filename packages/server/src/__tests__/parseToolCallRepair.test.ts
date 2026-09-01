// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * parseToolCall — jsonrepair fallback for malformed-but-near-valid LLM JSON.
 *
 * Real-world cloud/local models sometimes emit tool calls that are nearly
 * valid JSON but fail strict JSON.parse: unquoted keys, single-quoted
 * strings, trailing commas, truncated closing braces. Before the
 * jsonrepair fallback, these tool calls silently failed — raw JSON was
 * streamed to the user or the agent returned "Non ho trovato informazioni"
 * because the tool was never invoked.
 *
 * jsonrepair was chosen over 12 alternatives per toolcall-parser-library-eval
 * (agent memory): ISC license, zero runtime dependencies, air-gap
 * compatible, ships ESM + CJS + UMD builds.
 *
 * The safety gate (typeof parsed.tool === 'string' AND (inputObj ||
 * topLevelParams.length > 0)) is applied identically on both the happy
 * path and the repair path, so non-tool objects or bare {tool:"x"} payloads
 * remain null even when jsonrepair can repair them.
 */
import "./helpers/setupEnv";

import { parseToolCall } from "../agent/llmStreaming";

describe("parseToolCall — jsonrepair fallback", () => {
  it("happy-path valid JSON — byte-identical (regression)", () => {
    const r = parseToolCall(`{"tool":"rag_search","input":{"query":"x"}}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("x");
  });

  it("unquoted keys — repaired by jsonrepair", () => {
    const r = parseToolCall(`{tool: "rag_search", input: {query: "x"}}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("x");
  });

  it("single-quoted strings — repaired by jsonrepair", () => {
    const r = parseToolCall(`{'tool':'rag_search','input':{'query':'x'}}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("x");
  });

  it("trailing comma — repaired by jsonrepair", () => {
    const r = parseToolCall(`{"tool":"rag_search","input":{"query":"x",}}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("x");
  });

  // NOTE: The plan's "truncated closing braces" test case
  // (`{"tool":"rag_search","input":{"query":"x"` with no closing braces) is
  // unachievable through the public `parseToolCall` API: `extractBalancedJSON`
  // returns null on unbalanced braces, and the plan forbids modifying it
  // (per threat model T-lgq-03, extractBalancedJSON bounds jsonrepair input).
  // The plan's fallback form (`prefix {...`) is also unbalanced and fails the
  // same way. Dropped per Rule 3 (blocking issue); 3 of 4 failure modes are
  // covered (unquoted keys, single quotes, trailing commas — the common
  // real-world deviations). See SUMMARY.md deviation log.

  it("top-level params + unquoted keys on repair path — promoted into toolInput", () => {
    const r = parseToolCall(`{tool: "rag_search", query: "hello"}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("hello");
  });

  it("safety gate on repair path — bare {tool:'x'} returns null", () => {
    // Valid JSON, but no params and no input — not a usable call.
    expect(parseToolCall(`{"tool":"rag_search"}`)).toBeNull();
  });

  it("safety gate on repair path — non-tool object returns null even when repairable", () => {
    // {name:"Alice"} is repairable and parseable, but has no `tool` field.
    expect(parseToolCall(`{"name":"Alice"}`)).toBeNull();
  });

  it("safety gate on repair path — non-string tool via repair returns null", () => {
    // jsonrepair can parse `{tool: 123, query: "x"}` but `tool` is not a string.
    expect(parseToolCall(`{tool: 123, query: "x"}`)).toBeNull();
  });
});
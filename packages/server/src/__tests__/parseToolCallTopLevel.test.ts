// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * parseToolCall — top-level params deviation (cloud models).
 *
 * Cloud models (minimax-m3:cloud, glm-5.1:cloud) often emit the tool params
 * at the top level instead of nested under `input`:
 *   {"tool":"rag_search","query":"..."}            (no `input`)
 *   {"tool":"rag_search","input":{},"query":"..."} (empty `input`)
 * Before the fix these either returned null (tool never invoked, raw JSON
 * streamed to the user) or produced an empty toolInput (query lost → rag_search
 * returns "query parameter is required" → "Non ho trovato informazioni").
 */
import "./helpers/setupEnv";

import { parseToolCall } from "../agent/llmStreaming";

describe("parseToolCall — top-level params deviation", () => {
  it("instructed format {tool, input:{query}} — unchanged", () => {
    const r = parseToolCall(`{"tool":"rag_search","input":{"query":"workspace docs"}}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("workspace docs");
  });

  it("top-level query, NO input — promotes query into toolInput", () => {
    const r = parseToolCall(`{"tool":"rag_search","query":"workspace docs overview"}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("workspace docs overview");
  });

  it("empty input + top-level query — query recovered (was lost → empty toolInput)", () => {
    const r = parseToolCall(`{"tool":"rag_search","input":{},"query":"The Founders Playbook"}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("The Founders Playbook");
  });

  it("multiple top-level params — all promoted", () => {
    const r = parseToolCall(`{"tool":"rag_search","query":"hello","limit":"5"}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("hello");
    // limit is a string here (model-emitted); parseXMLElements does numeric
    // coercion but JSON.parse keeps "5" as string — toolInput preserves it.
    expect(r?.toolInput.limit).toBe("5");
  });

  it("input prevails over top-level for overlapping keys", () => {
    // The instructed `input` wins; top-level fills only the gaps.
    const r = parseToolCall(`{"tool":"rag_search","query":"top","input":{"query":"nested","limit":3}}`);
    expect(r?.toolInput.query).toBe("nested");
    expect(r?.toolInput.limit).toBe(3);
  });

  it("top-level only (no input) — preserves non-query params too (content, filePath)", () => {
    const r = parseToolCall(`{"tool":"document_temp_process","content":"some text","filePath":"/tmp/x.pdf"}`);
    expect(r?.toolName).toBe("document_temp_process");
    expect(r?.toolInput.content).toBe("some text");
    expect(r?.toolInput.filePath).toBe("/tmp/x.pdf");
  });

  it("bare {tool:'x'} with no params — returns null (not a usable call)", () => {
    expect(parseToolCall(`{"tool":"rag_search"}`)).toBeNull();
  });

  it("empty input, no top-level — returns empty toolInput (ReAct loop surfaces 'query required' and retries)", () => {
    // Backward-compat: an explicit empty `input` object still yields a tool
    // call with empty toolInput so the loop can retry, rather than streaming
    // the JSON as text.
    const r = parseToolCall(`{"tool":"rag_search","input":{}}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput).toEqual({});
  });

  it("non-string tool — returns null", () => {
    expect(parseToolCall(`{"tool":123,"query":"x"}`)).toBeNull();
  });

  it("tool call embedded in prose — still extracted (balanced JSON scan)", () => {
    const r = parseToolCall(`Sure, let me search.\n{"tool":"rag_search","query":"x"}`);
    expect(r?.toolName).toBe("rag_search");
    expect(r?.toolInput.query).toBe("x");
  });
});
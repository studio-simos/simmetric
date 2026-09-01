// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * implicitToolCall resolver tests
 *
 * Covers the recovery path for LLMs that ignore the JSON tool-call format
 * and emit a bare XML-ish tag (e.g. Ollama deepseek-v4:pro:cloud →
 * `<search><query>...</query></search>`). The resolver maps the short tag
 * to a registered skill via fuzzy matching and extracts the tool input,
 * so the orchestrator triggers the real skill instead of streaming raw XML.
 */
import "./helpers/setupEnv";

import { matchSkillByName, resolveImplicitToolCall } from "../agent/implicitToolCall";
import type { AgentSkillDefinition } from "../agent/skills";

const SKILLS: AgentSkillDefinition[] = [
  {
    name: "rag_search",
    displayName: "RAG Search",
    description: "Search the workspace knowledge base.",
    type: "builtin",
    execute: jest.fn(),
  },
  {
    name: "workspace_memory",
    displayName: "Workspace Memory",
    description: "Read/write workspace-scoped key-value pairs.",
    type: "builtin",
    execute: jest.fn(),
  },
  {
    name: "wiki_query",
    displayName: "Wiki Query",
    description: "Query the wiki.",
    type: "builtin",
    execute: jest.fn(),
  },
];

describe("matchSkillByName", () => {
  it("exact match (case-insensitive)", () => {
    expect(matchSkillByName("rag_search", SKILLS)?.name).toBe("rag_search");
    expect(matchSkillByName("RAG_SEARCH", SKILLS)?.name).toBe("rag_search");
  });

  it("endsWith _<tag> — `search` → rag_search", () => {
    expect(matchSkillByName("search", SKILLS)?.name).toBe("rag_search");
  });

  it("endsWith _<tag> — `memory` → workspace_memory", () => {
    expect(matchSkillByName("memory", SKILLS)?.name).toBe("workspace_memory");
  });

  it("endsWith _<tag> — `query` → wiki_query", () => {
    expect(matchSkillByName("query", SKILLS)?.name).toBe("wiki_query");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchSkillByName("weather", SKILLS)).toBeUndefined();
  });

  it("does NOT loose-match — short tag `a` must not match rag_search (no includes fallback)", () => {
    expect(matchSkillByName("a", SKILLS)).toBeUndefined();
    expect(matchSkillByName("ra", SKILLS)).toBeUndefined();
  });
});

describe("resolveImplicitToolCall", () => {
  it("deepseek-v4:pro:cloud shape — <search><query>...</query></search> → rag_search", () => {
    const content = `<search> <query>workspace memory documents metadata</query> </search>`;
    const resolved = resolveImplicitToolCall(content, SKILLS);
    expect(resolved).not.toBeNull();
    expect(resolved?.toolName).toBe("rag_search");
    expect(resolved?.toolInput.query).toBe("workspace memory documents metadata");
  });

  it("single-arg fallback — <search>plain text query</search> → query from inner text", () => {
    const resolved = resolveImplicitToolCall(`<search>summarize the documents</search>`, SKILLS);
    expect(resolved?.toolName).toBe("rag_search");
    expect(resolved?.toolInput.query).toBe("summarize the documents");
  });

  it("exact-tag shape — <rag_search><query>x</query></rag_search>", () => {
    const resolved = resolveImplicitToolCall(`<rag_search><query>x</query></rag_search>`, SKILLS);
    expect(resolved?.toolName).toBe("rag_search");
    expect(resolved?.toolInput.query).toBe("x");
  });

  it("`query` short tag resolves to wiki_query (endsWith _query) — query param from inner text", () => {
    const resolved = resolveImplicitToolCall(`<query>something</query>`, SKILLS);
    expect(resolved?.toolName).toBe("wiki_query");
    expect(resolved?.toolInput.query).toBe("something");
  });

  it("whole-content gate — prose wrapping a tag is NOT treated as a tool call", () => {
    // Starts with `<` but the tag does not wrap the whole content → null.
    const resolved = resolveImplicitToolCall(
      `Sure, let me search: <search><query>x</query></search> and respond.`,
      SKILLS
    );
    expect(resolved).toBeNull();
  });

  it("no surrounding prose but unmatched skill tag → null", () => {
    const resolved = resolveImplicitToolCall(`<weather><city>Rome</city></weather>`, SKILLS);
    expect(resolved).toBeNull();
  });

  it("empty skills list → null (no skill to route to)", () => {
    const resolved = resolveImplicitToolCall(`<search><query>x</query></search>`, []);
    expect(resolved).toBeNull();
  });

  it("content not starting with `<` → null", () => {
    expect(resolveImplicitToolCall("Just a plain answer.", SKILLS)).toBeNull();
  });

  it("tag with no inner content and no child element → null (nothing to pass)", () => {
    expect(resolveImplicitToolCall(`<search></search>`, SKILLS)).toBeNull();
  });

  it("multiple child params populate toolInput", () => {
    const resolved = resolveImplicitToolCall(
      `<search><query>hello</query><limit>5</limit></search>`,
      SKILLS
    );
    expect(resolved?.toolName).toBe("rag_search");
    expect(resolved?.toolInput.query).toBe("hello");
    expect(resolved?.toolInput.limit).toBe(5);
  });

  it("whitespace-only inner text without child element → null", () => {
    expect(resolveImplicitToolCall(`<search>   </search>`, SKILLS)).toBeNull();
  });
});
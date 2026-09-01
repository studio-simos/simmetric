// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Implicit tool-call resolution.
 *
 * Recovery path for LLMs that ignore the JSON tool-call format instructed in
 * the system prompt and emit a generic XML-ish tag instead — e.g. Ollama
 * `deepseek-v4:pro:cloud` produces:
 *
 *   <search><query>workspace memory documents metadata</query></search>
 *
 * instead of:
 *
 *   {"tool":"rag_search","input":{"query":"workspace memory documents metadata"}}
 *
 * `parseToolCall` (in llmStreaming) only recognises structured formats
 * (plain JSON, code-fenced JSON, `<function-calls><invoke ...>`,
 * `<tool_call name=...>`, bracket, plain-text+JSON). A bare
 * `<tagname>...</tagname>` block slips through as plain text and would be
 * streamed raw to the user. These helpers resolve that block to a real tool
 * call so the actual skill runs and the raw XML never reaches the client.
 *
 * The module is pure (no I/O, no logging) so it can be unit-tested without
 * the orchestrator's heavy dependencies.
 */
import type { AgentSkillDefinition } from "./skills";
import { parseXMLElements } from "./llmStreaming";

/**
 * Match a free-form tool tag name (emitted by the model) to a registered
 * skill. The tag name rarely equals the skill name exactly (models shorten
 * it — `rag_search` → `search`), so we match progressively:
 *   1. exact (case-insensitive)
 *   2. skill name ends with `_<tag>` (rag_search endsWith _search,
 *      workspace_memory endsWith _memory, wiki_query endsWith _query)
 * We intentionally do NOT use a loose `includes` fallback: a short tag like
 * `a` or `ra` would match `rag_search` and misroute unrelated XML (e.g. an
 * HTML `<a>` link) to a skill. exact + endsWith-`_<tag>` covers every real
 * short-tag emission while staying strict.
 * Returns the first matching skill or undefined.
 */
export function matchSkillByName(
  tag: string,
  skills: AgentSkillDefinition[]
): AgentSkillDefinition | undefined {
  const t = tag.toLowerCase();
  const idx = skills.findIndex((s) => s.name.toLowerCase() === t);
  if (idx >= 0) return skills[idx];
  const idxEndsWith = skills.findIndex((s) => s.name.toLowerCase().endsWith(`_${t}`));
  if (idxEndsWith >= 0) return skills[idxEndsWith];
  return undefined;
}

/**
 * Resolve an "implicit" tool call from content that `parseToolCall` did NOT
 * recognise — i.e. a generic `<toolname><param>value</param></toolname>`
 * block where the tag name is the (possibly shortened) tool name.
 *
 * Safety gate (avoids misrouting legitimate prose that happens to start with
 * `<`): the trimmed content MUST start with the opening tag AND end with the
 * matching closing tag — i.e. the whole content IS the tool call, with no
 * surrounding prose. The tag must fuzzy-match a registered skill via
 * `matchSkillByName`. Child elements become the tool input (reusing
 * `parseXMLElements`); if there are no child elements, the inner text is used
 * as the `query` param (the common single-arg shape for rag_search/wiki_query).
 *
 * Returns `{ toolName, toolInput }` or null when the content is not an
 * implicit tool call.
 */
export function resolveImplicitToolCall(
  content: string,
  skills: AgentSkillDefinition[]
): { toolName: string; toolInput: Record<string, unknown> } | null {
  if (skills.length === 0) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("<")) return null;

  // Opening tag: <tagname> or <tagname > (no attributes — the model's format
  // uses bare tags). Require the tag name to fuzzy-match a skill before we
  // even look for a closing tag, so unrelated XML never triggers this.
  const openMatch = trimmed.match(/^<([a-zA-Z_][a-zA-Z0-9_-]*)\s*>/);
  if (!openMatch || !openMatch[1]) return null;
  const tag = openMatch[1];
  const skill = matchSkillByName(tag, skills);
  if (!skill) return null;

  const closeTag = `</${tag}>`;
  // Whole-content gate: the tag must wrap the entire trimmed content.
  if (!trimmed.endsWith(closeTag)) return null;

  const innerStart = openMatch[0].length;
  const inner = trimmed.slice(innerStart, trimmed.length - closeTag.length);
  const toolInput = parseXMLElements(inner);
  // Single-arg fallback: <search>some query</search> (no child element) →
  // treat the inner text as the query param.
  if (Object.keys(toolInput).length === 0) {
    const text = inner.trim();
    if (text) toolInput.query = text;
  }
  if (Object.keys(toolInput).length === 0) return null;

  return { toolName: skill.name, toolInput };
}
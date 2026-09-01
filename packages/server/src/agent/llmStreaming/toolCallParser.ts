// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Tool call parsing — L3 text-parsing fallback for tool invocation.
// Extracted from the original llmStreaming.ts god-file (Phase 158 / CSW-13).
// Pure parsing functions — no cross-module imports except jsonrepair.

import { jsonrepair } from "jsonrepair";

/**
 * Parse a tool call from the LLM response.
 *
 * Handles six formats:
 * 1. Standard: {"tool": "tool_name", "input": {...}}
 * 2. Code-fenced: ```json\n{"tool": "...", ...}\n``` or ```tool_name\n{...}\n```
 * 3a. XML function-calls (DeepSeek native): <function-calls><invoke name="t"><parameter name="k">v</parameter></invoke></function-calls>
 * 3b. XML tool_call (fine-tuned models): <tool_call name="t"><input><k>v</k></input></tool_call>
 * 4. Bracket notation: [tool_name] {json_input} or [调用 tool_name] {json_input}
 * 5. Plain text followed by JSON tool call (some models explain before acting)
 */
export function parseToolCall(text: string): { toolName: string; toolInput: Record<string, unknown> } | null {
  // Format 3a: XML function-calls — <function-calls><invoke name="tool"><parameter name="k">v</parameter></invoke></function-calls>
  // DeepSeek models (deepseek-v4-pro, etc.) use this as their native function-calling format.
  const fcResult = tryParseFunctionCallsXML(text);
  if (fcResult) return fcResult;

  // Format 3b: XML tool_call — <tool_call name="tool_name"><input><key>value</key></input></tool_call>
  // Some fine-tuned models use this alternative XML format.
  const xmlResult = tryParseXMLToolCall(text);
  if (xmlResult) return xmlResult;

  // Format 2: Code-fenced JSON — ```json\n{...}\n``` or ```tool_name\n{...}\n```
  const fenceMatch = text.match(/```(?:json\s*\n?)?([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    const result = tryParseJSONToolCall(inner);
    if (result) return result;
  }

  // Format 1 & 5: Extract the first balanced JSON object containing "tool" and "input" keys.
  const jsonResult = tryParseJSONToolCall(text);
  if (jsonResult) return jsonResult;

  // Format 4: Bracket notation [调用 tool_name] {json_input} or [tool_name] {json_input}
  const bracketMatch = text.match(/\[(?:调用\s+)?([a-z][a-z0-9]*_[a-z0-9_]*)\]\s*/);
  if (bracketMatch && bracketMatch.index !== undefined && bracketMatch[1]) {
    const toolName = bracketMatch[1];
    const startFrom = bracketMatch.index + bracketMatch[0].length;
    const jsonStr = extractBalancedJSON(text, startFrom);
    if (jsonStr) {
      try {
        const toolInput = JSON.parse(jsonStr);
        if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
          return { toolName, toolInput: toolInput as Record<string, unknown> };
        }
      } catch {
        // Not valid JSON
      }
    }
  }

  return null;
}

/**
 * Try to parse an XML-format tool call: <tool_call name="tool_name">...</tool_call>
 * DeepSeek models output this format with nested <input><key>value</key></input> elements.
 */
function tryParseXMLToolCall(text: string): { toolName: string; toolInput: Record<string, unknown> } | null {
  const match = text.match(/<tool_call\s+name\s*=\s*"([^"]+)"\s*>/);
  if (!match || !match[1]) return null;

  const toolName = match[1];
  const startIdx = (match.index ?? 0) + match[0].length;
  const endTag = "</tool_call>";
  const endIdx = text.indexOf(endTag, startIdx);
  if (endIdx === -1) return null;

  const inner = text.substring(startIdx, endIdx);
  const toolInput = parseXMLElements(inner);

  return { toolName, toolInput };
}

/**
 * Parse simple XML elements like <input><key1>value1</key1><key2>value2</key2></input>
 * into a flat Record<string, unknown>. Handles string and numeric values.
 */
export function parseXMLElements(xml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Match self-contained elements: <key>value</key> or <key />
  const tagRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xml)) !== null) {
    const key = match[1]!;
    let value: unknown = match[2]!.trim();

    // Convert numeric strings
    if (/^-?\d+$/.test(value as string)) {
      value = parseInt(value as string, 10);
    } else if (/^-?\d+\.\d+$/.test(value as string)) {
      value = parseFloat(value as string);
    } else if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    }
    // Keep as is for strings (including empty and null)

    result[key] = value;
  }

  return result;
}

/**
 * Try to parse the DeepSeek function-calls XML format:
 *   <function-calls>
 *     <invoke name="tool_name">
 *       <parameter name="key">value</parameter>
 *     </invoke>
 *   </function-calls>
 *
 * Also handles the variant without the wrapping <function-calls> element.
 */
function tryParseFunctionCallsXML(text: string): { toolName: string; toolInput: Record<string, unknown> } | null {
  // Find <invoke name="tool_name"> — may be wrapped in <function-calls> or standalone
  const invokeMatch = text.match(/<invoke\s+name\s*=\s*"([^"]+)"\s*>/);
  if (!invokeMatch) return null;

  const toolName = invokeMatch[1];
  const startIdx = invokeMatch.index! + invokeMatch[0].length;
  const endTag = "</invoke>";
  const endIdx = text.indexOf(endTag, startIdx);
  if (endIdx === -1) return null;

  const inner = text.substring(startIdx, endIdx);

  // Parse <parameter name="key">value</parameter> elements
  const toolInput: Record<string, unknown> = {};
  const paramRegex = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
  let paramMatch: RegExpExecArray | null;

  while ((paramMatch = paramRegex.exec(inner)) !== null) {
    const key = paramMatch[1]!;
    if (!paramMatch[2]) continue;
    let value: unknown = paramMatch[2]!.trim();

    if (/^-?\d+$/.test(value as string)) {
      value = parseInt(value as string, 10);
    } else if (/^-?\d+\.\d+$/.test(value as string)) {
      value = parseFloat(value as string);
    } else if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    }

    toolInput[key] = value;
  }

  return { toolName: toolName!, toolInput };
}

/**
 * Try to find and parse the first balanced JSON object in `text` as a tool call.
 *
 * Accepts the instructed format `{"tool": "...", "input": {...}}` AND a common
 * deviation from cloud models that put the parameters at the top level instead
 * of nested under `input`, e.g. `{"tool": "rag_search", "query": "..."}` or
 * `{"tool": "rag_search", "input": {}, "query": "..."}`. Without this, such
 * payloads either returned null (no `input` → tool never invoked, raw JSON
 * streamed to the user) or produced an empty `toolInput` (query lost →
 * rag_search returns "query parameter is required" → "Non ho trovato
 * informazioni").
 *
 * When `input` is present and is an object, it prevails over top-level params
 * for overlapping keys (it is the instructed format); top-level params fill
 * the gaps for keys `input` omits.
 */
function tryParseJSONToolCall(text: string): { toolName: string; toolInput: Record<string, unknown> } | null {
  const openIdx = text.indexOf("{");
  if (openIdx === -1) return null;

  const jsonStr = extractBalancedJSON(text, openIdx);
  if (!jsonStr) return null;

  // Build a tool call from a parsed object, applying the safety gate:
  // `tool` must be a string AND there must be either an `input` object or
  // top-level params. A bare `{"tool":"x"}` is not a usable call.
  const buildToolCall = (parsed: any): { toolName: string; toolInput: Record<string, unknown> } | null => {
    if (typeof parsed.tool !== "string") return null;

    // Collect parameters the model emitted at the top level (everything
    // except the meta keys `tool` and `input`).
    const topLevelParams: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      if (key !== "tool" && key !== "input") {
        topLevelParams[key] = parsed[key];
      }
    }
    const inputObj =
      parsed.input && typeof parsed.input === "object"
        ? (parsed.input as Record<string, unknown>)
        : null;

    // Return a tool call when there is ANY input — an explicit `input`
    // object (even empty, preserving prior behaviour so the ReAct loop can
    // surface a "query parameter is required" error and retry) OR top-level
    // params. A bare `{"tool":"x"}` with nothing else is not a usable call.
    if (inputObj || Object.keys(topLevelParams).length > 0) {
      const toolInput = { ...topLevelParams, ...(inputObj ?? {}) };
      return { toolName: parsed.tool, toolInput };
    }
    return null;
  };

  // Happy path: strict JSON.parse first (zero behavior drift on valid input).
  try {
    return buildToolCall(JSON.parse(jsonStr));
  } catch {
    // Not valid JSON — try jsonrepair fallback below.
  }

  // Fallback: jsonrepair rescues malformed-but-near-valid LLM JSON (unquoted
  // keys, single quotes, trailing commas, truncated braces). The safety gate
  // in buildToolCall still applies, so non-tool objects or bare {tool:"x"}
  // remain null even when repairable.
  try {
    return buildToolCall(JSON.parse(jsonrepair(jsonStr)));
  } catch {
    // Not repairable — caller may try the next `{` if applicable
  }

  return null;
}

/**
 * Extract a balanced JSON object string starting at `startFrom` position.
 * Counts opening/closing braces to find the matching closing brace.
 * Returns null if no JSON object is found.
 */
function extractBalancedJSON(text: string, startFrom: number): string | null {
  // Find the first '{' after startFrom
  const openIdx = text.indexOf("{", startFrom);
  if (openIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.substring(openIdx, i + 1);
      }
    }
  }

  return null; // Unbalanced braces
}

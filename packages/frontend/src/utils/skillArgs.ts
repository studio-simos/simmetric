// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-02, D-09) — /slug invocation argument grammar.
 *
 * Pure client-side convenience parse of the text after "/slug " into the
 * structured `params` the skillCall transport carries. The server NEVER
 * trusts this parse (T-190-24): Plan 03's resolveSkillCallForAgent
 * re-resolves the slug/scope and re-validates params via skillCallSchema —
 * the client parse is UX sugar so the user gets immediate feedback.
 *
 * Grammar (D-09):
 *  - tokenize on unquoted whitespace; double-quoted spans may contain spaces
 *    and escaped quotes (\");
 *  - `key=value` tokens (value optionally quoted) fill the named field when
 *    the key exists in inputSchema.properties — unknown keys are ignored
 *    (the server schema re-validates);
 *  - bare positional tokens accumulate into the FIRST required field of
 *    inputSchema.required, joined with single spaces;
 *  - zero args → every required field takes defaultParams[key]; a required
 *    field missing both a value and a default → missing-required;
 *  - empty argsText with zero required fields → ok with {} (zero-placeholder
 *    skills are invocable bare).
 */

export interface SkillArgsInputSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

export type ParseSkillArgsResult =
  | { ok: true; params: Record<string, string> }
  | { ok: false; error: "missing-required" };

interface Token {
  kind: "positional" | "pair";
  /** positional: the raw text (quotes already stripped); pair: the key. */
  key?: string;
  /** positional: the raw text; pair: the (unquoted) value. */
  value: string;
}

/**
 * Tokenize on unquoted whitespace. A double-quoted span may contain spaces
 * and escaped quotes (\"); the surrounding quotes are stripped and \" becomes
 * ". A token whose text starts with `key=` (outside quotes) is a pair.
 */
function tokenize(argsText: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let inQuotes = false;
  let quoteStartedCurrentToken = false;
  let hasContent = false;

  const flush = () => {
    if (!hasContent && !quoteStartedCurrentToken) return;
    const text = current.trim();
    if (text.length === 0 && !quoteStartedCurrentToken) return;
    const eq = text.indexOf("=");
    if (eq > 0 && !quoteStartedCurrentToken) {
      tokens.push({ kind: "pair", key: text.slice(0, eq), value: text.slice(eq + 1) });
    } else {
      tokens.push({ kind: "positional", value: text });
    }
    current = "";
    quoteStartedCurrentToken = false;
    hasContent = false;
  };

  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (inQuotes) {
      if (ch === "\\" && argsText[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      current += ch;
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      // Only a quote at TOKEN START makes the whole token positional (a
      // `"a=b"` span never splits on =). A quote after `key=` opens the
      // pair's quoted value — the key= split still applies at flush.
      quoteStartedCurrentToken = current.length === 0;
      hasContent = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      flush();
      continue;
    }
    current += ch;
    hasContent = true;
  }
  flush();
  return tokens;
}

/**
 * Parse the argument text after "/slug " against the skill's inputSchema +
 * defaultParams. Never throws — malformed params surface as
 * { ok: false, error: "missing-required" } so the caller can show the D-09
 * chat-level notice instead of sending.
 */
export function parseSkillArgs(
  argsText: string,
  inputSchema: SkillArgsInputSchema,
  defaultParams: Record<string, string>,
): ParseSkillArgsResult {
  const properties = inputSchema.properties ?? {};
  const required = inputSchema.required ?? [];
  const params: Record<string, string> = {};
  const positional: string[] = [];

  for (const token of tokenize(argsText ?? "")) {
    if (token.kind === "pair" && token.key !== undefined && token.key in properties) {
      params[token.key] = token.value;
    } else if (token.kind === "positional") {
      positional.push(token.value);
    }
  }

  if (positional.length > 0 && required.length > 0) {
    // All positional text joins (single spaces) into the FIRST required field.
    params[required[0] as string] = positional.join(" ");
  }

  for (const key of required) {
    if (key in params) continue;
    const fallback = defaultParams?.[key];
    if (fallback !== undefined) {
      params[key] = fallback;
    } else {
      return { ok: false, error: "missing-required" };
    }
  }

  return { ok: true, params };
}
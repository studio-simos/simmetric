// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 97 (MEM-03 SC3) — 7-locale eval harness fixture loader.
 *
 * Reads every JSON fixture under the eval/locales directory tree and returns
 * a typed array. Used by evalHarness.test.ts (offline regression) and
 * evalHarness.live.ts (opt-in live LLM run).
 */

import * as fs from "fs";
import * as path from "path";

export type EvalCategory =
  | "add_preference"
  | "replace_preference"
  | "move_path"
  | "remove_info"
  | "one_off_activity"
  | "deny_credentials"
  | "deny_pii"
  | "deny_agent_instruction"
  | "dedup"
  | "mixed_language"
  | "non_latin_script"
  | "no_memory_signal";

export type EvalLocale = "en" | "it" | "ru" | "de" | "fr" | "es" | "zh";

export interface EvalFixture {
  id: string;
  locale: EvalLocale;
  category: EvalCategory;
  transcript: { role: "user" | "assistant"; content: string }[];
  existingMemories: { id: string; type: string; path: string | null; content: string }[];
  expectedOps: Array<{
    op: "add" | "replace" | "move" | "remove";
    type?: string;
    path?: string | null;
    content?: string;
    id?: string;
    sensitivity?: string;
  }>;
  expectedDenyList: boolean;
  notes?: string;
}

const EVAL_DIR = path.join(__dirname, "..", "memory", "eval", "locales");

/** Load all eval fixtures from the locales directory tree. */
export function loadAllFixtures(): EvalFixture[] {
  const fixtures: EvalFixture[] = [];
  if (!fs.existsSync(EVAL_DIR)) return fixtures;
  for (const locale of fs.readdirSync(EVAL_DIR)) {
    const localeDir = path.join(EVAL_DIR, locale);
    if (!fs.statSync(localeDir).isDirectory()) continue;
    for (const file of fs.readdirSync(localeDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const fullPath = path.join(localeDir, file);
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as EvalFixture;
      // Normalize + validate minimal shape.
      if (!raw.id || !raw.locale || !raw.category || !Array.isArray(raw.transcript)) {
        continue;
      }
      fixtures.push(raw);
    }
  }
  return fixtures;
}

/** Group fixtures by locale for per-locale precision reporting. */
export function groupByLocale(fixtures: EvalFixture[]): Record<string, EvalFixture[]> {
  const out: Record<string, EvalFixture[]> = {};
  for (const f of fixtures) {
    if (!out[f.locale]) out[f.locale] = [];
    out[f.locale]!.push(f);
  }
  return out;
}

/** Group fixtures by category for category-level metric reporting. */
export function groupByCategory(fixtures: EvalFixture[]): Record<string, EvalFixture[]> {
  const out: Record<string, EvalFixture[]> = {};
  for (const f of fixtures) {
    if (!out[f.category]) out[f.category] = [];
    out[f.category]!.push(f);
  }
  return out;
}
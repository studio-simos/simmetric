// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Zero-dependency root .env loader (Phase 177 follow-up cleanup).
 *
 * The repo-root `.env` is THE single runtime config for all Node services.
 * The per-package `.env` legacy override layer was removed: this loader
 * reads ONLY the root file (marker-walk discovery) and fills keys absent
 * from `process.env`.
 *
 * Precedence (LOCKED): process.env (never overwritten) > root .env > Zod
 * default. Presence — never truthiness — defines a key; `KEY=`
 * (present-but-empty) counts as DEFINED.
 *
 * Zero dependencies: node:fs + node:path ONLY. Never a third-party parser
 * import into shared (the frontend aliases this barrel's SOURCE into the
 * browser graph; a value-import from the browser would drag node:fs into
 * the bundle — guarded by loadEnv.test.ts browser-barrel guard test).
 *
 * Security: metadata and ALL log output carry file paths + key NAMES
 * exclusively — NEVER env values. The loader never throws and never calls
 * process.exit (fail-loud is reserved for the per-package Zod schemas,
 * which stay untouched). Missing marker is a graceful no-op: `rootPath:
 * null` means skip the merge entirely (Tauri packaged layout has no
 * pnpm-workspace.yaml by design — containers receive env via compose).
 */

import fs from "node:fs";
import path from "node:path";

/** Root marker file: unique to the repo root — nested packages never carry it. */
const REPO_ROOT_MARKER = "pnpm-workspace.yaml";

/** Per-file parse result: keys/names only is the loader's entire metadata flow. */
interface ParsedEnvFile {
  /** Keys present in the file (values stored transiently, never exported/logged). */
  keys: string[];
  /** Parsed KEY → VALUE map (values live ONLY here; never logged or returned). */
  values: Record<string, string>;
}

export interface RootEnvResult {
  /** Resolved repo root (marker-walk hit) or null when no marker exists. */
  rootPath: string | null;
  /** Root .env absolute path that was consulted. */
  envPath: string;
  /** Key NAMES applied from the root file (absent in process.env). */
  rootApplied: string[];
  /** Root-file key names skipped because process.env already had them. */
  skipped: string[];
}

/** Locate the repo root by walking up until the marker file appears. */
export function findRepoRoot(fromDir: string): string | null {
  let cur = path.resolve(fromDir);
  while (true) {
    if (fs.existsSync(path.join(cur, REPO_ROOT_MARKER))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null; // filesystem root — no marker anywhere
    cur = parent;
  }
}

/**
 * The root .env path a caller should reference in diagnostics (the same
 * file loadRootEnv consults). Falls back to a cwd-adjacent `.env` when no
 * marker exists up-chain (Tauri packaged layout) — the load itself is a
 * graceful no-op there, but diagnostics still need a printable path.
 */
export function resolveRootEnvPath(fromDir: string): string {
  const rootPath = findRepoRoot(fromDir);
  if (rootPath !== null) return path.join(rootPath, ".env");
  return path.resolve(fromDir, "../../.env");
}

/**
 * Minimal .env parser: trimmed KEY=VALUE lines, `#` whole-line comments,
 * optional `export ` prefix, value quoted with one matching single/double
 * pair gets stripped (inner whitespace preserved). No multiline, no ${VAR}
 * expansion (verified unused across all real repo env files). `KEY=` stores
 * an EMPTY string as a DEFINED value (existence — not truthiness — governs
 * merges). Missing/unreadable file → empty map (never an error, never a
 * throw).
 */
function parseEnvFile(filePath: string): ParsedEnvFile {
  const out: ParsedEnvFile = { keys: [], values: {} };
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return out;
    raw = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
  } catch {
    // Unreadable file (permissions, IO error): graceful skip — never crash boot.
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const stmt = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const eq = stmt.indexOf("=");
    if (eq <= 0) continue; // no '=' at all, or empty key
    const key = stmt.slice(0, eq).trim();
    if (!key) continue;
    const rawValue = stmt.slice(eq + 1).trim();
    // An empty value (KEY=) counts as DEFINED.
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue;
    out.keys.push(key);
    out.values[key] = value;
  }
  return out;
}

/** set-if-undefined applied to process.env. Applied/skipped name lists fill in-place. */
function applyMap(
  parsed: ParsedEnvFile,
  applied: string[],
  skipped: string[],
): void {
  for (const key of parsed.keys) {
    const value = parsed.values[key];
    if (value === undefined) continue;
    if (key in process.env) {
      // Never override existing process.env — record the skip, don't touch.
      skipped.push(key);
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }
}

/**
 * Load the repo-root `.env` into process.env (fills only absent keys).
 * Idempotent per call site: nothing already in `process.env` is ever
 * overwritten.
 */
export function loadRootEnv(
  fromDir: string,
  opts?: { envRoot?: string },
): RootEnvResult {
  const rootPath = opts?.envRoot ? path.resolve(opts.envRoot) : findRepoRoot(fromDir);
  const envPath = rootPath !== null ? path.join(rootPath, ".env") : resolveRootEnvPath(fromDir);
  const rootParsed =
    rootPath !== null ? parseEnvFile(envPath) : { keys: [], values: {} };

  const result: RootEnvResult = {
    rootPath,
    envPath,
    rootApplied: [],
    skipped: [],
  };

  const rootAppliedNames: string[] = [];
  const rootSkippedNames: string[] = [];
  applyMap(rootParsed, rootAppliedNames, rootSkippedNames);
  result.rootApplied = rootAppliedNames;
  result.skipped = rootSkippedNames;

  // Silent-success policy — debug log on normal resolution: paths and
  // per-file applied-key COUNTS only (never values).
  console.debug(
    `[loadEnv] root discovery: ${rootPath ?? "not found (graceful skip)"}; ` +
      `root .env: ${envPath}`,
  );
  console.debug(
    `[loadEnv] applied keys — root:${result.rootApplied.length} skipped:${result.skipped.length}`,
  );

  return result;
}
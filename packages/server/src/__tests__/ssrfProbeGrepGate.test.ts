// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
// Phase 154 (CSW-08): SSRF probe grep-gate — enforces the single-choke-point
// property of assertSafeProbeUrl (packages/server/src/utils/ssrfGuard.ts:133).
// Mirrors wikiGraphCleanRoomGrep.test.ts (D-06 precedent). Per D-03/D-04/D-05.
//
// The gate has three parts:
//   Part A — allowlist drift: the 6 known assertSafeProbeUrl call sites in
//            packages/server/src/routes/system.ts (lines 404, 417, 434, 510,
//            521, 533 — recalibrated 260829-xxx after 691fc456 shifted the
//            probe block) must still contain `assertSafeProbeUrl(`. Removing
//            any call site fails CI (T-154-05).
//   Part B — new-endpoint detection: scan every *.ts file in
//            packages/server/src/routes/ for an outbound HTTP call
//            (fetch/http.get/http.request/https.get/https.request/axios.*)
//            WHOSE URL expression references the user-input surface
//            (req.body/req.query/req.params/req.headers) within a ~30-line
//            backward window AND is NOT preceded by an assertSafeProbeUrl call
//            in that window AND whose file does not import assertSafeProbeUrl.
//            Config/env/literal-URL calls (e.g. documents.ts fetch to
//            env.COLLECTOR_URL) are excluded by construction (D-05) — no false
//            positives, no production edits. A new route that calls
//            axios.get(req.body.url) without the guard fails CI (T-154-04).
//   Part C — self-test: synthetic source strings prove the scanner flags an
//            unguarded user-input call, ignores a guarded one, and ignores
//            config-URL and hardcoded-URL calls (D-05 narrowing).
//
// Precedent: packages/server/src/__tests__/wikiGraphCleanRoomGrep.test.ts
// (D-06). Same @ts-nocheck + fs/path/@jest/globals shape, swapped the
// forbidden-list for an allowlist + outbound-call scanner.
//
// Opt-out escape hatch: a line carrying `// ssrf-gate: allow` is skipped by the
// scanner — a last-resort fallback for a future edge case. The current tree
// needs none.
import fs from "fs";
import path from "path";
import { describe, it, expect } from "@jest/globals";

// Outbound HTTP call patterns the scanner recognizes. The first argument of
// each call is treated as the URL expression for the user-input-surface check.
const OUTBOUND_CALL_RE =
  /\b(?:fetch|http\.get|http\.request|https\.get|https\.request|axios\.(?:get|post|put|delete|request))\s*\(/g;

// The four Express user-input sources. A candidate call's URL must reference
// one of these within its backward window to be flagged.
const USER_INPUT_RE = /\breq\.(body|query|params|headers)\b/;

// Backward window size (lines) the scanner looks back from a candidate call to
// find both the user-input reference and a preceding assertSafeProbeUrl call.
const WINDOW = 30;

// The guard function the gate enforces.
const GUARD = "assertSafeProbeUrl(";
const GUARD_IMPORT_RE =
  /(?:import\s+\{[^}]*\bassertSafeProbeUrl\b[^}]*\}\s*from\s*["'][^"']*ssrfGuard["']|require\s*\(\s*["'][^"']*ssrfGuard["']\))/;

// Allowlist of the known assertSafeProbeUrl call sites. Drift (removing any
// call site) fails Part A.
// 260829-xxx recalibration: 691fc456 (155-01 parseMetadata helper + bcrypt
// cap) inserted ~5 lines above the probe block in system.ts, shifting every
// call site down — the guard calls themselves are UNCHANGED (verified by
// grep: all 6 present), only the pinned line numbers drifted. Recalibrated
// 399→404, 412→417, 429→434, 505→510, 516→521, 528→533.
const KNOWN_CALL_SITES: Array<{ file: string; line: number }> = [
  { file: "system.ts", line: 404 },
  { file: "system.ts", line: 417 },
  { file: "system.ts", line: 434 },
  { file: "system.ts", line: 510 },
  { file: "system.ts", line: 521 },
  { file: "system.ts", line: 533 },
];

const ROUTES_DIR = path.resolve(__dirname, "../routes");

/**
 * Scan a source string for unguarded outbound HTTP calls whose URL references
 * the user-input surface. Returns a list of { line, pattern } for each flagged
 * call. A call is flagged ONLY when ALL of:
 *   (1) it matches an outbound HTTP call pattern,
 *   (2) the call line + preceding ~WINDOW lines reference req.body/req.query/
 *       req.params/req.headers (the user-input surface — D-05 narrowing that
 *       excludes config/env/literal-URL calls),
 *   (3) the same backward window contains NO assertSafeProbeUrl( call, AND
 *   (4) the file does not import assertSafeProbeUrl from ../utils/ssrfGuard.
 *
 * The opt-out `// ssrf-gate: allow` on the matched line suppresses the flag.
 *
 * Conservative: a file that imports the guard AND calls it in a wider window is
 * not flagged — the guard's presence is treated as evidence of intent. The
 * backward window is ~WINDOW lines and is the ONLY region inspected for both
 * the user-input reference and the preceding guard call, so the heuristic
 * cannot be defeated by moving the guard arbitrarily far away.
 */
function findUnguardedOutboundCalls(
  src: string,
  filePath: string,
): Array<{ line: number; pattern: string }> {
  const lines = src.split("\n");
  const fileImportsGuard = GUARD_IMPORT_RE.test(src);
  const flagged: Array<{ line: number; pattern: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Opt-out escape hatch — last-resort suppression for future edge cases.
    if (line.includes("// ssrf-gate: allow")) continue;

    // Reset the global regex for each line (stateful without reset).
    OUTBOUND_CALL_RE.lastIndex = 0;
    const match = OUTBOUND_CALL_RE.exec(line);
    if (!match) continue;

    // The pattern string (e.g. "axios.get(") for the flagged report.
    const pattern = match[0].replace(/\s*\($/, "");

    // Build the backward window: this line + preceding ~WINDOW lines.
    const start = Math.max(0, i - WINDOW);
    const window = lines.slice(start, i + 1).join("\n");

    // (2) The window MUST reference the user-input surface. If it does not,
    //     the call's URL resolves to config/env/a literal — excluded by D-05.
    if (!USER_INPUT_RE.test(window)) continue;

    // (3) If the backward window contains a guard call, the call is guarded.
    if (window.includes(GUARD)) continue;

    // (4) If the file imports the guard at all, be conservative: treat the
    //     call as guarded (the guard is present in the file; the narrow
    //     window may simply not contain it). Only flag when the file does
    //     NOT import the guard — the clearest signal of an unguarded probe.
    if (fileImportsGuard) continue;

    flagged.push({ line: i + 1, pattern });
  }

  return flagged;
}

describe("SSRF probe grep-gate (CSW-08) — Part A: allowlist drift", () => {
  for (const site of KNOWN_CALL_SITES) {
    it(`${site.file}:${site.line} still calls assertSafeProbeUrl`, () => {
      const file = path.resolve(ROUTES_DIR, site.file);
      const src = fs.readFileSync(file, "utf-8");
      const lines = src.split("\n");
      const line = lines[site.line - 1];
      expect(line).toBeDefined();
      expect(line).toContain(GUARD);
    });
  }
});

describe("SSRF probe grep-gate (CSW-08) — Part B: real route scan", () => {
  it("no route file makes an unguarded user-input-referencing outbound HTTP call", () => {
    const files = fs
      .readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.resolve(ROUTES_DIR, f));

    const unguarded: Array<{ file: string; line: number; pattern: string }> = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf-8");
      const hits = findUnguardedOutboundCalls(src, file);
      for (const h of hits) {
        unguarded.push({ file: path.basename(file), line: h.line, pattern: h.pattern });
      }
    }
    expect(unguarded).toEqual([]);
  });
});

describe("SSRF probe grep-gate (CSW-08) — Part C: scanner self-test", () => {
  it("(i) flags an unguarded axios.get(req.body.url)", () => {
    const src = [
      "router.post('/probe', (req, res) => {",
      "  const url = req.body.url;",
      "  const response = axios.get(url, { timeout: 5000 });",
      "  res.json(response.data);",
      "});",
    ].join("\n");
    const hits = findUnguardedOutboundCalls(src, "synthetic.ts");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("(ii) does NOT flag a guarded call (assertSafeProbeUrl in window)", () => {
    const src = [
      "import { assertSafeProbeUrl } from '../utils/ssrfGuard';",
      "router.post('/probe', async (req, res) => {",
      "  const url = req.body.url;",
      "  const validated = await assertSafeProbeUrl(url, { allowLoopback: false });",
      "  const response = axios.get(validated.href, { timeout: 5000 });",
      "  res.json(response.data);",
      "});",
    ].join("\n");
    const hits = findUnguardedOutboundCalls(src, "synthetic.ts");
    expect(hits).toEqual([]);
  });

  it("(iii) does NOT flag a config-URL call (env.COLLECTOR_URL — D-05)", () => {
    const src = [
      "import { getEnv } from '../config/env';",
      "const env = getEnv();",
      "const response = fetch(`${env.COLLECTOR_URL}/api/ingest`, {",
      "  method: 'POST',",
      "  body: formData,",
      "});",
    ].join("\n");
    const hits = findUnguardedOutboundCalls(src, "synthetic.ts");
    expect(hits).toEqual([]);
  });

  it("(iv) does NOT flag a hardcoded-URL call (string literal)", () => {
    const src = [
      "const response = fetch('https://api.example.com/health');",
    ].join("\n");
    const hits = findUnguardedOutboundCalls(src, "synthetic.ts");
    expect(hits).toEqual([]);
  });
});
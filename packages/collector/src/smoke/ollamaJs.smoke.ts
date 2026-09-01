// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * smoke:ollama — dual-runtime CJS/ESM resolution gate for the `ollama`
 * package (Phase 92-01, D-06, OJ-02 SC, Pitfall 7). Collector mirror.
 *
 * Typecheck alone cannot prove the package resolves under BOTH runtimes this
 * repo ships: `tsx` (dev, ESM-ish loader) and `node dist` (prod, compiled
 * CommonJS). This script is run twice by the `smoke:ollama` pnpm script —
 * `tsx src/smoke/ollamaJs.smoke.ts && node dist/smoke/ollamaJs.smoke.js` —
 * and fails loud (exit 1 + actionable `[smoke:ollama]` stderr) when any
 * import/require/instantiation probe fails.
 *
 * Design notes:
 *  - ALL ollama probes are dynamic (await import / require inside try/catch)
 *    so a resolution failure is captured as a FAIL check with the actionable
 *    remediation message instead of an unprefixed module-load stack.
 *  - Human-readable lines go to stderr; the machine-readable JSON payload
 *    goes to stdout (verify-encryption-key archetype).
 *  - The daemon probe is SOFT: an unreachable daemon warns but never fails
 *    the gate (CI/air-gap may legitimately have no Ollama running).
 *  - `process.exit` lives ONLY inside the `require.main === module` guard so
 *    `runSmokeChecks()` stays importable by tests/tools without side effects.
 *
 * Pitfall 6: this script is DUPLICATED in
 * packages/server/src/smoke/ollamaJs.smoke.ts. Update BOTH.
 */

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SmokeResult {
  checks: SmokeCheck[];
  exitCode: 0 | 1;
}

const REMEDIATION =
  "the `ollama` package did not resolve or instantiate under this runtime. " +
  "Run `pnpm install` to restore node_modules, then verify the dual exports " +
  "(require → dist/index.cjs, import → dist/index.mjs) with " +
  "`node -p \"require('ollama/package.json').exports['.']\"`.";

export async function runSmokeChecks(): Promise<SmokeResult> {
  const checks: SmokeCheck[] = [];

  // 1. ESM resolution probe — named + default import (tsx leg hits
  // dist/index.mjs; under tsx's CJS interop and the node dist leg this is
  // compiled to require() and hits dist/index.cjs).
  try {
    const mod = await import("ollama");
    const def = mod.default;
    checks.push({
      name: 'ESM import "ollama" resolves (named + default)',
      ok:
        typeof mod.Ollama === "function" &&
        !!def &&
        typeof def.chat === "function" &&
        typeof def.embed === "function" &&
        typeof def.list === "function",
      detail: `Ollama=${typeof mod.Ollama}, default=${typeof def}`,
    });
  } catch (err) {
    checks.push({
      name: 'ESM import "ollama" resolves (named + default)',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. CJS resolution probe — require() against the "require" export
  // condition (dist/index.cjs).
  try {
    const mod = require("ollama") as typeof import("ollama");
    checks.push({
      name: 'CJS require("ollama") resolves',
      ok: typeof mod.Ollama === "function",
      detail: `Ollama=${typeof mod.Ollama}`,
    });
  } catch (err) {
    checks.push({
      name: 'CJS require("ollama") resolves',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Factory instantiation probe — real client construction via the
  // getOllamaClient() singleton (D-02) against the configured host.
  const host = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
  let client: import("ollama").Ollama | null = null;
  try {
    const { getOllamaClient } = await import("../services/ollamaClient");
    client = getOllamaClient(host);
    checks.push({
      name: `getOllamaClient("${host}") instantiates`,
      ok:
        typeof client.chat === "function" &&
        typeof client.embed === "function" &&
        typeof client.list === "function" &&
        typeof client.generate === "function",
    });
  } catch (err) {
    checks.push({
      name: `getOllamaClient("${host}") instantiates`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Daemon probe — SOFT (informational). Never fails the gate: the daemon
  // may legitimately be absent (CI, air-gap install before first boot).
  if (client) {
    try {
      const { getOllamaClient } = await import("../services/ollamaClient");
      const probe = getOllamaClient(host, { timeoutMs: 2000 });
      const version = await probe.version();
      checks.push({
        name: "daemon probe (soft — informational)",
        ok: true,
        detail: `reachable at ${host}, version=${version.version}`,
      });
    } catch (err) {
      checks.push({
        name: "daemon probe (soft — informational)",
        ok: true,
        detail: `unreachable at ${host} (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  } else {
    checks.push({
      name: "daemon probe (soft — informational)",
      ok: true,
      detail: "skipped — client construction failed",
    });
  }

  const failed = checks.some((c) => !c.ok);
  return { checks, exitCode: failed ? 1 : 0 };
}

async function main(): Promise<void> {
  const result = await runSmokeChecks();

  // Machine-readable payload to stdout.
  process.stdout.write(
    JSON.stringify({
      tool: "smoke:ollama",
      runtime: process.argv[1]?.endsWith(".ts") ? "tsx" : "node",
      checks: result.checks,
      exitCode: result.exitCode,
    }) + "\n",
  );

  // Human-readable summary to stderr (stdout reserved for the payload).
  for (const c of result.checks) {
    console.error(
      `[smoke:ollama] ${c.ok ? "OK  " : "FAIL"} ${c.name}` +
        (c.detail ? ` — ${c.detail}` : ""),
    );
  }
  if (result.exitCode !== 0) {
    console.error(`[smoke:ollama] FAILED — ${REMEDIATION}`);
  }

  // process.exit lives in main() (NOT runSmokeChecks) so the core stays
  // importable without a sentinel-throw interrupting the return value.
  process.exit(result.exitCode);
}

// Only run main when invoked directly (tsx / node dist), not when imported.
const isDirectInvocation =
  typeof require !== "undefined" && require.main === module;
if (isDirectInvocation) {
  main().catch((err: Error) => {
    console.error("[smoke:ollama] Fatal:", err.message);
    process.exitCode = 1;
  });
}

/**
 * check-license.ts — Operator-facing license diagnostics CLI (LIC-03, D-02).
 *
 * Reuses the shared `verifyLicenseKey` verifier (Phase 120) — the SAME code
 * path `initLicense` delegates to, so verdicts match server behavior exactly.
 * No re-verification logic lives here.
 *
 * EXIT-CODE CONTRACT (documented verbatim for operators):
 *   0 = valid Enterprise key OR Community-entitled state (missing LICENSE_KEY
 *       is the normal Community state — matches initLicense's info-level
 *       fallback semantics; OQ1 resolution).
 *   1 = token-doesn't-entitle (verifyLicenseKey reasons expired /
 *       bad-signature / malformed / schema-mismatch — the key exists but
 *       fails verification).
 *   2 = env/config error (dotenv load failure only).
 *
 * SECURITY (T-121-01): stdout/stderr NEVER carry the LICENSE_KEY,
 * decoded payload, or the private key — only the closed reason enum, tier,
 * and expiry. Same canary-absence guarantee as the diagnose endpoint (D-01).
 *
 * Pitfall 4: do NOT call getEnv() from this script — its process.exit(1) on
 * invalid env is uncatchable and would collide with the exit-1 contract.
 * ENV_PATH is imported from ../src/config/env and dotenv is loaded here.
 *
 * Usage:
 *   pnpm --filter server license:check            # human-readable verdict
 *   pnpm --filter server license:check -- --json  # machine-readable CheckResult
 */

import dotenv from "dotenv";
import { program } from "commander";
import { ENV_PATH } from "../src/config/env";
import { verifyLicenseKey, LICENSE_PUBLIC_KEY } from "../src/services/licenseService";

// Env-load happens at module scope so `runCheck` can inspect the dotenv result.
// A load failure (unreadable .env) maps to exit 2 — the only exit-2 source.
const dotenvResult = dotenv.config({ path: ENV_PATH });

export interface CheckResult {
  tier?: string;
  expiresAt?: string | null;
  reason: string;
  exitCode: 0 | 1 | 2;
}

/**
 * Run the license check and return the verdict. Never throws; all failure
 * modes are mapped to the CheckResult.exitCode contract above.
 */
export async function runCheck(opts: { json?: boolean }): Promise<CheckResult> {
  // 2 = env-load failure (dotenv could not read/parse the .env file).
  if (dotenvResult.error) {
    const result: CheckResult = { reason: "env-load-failure", exitCode: 2 };
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.warn("[license:check] FAILED: could not load environment file");
      console.warn("[license:check] exit 2 = env/config error (dotenv load failure)");
    }
    return result;
  }

  // Read directly from process.env (optional string — env.ts).
  const key = process.env.LICENSE_KEY;

  // The public key is embedded in the source (license-public-key.ts). There
  // is intentionally no env override — an override would allow self-signing.
  const verdict = verifyLicenseKey(key, LICENSE_PUBLIC_KEY);

  if (verdict.ok) {
    const result: CheckResult = {
      tier: verdict.payload.tier,
      expiresAt: verdict.expiresAt,
      reason: "ok",
      exitCode: 0,
    };
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(
        `[license:check] OK: ${verdict.payload.tier} license (${verdict.payload.sub})` +
          ` — expires ${verdict.expiresAt}`,
      );
    }
    return result;
  }

  if (verdict.reason === "missing") {
    // OQ1 resolution: no LICENSE_KEY at all → Community-entitled → exit 0.
    const result: CheckResult = { tier: "community", reason: "missing", exitCode: 0 };
    if (opts.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log("[license:check] OK: Community Edition (no license key configured)");
    }
    return result;
  }

  // token-doesn't-entitle: expired / bad-signature / malformed / schema-mismatch.
  const result: CheckResult = { reason: verdict.reason, exitCode: 1 };
  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    console.warn(`[license:check] FAILED: license key does not entitle (${verdict.reason})`);
    console.warn("[license:check] exit 1 = token-doesn't-entitle");
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI entrypoint — process.exit lives in main() ONLY so unit tests can assert
// the returned CheckResult.exitCode without a sentinel-throw (verify-encryption
// -key pattern). An uncaught throw in main IS an env/config failure → exit 2.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  program.option("--json", "emit machine-readable JSON to stdout").parse();

  const opts = program.opts() as { json?: boolean };
  const result = await runCheck({ json: !!opts.json });
  process.exit(result.exitCode);
}

// Only run main when invoked directly via tsx, not when imported by tests.
const isDirectInvocation = typeof require !== "undefined" && require.main === module;
if (isDirectInvocation) {
  main().catch(() => process.exit(2));
}

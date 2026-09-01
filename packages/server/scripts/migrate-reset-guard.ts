/**
 * @fileoverview Consent gate for `prisma migrate reset` (Phase 102, SAFE-01, D-02).
 *
 * `prisma migrate reset` drops and recreates the ENTIRE database — all data is lost.
 * This wrapper requires explicit operator consent before delegating:
 *   - `PRISMA_MIGRATE_RESET_CONFIRM=yes` env var, OR
 *   - `--force-accept-data-loss` CLI flag (via commander)
 *
 * Without consent, the guard prints a clear data-loss warning and exits 1.
 * Mirrors the established `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` pattern
 * from CI (`ci.yml`) and test setup (`jest.globalSetup.js`), but uses a SEPARATE
 * env var (D-02) — `migrate reset` is a different level of danger than a single
 * destructive migration.
 *
 * Usage:
 *   pnpm db:migrate:reset:guard
 *   pnpm db:migrate:reset:guard --force-accept-data-loss
 *   PRISMA_MIGRATE_RESET_CONFIRM=yes pnpm db:migrate:reset:guard
 *
 * Exit codes:
 *   0 — consent granted, delegated to `prisma migrate reset`
 *   1 — consent NOT granted
 *
 * Imports `commander` (already a devDep, used by `rotate-encryption-key.ts:24`).
 * Delegates via `execFileSync` with array args (no shell — no injection).
 * Passes `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes` in the child env so
 * `prisma migrate reset` itself doesn't prompt (it has its own consent check).
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { program } from "commander";
import { logger } from "../src/utils/logger";

/**
 * Check an env var for explicit consent. Accepted values: `yes`/`1`/`true`
 * (case-insensitive, whitespace-trimmed). Same 3-value pattern as the deploy
 * guard — established in `ci.yml:95-96` + `jest.globalSetup.js:49`.
 */
export function isConsentGranted(envVar: string | undefined): boolean {
  const v = (envVar ?? "").trim().toLowerCase();
  return v === "yes" || v === "1" || v === "true";
}

export interface ResetConsentResult {
  granted: boolean;
  reason: "env" | "flag" | "neither";
}

/**
 * Pure function: decide whether reset consent is granted based on env var and
 * CLI flag. Exported for unit testing (no side effects, no I/O).
 *
 * @param envConsent — value of `PRISMA_MIGRATE_RESET_CONFIRM` env var
 * @param forceFlag — true if `--force-accept-data-loss` was passed
 * @returns `{ granted: true, reason: "env" }` if env consent,
 *          `{ granted: true, reason: "flag" }` if force flag,
 *          `{ granted: false, reason: "neither" }` otherwise.
 */
export function checkResetConsent(
  envConsent: string | undefined,
  forceFlag: boolean,
): ResetConsentResult {
  if (isConsentGranted(envConsent)) {
    return { granted: true, reason: "env" };
  }
  if (forceFlag) {
    return { granted: true, reason: "flag" };
  }
  return { granted: false, reason: "neither" };
}

export interface ResetGuardResult {
  consented: boolean;
  reason: string;
}

/**
 * Main reset guard logic — exported for unit testing.
 *
 * Flow:
 *   a. Read `envConsent` from `opts.envConsent` or `process.env.PRISMA_MIGRATE_RESET_CONFIRM`.
 *   b. Call `checkResetConsent`.
 *   c. Not granted → log refusal, return { consented: false, reason: "neither" }.
 *   d. Granted → log warning (with reason), delegate to `prisma migrate reset`.
 *   e. Return { consented: true, reason }.
 */
export async function runResetGuard(opts: {
  forceAcceptDataLoss?: boolean;
  envConsent?: string;
}): Promise<ResetGuardResult> {
  const envConsent = opts.envConsent ?? process.env.PRISMA_MIGRATE_RESET_CONFIRM;
  const decision = checkResetConsent(envConsent, opts.forceAcceptDataLoss ?? false);

  if (!decision.granted) {
    logger.error(
      "[migrate-reset-guard] REFUSED: prisma migrate reset will DROP ALL DATA.",
    );
    logger.error(
      "[migrate-reset-guard] Set PRISMA_MIGRATE_RESET_CONFIRM=yes or pass --force-accept-data-loss to proceed.",
    );
    return { consented: false, reason: "neither" };
  }

  logger.warn(
    `[migrate-reset-guard] CONSENT GRANTED (via ${decision.reason}) — proceeding to prisma migrate reset. ALL DATA WILL BE LOST.`,
  );

  // Pass PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes in the child env so
  // `prisma migrate reset` itself doesn't prompt (it has its own consent check).
  // Array args (no shell injection).
  execFileSync("npx", ["prisma", "migrate", "reset"], {
    cwd: resolve(dirname(__filename), ".."),
    env: {
      ...process.env,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "inherit",
  });

  return { consented: true, reason: decision.reason };
}

/**
 * CLI entrypoint. Parses `--force-accept-data-loss` via commander, calls
 * `runResetGuard`, exits 1 if not consented, 0 if consented.
 */
async function main(): Promise<void> {
  program
    .option(
      "--force-accept-data-loss",
      "Bypass the consent gate (same as PRISMA_MIGRATE_RESET_CONFIRM=yes)",
    )
    .parse();

  const opts = program.opts() as { forceAcceptDataLoss?: boolean };
  const result = await runResetGuard({
    forceAcceptDataLoss: opts.forceAcceptDataLoss === true,
  });
  if (!result.consented) {
    process.exit(1);
  }
  process.exit(0);
}

// Only run main when invoked directly via tsx, not when imported by tests.
if (require.main === module) {
  main().catch((err: Error) => {
    logger.error("[migrate-reset-guard] Fatal:", err.message);
    process.exit(1);
  });
}
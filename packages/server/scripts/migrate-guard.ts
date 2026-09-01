/**
 * @fileoverview Pre-apply wrapper for `prisma migrate deploy` (Phase 102, SAFE-01).
 *
 * Inspects the PENDING migration SQL (on-disk minus already-applied in `_prisma_migrations`)
 * before `migrate deploy` executes. If any pending migration is classified as destructive
 * by the existing `audit-migrations.ts` classification engine (D-01 reuse, D-04 equal
 * treatment), the guard refuses to delegate and exits 1 — unless the operator has set
 * `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes` (D-03 override).
 *
 * Usage:
 *   pnpm db:migrate:guard
 *   pnpm --filter server db:migrate:guard
 *
 * Exit codes:
 *   0 — no pending migrations, OR all pending additive, OR destructive with consent granted
 *   1 — destructive pending AND consent NOT granted
 *
 * Reuses `classifyMigration()` from `./audit-migrations` (D-01 — no reimplemented regex).
 * Imports the Prisma singleton from `../src/utils/prisma` (AGENTS.md Prisma rule).
 * Delegates to `prisma migrate deploy` (NOT `migrate dev` — Pitfall 2) via `execFileSync`
 * with array args (no shell — Pitfall: no injection).
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { classifyMigration, type Classification } from "./audit-migrations";
import prisma from "../src/utils/prisma";
import { logger } from "../src/utils/logger";

const MIGRATIONS_DIR = resolve(dirname(__filename), "..", "prisma", "migrations");

/** Shape returned by `prisma.$queryRaw` for the `_prisma_migrations` table (Pitfall 1). */
interface AppliedMigrationRow {
  migration_name: string;
}

/**
 * Query the Prisma-internal `_prisma_migrations` table for applied migration slugs.
 * Prisma does not generate a model for this table, so `$queryRaw` is required
 * (Pitfall 1 — AGENTS.md raw-query pattern, tagged template literal).
 */
export async function getAppliedMigrationNames(): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<AppliedMigrationRow[]>`
    SELECT migration_name FROM _prisma_migrations
  `;
  return new Set(rows.map((r) => r.migration_name));
}

/**
 * Walk the migrations directory and return on-disk migration slugs, sorted
 * chronologically (ascending by directory name = `<timestamp>_<slug>`).
 * Replicates the `collectMigrations()` pattern from `audit-migrations.ts:90-112`
 * but returns slugs only (no paths/dates).
 */
export function getOnDiskMigrationSlugs(): string[] {
  const dirents = readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  return dirents
    .filter((d) => d.isDirectory() && d.name !== "migration_lock.toml")
    .map((d) => d.name)
    .sort();
}

/**
 * Diff on-disk minus applied, then classify each pending migration's SQL.
 * Returns an array of `{ slug, type, operations }` for each pending migration.
 */
export function classifyPending(
  applied: Set<string>,
): Array<{ slug: string; type: string; operations: string[] }> {
  const onDisk = getOnDiskMigrationSlugs();
  const pending = onDisk.filter((slug) => !applied.has(slug));
  return pending.map((slug) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, slug, "migration.sql"), "utf8");
    const result: Classification = classifyMigration(sql);
    return { slug, type: result.type, operations: result.operations };
  });
}

/**
 * Check an env var for explicit consent. Accepted values: `yes`/`1`/`true`
 * (case-insensitive, whitespace-trimmed). Established 3-value pattern from
 * `ci.yml:95-96` + `jest.globalSetup.js:49`.
 */
export function isConsentGranted(envVar: string | undefined): boolean {
  const v = (envVar ?? "").trim().toLowerCase();
  return v === "yes" || v === "1" || v === "true";
}

export interface GuardResult {
  pending: number;
  destructive: number;
  proceeded: boolean;
}

/**
 * Main guard logic — exported for unit testing (mirrors `rotate-encryption-key.ts`
 * `runRotation` pattern).
 *
 * Flow:
 *   a. Query applied migrations from `_prisma_migrations`.
 *   b. Classify pending (onDisk - applied).
 *   c. No pending → return { pending: 0, destructive: 0, proceeded: false }.
 *   d. Count destructive pending.
 *   e. Destructive > 0 AND consent not granted → refuse, return proceeded: false.
 *   f. Destructive > 0 AND consent granted → log warning (D-03), proceed.
 *   g. `prisma.$disconnect()` before delegation (Open Question 2 — lock contention).
 *   h. `execFileSync("npx", ["prisma", "migrate", "deploy"], ...)` (Pitfall 2 — deploy, not dev).
 *   i. Return { pending, destructive, proceeded: true }.
 */
export async function runGuard(opts: {
  consentOverride?: boolean;
}): Promise<GuardResult> {
  const applied = await getAppliedMigrationNames();
  const pending = classifyPending(applied);

  if (pending.length === 0) {
    logger.info("[migrate-guard] No pending migrations.");
    return { pending: 0, destructive: 0, proceeded: false };
  }

  const destructive = pending.filter((p) => p.type === "destructive");

  if (
    destructive.length > 0 &&
    !opts.consentOverride &&
    !isConsentGranted(process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION)
  ) {
    logger.error(
      `[migrate-guard] REFUSED: ${destructive.length} destructive pending migration(s).`,
    );
    for (const p of destructive) {
      logger.error(
        `[migrate-guard]   ${p.slug} — matched: ${p.operations.join(", ")}`,
      );
    }
    logger.error(
      "[migrate-guard] Set PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes to proceed (data loss possible).",
    );
    return { pending: pending.length, destructive: destructive.length, proceeded: false };
  }

  if (destructive.length > 0) {
    logger.warn(
      `[migrate-guard] CONSENT GRANTED — proceeding with ${destructive.length} destructive migration(s). Data loss possible.`,
    );
  } else {
    logger.info(
      `[migrate-guard] ${pending.length} pending additive migration(s) — proceeding to prisma migrate deploy.`,
    );
  }

  // Open Question 2 — disconnect before delegation to avoid lock contention
  // with the child process.
  await prisma.$disconnect();

  // Pitfall 2 — migrate deploy (NOT migrate dev). Array args (no shell injection).
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: resolve(dirname(__filename), ".."),
    env: { ...process.env },
    stdio: "inherit",
  });

  return { pending: pending.length, destructive: destructive.length, proceeded: true };
}

/**
 * CLI entrypoint. Calls `runGuard({})`, exits 1 if destructive && !proceeded,
 * else exits 0.
 */
async function main(): Promise<void> {
  const result = await runGuard({});
  if (result.destructive > 0 && !result.proceeded) {
    process.exit(1);
  }
  process.exit(0);
}

// Only run main when invoked directly via tsx, not when imported by tests.
// Mirrors `rotate-encryption-key.ts:364-375` pattern.
if (require.main === module) {
  main()
    .then(() => prisma.$disconnect())
    .catch((err: Error) => {
      logger.error("[migrate-guard] Fatal:", err.message);
      prisma
        .$disconnect()
        .catch(() => {})
        .finally(() => process.exit(1));
    });
}
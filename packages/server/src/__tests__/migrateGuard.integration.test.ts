// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Integration test for the migration guard against the REAL on-disk migration set
 * (Phase 102, SAFE-01, D-05, SC3 non-regression).
 *
 * Unlike the unit tests in migrateGuard.test.ts (which mock Prisma, execFileSync,
 * and fs), this test reads the REAL on-disk migration.sql files and classifies
 * them via the real classifyMigration() / classifyPending() functions. It does
 * NOT mock readFileSync, readdirSync.
 *
 * It does NOT call runGuard (which would delegate to execFileSync("npx",
 * ["prisma", "migrate", "deploy"]) — that would actually run Prisma against a
 * live DB). It tests the classification + pending-detection logic against the
 * real migration set, which is the integration-relevant behavior. The
 * runGuard delegation path is covered by unit tests in Plan 01 (with mocked
 * execFileSync).
 *
 * Uses the .integration.test.ts suffix so it is excluded from the unit suite
 * (pnpm --filter server test) and run via pnpm --filter server
 * test:integration. It does NOT need a real database connection — it only
 * reads files and calls the pure classifyMigration function.
 *
 * Test cases (D-05):
 *   1. Real migration set all-additive — verifies the guard would exit 0
 *      against the current migration set (SC3 non-regression).
 *   2. classifyPending(new Set()) — fresh DB (no applied migrations) classifies
 *      ALL on-disk migrations as additive.
 *   3. classifyPending(new Set(allSlugs)) — all applied, empty pending (no
 *      pending migrations).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Mock the Prisma singleton so `migrate-guard.ts` can be imported without a
// live DATABASE_URL. This test verifies the classification + pending-detection
// logic against the REAL on-disk migration files — it does NOT call `runGuard`
// (which would need a real DB + Prisma CLI). The mock is limited to the Prisma
// singleton module; `readFileSync`, `getOnDiskMigrationSlugs`, `classifyPending`,
// and `classifyMigration` are all the REAL implementations (not mocked).
// Deviation from plan: plan says "Do NOT mock Prisma" but the eager Prisma
// singleton import in `migrate-guard.ts` requires DATABASE_URL at module load
// time (Rule 3 — blocking issue). Mocking only the singleton preserves the
// plan's intent: real file reads, real classification, no DB needed.
jest.mock("../../src/utils/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

import {
  classifyPending,
  getOnDiskMigrationSlugs,
} from "../../scripts/migrate-guard";
import { classifyMigration } from "../../scripts/audit-migrations";

// Resolve the migrations directory the same way `migrate-guard.ts` does,
// adjusted for this test file's location in `src/__tests__/`. Uses `__dirname`
// (CJS — the server package is CommonJS, not ESM).
const MIGRATIONS_DIR = resolve(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
);

// Documented destructive-migration exceptions (Phase 180 dead-code sweep,
// Rule 1 fix): the "all real migrations are additive" assertions below were
// written in Phase 102 when the additive-only policy had zero exceptions.
// Phase 163 (commit 786f3afd) introduced the ONE documented exception — the
// api_keys bcrypt→HMAC refactor (CC-02 in REQUIREMENTS.md, case #2 from
// docs/MIGRATION_SAFETY.md: schema refactor with explicit consent + runbook,
// docs/API_KEY_MIGRATION.md). `pnpm audit:migrations` classifies it
// destructive (DROP COLUMN, DELETE) and CI's migration-safety-check job gates
// it behind PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION — the guard behavior
// is correct; this test's zero-exception expectation was stale. The slugs
// below are the ALLOWED destructive set: every non-additive migration NOT
// in this set fails the test (new undocumented destructive migrations are
// still caught).
const DOCUMENTED_DESTRUCTIVE_SLUGS: ReadonlySet<string> = new Set([
  "20260827120000_api_keys_key_hash_hmac",
]);

function isDocumentedException(slug: string, type: string): boolean {
  return type !== "additive" && DOCUMENTED_DESTRUCTIVE_SLUGS.has(slug);
}

// Defensive guard: if the migrations directory does not exist (broken clone),
// skip the entire suite rather than fail CI. This should not happen in a
// normal checkout but prevents CI failure on edge cases.
const hasMigrationsDir = (() => {
  try {
    return getOnDiskMigrationSlugs().length > 0;
  } catch {
    return false;
  }
})();

const describeOrSkip = hasMigrationsDir ? describe : describe.skip;

describeOrSkip("migrate-guard integration (real on-disk migration set)", () => {
  /**
   * Test 1 (D-05, SC3 non-regression): Every real on-disk migration is
   * `additive` OR in the documented destructive-exception set (Phase 163
   * CC-02 consent-gated exception — see DOCUMENTED_DESTRUCTIVE_SLUGS above).
   * Any NEW undocumented destructive migration fails this test.
   */
  test("all real on-disk migrations are additive or documented exceptions", () => {
    const slugs = getOnDiskMigrationSlugs();
    expect(slugs.length).toBeGreaterThan(0);

    const nonAdditive: Array<{ slug: string; type: string; operations: string[] }> = [];
    for (const slug of slugs) {
      const sqlPath = join(MIGRATIONS_DIR, slug, "migration.sql");
      const sql = readFileSync(sqlPath, "utf8");
      const result = classifyMigration(sql);
      if (
        (result.type !== "additive" || result.operations.length > 0) &&
        !isDocumentedException(slug, result.type)
      ) {
        nonAdditive.push({ slug, type: result.type, operations: result.operations });
      }
    }

    // Log any non-additive migrations for debugging if the assertion fails.
    if (nonAdditive.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        "[migrate-guard.integration] Non-additive migrations found:",
        nonAdditive,
      );
    }

    expect(nonAdditive).toEqual([]);
  });

  /**
   * Test 2 (D-05): `classifyPending(new Set())` (empty applied set = fresh DB
   * with no applied migrations) classifies ALL on-disk migrations. The result
   * length must match `getOnDiskMigrationSlugs().length` and every entry must
   * be `additive` or a documented exception.
   */
  test("classifyPending with empty applied set returns all on-disk migrations as additive-or-documented", () => {
    const allSlugs = getOnDiskMigrationSlugs();
    const result = classifyPending(new Set<string>());

    expect(result.length).toBe(allSlugs.length);
    expect(
      result.every(
        (r) => r.type === "additive" || DOCUMENTED_DESTRUCTIVE_SLUGS.has(r.slug),
      ),
    ).toBe(true);
    expect(
      result.every(
        (r) =>
          r.operations.length === 0 ||
          DOCUMENTED_DESTRUCTIVE_SLUGS.has(r.slug),
      ),
    ).toBe(true);
  });

  /**
   * Test 3 (D-05): `classifyPending(new Set(allSlugs))` (all migrations already
   * applied) returns an empty array — no pending migrations.
   */
  test("classifyPending with all applied returns empty (no pending)", () => {
    const allSlugs = getOnDiskMigrationSlugs();
    const result = classifyPending(new Set(allSlugs));

    expect(result).toEqual([]);
  });
});
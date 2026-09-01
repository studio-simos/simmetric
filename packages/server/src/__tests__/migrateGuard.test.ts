// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for both migration guard wrapper scripts (Phase 102, SAFE-01, D-05).
 *
 * Covers 8 test cases:
 *   1. Deploy guard: destructive pending → refused (D-05)
 *   2. Deploy guard: additive pending → proceeds to migrate deploy (D-05)
 *   3. Deploy guard: consentOverride → proceeds with destructive (D-03)
 *   4. Reset guard: no consent → refused (D-05)
 *   5. Reset guard: env consent → granted (D-05)
 *   6. Reset guard: --force-accept-data-loss flag → granted (D-05)
 *   7. D-04 equal treatment: DELETE FROM classified destructive (no soft-delete introspection)
 *   8. Consent parsing edge cases: YES/1/true/whitespace → true; ""/no/undefined → false
 *
 * Mocks: `prisma.$queryRaw` (controlled applied set), `execFileSync` (no real Prisma CLI),
 * `readFileSync` (inline SQL fixtures), `readdirSync` (controlled on-disk slugs).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

// Mock the Prisma singleton — control $queryRaw to return controlled applied sets.
jest.mock("../../src/utils/prisma", () => {
  const mockPrisma = {
    $queryRaw: jest.fn(),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: mockPrisma };
});

// Mock child_process.execFileSync so no real Prisma CLI is invoked.
jest.mock("node:child_process", () => ({
  execFileSync: jest.fn(),
}));

// Mock commander — v15 is ESM-only and incompatible with the CJS jest transform.
// The reset guard's main() (which uses commander) is NOT under unit test; only
// the pure functions checkResetConsent / runResetGuard / isConsentGranted are tested.
jest.mock("commander", () => ({
  program: {
    option: jest.fn().mockReturnThis(),
    parse: jest.fn().mockReturnThis(),
    opts: jest.fn().mockReturnValue({}),
  },
}));

// Mock node:fs to control readdirSync (on-disk migration slugs) and readFileSync (SQL content).
// Preserve existsSync + other fs functions needed by winston/logger (loaded transitively).
jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
}));

import { runGuard, isConsentGranted } from "../../scripts/migrate-guard";
import {
  checkResetConsent,
  isConsentGranted as isResetConsentGranted,
} from "../../scripts/migrate-reset-guard";
import { classifyMigration } from "../../scripts/audit-migrations";

// Import the mocked modules to control them.
import prisma from "../../src/utils/prisma";
import { logger } from "../../src/utils/logger";

// Suppress logger output during tests.
beforeAll(() => {
  jest.spyOn(logger, "info").mockImplementation(() => undefined as never);
  jest.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  jest.spyOn(logger, "error").mockImplementation(() => undefined as never);
});

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;

/** Helper: configure fs mocks for a set of on-disk migrations with given SQL content. */
function setOnDiskMigrations(migrations: Array<{ slug: string; sql: string }>) {
  // readdirSync returns Dirent-like objects with isDirectory() and name.
  const dirents = migrations.map((m) => ({
    name: m.slug,
    isDirectory: () => true,
  }));
  // Also include migration_lock.toml as a file (not directory) — filtered out.
  dirents.push({ name: "migration_lock.toml", isDirectory: () => false } as never);
  mockReaddirSync.mockReturnValue(dirents as never);
  // readFileSync returns the SQL for the matching slug.
  mockReadFileSync.mockImplementation(((path: unknown) => {
    const p = String(path);
    for (const m of migrations) {
      if (p.includes(m.slug)) return m.sql;
    }
    return "";
  }) as never);
}

/** Helper: configure $queryRaw to return a set of applied migration names. */
function setAppliedMigrations(names: string[]) {
  mockQueryRaw.mockResolvedValue(names.map((n) => ({ migration_name: n })));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExecFileSync.mockImplementation(() => Buffer.from("") as never);
  // Default: no migrations applied, no migrations on disk.
  setAppliedMigrations([]);
  setOnDiskMigrations([]);
  // Clear process.env consent flags.
  delete process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION;
  delete process.env.PRISMA_MIGRATE_RESET_CONFIRM;
});

describe("deploy guard", () => {
  it("Test 1 (D-05): destructive pending migration → refused (proceeded: false, destructive: 1)", async () => {
    setAppliedMigrations([]); // nothing applied → all pending
    setOnDiskMigrations([
      { slug: "20260729000000_drop_users", sql: "DROP TABLE users;" },
    ]);

    const result = await runGuard({});

    expect(result.proceeded).toBe(false);
    expect(result.destructive).toBe(1);
    expect(result.pending).toBe(1);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("Test 2 (D-05): additive pending migration → proceeds to prisma migrate deploy", async () => {
    setAppliedMigrations([]);
    setOnDiskMigrations([
      { slug: "20260729000000_add_foo", sql: "CREATE TABLE foo (id INT);" },
    ]);

    const result = await runGuard({});

    expect(result.proceeded).toBe(true);
    expect(result.destructive).toBe(0);
    expect(result.pending).toBe(1);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npx",
      ["prisma", "migrate", "deploy"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });

  it("Test 3 (D-03): consentOverride=true → proceeds with destructive migration", async () => {
    setAppliedMigrations([]);
    setOnDiskMigrations([
      { slug: "20260729000000_drop_users", sql: "DROP TABLE users;" },
    ]);

    const result = await runGuard({ consentOverride: true });

    expect(result.proceeded).toBe(true);
    expect(result.destructive).toBe(1);
    expect(result.pending).toBe(1);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "npx",
      ["prisma", "migrate", "deploy"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});

describe("reset guard", () => {
  it("Test 4 (D-05): no consent env, no flag → refused", () => {
    const result = checkResetConsent(undefined, false);
    expect(result.granted).toBe(false);
    expect(result.reason).toBe("neither");
  });

  it("Test 5 (D-05): env consent=yes → granted via env", () => {
    const result = checkResetConsent("yes", false);
    expect(result.granted).toBe(true);
    expect(result.reason).toBe("env");
  });

  it("Test 6 (D-05): --force-accept-data-loss flag → granted via flag", () => {
    const result = checkResetConsent(undefined, true);
    expect(result.granted).toBe(true);
    expect(result.reason).toBe("flag");
  });
});

describe("D-04 equal treatment", () => {
  it("Test 7 (D-04): DELETE FROM classified as destructive (no soft-delete introspection)", () => {
    const result = classifyMigration('DELETE FROM "User";');
    expect(result.type).toBe("destructive");
    expect(result.operations).toContain("DELETE");
  });
});

describe("consent parsing", () => {
  it("Test 8 (D-05): isConsentGranted accepts yes/1/true/YES/whitespace; rejects empty/no/undefined", () => {
    // Truthy cases
    expect(isConsentGranted("yes")).toBe(true);
    expect(isConsentGranted("1")).toBe(true);
    expect(isConsentGranted("true")).toBe(true);
    expect(isConsentGranted("YES")).toBe(true);
    expect(isConsentGranted("  yes  ")).toBe(true);

    // Falsy cases
    expect(isConsentGranted("")).toBe(false);
    expect(isConsentGranted("no")).toBe(false);
    expect(isConsentGranted(undefined)).toBe(false);

    // Reset guard uses the same isConsentGranted implementation
    expect(isResetConsentGranted("yes")).toBe(true);
    expect(isResetConsentGranted(undefined)).toBe(false);
  });
});
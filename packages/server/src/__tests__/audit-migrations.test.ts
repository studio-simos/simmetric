// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for the migration audit script (SEED-01).
 *
 * Covers:
 *  - the 5-pattern destructive allowlist (positive + negative cases)
 *  - the 3 Prisma idioms that MUST stay additive (regression tests for Pitfall 1)
 *  - case-insensitive matching (Pitfall 6)
 *  - JSON-sidecar shape (per D-01)
 *  - real-migration regression tests on two existing migrations containing idioms
 */

import {
  classifyMigration,
  DESTRUCTIVE_PATTERNS,
  type MigrationRow,
} from "../../scripts/audit-migrations";

describe("classifyMigration", () => {
  it("returns additive for plain CREATE TABLE", () => {
    const result = classifyMigration("CREATE TABLE foo (id INT);");
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });

  it("returns additive for ALTER TABLE ... ADD COLUMN (no DROP)", () => {
    const result = classifyMigration("ALTER TABLE foo ADD COLUMN bar TEXT;");
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });

  it("flags DROP TABLE as destructive (pattern 1)", () => {
    const result = classifyMigration("DROP TABLE users;");
    expect(result.type).toBe("destructive");
    expect(result.operations).toContain("DROP TABLE");
  });

  it("flags ALTER TABLE ... DROP COLUMN as destructive (pattern 2)", () => {
    const result = classifyMigration("ALTER TABLE users DROP COLUMN email;");
    expect(result.type).toBe("destructive");
    expect(result.operations).toContain("DROP COLUMN");
  });

  it("flags TRUNCATE as destructive (pattern 3)", () => {
    const result = classifyMigration("TRUNCATE TABLE audit_log;");
    expect(result.type).toBe("destructive");
    expect(result.operations).toContain("TRUNCATE");
  });

  it("flags DELETE FROM as destructive (pattern 5)", () => {
    const result = classifyMigration('DELETE FROM "User";');
    expect(result.type).toBe("destructive");
    expect(result.operations).toContain("DELETE");
  });

  it("keeps DROP CONSTRAINT additive — Prisma idiom #1 (negative-lookahead guard)", () => {
    // Prisma drops a foreign-key constraint before re-adding it with different ON DELETE semantics.
    const result = classifyMigration("ALTER TABLE foo DROP CONSTRAINT foo_pkey;");
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });

  it("keeps DROP INDEX additive — Prisma idiom #2 (not in allowlist)", () => {
    // Prisma drops and re-creates an index when its definition changes; only the index metadata changes.
    const result = classifyMigration("DROP INDEX my_index;");
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });

  it("keeps ALTER COLUMN ... DROP DEFAULT additive — Prisma idiom #3 (negative-lookahead guard)", () => {
    // Removing a default expression does not lose data; the column and its data are unaffected.
    const result = classifyMigration(
      "ALTER TABLE document_chunks ALTER COLUMN searchVector DROP DEFAULT;",
    );
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });

  it("is case-insensitive on DROP TABLE (PostgreSQL keyword case-insensitivity)", () => {
    const result = classifyMigration("drop table users;");
    expect(result.type).toBe("destructive");
    expect(result.operations).toContain("DROP TABLE");
  });

  it("flags table-level DROP of other things (e.g. DROP PARTITION) via pattern 4", () => {
    // The negative-lookahead whitelists COLUMN/CONSTRAINT/DEFAULT/INDEX — anything else
    // (e.g. PARTITION) hits pattern 4 and is destructive.
    const result = classifyMigration("ALTER TABLE foo DROP PARTITION p1;");
    expect(result.type).toBe("destructive");
    expect(result.operations).toContain("ALTER ... DROP (table-level)");
  });
});

describe("DESTRUCTIVE_PATTERNS", () => {
  it("contains exactly 5 entries (locked finite allowlist)", () => {
    expect(DESTRUCTIVE_PATTERNS).toHaveLength(5);
  });

  it("uses the documented pattern names (any change to the allowlist is a deliberate code review)", () => {
    const names = DESTRUCTIVE_PATTERNS.map((p) => p.name);
    expect(names).toEqual([
      "DROP TABLE",
      "DROP COLUMN",
      "TRUNCATE",
      "ALTER ... DROP (table-level)",
      "DELETE",
    ]);
  });
});

describe("real-migration regression", () => {
  // The historical migration files these regressions originally loaded
  // (20260516134634_add_missing_models, 20260522061450_add_text_size_to_user)
  // were squashed into 00000000000000_init on 2026-06-06. The destructive-vs-
  // additive patterns they exercised are preserved here as inline fixtures.

  it("classifies DROP CONSTRAINT followed by re-add as additive", () => {
    // Dropping a foreign key before re-adding it with new ON DELETE semantics
    // is semantically additive.
    const sql = [
      `ALTER TABLE "documents" DROP CONSTRAINT "documents_workspaceId_fkey";`,
      `ALTER TABLE "documents" ADD CONSTRAINT "documents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
    ].join("\n");
    const result = classifyMigration(sql);
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });

  it("classifies DROP INDEX + DROP DEFAULT as additive", () => {
    // Dropping an index and removing a default expression are semantically additive.
    const sql = [
      `DROP INDEX "users_textSize_idx";`,
      `ALTER TABLE "users" ALTER COLUMN "textSize" DROP DEFAULT;`,
      `ALTER TABLE "users" ALTER COLUMN "textSize" SET DATA TYPE TEXT;`,
    ].join("\n");
    const result = classifyMigration(sql);
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });

  it("the flattened init embeds the searchVectorMulti DDL with zero UPDATE statements", () => {
    // Phase 181 flattened the trail to a single init; the historical invariant
    // (RAG-01: no data-rewriting UPDATE in the searchVectorMulti DDL — a
    // UPDATE would lock tables on deploy, D-02 / T-151-06) now applies to the
    // flattened init as a whole. The flattened init carries searchVectorMulti
    // as inline table columns + GIN indexes (no ALTER path).
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const sql = readFileSync(
      join(__dirname, "..", "..", "prisma", "migrations", "00000000000000_init", "migration.sql"),
      "utf8",
    );
    expect(sql).toContain('"searchVectorMulti" tsvector');
    expect(sql).toContain('USING GIN ("searchVectorMulti")');
    // Strip comments before scanning — header comments legitimately mention UPDATE.
    const statements = sql
      .split("\n")
      .filter((line: string) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(/^\s*UPDATE\b/im.test(statements)).toBe(false);
    const result = classifyMigration(sql);
    expect(result.type).toBe("additive");
    expect(result.operations).toEqual([]);
  });
});

describe("MigrationRow type", () => {
  it("compiles and is exported as a type (smoke check for the exported contract)", () => {
    // No runtime assertion possible for a type — but we can confirm the import resolves.
    const row: MigrationRow = { slug: "20260101_x", date: "2026-01-01", path: "/x" };
    expect(row.slug).toBe("20260101_x");
    expect(row.date).toBe("2026-01-01");
    expect(row.path).toBe("/x");
  });
});

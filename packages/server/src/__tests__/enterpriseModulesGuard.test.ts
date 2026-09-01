// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

/**
 * enterpriseModulesGuard.test.ts — Phase 147 (EPA-07) D-14.
 *
 * Asserts ZERO references to the `GET /api/enterprise/modules` manifest
 * route remain in the community `packages/server/src/` tree (excluding
 * `__mocks__/`, `__tests__/`, `dist/`, `node_modules/`, `generated/`).
 * The manifest route is owned by the enterprise plugin
 * (`simmetric-enterprise/src/routes/modules.ts`); a community build has
 * no such route mounted, so `GET /api/enterprise/modules` 404s in
 * community (SC-2). Mirrors the Phase 143-146 grep-guard pattern
 * (e.g. `auditLogExtractionGuard.test.ts`).
 *
 * Phase 147 (EPA-07) — Plan 01 Task 1
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve(__dirname, "..");

// D-14 — patterns that must be ABSENT from community src/ after the move.
// The manifest route factory lives in the enterprise package; community
// routes/ must not register `/api/enterprise/modules` or import a
// `routes/modules` factory.
const MANIFEST_PATTERNS: RegExp[] = [
  /from\s+["'](\.\.\/)+routes\/modules["']/,
  /from\s+["']\.\/routes\/modules["']/,
  /["']\/api\/enterprise\/modules["']/,
  /app\.use\(\s*["']\/api\/enterprise\/modules["']/,
];

const EXCLUDED_DIRS = new Set(["__mocks__", "__tests__", "dist", "node_modules", "generated"]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("D-14: enterprise modules manifest route grep-guard", () => {
  it("zero /api/enterprise/modules route references in community src/ (route lives in enterprise plugin)", () => {
    const files = walkTsFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of MANIFEST_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(
            `${path.relative(SRC_DIR, file)}: ${pattern.source}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * auditLogExtractionGuard.test.ts — D-15/D-16 grep-guard.
 *
 * Asserts ZERO audit-log imports/writes remain in the community
 * `packages/server/src/` tree (excluding `__mocks__/`, `__tests__/`, `dist/`,
 * `node_modules/`). This is the phase's regression gate: after Plan 01 the
 * audit log route, the getEventLogs query, and the direct
 * `prisma.eventLog.create()` write have all moved to the enterprise plugin.
 * The community `logEvent()` shim delegates via `auditLogDelegate` (D-11) and
 * NEVER calls `prisma.eventLog.create()` (D-16).
 *
 * Pattern list (D-15/D-16):
 *   - `from "...routes/eventLogs"` / `from "./routes/eventLogs"` — the moved
 *     route file (relative imports — prefix varies by caller depth).
 *   - `getEventLogs` — the moved query function (D-15).
 *   - `prisma.eventLog.create` — D-16 (the shim must never write directly).
 *
 * Mirrors the Phase 143 `ssoExtractionGuard.test.ts` pattern.
 *
 * Phase 144 (EPA-04) — Plan 01
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve(__dirname, "..");

// D-15/D-16 — patterns that must be GONE from community src/ after the move.
const AUDIT_PATTERNS: RegExp[] = [
  // Moved route file (relative imports — prefix varies by caller depth).
  /from\s+["'](\.\.\/)+routes\/eventLogs["']/,
  /from\s+["']\.\/routes\/eventLogs["']/,
  // Moved query function (D-15).
  /\bgetEventLogs\b/,
  // D-16 — the shim must never write directly.
  /prisma\.eventLog\.create/,
];

// Directories excluded from the walk — mocks + tests contain the strings by
// design (mocks wire the module name, tests assert on the moved code),
// dist/ is generated, node_modules/ is third-party, generated/ holds the
// Prisma generated client (it references prisma.eventLog.create in its type
// declarations — not community source).
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

describe("D-15/D-16: Audit log extraction grep-guard", () => {
  it("zero audit-log imports/writes remain in community src/ (all moved to enterprise)", () => {
    const files = walkTsFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of AUDIT_PATTERNS) {
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
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * backupExtractionGuard.test.ts — D-18 grep-guard.
 *
 * Asserts ZERO backup service/route/scheduler code remains in the community
 * `packages/server/src/` tree (excluding `__mocks__/`, `__tests__/`, `dist/`,
 * `node_modules/`, `generated/`). This is the phase's regression gate: after
 * Plan 01 the backup scheduler service, the backup job worker, the backup
 * service, the 4 route files, and the `@mintplex-labs/bree` dependency have
 * all moved to the enterprise plugin. The community `enterpriseLoader.ts`
 * is EXCLUDED (it keeps the `registerScheduler`/`onShutdown` hooks — the
 * generic plugin lifecycle seam, not backup-specific code).
 *
 * Pattern list (D-18):
 *   - `from "...routes/(backups|backupJobs|backupDestinations|restore)"` —
 *     the moved route files (relative imports — prefix varies by caller depth).
 *   - `from "...services/(backupService|backupSchedulerService|backupJobWorker|restoreService|backupRetention)"` —
 *     the moved service files.
 *   - `@mintplex-labs/bree` — the moved Bree dependency.
 *   - `/api/system/backups`, `/api/backup-destinations`, `/api/backup-jobs` —
 *     the moved mount paths.
 *   - `createBackupJobScheduler`, `bootstrapJobs`, `stopAllJobs` — the moved
 *     scheduler lifecycle functions.
 *
 * Mirrors the Phase 143/144 `ssoExtractionGuard.test.ts` /
 * `auditLogExtractionGuard.test.ts` pattern.
 *
 * Phase 146 (EPA-06) — Plan 01
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve(__dirname, "..");

// D-18 — patterns that must be GONE from community src/ after the move.
const BACKUP_PATTERNS: RegExp[] = [
  // Moved route files (relative imports — prefix varies by caller depth).
  /from\s+["'](\.\.\/)+routes\/(backups|backupJobs|backupDestinations|restore)["']/,
  /from\s+["']\.\/routes\/(backups|backupJobs|backupDestinations|restore)["']/,
  // Moved service files.
  /from\s+["'](\.\.\/)+services\/(backupService|backupSchedulerService|backupJobWorker|restoreService|backupRetention)["']/,
  /from\s+["']\.\/services\/(backupService|backupSchedulerService|backupJobWorker|restoreService|backupRetention)["']/,
  // Moved Bree dependency.
  /@mintplex-labs\/bree/,
  // Moved mount paths.
  /\/api\/system\/backups/,
  /\/api\/backup-destinations/,
  /\/api\/backup-jobs/,
  // Moved scheduler lifecycle functions.
  /\bcreateBackupJobScheduler\b/,
  /\bbootstrapJobs\b/,
  /\bstopAllJobs\b/,
];

// Directories excluded from the walk — mocks + tests contain the strings by
// design, dist/ is generated, node_modules/ is third-party, generated/ holds
// the Prisma generated client.
const EXCLUDED_DIRS = new Set(["__mocks__", "__tests__", "dist", "node_modules", "generated"]);

// enterpriseLoader.ts is EXCLUDED — it keeps the registerScheduler/onShutdown
// hooks (the generic plugin lifecycle seam, not backup-specific code).
const EXCLUDED_FILES = new Set(["enterpriseLoader.ts"]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !EXCLUDED_FILES.has(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("D-18: backup extraction grep-guard", () => {
  it("zero backup code remains in community src/ (all moved to enterprise)", () => {
    const files = walkTsFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of BACKUP_PATTERNS) {
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
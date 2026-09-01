// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Regression test for CSW-10 / Phase 156-01 — guards against re-introducing
 * per-file `eslint-disable-next-line react-hooks/exhaustive-deps` suppressions
 * in the 10 frontend Settings/hook files that were cleaned up.
 *
 * These suppressions hide latent stale-closure bug sites (CONCERNS.md §Tech
 * Debt). Each was resolved in Phase 156-01 by either fixing the deps array
 * or documenting an intentional empty-deps escape hatch (D-05). This test
 * reads the source files directly and asserts none of the 10 sites
 * re-introduces the suppression comment.
 *
 * This is a static-source invariant — it complements (not replaces) the
 * `pnpm --filter @simmetric-chat/frontend lint` gate, which also catches
 * new suppressions elsewhere in the tree.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SUPPRESSION = "eslint-disable-next-line react-hooks/exhaustive-deps";

const FILES = [
  "src/components/SettingsProfile.tsx",
  "src/components/SettingsVapid.tsx",
  "src/components/SettingsReranker.tsx",
  "src/components/SettingsAgentWatchdog.tsx",
  "src/components/SettingsWebSearch.tsx",
  "src/components/SettingsBackups.tsx",
  "src/components/SettingsAppearance.tsx",
  "src/components/SettingsGeneral.tsx",
  "src/components/McpPinnerPopover.tsx",
  "src/hooks/usePageMeta.ts",
];

// __dirname is .../src/__tests__; go up two levels to reach the frontend
// package root, then join the file paths (which are already src/-rooted).
const root = resolve(__dirname, "..", "..");

describe("CSW-10: no react-hooks/exhaustive-deps suppressions in the 10 cleaned-up files", () => {
  for (const rel of FILES) {
    it(`${rel} contains no exhaustive-deps suppression`, () => {
      const src = readFileSync(resolve(root, rel), "utf8");
      expect(src).not.toContain(SUPPRESSION);
    });
  }
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 87-01 Task 2 — SourceCitation local-declaration-removed grep guard (TYP-01 D-05b).
 *
 * Asserts that `agent/skills.ts` no longer declares a local `interface
 * SourceCitation` and instead re-exports the canonical type from
 * @simmetric-chat/shared (D-03). This is a process guard: if a future change
 * re-introduces a local declaration, this test fails.
 *
 * Unit-level (no DB harness) — sidesteps the integration-harness-maindb-leak
 * landmine per RESEARCH Pitfall 5. The grep-guard idiom mirrors
 * orchestrator.disableRagSearch.test.ts:119-127.
 */

import * as fs from "fs";
import * as path from "path";

describe("SourceCitation local declaration removed (TYP-01 D-05b)", () => {
  it("agent/skills.ts no longer declares a local interface SourceCitation", () => {
    const skillsPath = path.resolve(__dirname, "../agent/skills.ts");
    const source = fs.readFileSync(skillsPath, "utf-8");
    // D-03: the local interface must be gone.
    expect(source).not.toMatch(/interface\s+SourceCitation\s*\{/);
    // D-03: the re-export from @simmetric-chat/shared must be present.
    expect(source).toMatch(/export type \{ SourceCitation \} from "@simmetric-chat\/shared"/);
  });
});
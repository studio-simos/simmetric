// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 90-01 Task 3 — SourceCitation widget split-host seam test (D-05).
 *
 * Mirrors packages/server/src/__tests__/sourceCitationSeam.test.ts and
 * packages/frontend/src/__tests__/sourceCitationSeam.test.ts. Completes the
 * 4-host coverage (shared canonical + 3 re-export hosts: server, frontend,
 * widget) as required by CIT-01 success criterion 1.
 *
 * Unit-level, no DB harness. The grep-guard idiom mirrors
 * orchestrator.disableRagSearch.test.ts and the existing server/frontend
 * seam tests.
 */

import * as fs from "fs";
import * as path from "path";

describe("SourceCitation widget seam (Phase 90 D-05)", () => {
  it("useWidgetChat.ts re-exports SourceCitation from @simmetric-chat/shared", () => {
    const useWidgetChatPath = path.resolve(
      __dirname,
      "../widget/hooks/useWidgetChat.ts",
    );
    const source = fs.readFileSync(useWidgetChatPath, "utf-8");
    // D-02: the local declaration must be gone.
    expect(source).not.toMatch(/interface\s+SourceCitation\s*\{/);
    // D-02: the re-export from @simmetric-chat/shared must be present.
    expect(source).toMatch(
      /export type \{ SourceCitation \} from "@simmetric-chat\/shared"/,
    );
  });

  it("no local `interface SourceCitation` declaration remains in widget sources", () => {
    const widgetSrcRoot = path.resolve(__dirname, "..");
    const matches: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(t|j)sx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf-8");
          if (/interface\s+SourceCitation\s*\{/.test(text)) {
            matches.push(full);
          }
        }
      }
    };
    walk(widgetSrcRoot);
    expect(matches).toEqual([]);
  });

  it("4-host invariant: only shared/src/types/index.ts declares `interface SourceCitation`", () => {
    // Completes the 4-host coverage (shared canonical + 3 re-export hosts:
    // server, frontend, widget) as required by CIT-01 success criterion 1.
    const packagesRoot = path.resolve(__dirname, "../../..");
    const skipDirs = ["/dist/", "/dist-widget/", "/node_modules/", "/__tests__/"];
    const matches: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.some((s) => full.includes(s))) continue;
          walk(full);
        } else if (/\.(t|j)sx?$/.test(entry.name)) {
          if (skipDirs.some((s) => full.includes(s))) continue;
          const text = fs.readFileSync(full, "utf-8");
          if (/interface\s+SourceCitation\s*\{/.test(text)) {
            matches.push(full);
          }
        }
      }
    };
    walk(packagesRoot);
    // Only the canonical declaration in shared/src/types/index.ts is allowed.
    // Test description strings in __tests__/ files are excluded via skipDirs.
    const canonical = matches.filter((p) =>
      p.includes("packages/shared/src/types/index.ts"),
    );
    const others = matches.filter(
      (p) => !p.includes("packages/shared/src/types/index.ts"),
    );
    expect(canonical.length).toBe(1);
    expect(others).toEqual([]);
  });
});
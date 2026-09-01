// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * F81 scission canary — Phase 88 MOD-02.
 *
 * Asserts the Phase 81 ChatContext/useChat scission fix stays intact through
 * the useChat.ts split. Sub-hooks MUST NOT import from `contexts/ChatContext`
 * (Pitfall 5 — re-coupling would regress the F81 fix).
 *
 * Uses `fs.readFileSync` + regex (NOT a runtime import) so the test fails
 * fast at import-time if a sub-hook re-couples. On base (before extraction),
 * the 3 sub-hook files don't exist yet — the test gracefully skips them.
 * Task 2 extends this canary to assert the new sub-hook files.
 *
 * Captured green on base BEFORE extraction (D-02).
 */

import * as fs from "fs";
import * as path from "path";

describe("F81 scission canary (ChatContext/useChat stay decoupled)", () => {
  const hooksDir = path.resolve(__dirname, "../hooks");

  // The forbidden import patterns — a sub-hook must NOT import from ChatContext.
  const FORBIDDEN_PATTERNS: RegExp[] = [
    /from\s+["']\.\.\/contexts\/ChatContext["']/,
    /from\s+["']\.\/ChatContext["']/,
    /from\s+["']\.\.\/\.\.\/contexts\/ChatContext["']/,
  ];

  function assertNoChatContextImport(filePath: string): void {
    const src = fs.readFileSync(filePath, "utf-8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(src).not.toMatch(pattern);
    }
  }

  it("useChat.ts does NOT import from contexts/ChatContext", () => {
    const p = path.join(hooksDir, "useChat.ts");
    expect(fs.existsSync(p)).toBe(true);
    assertNoChatContextImport(p);
  });

  // Task 2 extension: assert the 3 new sub-hooks (which don't exist on base)
  // also do NOT import from ChatContext. On base, these files don't exist —
  // the test gracefully skips. After Task 2 extraction, they exist and the
  // assertion enforces the F81 scission guard.
  const subHooks = [
    "useChatStreaming.ts",
    "useChatPersistence.ts",
    "useChatModelSelection.ts",
  ];

  for (const f of subHooks) {
    it(`${f} (if present) does NOT import from ChatContext`, () => {
      const p = path.join(hooksDir, f);
      if (!fs.existsSync(p)) {
        // Base: file not yet extracted — skip gracefully.
        return;
      }
      assertNoChatContextImport(p);
    });
  }

  it("useChat.ts does NOT re-export from contexts/ChatContext", () => {
    const p = path.join(hooksDir, "useChat.ts");
    const src = fs.readFileSync(p, "utf-8");
    // A `export ... from "../contexts/ChatContext"` would also re-couple.
    expect(src).not.toMatch(/export\s+.*from\s+["']\.\.\/contexts\/ChatContext["']/);
    expect(src).not.toMatch(/export\s+.*from\s+["']\.\/ChatContext["']/);
  });
});
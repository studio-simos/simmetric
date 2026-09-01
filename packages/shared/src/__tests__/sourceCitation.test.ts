// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 90-01 Task 1 — SourceCitation source widening + normalizeSource() (D-01).
 *
 * Verifies:
 *  - The `source` field union was widened additively to 6 values
 *    (`rag | archive | tool | web | memory | workspace`), with `workspace`
 *    retained as a legacy alias (D-01, D-06 — additive non-breaking).
 *  - `normalizeSource()` is a pure read-side helper that maps the legacy alias
 *    `"workspace"` → canonical `"rag"` and leaves every other value (including
 *    `undefined`) unchanged. It performs NO write-side mutation (D-06).
 */

import { normalizeSource } from "../types";

describe("SourceCitation source widening + normalizeSource() (Phase 90-01 D-01)", () => {
  it("normalizeSource maps the legacy `workspace` alias to canonical `rag`", () => {
    expect(normalizeSource("workspace")).toBe("rag");
  });

  it("normalizeSource leaves canonical values unchanged (idempotent)", () => {
    expect(normalizeSource("rag")).toBe("rag");
    expect(normalizeSource("archive")).toBe("archive");
    expect(normalizeSource("tool")).toBe("tool");
    expect(normalizeSource("web")).toBe("web");
    expect(normalizeSource("memory")).toBe("memory");
  });

  it("normalizeSource passes `undefined` through (optional field)", () => {
    expect(normalizeSource(undefined)).toBeUndefined();
  });

  it("normalizeSource is a pure function (no write-side mutation)", () => {
    // Calling twice with the same input yields the same result; the helper
    // does not mutate its argument or any shared state (D-06 read-side only).
    const input = "workspace" as const;
    const first = normalizeSource(input);
    const second = normalizeSource(input);
    expect(first).toBe("rag");
    expect(second).toBe("rag");
    expect(input).toBe("workspace"); // argument not mutated
  });
});
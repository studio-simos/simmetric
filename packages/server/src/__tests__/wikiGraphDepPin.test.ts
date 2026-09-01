// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck
// Dep-pin enforcement (D-05).
// graphology + graphology-communities-louvain must be pinned to EXACT versions
// (0.26.0 + 2.0.2). A dep bump that adds a caret/tilde or changes the version
// FAILS this test — surfacing the non-determinism risk at CI time.
import fs from "fs";
import path from "path";
import { describe, it, expect } from "@jest/globals";

describe("wiki-graph dep pin (D-05)", () => {
  const pkgPath = path.resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const deps = pkg.dependencies || {};

  it("graphology is pinned to exactly 0.26.0 (no caret/tilde)", () => {
    expect(deps.graphology).toBe("0.26.0");
  });

  it("graphology-communities-louvain is pinned to exactly 2.0.2 (no caret/tilde)", () => {
    expect(deps["graphology-communities-louvain"]).toBe("2.0.2");
  });

  it("neither dep uses a semver range operator (^/~/>=)", () => {
    expect(deps.graphology).not.toMatch(/^[\^~>=]/);
    expect(deps["graphology-communities-louvain"]).not.toMatch(/^[\^~>=]/);
  });
});
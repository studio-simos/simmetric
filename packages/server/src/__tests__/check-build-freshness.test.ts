// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Unit tests for the build-freshness check (DISC-02).
 *
 * Covers the 4 behavioral cases of `findStaleFiles(srcDir, distDir)`:
 *  - fresh dist (every src .ts has a dist .js with mtime >= src mtime) → []
 *  - stale dist (src newer than dist) → entry with "src newer than dist (stale)"
 *  - missing dist (no dist mirror) → entry with "missing in dist/"
 *  - exclude set (__tests__/, __mocks__/, *.test.ts, *.spec.ts) not walked
 *
 * Uses a throwaway src/ + dist/ pair under os.tmpdir() with fs.utimesSync to
 * control mtimes (the freshness check is filesystem-only — no git diff; per
 * 59-RESEARCH §Pattern 2 / Pitfall 2).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The check script is a .cjs (runs under plain Node in `pnpm start` before any
// build, mirroring fix-prisma-pnpm.cjs). `require()` of a .cjs file works under
// ts-jest; the destructured function is `any` so no type directive is needed.
const { findStaleFiles } = require("../../scripts/check-build-freshness.cjs") as {
  findStaleFiles: (srcDir: string, distDir: string) => string[];
};

describe("findStaleFiles", () => {
  let tmpRoot: string;
  let srcDir: string;
  let distDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "build-freshness-"));
    srcDir = path.join(tmpRoot, "src");
    distDir = path.join(tmpRoot, "dist");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns [] when every src .ts has a dist .js with mtime >= src mtime", () => {
    const srcFile = path.join(srcDir, "foo.ts");
    const distFile = path.join(distDir, "foo.js");
    fs.writeFileSync(srcFile, "export const foo = 1;");
    fs.writeFileSync(distFile, "module.exports = {};");
    // dist mtime 1s ahead of src → fresh
    const base = Math.floor(Date.now() / 1000);
    fs.utimesSync(srcFile, base, base);
    fs.utimesSync(distFile, base + 1, base + 1);
    expect(findStaleFiles(srcDir, distDir)).toEqual([]);
  });

  it("returns a stale entry when a src .ts is newer than its dist .js mirror", () => {
    const srcFile = path.join(srcDir, "foo.ts");
    const distFile = path.join(distDir, "foo.js");
    fs.writeFileSync(srcFile, "export const foo = 1;");
    fs.writeFileSync(distFile, "module.exports = {};");
    // src mtime 2s ahead of dist → stale
    const base = Math.floor(Date.now() / 1000);
    fs.utimesSync(srcFile, base + 2, base + 2);
    fs.utimesSync(distFile, base, base);
    const result = findStaleFiles(srcDir, distDir);
    expect(result).toHaveLength(1);
    const entry = result[0] ?? "";
    expect(entry).toContain("foo.js");
    expect(entry).toContain("src newer than dist (stale)");
  });

  it("returns a missing entry when the dist .js mirror does not exist", () => {
    const srcFile = path.join(srcDir, "foo.ts");
    fs.writeFileSync(srcFile, "export const foo = 1;");
    const result = findStaleFiles(srcDir, distDir);
    expect(result).toHaveLength(1);
    const entry = result[0] ?? "";
    expect(entry).toContain("foo.js");
    expect(entry).toContain("missing in dist/");
  });

  it("excludes __tests__/, __mocks__/, *.test.ts, *.spec.ts, *.d.ts files from the walk", () => {
    // bar.test.ts with no dist mirror — must NOT be reported (excluded by name)
    fs.writeFileSync(path.join(srcDir, "bar.test.ts"), "it('x', () => {});");
    // baz.spec.ts with no dist mirror — must NOT be reported (excluded by name)
    fs.writeFileSync(path.join(srcDir, "baz.spec.ts"), "it('y', () => {});");
    // __tests__/qux.ts with no dist mirror — must NOT be reported (excluded by path)
    fs.mkdirSync(path.join(srcDir, "__tests__"));
    fs.writeFileSync(
      path.join(srcDir, "__tests__", "qux.ts"),
      "export const qux = 1;",
    );
    // __mocks__/quux.ts with no dist mirror — must NOT be reported (excluded by path)
    fs.mkdirSync(path.join(srcDir, "__mocks__"));
    fs.writeFileSync(
      path.join(srcDir, "__mocks__", "quux.ts"),
      "export const quux = 1;",
    );
    // types.d.ts with no dist mirror — must NOT be reported (declaration files
    // emit .d.ts, not .js; checking for a .js mirror would be a false positive)
    fs.writeFileSync(
      path.join(srcDir, "types.d.ts"),
      "declare module 'foo';",
    );
    expect(findStaleFiles(srcDir, distDir)).toEqual([]);
  });
});
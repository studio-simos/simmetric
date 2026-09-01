// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 66.1-03 Task 2 — Assert main.tsx imports uiFontScale + uiDensity before App.
 *
 * Reads the main.tsx source and verifies:
 *  1. `import "./lib/uiFontScale";` appears BEFORE any `from "./App"` import.
 *  2. `import "./lib/uiDensity";` appears BEFORE any `from "./App"` import.
 *  3. main.tsx does NOT use inline-script injection (no document.write / innerHTML).
 *
 * tsconfig excludes this dir; ts-jest transpiles without type-checking, so
 * `fs`/`path`/`__dirname` are available at runtime under Node.
 */

const fs = require("fs");
const path = require("path");

function readMainTsxSource(): string {
  return fs.readFileSync(
    path.resolve(__dirname, "../main.tsx"),
    "utf8",
  );
}

function lineNumberOfFirstMatch(lines: string[], pattern: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i]!)) return i + 1; // 1-based
  }
  return -1;
}

describe("main.tsx import order", () => {
  test('import "./lib/uiFontScale" appears before any App import', () => {
    const src = readMainTsxSource();
    const lines = src.split(/\r?\n/);
    const fontScaleLine = lineNumberOfFirstMatch(
      lines,
      /import\s+["']\.\/lib\/uiFontScale["'];?/,
    );
    expect(fontScaleLine).toBeGreaterThan(0);
    const appLine = lineNumberOfFirstMatch(lines, /from\s+["']\.\/App["']/);
    expect(appLine).toBeGreaterThan(0);
    expect(fontScaleLine).toBeLessThan(appLine);
  });

  test('import "./lib/uiDensity" appears before any App import', () => {
    const src = readMainTsxSource();
    const lines = src.split(/\r?\n/);
    const densityLine = lineNumberOfFirstMatch(
      lines,
      /import\s+["']\.\/lib\/uiDensity["'];?/,
    );
    expect(densityLine).toBeGreaterThan(0);
    const appLine = lineNumberOfFirstMatch(lines, /from\s+["']\.\/App["']/);
    expect(appLine).toBeGreaterThan(0);
    expect(densityLine).toBeLessThan(appLine);
  });

  test("main.tsx does NOT use inline-script injection (document.write / innerHTML)", () => {
    const src = readMainTsxSource();
    expect(src).not.toMatch(/document\.write/);
    expect(src).not.toMatch(/\.innerHTML\s*=/);
  });
});
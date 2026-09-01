// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 66.1-03 Task 1 — Unit tests for src/lib/uiFontScale.ts
 *
 * Verifies:
 *  - readUiFontScale() returns "md" when localStorage is null / unknown / SSR
 *  - readUiFontScale() returns "sm" / "lg" when localStorage matches
 *  - applyUiFontScale() sets the --ui-font-scale CSS var on documentElement
 *  - applyUiFontScale() is a no-op when document is undefined (SSR guard)
 *  - module-level init applies the saved scale to <html> on first import
 *
 * tsconfig excludes this dir; ts-jest transpiles without type-checking.
 */

function resetDom() {
  document.documentElement.className = "";
  document.documentElement.style.cssText = "";
}

beforeEach(() => {
  jest.resetModules();
  if (typeof localStorage !== "undefined") localStorage.clear();
  resetDom();
});

describe("uiFontScale", () => {
  test("readUiFontScale() returns 'md' when localStorage has no key", () => {
    const { readUiFontScale } = require("../lib/uiFontScale");
    expect(readUiFontScale()).toBe("md");
  });

  test("readUiFontScale() returns 'lg'/'sm' for matching values, 'md' otherwise", () => {
    const { readUiFontScale } = require("../lib/uiFontScale");
    localStorage.setItem("uiFontScale", "lg");
    expect(readUiFontScale()).toBe("lg");
    localStorage.setItem("uiFontScale", "sm");
    expect(readUiFontScale()).toBe("sm");
    localStorage.setItem("uiFontScale", "garbage");
    expect(readUiFontScale()).toBe("md");
  });

  test("readUiFontScale() returns 'md' when typeof localStorage === 'undefined' (SSR)", () => {
    const original = (globalThis as unknown as { localStorage: Storage }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        return undefined;
      },
    });
    try {
      const { readUiFontScale } = require("../lib/uiFontScale");
      expect(readUiFontScale()).toBe("md");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          return original;
        },
      });
    }
  });

  test("applyUiFontScale('lg') sets --ui-font-scale to 1.0625rem", () => {
    const { applyUiFontScale } = require("../lib/uiFontScale");
    applyUiFontScale("lg");
    expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe("1.0625rem");
  });

  test("applyUiFontScale('sm')→0.9375rem, 'md'→1rem", () => {
    const { applyUiFontScale } = require("../lib/uiFontScale");
    applyUiFontScale("sm");
    expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe("0.9375rem");
    applyUiFontScale("md");
    expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe("1rem");
  });

  test("applyUiFontScale has an SSR guard for typeof document === 'undefined'", () => {
    // jsdom's `document` is a non-configurable getter, so we cannot truly
    // simulate `typeof document === "undefined"` at runtime. Instead, verify
    // the guard is present in the source (same pattern as ChatThemes.test.tsx
    // reading CSS source). The guard is a trivial mirror of ThemeContext.tsx.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../lib/uiFontScale.ts"),
      "utf8",
    );
    expect(src).toMatch(/typeof document === ["']undefined["']/);
    expect(src).toMatch(/if \(typeof document === ["']undefined["']\) return;/);
  });

  test("module-level init applies the saved scale to <html> on first import", () => {
    localStorage.setItem("uiFontScale", "lg");
    jest.isolateModules(() => {
      require("../lib/uiFontScale");
    });
    expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe("1.0625rem");
  });
});
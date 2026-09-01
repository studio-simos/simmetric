// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 66.1-03 Task 1 — Unit tests for src/lib/uiDensity.ts
 *
 * Verifies:
 *  - readDensity() returns "comfortable" by default, "compact" when stored
 *  - readDensity() SSR-safe
 *  - applyDensity() toggles the `density-compact` class on documentElement
 *  - applyDensity() is a no-op when document is undefined (SSR guard)
 *  - module-level init applies the saved density to <html> on first import
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

describe("uiDensity", () => {
  test("readDensity() returns 'comfortable' when null, 'compact' when stored, 'comfortable' otherwise", () => {
    const { readDensity } = require("../lib/uiDensity");
    expect(readDensity()).toBe("comfortable");
    localStorage.setItem("uiDensity", "compact");
    expect(readDensity()).toBe("compact");
    localStorage.setItem("uiDensity", "garbage");
    expect(readDensity()).toBe("comfortable");
  });

  test("readDensity() SSR-safe (returns default when typeof localStorage === 'undefined')", () => {
    const original = (globalThis as unknown as { localStorage: Storage }).localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        return undefined;
      },
    });
    try {
      const { readDensity } = require("../lib/uiDensity");
      expect(readDensity()).toBe("comfortable");
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          return original;
        },
      });
    }
  });

  test("applyDensity('compact') adds density-compact class; 'comfortable' removes it", () => {
    const { applyDensity } = require("../lib/uiDensity");
    applyDensity("compact");
    expect(document.documentElement.classList.contains("density-compact")).toBe(true);
    applyDensity("comfortable");
    expect(document.documentElement.classList.contains("density-compact")).toBe(false);
  });

  test("applyDensity has an SSR guard for typeof document === 'undefined'", () => {
    // jsdom's `document` is a non-configurable getter, so we cannot truly
    // simulate `typeof document === "undefined"` at runtime. Instead, verify
    // the guard is present in the source (same pattern as ChatThemes.test.tsx
    // reading CSS source). The guard is a trivial mirror of ThemeContext.tsx.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../lib/uiDensity.ts"),
      "utf8",
    );
    expect(src).toMatch(/typeof document === ["']undefined["']/);
    expect(src).toMatch(/if \(typeof document === ["']undefined["']\) return;/);
  });

  test("module-level init applies the saved density to <html> on first import", () => {
    localStorage.setItem("uiDensity", "compact");
    jest.isolateModules(() => {
      require("../lib/uiDensity");
    });
    expect(document.documentElement.classList.contains("density-compact")).toBe(true);
  });
});
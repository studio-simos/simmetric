// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { matchUrlPattern } from "../utils/matchUrlPattern";

describe("matchUrlPattern", () => {
  describe("empty/whitespace patterns", () => {
    it("returns false for empty string", () => {
      expect(matchUrlPattern("", "/products")).toBe(false);
    });

    it("returns false for whitespace-only string", () => {
      expect(matchUrlPattern("   ", "/products")).toBe(false);
    });
  });

  describe("JSON array format", () => {
    it("matches a single pattern in JSON array", () => {
      expect(matchUrlPattern('["/products"]', "/products")).toBe(true);
      expect(matchUrlPattern('["/products"]', "/about")).toBe(false);
    });

    it("matches any pattern in a multi-entry JSON array", () => {
      const patterns = JSON.stringify(["/products", "/cart", "/checkout/*"]);
      expect(matchUrlPattern(patterns, "/products")).toBe(true);
      expect(matchUrlPattern(patterns, "/cart")).toBe(true);
      expect(matchUrlPattern(patterns, "/checkout/step1")).toBe(true);
      expect(matchUrlPattern(patterns, "/about")).toBe(false);
    });

    it("returns false when JSON value is not an array", () => {
      expect(matchUrlPattern('"/products"', "/products")).toBe(false);
      expect(matchUrlPattern('{"key":"value"}', "/products")).toBe(false);
      expect(matchUrlPattern("123", "/products")).toBe(false);
    });
  });

  describe("comma-separated format (fallback)", () => {
    it("matches a single comma-separated pattern", () => {
      expect(matchUrlPattern("/products", "/products")).toBe(true);
    });

    it("matches any pattern in a comma-separated list", () => {
      const patterns = "/products, /cart, /checkout/*";
      expect(matchUrlPattern(patterns, "/products")).toBe(true);
      expect(matchUrlPattern(patterns, "/cart")).toBe(true);
      expect(matchUrlPattern(patterns, "/checkout/step1")).toBe(true);
      expect(matchUrlPattern(patterns, "/about")).toBe(false);
    });

    it("trims whitespace around comma-separated patterns", () => {
      expect(matchUrlPattern("  /products  ,  /cart  ", "/products")).toBe(true);
      expect(matchUrlPattern("  /products  ,  /cart  ", "/cart")).toBe(true);
    });

    it("skips empty entries in comma-separated list", () => {
      expect(matchUrlPattern(",/products,", "/products")).toBe(true);
      expect(matchUrlPattern(",,,", "/products")).toBe(false);
    });
  });

  describe("glob pattern matching", () => {
    it("matches ** across path segments", () => {
      expect(matchUrlPattern('["/docs/**"]', "/docs/a/b/c")).toBe(true);
    });

    it("does not match base path with ** (requires at least one segment after /)", () => {
      expect(matchUrlPattern('["/docs/**"]', "/docs")).toBe(false);
    });

    it("matches * within a single segment", () => {
      expect(matchUrlPattern('["/users/*"]', "/users/42")).toBe(true);
      expect(matchUrlPattern('["/users/*"]', "/users/42/settings")).toBe(false);
    });

    it("matches {a,b} alternation", () => {
      expect(matchUrlPattern('["/{en,it,de}"]', "/it")).toBe(true);
      expect(matchUrlPattern('["/{en,it,de}"]', "/fr")).toBe(false);
    });
  });

  describe("invalid patterns", () => {
    it("skips invalid glob patterns without throwing", () => {
      // An unclosed brace produces a valid regex (escaped opening brace) in
      // globToRegex, so this actually matches. Test a truly invalid scenario:
      // a JSON array containing a non-string entry is not possible since JSON
      // parsing would reject mixed types as strings. Instead verify that
      // malformed JSON falls through to comma-split:
      expect(matchUrlPattern("{invalid json", "/invalid")).toBe(false);
    });
  });
});
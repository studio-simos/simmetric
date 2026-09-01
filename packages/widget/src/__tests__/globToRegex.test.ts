// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { globToRegex } from "../utils/globToRegex";

describe("globToRegex", () => {
  describe("literal patterns", () => {
    it("matches exact path", () => {
      expect(globToRegex("/products").test("/products")).toBe(true);
      expect(globToRegex("/products").test("/product")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(globToRegex("/Products").test("/products")).toBe(true);
      expect(globToRegex("/products").test("/PRODUCTS")).toBe(true);
    });

    it("escapes regex special chars in literal", () => {
      const re = globToRegex("/path.with.dots");
      expect(re.test("/path.with.dots")).toBe(true);
      expect(re.test("/pathXwithXdots")).toBe(false);
    });
  });

  describe("single * (one path segment)", () => {
    it("matches any chars within a single segment", () => {
      expect(globToRegex("/users/*").test("/users/42")).toBe(true);
      expect(globToRegex("/users/*").test("/users/abc")).toBe(true);
    });

    it("does not match across slashes", () => {
      expect(globToRegex("/users/*").test("/users/42/settings")).toBe(false);
    });
  });

  describe("** (any number of segments)", () => {
    it("matches a single segment after /", () => {
      expect(globToRegex("/docs/**").test("/docs/a")).toBe(true);
    });

    it("matches multiple segments", () => {
      expect(globToRegex("/docs/**").test("/docs/a/b/c")).toBe(true);
    });

    it("does not match the base path without trailing slash (the / before ** is consumed)", () => {
      expect(globToRegex("/docs/**").test("/docs")).toBe(false);
    });

    it("matches a single segment after **/", () => {
      expect(globToRegex("/docs/**/edit").test("/docs/x/edit")).toBe(true);
      expect(globToRegex("/docs/**/edit").test("/docs/x/y/edit")).toBe(true);
    });
  });

  describe("? (single char)", () => {
    it("matches exactly one character", () => {
      expect(globToRegex("/p?").test("/pa")).toBe(true);
      expect(globToRegex("/p?").test("/pab")).toBe(false);
    });

    it("does not match slash", () => {
      expect(globToRegex("/p?").test("/p/")).toBe(false);
    });
  });

  describe("{a,b} alternation", () => {
    it("matches either option", () => {
      expect(globToRegex("/{en,it}").test("/en")).toBe(true);
      expect(globToRegex("/{en,it}").test("/it")).toBe(true);
      expect(globToRegex("/{en,it}").test("/de")).toBe(false);
    });

    it("matches within a larger pattern", () => {
      expect(globToRegex("/products/{list,grid}/*").test("/products/list/42")).toBe(true);
      expect(globToRegex("/products/{list,grid}/*").test("/products/grid/42")).toBe(true);
      expect(globToRegex("/products/{list,grid}/*").test("/products/detail/42")).toBe(false);
    });

    it("escapes special chars inside alternation options", () => {
      const re = globToRegex("/{a.b,c*d}");
      expect(re.test("/a.b")).toBe(true);
      expect(re.test("/axb")).toBe(false);
    });
  });

  describe("anchoring", () => {
    it("matches full path only (^...$)", () => {
      expect(globToRegex("/products").test("/products/extra")).toBe(false);
      expect(globToRegex("/products").test("prefix/products")).toBe(false);
    });
  });

  describe("complex patterns", () => {
    it("combines * and {a,b}", () => {
      expect(globToRegex("/*/settings/*").test("/ws1/settings/general")).toBe(true);
      expect(globToRegex("/*/settings/*").test("/ws1/settings/general/extra")).toBe(false);
    });

    it("combines ** and ?", () => {
      expect(globToRegex("/api/**/v?").test("/api/users/v1")).toBe(true);
      expect(globToRegex("/api/**/v?").test("/api/users/settings/v2")).toBe(true);
      expect(globToRegex("/api/**/v?").test("/api/users/v1/extra")).toBe(false);
    });
  });
});
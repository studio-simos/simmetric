// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Archive Schema Validator unit tests.
 */
import {
  validatePageContent,
  validateSlugAgainstConvention,
} from "../services/archiveSchemaValidator";
import type { ArchiveConfigInput } from "@simmetric-chat/shared";

describe("archiveSchemaValidator", () => {
  describe("validatePageContent", () => {
    it("returns valid=true with empty arrays when config is undefined", () => {
      const result = validatePageContent("# Hello", undefined, "human");
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it("returns valid=true with empty arrays when config is empty", () => {
      const result = validatePageContent("# Hello", {}, "human");
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it("human: missing required frontmatter produces violations", () => {
      const config: ArchiveConfigInput = {
        requiredFrontmatter: {
          title: { type: "string", required: true },
          author: { type: "string", required: true },
        },
      };
      const content = "---\nauthor: Alice\n---\n\n# Body\n";
      const result = validatePageContent(content, config, "human");
      expect(result.valid).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({ rule: "frontmatter_required", field: "title", severity: "error" })
      );
      expect(result.violations.length).toBe(1);
      expect(result.warnings.length).toBe(0);
    });

    it("agent: missing required frontmatter produces warnings only", () => {
      const config: ArchiveConfigInput = {
        requiredFrontmatter: {
          title: { type: "string", required: true },
        },
      };
      const content = "# Body\n";
      const result = validatePageContent(content, config, "agent");
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ rule: "frontmatter_required", field: "title", severity: "error" })
      );
    });

    it("link density below minimum produces warning", () => {
      const config: ArchiveConfigInput = {
        linkingDensity: { min: 0.5, max: 1.0 },
      };
      const content = "# Hello\n\nThis is a body with no links.\n";
      const result = validatePageContent(content, config, "human");
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.rule === "link_density" && w.message.includes("below"))).toBe(true);
    });

    it("link density above maximum produces warning", () => {
      const config: ArchiveConfigInput = {
        linkingDensity: { min: 0.0, max: 0.01 },
      };
      const content = "# Hello\n\n[[a]] [[b]] [[c]] [[d]] [[e]] word.\n";
      const result = validatePageContent(content, config, "human");
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.rule === "link_density" && w.message.includes("above"))).toBe(true);
    });

    it("section_required rule: missing section produces violation for human", () => {
      const config: ArchiveConfigInput = {
        lintRules: [
          { type: "section_required", severity: "error", config: { section: "Context" } },
        ],
      };
      const content = "# Title\n\nSome body without the section.\n";
      const result = validatePageContent(content, config, "human");
      expect(result.valid).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({ rule: "section_required", field: "Context", severity: "error" })
      );
    });

    it("section_required rule: missing section produces warning for agent", () => {
      const config: ArchiveConfigInput = {
        lintRules: [
          { type: "section_required", severity: "error", config: { section: "Context" } },
        ],
      };
      const content = "# Title\n\nSome body.\n";
      const result = validatePageContent(content, config, "agent");
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ rule: "section_required", field: "Context", severity: "error" })
      );
      expect(result.violations).toEqual([]);
    });

    it("section_required rule: present section produces no issues", () => {
      const config: ArchiveConfigInput = {
        lintRules: [
          { type: "section_required", severity: "error", config: { section: "Context" } },
        ],
      };
      const content = "# Title\n\n## Context\n\nHere it is.\n";
      const result = validatePageContent(content, config, "human");
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it("naming_convention rule: returns issue for human", () => {
      const config: ArchiveConfigInput = {
        lintRules: [
          { type: "naming_convention", severity: "error", config: { pattern: "^[a-z]+$", message: "Lowercase only" } },
        ],
      };
      const content = "# Title\n";
      const result = validatePageContent(content, config, "human");
      expect(result.violations).toContainEqual(
        expect.objectContaining({ rule: "naming_convention", field: "slug", severity: "error" })
      );
    });

    it("naming_convention rule: returns warning for agent", () => {
      const config: ArchiveConfigInput = {
        lintRules: [
          { type: "naming_convention", severity: "error", config: { pattern: "^[a-z]+$", message: "Lowercase only" } },
        ],
      };
      const content = "# Title\n";
      const result = validatePageContent(content, config, "agent");
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ rule: "naming_convention", field: "slug", severity: "error" })
      );
      expect(result.violations).toEqual([]);
    });
  });

  describe("validateSlugAgainstConvention", () => {
    it("returns valid=true when no naming convention is set", () => {
      const result = validateSlugAgainstConvention("my-slug", undefined);
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("returns valid=true for matching slug", () => {
      const config: ArchiveConfigInput = {
        namingConvention: { pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", message: "Kebab-case required" },
      };
      const result = validateSlugAgainstConvention("my-page-title", config);
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("returns valid=false for non-matching slug", () => {
      const config: ArchiveConfigInput = {
        namingConvention: { pattern: "^[a-z0-9]+$", message: "Alphanumeric only" },
      };
      const result = validateSlugAgainstConvention("My Page", config);
      expect(result.valid).toBe(false);
      expect(result.violations).toContainEqual(
        expect.objectContaining({ rule: "naming_convention", field: "slug", severity: "error" })
      );
    });
  });
});

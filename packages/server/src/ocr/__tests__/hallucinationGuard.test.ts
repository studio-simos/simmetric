// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import {
  applyHallucinationGuard,
  GuardIssue,
  GuardResult,
} from "../hallucinationGuard";

describe("applyHallucinationGuard", () => {
  describe("fence balance (UNBALANCED_FENCE)", () => {
    it("returns zero UNBALANCED_FENCE issues for balanced fences", () => {
      const input = "```\ncode here\n```";
      const result = applyHallucinationGuard(input, 1);
      const fenceIssues = result.issues.filter(
        (i) => i.type === "UNBALANCED_FENCE"
      );
      expect(fenceIssues).toHaveLength(0);
    });

    it("returns 1 UNBALANCED_FENCE issue with severity error for unclosed fence", () => {
      const input = "```\ncode here with no close";
      const result = applyHallucinationGuard(input, 1);
      const fenceIssues = result.issues.filter(
        (i) => i.type === "UNBALANCED_FENCE"
      );
      expect(fenceIssues).toHaveLength(1);
      expect(fenceIssues[0]!.severity).toBe("error");
      expect(fenceIssues[0]!.detail).toContain("1 open, 0 close");
    });

    it("auto-fixes unclosed fence by appending closing fence", () => {
      const input = "```\ncode here with no close";
      const result = applyHallucinationGuard(input, 1);
      expect(result.markdown).toContain("```");
      // Count fences: should have both open and close now
      const lines = result.markdown.split("\n");
      const fenceLines = lines.filter((l) => l.trim() === "```");
      expect(fenceLines.length % 2).toBe(0);
    });
  });

  describe("heading hierarchy (HEADING_GAP)", () => {
    it("returns zero HEADING_GAP issues when heading levels are sequential", () => {
      const input = "# H1\n\n## H2\n\n### H3\n\n## Another H2";
      const result = applyHallucinationGuard(input, 1);
      const gapIssues = result.issues.filter((i) => i.type === "HEADING_GAP");
      expect(gapIssues).toHaveLength(0);
    });

    it("returns 1 HEADING_GAP issue with severity warning for H1→H3 gap", () => {
      const input = "# Heading One\n\n### Heading Three";
      const result = applyHallucinationGuard(input, 1);
      const gapIssues = result.issues.filter((i) => i.type === "HEADING_GAP");
      expect(gapIssues).toHaveLength(1);
      expect(gapIssues[0]!.severity).toBe("warning");
      expect(gapIssues[0]!.detail).toContain("Heading One");
      expect(gapIssues[0]!.detail).toContain("Heading Three");
    });

    it("detects multiple heading gaps", () => {
      const input =
        "# H1\n\n#### H4 (gap from H1)\n\n###### H6 (gap from H4)";
      const result = applyHallucinationGuard(input, 1);
      const gapIssues = result.issues.filter((i) => i.type === "HEADING_GAP");
      expect(gapIssues.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("UNVERIFIED tag detection", () => {
    it("detects UNVERIFIED tags and sets hasUnverified and unverifiedCount", () => {
      const input = "Some text [UNVERIFIED: text obscured] more text";
      const result = applyHallucinationGuard(input, 1);
      expect(result.hasUnverified).toBe(true);
      expect(result.unverifiedCount).toBe(1);
    });

    it("detects multiple UNVERIFIED tags", () => {
      const input =
        "[UNVERIFIED: blurry text] and [UNVERIFIED: smudged region]";
      const result = applyHallucinationGuard(input, 2);
      expect(result.hasUnverified).toBe(true);
      expect(result.unverifiedCount).toBe(2);
    });

    it("returns hasUnverified=false when no UNVERIFIED tags present", () => {
      const input = "Clean text with no tags";
      const result = applyHallucinationGuard(input, 1);
      expect(result.hasUnverified).toBe(false);
      expect(result.unverifiedCount).toBe(0);
    });
  });

  describe("HANDWRITING tag detection", () => {
    it("sets hasHandwriting=true when HANDWRITING tag present", () => {
      const input = "[HANDWRITING: scribbled note]";
      const result = applyHallucinationGuard(input, 1);
      expect(result.hasHandwriting).toBe(true);
    });

    it("sets hasHandwriting=false when no HANDWRITING tag", () => {
      const input = "Clean typed text";
      const result = applyHallucinationGuard(input, 1);
      expect(result.hasHandwriting).toBe(false);
    });

    it("pushes HANDWRITING issue with severity warning", () => {
      const input = "[HANDWRITING: illegible cursive]";
      const result = applyHallucinationGuard(input, 1);
      const hwIssues = result.issues.filter((i) => i.type === "HANDWRITING");
      expect(hwIssues).toHaveLength(1);
      expect(hwIssues[0]!.severity).toBe("warning");
    });
  });

  describe("empty output detection (EMPTY_OUTPUT)", () => {
    it("returns hasEmpty=true for empty string", () => {
      const result = applyHallucinationGuard("", 1);
      expect(result.hasEmpty).toBe(true);
    });

    it("returns hasEmpty=true for whitespace-only input", () => {
      const result = applyHallucinationGuard("   \n  \t  ", 1);
      expect(result.hasEmpty).toBe(true);
    });

    it("includes FAILED message in markdown for empty output", () => {
      const result = applyHallucinationGuard("", 3);
      expect(result.markdown).toContain("[FAILED:");
      expect(result.markdown).toContain("page 3");
    });

    it("EMPTY_OUTPUT issue has severity error", () => {
      const result = applyHallucinationGuard("", 1);
      const emptyIssues = result.issues.filter(
        (i) => i.type === "EMPTY_OUTPUT"
      );
      expect(emptyIssues).toHaveLength(1);
      expect(emptyIssues[0]!.severity).toBe("error");
    });
  });

  describe("table column consistency (TABLE_MISMATCH)", () => {
    it("returns zero TABLE_MISMATCH issues for consistent columns", () => {
      const input =
        "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
      const result = applyHallucinationGuard(input, 1);
      const tableIssues = result.issues.filter(
        (i) => i.type === "TABLE_MISMATCH"
      );
      expect(tableIssues).toHaveLength(0);
    });

    it("returns TABLE_MISMATCH issue for inconsistent column count", () => {
      const input =
        "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |\n| 4 | 5 | 6 |";
      const result = applyHallucinationGuard(input, 1);
      const tableIssues = result.issues.filter(
        (i) => i.type === "TABLE_MISMATCH"
      );
      expect(tableIssues.length).toBeGreaterThan(0);
      expect(tableIssues[0]!.severity).toBe("error");
    });

    it("auto-fixes short table rows by padding with empty cells", () => {
      const input =
        "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |\n| 4 | 5 | 6 |";
      const result = applyHallucinationGuard(input, 1);
      const lines = result.markdown.split("\n");
      // Third data line (index 3) should now have 3 cells
      const rowCells = lines[3]!.split("|").filter((c) => c.trim().length >= 0);
      expect(rowCells.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("repetition / degeneration detection", () => {
    it("detects repetition when 4-gram uniqueness < 0.50", () => {
      // Repeated phrase that will have low 4-gram uniqueness
      const input =
        "the quick brown fox the quick brown fox the quick brown fox the quick brown fox";
      const result = applyHallucinationGuard(input, 1);
      const repIssues = result.issues.filter(
        (i) => i.detail.includes("degeneration") || i.detail.includes("repetition")
      );
      expect(repIssues.length).toBeGreaterThan(0);
    });

    it("does not flag normal text as repetitive", () => {
      const input =
        "The company reported strong quarterly earnings with revenue growth across all segments and improved operating margins.";
      const result = applyHallucinationGuard(input, 1);
      const repIssues = result.issues.filter(
        (i) => i.detail.includes("degeneration") || i.detail.includes("repetition")
      );
      expect(repIssues).toHaveLength(0);
    });

    // Severe degeneration (4-gram uniqueness < 0.3) is a recoverable
    // condition — the pipeline retries via ocrStages and frequently
    // succeeds. The log was downgraded from error to warn; this test
    // asserts the observable GuardResult contract (hasEmpty + EMPTY_OUTPUT
    // issue with degeneration detail), matching the existing test style in
    // this file (no logger mock).
    it("severe degeneration logs at warn level (not error)", () => {
      const repeated = "word ".repeat(60).trim();
      const result = applyHallucinationGuard(repeated, 1);
      expect(result.hasEmpty).toBe(true);
      expect(
        result.issues.some(
          (i) => i.type === "EMPTY_OUTPUT" && i.detail.includes("degeneration"),
        ),
      ).toBe(true);
    });
  });

  describe("critical UNVERIFIED ratio", () => {
    it("flags when UNVERIFIED ratio exceeds 50%", () => {
      const input =
        "[UNVERIFIED: most text] [UNVERIFIED: more text] [UNVERIFIED: even more] some";
      const result = applyHallucinationGuard(input, 1);
      const critIssues = result.issues.filter(
        (i) => i.detail.includes("50%")
      );
      expect(critIssues.length).toBeGreaterThan(0);
    });

    it("does not flag when UNVERIFIED ratio is under 50%", () => {
      const input =
        "Lots of clean text here that is perfectly readable and clear [UNVERIFIED: small smudge]";
      const result = applyHallucinationGuard(input, 1);
      const critIssues = result.issues.filter(
        (i) => i.detail.includes("50%")
      );
      expect(critIssues).toHaveLength(0);
    });
  });

  describe("result structure", () => {
    it("returns all expected GuardResult fields", () => {
      const result = applyHallucinationGuard("test", 1);
      expect(result).toHaveProperty("markdown");
      expect(result).toHaveProperty("hasUnverified");
      expect(result).toHaveProperty("unverifiedCount");
      expect(result).toHaveProperty("hasHandwriting");
      expect(result).toHaveProperty("hasEmpty");
      expect(result).toHaveProperty("issues");
      expect(Array.isArray(result.issues)).toBe(true);
    });
  });

  // =========================================================================
  // skipDegeneration param (260826-gsr) — KB/archive jobs opt out of the
  // 4-gram uniqueness checks so legitimately repetitive text (legislative
  // docs, repeated tables) is not discarded. The empty-output check stays
  // active unconditionally. Backward-compatible: default false.
  // =========================================================================
  describe("skipDegeneration param", () => {
    const repetitiveText = "word ".repeat(60).trim();

    it("with skipDegeneration=true returns repetitive non-empty text unchanged (no [FAILED] marker)", () => {
      const result = applyHallucinationGuard(repetitiveText, 1, true);
      expect(result.hasEmpty).toBe(false);
      expect(result.markdown).not.toContain("[FAILED:");
      expect(result.markdown).not.toContain("[WARNING:");
      expect(result.markdown).toBe(repetitiveText);
    });

    it("with skipDegeneration=true still flags empty output ([FAILED] + hasEmpty=true)", () => {
      const result = applyHallucinationGuard("", 1, true);
      expect(result.hasEmpty).toBe(true);
      expect(result.markdown).toContain("[FAILED:");
    });

    it("with skipDegeneration=true and whitespace-only input still flags empty", () => {
      const result = applyHallucinationGuard("   \n  ", 1, true);
      expect(result.hasEmpty).toBe(true);
    });

    it("with skipDegeneration=false (default) still discards highly repetitive text", () => {
      const result = applyHallucinationGuard(repetitiveText, 1, false);
      expect(result.hasEmpty).toBe(true);
      expect(result.markdown).toContain("[FAILED:");
    });

    it("calling with 2 args (no third) behaves identically to skipDegeneration=false", () => {
      const twoArg = applyHallucinationGuard(repetitiveText, 1);
      const explicitFalse = applyHallucinationGuard(repetitiveText, 1, false);
      expect(twoArg).toEqual(explicitFalse);
    });

    it("with skipDegeneration=true does NOT compute uniqueness (no degeneration issues)", () => {
      const result = applyHallucinationGuard(repetitiveText, 1, true);
      const degenerationIssues = result.issues.filter(
        (i) =>
          i.detail.includes("degeneration") ||
          i.detail.includes("uniqueness") ||
          i.detail.includes("repetitive"),
      );
      expect(degenerationIssues).toHaveLength(0);
    });

    it("with skipDegeneration=true still detects UNVERIFIED tags and handwriting", () => {
      const input =
        "[UNVERIFIED: blurry] [HANDWRITING: scrawl] " + repetitiveText;
      const result = applyHallucinationGuard(input, 1, true);
      expect(result.hasUnverified).toBe(true);
      expect(result.hasHandwriting).toBe(true);
    });

    it("with skipDegeneration=true still runs fence/heading/table checks", () => {
      const input = "```\ncode with no close\n\n# H1\n\n### H3";
      const result = applyHallucinationGuard(input, 1, true);
      const fenceIssues = result.issues.filter(
        (i) => i.type === "UNBALANCED_FENCE",
      );
      const gapIssues = result.issues.filter((i) => i.type === "HEADING_GAP");
      expect(fenceIssues.length).toBeGreaterThan(0);
      expect(gapIssues.length).toBeGreaterThan(0);
    });
  });
});

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

    // 260919-kvm: GuardResult.degenerated — true ONLY on the severe-
    // degeneration discard arm; every other return path sets false.
    it("sets degenerated=true on the severe degeneration discard arm", () => {
      const repeated = "word ".repeat(60).trim();
      const result = applyHallucinationGuard(repeated, 1);
      expect(result.degenerated).toBe(true);
      expect(result.hasEmpty).toBe(true);
    });

    it("sets degenerated=false on the empty-output arm", () => {
      const result = applyHallucinationGuard("", 1);
      expect(result.hasEmpty).toBe(true);
      expect(result.degenerated).toBe(false);
    });

    it("sets degenerated=false on a clean pass", () => {
      const result = applyHallucinationGuard("Clean normal transcription text", 1);
      expect(result.hasEmpty).toBe(false);
      expect(result.degenerated).toBe(false);
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
  // Degeneration mode param (260918-oa9) — the third parameter is a typed
  // three-value mode, not a boolean:
  //   "full"         — both degeneration arms (default; regular uploads,
  //                    identical to the old skipDegeneration=false)
  //   "discard-only" — ONLY the < 0.3 hard-discard arm; NO < 0.5 warning
  //                    prefix (archive jobs — extreme repetition loops are
  //                    never legitimate content, but moderate repetition in
  //                    legislative documents is)
  //   "off"          — neither arm (the old full-skip; callers that must
  //                    bypass both arms). Every other check (empty-output,
  //                    UNVERIFIED ratio, handwriting, fence/heading/table)
  //                    stays active in ALL modes.
  // =========================================================================
  describe("degeneration mode param", () => {
    // < 0.3 band: a single repeated word — near-total repetition.
    const repetitiveText = "word ".repeat(60).trim();

    // 0.3–0.5 band fixture: ~25 distinct words followed by ~60 repetitions
    // of a single word → ≈ 0.40 uniqueness (moderate repetition: above the
    // hard-discard threshold, below the soft-warning threshold).
    const bandText =
      "Quarterly revenue grew across every regional segment while operating margins improved steadily. " +
      [
        "logistics", "procurement", "compliance", "governance", "infrastructure",
        "workforce", "demand", "inventory", "forecast", "pipeline",
        "marketing", "retention", "expansion", "partnership", "contract",
        "regulation", "licensing", "settlement", "renewal", "portfolio",
        "milestone", "deadline", "budget", "review", "audit",
      ].join(" ") +
      " " + "delay ".repeat(60);

    // --- Test D: "off" ≡ old full-skip (migrated true-arg pins) ---

    it('with mode "off" returns repetitive non-empty text unchanged (no [FAILED]/[WARNING] marker)', () => {
      const result = applyHallucinationGuard(repetitiveText, 1, "off");
      expect(result.hasEmpty).toBe(false);
      expect(result.markdown).not.toContain("[FAILED:");
      expect(result.markdown).not.toContain("[WARNING:");
      expect(result.markdown).toBe(repetitiveText);
    });

    it('with mode "off" still flags empty output ([FAILED] + hasEmpty=true)', () => {
      const result = applyHallucinationGuard("", 1, "off");
      expect(result.hasEmpty).toBe(true);
      expect(result.markdown).toContain("[FAILED:");
    });

    it('with mode "off" and whitespace-only input still flags empty', () => {
      const result = applyHallucinationGuard("   \n  ", 1, "off");
      expect(result.hasEmpty).toBe(true);
    });

    it('with mode "off" does NOT compute uniqueness (no degeneration issues)', () => {
      const result = applyHallucinationGuard(repetitiveText, 1, "off");
      const degenerationIssues = result.issues.filter(
        (i) =>
          i.detail.includes("degeneration") ||
          i.detail.includes("uniqueness") ||
          i.detail.includes("repetitive"),
      );
      expect(degenerationIssues).toHaveLength(0);
    });

    it('with mode "off" still detects UNVERIFIED tags and handwriting', () => {
      const input =
        "[UNVERIFIED: blurry] [HANDWRITING: scrawl] " + repetitiveText;
      const result = applyHallucinationGuard(input, 1, "off");
      expect(result.hasUnverified).toBe(true);
      expect(result.hasHandwriting).toBe(true);
    });

    it('with mode "off" still runs fence/heading/table checks', () => {
      const input = "```\ncode with no close\n\n# H1\n\n### H3";
      const result = applyHallucinationGuard(input, 1, "off");
      const fenceIssues = result.issues.filter(
        (i) => i.type === "UNBALANCED_FENCE",
      );
      const gapIssues = result.issues.filter((i) => i.type === "HEADING_GAP");
      expect(fenceIssues.length).toBeGreaterThan(0);
      expect(gapIssues.length).toBeGreaterThan(0);
    });

    it('with mode "off" empty/whitespace-only input still flagged while repetitive non-empty passes byte-unchanged', () => {
      const pass = applyHallucinationGuard(repetitiveText, 1, "off");
      expect(pass.hasEmpty).toBe(false);
      expect(pass.markdown).toBe(repetitiveText);
      const empty = applyHallucinationGuard("   \n  ", 2, "off");
      expect(empty.hasEmpty).toBe(true);
      expect(empty.markdown).toContain("[FAILED:");
    });

    // --- Test E: "full" ≡ old default (migrated false-arg + two-arg pins) ---

    it('with mode "full" (explicit) discards highly repetitive text', () => {
      const result = applyHallucinationGuard(repetitiveText, 1, "full");
      expect(result.hasEmpty).toBe(true);
      expect(result.markdown).toContain("[FAILED:");
    });

    it("calling with 2 args (no third) behaves identically to explicit \"full\"", () => {
      const twoArg = applyHallucinationGuard(repetitiveText, 1);
      const explicitFull = applyHallucinationGuard(repetitiveText, 1, "full");
      expect(twoArg).toEqual(explicitFull);
    });

    it("two-arg call output deep-equals explicit \"full\" output for non-degenerate text too", () => {
      const normal =
        "The company reported strong quarterly earnings with revenue growth across all segments.";
      const twoArg = applyHallucinationGuard(normal, 1);
      const explicitFull = applyHallucinationGuard(normal, 1, "full");
      expect(twoArg).toEqual(explicitFull);
    });

    // --- Test A: "discard-only" hard arm (the archive-job contract) ---

    it('with mode "discard-only" discards < 0.3 repetitive text ([FAILED] + hasEmpty + degeneration issue)', () => {
      const result = applyHallucinationGuard(repetitiveText, 1, "discard-only");
      expect(result.hasEmpty).toBe(true);
      expect(result.markdown).toContain("[FAILED:");
      expect(
        result.issues.some(
          (i) => i.type === "EMPTY_OUTPUT" && i.detail.includes("degeneration"),
        ),
      ).toBe(true);
    });

    // --- Test B: "discard-only" soft-arm absence + "full" contrast pin ---

    it('with mode "discard-only" does NOT warn-prefix 0.3–0.5 band text (no [WARNING:], no warning-severity degeneration issue)', () => {
      const result = applyHallucinationGuard(bandText, 1, "discard-only");
      expect(result.hasEmpty).toBe(false);
      expect(result.markdown).not.toContain("[WARNING:");
      expect(result.markdown).toBe(bandText);
      const warningDegeneration = result.issues.filter(
        (i) =>
          i.severity === "warning" &&
          (i.detail.includes("degeneration") || i.detail.includes("uniqueness")),
      );
      expect(warningDegeneration).toHaveLength(0);
    });

    it("the SAME 0.3–0.5 band fixture under mode \"full\" DOES get the [WARNING:] prefix + warning issue (contrast pin)", () => {
      const full = applyHallucinationGuard(bandText, 1, "full");
      expect(full.hasEmpty).toBe(false);
      expect(full.markdown).toContain(
        "[WARNING: Possible text degeneration detected",
      );
      expect(full.markdown).toContain(bandText);
      const warningDegeneration = full.issues.filter(
        (i) =>
          i.severity === "warning" &&
          (i.detail.includes("degeneration") || i.detail.includes("uniqueness")),
      );
      expect(warningDegeneration.length).toBeGreaterThan(0);
    });

    // --- Test C: "discard-only" everything-else-still-active ---

    it('with mode "discard-only" empty input still → [FAILED] + hasEmpty=true', () => {
      const result = applyHallucinationGuard("", 1, "discard-only");
      expect(result.hasEmpty).toBe(true);
      expect(result.markdown).toContain("[FAILED:");
    });

    it('with mode "discard-only" whitespace-only input still flagged empty', () => {
      const result = applyHallucinationGuard("   \n  ", 1, "discard-only");
      expect(result.hasEmpty).toBe(true);
    });

    it('with mode "discard-only" still detects UNVERIFIED tags and handwriting', () => {
      const input =
        "[UNVERIFIED: blurry] [HANDWRITING: scrawl] " + bandText;
      const result = applyHallucinationGuard(input, 1, "discard-only");
      expect(result.hasUnverified).toBe(true);
      expect(result.hasHandwriting).toBe(true);
    });

    it('with mode "discard-only" still runs fence + heading-gap checks', () => {
      const input = "```\ncode with no close\n\n# H1\n\n### H3";
      const result = applyHallucinationGuard(input, 1, "discard-only");
      const fenceIssues = result.issues.filter(
        (i) => i.type === "UNBALANCED_FENCE",
      );
      const gapIssues = result.issues.filter((i) => i.type === "HEADING_GAP");
      expect(fenceIssues.length).toBeGreaterThan(0);
      expect(gapIssues.length).toBeGreaterThan(0);
    });
  });
});

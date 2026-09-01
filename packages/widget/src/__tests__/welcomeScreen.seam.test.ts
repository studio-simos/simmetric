// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 129-03 Task 1 — WelcomeScreen suggested-question chip seam test (QST-03).
 *
 * The widget test environment is node-only (packages/widget/jest.config.js:13 —
 * testEnvironment: "node", no jsdom; T-65-SC forbids new test deps), so Preact
 * components cannot render. Following the sourceCitationSeam.test.ts idiom:
 * read the source file with fs.readFileSync and assert the class string /
 * handler contract with regex matches.
 *
 * Pins (D-03 / D-04 / QST-03 SC4 + CR-01 / G-129-1):
 * - line-clamp-2 on an INNER SPAN wrapping {question} (CR-01 fix — the clamp
 *   lives on the text element, NOT the flex container; G-129-1)
 * - cascade-regression guard: the chip button className carries
 *   `flex items-center justify-center` but NOT `line-clamp-2` — a single
 *   element combining both is the CR-01 equal-specificity cascade conflict
 *   (.flex{display:flex} overrides .line-clamp-2{display:-webkit-box})
 * - slice(0, 3) display cap preserved (max 3 chips regardless of admin list)
 * - onClick={() => onQuestionClick(question)} click-to-start-chat preserved
 * - type="button" + min-h-[44px] + leading-snug touch target / line-height kept
 *
 * Class-string pins only guard against removal, not against CSS cascade
 * conflicts (IN-04) — the cascade guard above is the structural regression
 * net for CR-01; visual truncation is the manual backstop (UI-SPEC E3) held
 * out for /gsd-verify-work.
 */

import * as fs from "fs";
import * as path from "path";

describe("WelcomeScreen seam (Phase 129 QST-03)", () => {
  const welcomeScreenPath = path.resolve(
    __dirname,
    "../widget/components/WelcomeScreen.tsx",
  );
  const source = fs.readFileSync(welcomeScreenPath, "utf-8");

  it("clamps the question text on an inner span, not the chip button (CR-01 — line-clamp-2 must not share an element with flex)", () => {
    // CR-01 fix (G-129-1): line-clamp-2 renders on an inner span wrapping the
    // question text — the clamp applies to the text element, not the flex
    // container. The equal-specificity cascade conflict (.flex{display:flex}
    // overrides .line-clamp-2{display:-webkit-box}) becomes structurally
    // impossible because the two utilities no longer share an element.
    expect(source).toMatch(/<span className="line-clamp-2">/);
  });

  it("cascade-regression guard: the chip button className combines flex centering but never line-clamp-2 (CR-01, G-129-1)", () => {
    // The chip button is the only element in WelcomeScreen.tsx carrying
    // min-h-[44px] — anchor the extraction on that unique class, then assert
    // the button still centers its content with flex but does NOT carry the
    // clamp. A single element combining `flex items-center justify-center`
    // with `line-clamp-2` is the CR-01 equal-specificity cascade conflict
    // (verified at byte level in the compiled bundle: .flex at offset 9305
    // overrides .line-clamp-2 at 9185).
    const buttonClassMatch = source.match(
      /className="([^"]*min-h-\[44px\][^"]*)"/,
    );
    expect(buttonClassMatch).not.toBeNull();
    const buttonClassName = buttonClassMatch![1];
    expect(buttonClassName).toContain("flex items-center justify-center");
    expect(buttonClassName).not.toContain("line-clamp-2");
  });

  it("preserves the slice(0, 3) display cap and the click-to-start-chat handler (D-03, QST-03 SC4)", () => {
    expect(source).toMatch(/slice\(0, 3\)/);
    expect(source).toMatch(/onClick=\{\(\) => onQuestionClick\(question\)\}/);
  });

  it("preserves type=\"button\" and the min-h-[44px] + leading-snug touch target (D-04)", () => {
    expect(source).toMatch(/type="button"/);
    expect(source).toMatch(/min-h-\[44px\]/);
    expect(source).toMatch(/leading-snug/);
  });
});

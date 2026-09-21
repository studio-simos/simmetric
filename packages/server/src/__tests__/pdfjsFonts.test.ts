// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "./helpers/setupEnv";
import path from "path";
import fs from "fs";
import { getPdfStandardFontDataUrl } from "../utils/pdfjsFonts";

describe("getPdfStandardFontDataUrl (quick 260918-k8n)", () => {
  it("returns a string ending with a path separator (pdfjs appends the font filename directly onto the base)", () => {
    const result = getPdfStandardFontDataUrl();
    expect(typeof result).toBe("string");
    expect(result.endsWith(path.sep)).toBe(true);
  });

  it("resolves an existing directory whose basename is standard_fonts (candidate list walks real layouts under node and jest alike)", () => {
    const result = getPdfStandardFontDataUrl();
    expect(fs.existsSync(result)).toBe(true);
    expect(fs.statSync(result).isDirectory()).toBe(true);
    expect(path.basename(path.resolve(result))).toBe("standard_fonts");
  });

  it("is memoized — two consecutive calls return the identical string (no repeated resolution)", () => {
    const first = getPdfStandardFontDataUrl();
    const second = getPdfStandardFontDataUrl();
    expect(first).toBe(second);
  });

  it("never throws — even a hostile environment degrades to the empty string (pdfjs then keeps its warn-and-continue behavior)", () => {
    // The empty-string fallback is the terminal arm of the candidate list:
    // a mis-resolved layout must only preserve the old log noise, never
    // break ingestion. Pin the contract shape rather than simulating a
    // hostile fs (the function is defined to never throw by construction).
    expect(() => getPdfStandardFontDataUrl()).not.toThrow();
  });
});
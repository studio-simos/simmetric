// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.
/**
 * Phase 145 (EPA-05 — D-12): white-label extraction grep guard.
 *
 * Asserts that the white-label branding route code + the hardcoded
 * `isFeatureEnabled("white_label")` config-key rejection have been
 * extracted from the community repo. The community `settings.ts` must
 * contain ZERO branding-icon route code; the community
 * `systemConfigService.ts` must contain ZERO hardcoded
 * `isFeatureEnabled("white_label")` calls AND must STILL contain the D-02
 * fallback (defense-in-depth for no-plugin community builds).
 *
 * Mirrors the Phase 143 D-15 / Phase 144 D-15 grep-guard pattern.
 *
 * Phase 145 (EPA-05) Plan 01
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC_DIR = path.resolve(__dirname, "..");

// D-12 — patterns that must be GONE from community settings.ts after the
// move to the enterprise package.
const BRANDING_ROUTE_PATTERNS: RegExp[] = [
  /brandingUpload/, // multer config moved to enterprise
  /\bBRAND_DIR\b/, // const moved to enterprise
  /\/branding\/icon/, // route paths moved to enterprise
  /requireFeature\(["']white_label["']\)/, // replaced by adminLicense in enterprise
];

// The OLD hardcoded check (isFeatureEnabled + BRANDING_) must be GONE from
// systemConfigService.ts — replaced by the validator loop + D-02 fallback.
const OLD_CHECK_PATTERN = /isFeatureEnabled\(["']white_label["']\)/;

const EXCLUDED_DIRS = new Set(["__mocks__", "__tests__", "dist", "node_modules", "generated"]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      walkTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("D-12: White-label extraction grep-guard", () => {
  it("zero branding-icon route code in settings.ts", () => {
    const settingsFile = path.resolve(SRC_DIR, "routes/settings.ts");
    const content = readFileSync(settingsFile, "utf8");
    const violations: string[] = [];
    for (const pattern of BRANDING_ROUTE_PATTERNS) {
      if (pattern.test(content)) violations.push(`settings.ts: ${pattern.source}`);
    }
    expect(violations).toEqual([]);
  });

  it("zero hardcoded isFeatureEnabled(white_label) in systemConfigService.ts", () => {
    const configFile = path.resolve(SRC_DIR, "services/systemConfigService.ts");
    const content = readFileSync(configFile, "utf8");
    expect(OLD_CHECK_PATTERN.test(content)).toBe(false);
  });

  it("D-02 fallback still present in systemConfigService.ts (defense-in-depth)", () => {
    const configFile = path.resolve(SRC_DIR, "services/systemConfigService.ts");
    const content = readFileSync(configFile, "utf8");
    // The fallback MUST stay — it's the no-plugin community path.
    expect(content).toMatch(/startsWith\(["']BRANDING_["']\)/);
    expect(content).toMatch(/configKeyValidators\.length\s*===\s*0/);
  });
});
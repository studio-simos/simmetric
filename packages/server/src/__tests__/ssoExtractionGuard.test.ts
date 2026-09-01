// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SC-1 grep-guard (D-15) — asserts ZERO SSO imports remain in the community
 * `packages/server/src/` tree (excluding `__mocks__/`, `__tests__/`, `dist/`,
 * `node_modules/`). This is the phase's completion gate: after Plans 01 + 02 +
 * 03 every SSO route / service / middleware file has moved to the enterprise
 * plugin, and the community `package.json` no longer depends on
 * `passport-saml` / `openid-client`.
 *
 * Pattern list (D-15 — full set, finalized in Plan 03):
 *   - `from "passport-saml"` / `from "@node-saml/passport-saml"` /
 *     `from "@node-saml/node-saml"` — the SAML npm deps (moved to enterprise).
 *   - `from "openid-client"` — the OIDC npm dep (moved to enterprise; ESM-only
 *     v6 — D-08).
 *   - `from "./routes/sso"` / `from "./routes/saml"` / `from "./routes/oidc"`
 *     / `from "./routes/scim"` — the 4 SSO route files (moved to enterprise;
 *     `routes/sso.ts` was the Plan 01 tracer, the other 3 moved in Plan 02).
 *   - `from "./services/samlStrategy"` / `from "./services/scimService"` /
 *     `from "./services/oidcClient"` / `from "./services/ssoService"` — the
 *     4 SSO service files (moved to enterprise in Plans 01 + 02).
 *   - `from "./middleware/scimAuth"` — the SCIM Bearer auth middleware
 *     (moved to enterprise in Plan 02).
 *
 * The test walks the source tree with `node:fs` and regex-matches `from "..."`
 * import patterns. It excludes `__mocks__/` (mocks reference the strings by
 * design), `__tests__/` (test files + this guard reference the strings),
 * `dist/` (generated), and `node_modules/` (third-party).
 *
 * The `auth.ts` /sso/status guard is ALLOWED — it uses `prisma.ssoConfig.findFirst()`
 * directly (inlined in Plan 01) + imports `getOidcProviderFromDiscoveryUrl`
 * from `@simmetric-chat/shared` (Plan 03). Neither matches the SSO-internal
 * import patterns above (the shared import is `from "@simmetric-chat/shared"`,
 * not `from "./services/oidcClient"`). The D-07 guard comment in `auth.ts`
 * mentions `ssoService.ts` + `oidcClient.ts` as documentation of the move —
 * those are JSDoc comments, NOT import statements, so the `from "..."` regex
 * does not match them.
 *
 * Phase 143 (EPA-03) — Plan 03 finalizes the full pattern list (SC-1 COMPLETE).
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

// The community server `src/` directory (one level up from __tests__/).
const SRC_DIR = path.resolve(__dirname, "..");

// SC-1 (D-15) — the full pattern list of SSO imports that must be GONE from
// community `src/` after Plans 01 + 02 + 03. Each pattern matches an
// ES-module / TS `from "..."` import statement with a relative prefix that
// varies by caller depth (`./`, `../`, `../../`). The regex anchors on the
// `from` keyword + the SSO-internal path/package; it does NOT match comments
// or string literals that merely mention the file names.
const SSO_PATTERNS: RegExp[] = [
  // SAML npm deps (moved to enterprise package.json).
  /from\s+["']passport-saml["']/,
  /from\s+["']@node-saml\/passport-saml["']/,
  /from\s+["']@node-saml\/node-saml["']/,
  // OIDC npm dep (ESM-only v6, moved to enterprise).
  /from\s+["']openid-client["']/,
  // SSO route files (relative imports — prefix varies by caller depth).
  /from\s+["'](\.\.\/)+routes\/sso["']/,
  /from\s+["'](\.\.\/)+routes\/saml["']/,
  /from\s+["'](\.\.\/)+routes\/oidc["']/,
  /from\s+["'](\.\.\/)+routes\/scim["']/,
  /from\s+["']\.\/routes\/sso["']/,
  /from\s+["']\.\/routes\/saml["']/,
  /from\s+["']\.\/routes\/oidc["']/,
  /from\s+["']\.\/routes\/scim["']/,
  // SSO service files (relative imports — prefix varies by caller depth).
  /from\s+["'](\.\.\/)+services\/samlStrategy["']/,
  /from\s+["'](\.\.\/)+services\/scimService["']/,
  /from\s+["'](\.\.\/)+services\/oidcClient["']/,
  /from\s+["'](\.\.\/)+services\/ssoService["']/,
  /from\s+["']\.\/services\/samlStrategy["']/,
  /from\s+["']\.\/services\/scimService["']/,
  /from\s+["']\.\/services\/oidcClient["']/,
  /from\s+["']\.\/services\/ssoService["']/,
  // SCIM Bearer auth middleware (moved to enterprise).
  /from\s+["'](\.\.\/)+middleware\/scimAuth["']/,
  /from\s+["']\.\/middleware\/scimAuth["']/,
];

// Directories excluded from the walk — mocks + tests contain the strings by
// design (mocks wire the module name, tests assert on the moved code),
// dist/ is generated, node_modules/ is third-party.
const EXCLUDED_DIRS = new Set(["__mocks__", "__tests__", "dist", "node_modules"]);

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

describe("SC-1: SSO extraction grep-guard (D-15) — full pattern list", () => {
  it("zero SSO imports remain in community src/ (all SSO code moved to enterprise)", () => {
    const files = walkTsFiles(SRC_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of SSO_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(
            `${path.relative(SRC_DIR, file)}: ${pattern.source}`,
          );
        }
      }
    }
    // Pretty-print violations for fast triage if the guard ever trips.
    expect(violations).toEqual([]);
  });
});
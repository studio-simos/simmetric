#!/usr/bin/env node
/**
 * Project-self license field verifier (Phase 168, D-03 optional hardening).
 *
 * Asserts the root + all 5 package.json `license` fields equal the expected
 * SPDX expression (`AGPL-3.0-or-later`). Unlike `scripts/license-policy-check.cjs`
 * (which scans the dependency tree via `license-checker-rseidelsohn --onlyAllow`),
 * this reads the project's OWN package.json fields directly — no external
 * binary, zero deps (only `node:fs` / `node:path`).
 *
 * Catches accidental license-field edits — the field is static, but a stray
 * edit would silently change the project's own license. Pairs with the CI
 * "Verify project-self license fields" step in `.github/workflows/ci.yml`.
 *
 * Exit-code contract (mirrors `license-policy-check.cjs`):
 *   0 = all 6 package.json files match `EXPECTED`
 *   1 = at least one file is missing or carries a different license string
 *
 * The script fails loudly (`console.error` + non-zero exit), never silently
 * degrades — the Plain-Node CJS Script Pattern rule. Paths resolve relative
 * to `__dirname` (NOT `process.cwd()`), so the script is location-independent.
 *
 * Testability: `main()` RETURNS the exit code instead of calling
 * `process.exit`; the thin `if (require.main === module)` wrapper performs
 * the actual exit. Tests import `{ main, FILES, EXPECTED }` and assert on
 * the returned code. See `scripts/license-check-self.test.cjs`.
 */

const fs = require('node:fs')
const path = require('node:path')

const EXPECTED = 'AGPL-3.0-or-later'

const FILES = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/frontend/package.json',
  'packages/collector/package.json',
  'packages/widget/package.json',
]

/**
 * Iterate every package.json, compare its `license` field to EXPECTED, and
 * return the exit code (0 = pass, 1 = at least one mismatch / missing file).
 * Prints one `✓`/`✗` line per file, then a summary line. Does NOT call
 * `process.exit` — the CLI wrapper does that. Failures never abort early so
 * the operator sees every problem in one run.
 * @returns {number} 0 on full pass, 1 on any failure
 */
function main() {
  let failed = false
  for (const rel of FILES) {
    const file = path.resolve(__dirname, '..', rel)
    if (!fs.existsSync(file)) {
      console.error(`✗ ${rel}: file not found`)
      failed = true
      continue
    }
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      console.error(`✗ ${rel}: invalid JSON — ${e.message}`)
      failed = true
      continue
    }
    if (pkg.license !== EXPECTED) {
      const got = pkg.license === undefined ? 'undefined' : JSON.stringify(pkg.license)
      console.error(`✗ ${rel}: expected "${EXPECTED}", got ${got}`)
      failed = true
    } else {
      console.log(`✓ ${rel}: license = ${EXPECTED}`)
    }
  }
  if (failed) {
    console.error('\nLicense self-check: FAIL')
    return 1
  }
  console.log('\nLicense self-check: PASS (all 6 package.json files)')
  return 0
}

module.exports = { main, FILES, EXPECTED }

// CLI entrypoint — only runs when invoked directly, not when required by tests.
if (require.main === module) {
  process.exit(main())
}
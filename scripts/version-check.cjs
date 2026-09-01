#!/usr/bin/env node
/**
 * Version-stamp sync verifier (Phase 172, VER-01 / D-02).
 *
 * Asserts the root `package.json` `version` field agrees with the latest git
 * tag on the `major.minor` component. Closes the v0.12-era drift where
 * `package.json` was `0.17.0` while git tags went up to `v1.4`. Pairs with
 * `.github/workflows/release.yml` (which re-checks on tag push) — this script
 * makes the verification available locally + on every PR via the
 * `lint-and-typecheck` CI job, so drift is caught BEFORE tagging, not after.
 *
 * Normalization: BOTH the package version (e.g. `1.4.0`) and the tag (e.g.
 * `v1.4`) are reduced to `major.minor` (split on `.`, first 2 parts, join).
 * This resolves the repo's `vX.Y` tag scheme (no patch component) matching the
 * `X.Y.Z` package version scheme. A patch bump (`1.5.1` ↔ `v1.5.0`) is NOT
 * drift by design — only major.minor matters.
 *
 * Exit-code contract (mirrors `license-check-self.cjs`):
 *   0 = package.json major.minor === latest git tag major.minor
 *   1 = mismatch, OR no git tags found (a release repo must have tags)
 *
 * Plain-Node CJS Script Pattern: zero deps (only `node:fs` / `node:path` /
 * `node:child_process`), `main()` returns the exit code (the thin
 * `if (require.main === module)` wrapper performs the actual exit),
 * `module.exports` for testability. Paths resolve relative to `__dirname`
 * (NOT `process.cwd()`), so the script is location-independent.
 *
 * Testability: tests import `{ main, FILES, normalize }` and assert on the
 * returned code, stubbing `fs.readFileSync` + `child_process.execSync` via the
 * require-cache-clear + injection pattern from `license-check-self.test.cjs`.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const FILES = ['package.json']

/**
 * Reduce a version/tag string to its `major.minor` component.
 * Split on `.`, take the first 2 parts, join with `.`.
 *   `1.4.0` → `1.4`, `1.4` → `1.4`, `v1.5.0` → `v1.5` (caller strips `v`).
 * Exported so tests can assert on it directly.
 * @param {string} v version or tag string
 * @returns {string} the `major.minor` string
 */
function normalize(v) {
  return String(v)
    .split('.')
    .slice(0, 2)
    .join('.')
}

/**
 * Read the root `package.json` version + the latest git tag, normalize both to
 * `major.minor`, and return the exit code (0 = match, 1 = mismatch / no tags).
 * Does NOT call `process.exit` — the CLI wrapper does that.
 * @returns {number} 0 on match, 1 on mismatch or missing tags
 */
function main() {
  const pkgPath = path.resolve(__dirname, '..', 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch (e) {
    console.error('✗ cannot read root package.json — ' + e.message)
    return 1
  }
  const pkgVersion = pkg.version
  if (!pkgVersion) {
    console.error('✗ root package.json has no "version" field')
    return 1
  }

  let tag
  try {
    tag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim()
  } catch (e) {
    console.error('✗ No git tags found — cannot verify version stamp')
    return 1
  }

  // Strip a leading `v` from the tag (mirror release.yml: VERSION="${TAG#v}")
  const tagVersion = tag.replace(/^v/, '')

  const pkgMM = normalize(pkgVersion)
  const tagMM = normalize(tagVersion)

  if (pkgMM === tagMM) {
    console.log(
      '✓ version ' + pkgVersion + ' matches tag ' + tag + ' (major.minor ' + pkgMM + ')'
    )
    return 0
  }

  console.error(
    '✗ package.json version (' +
      pkgVersion +
      ' → major.minor ' +
      pkgMM +
      ') does not match latest git tag (' +
      tag +
      ' → major.minor ' +
      tagMM +
      ')'
  )
  console.error(
    "  Run `pnpm version:bump " +
      tagVersion +
      "` to resync, or create the tag `v" +
      pkgVersion +
      '`'
  )
  return 1
}

module.exports = { main, FILES, normalize }

// CLI entrypoint — only runs when invoked directly, not when required by tests.
if (require.main === module) {
  process.exit(main())
}
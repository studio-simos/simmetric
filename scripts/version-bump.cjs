#!/usr/bin/env node
/**
 * Version bump script (Phase 172, VER-02 / D-01 / D-03 / D-04).
 *
 * `pnpm version:bump <version>` updates the `version` field in ALL 6
 * package.json files (root + 5 packages, per D-01) and renames the CHANGELOG.md
 * `## [Unreleased]` section to `## [vX.Y.Z] — YYYY-MM-DD`, inserting a fresh
 * empty `## [Unreleased]` section above it (per D-03).
 *
 * Validation (per D-04): the version is validated against a SemVer regex
 * (`^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$`) AFTER stripping a leading `v` if
 * present. Invalid input exits 1 BEFORE any file write (fail-loud, no partial
 * writes — T-172-01 mitigation).
 *
 * Idempotency: if all 6 package.json files already carry the target version,
 * re-writing them is harmless. The CHANGELOG replace targets ONLY
 * `## [Unreleased]` — a re-run where `[Unreleased]` was already renamed leaves
 * nothing to replace, so no duplicate `[vX.Y.Z]` section is created.
 *
 * Plain-Node CJS Script Pattern: zero deps (only `node:fs` / `node:path`; NO
 * `child_process` — the bump writes files, it does not read git tags),
 * `main(argv)` returns the exit code (the thin `if (require.main === module)`
 * wrapper performs the actual exit), `module.exports` for testability. Paths
 * resolve relative to `__dirname` (NOT `process.cwd()`), so the script is
 * location-independent.
 *
 * Testability: tests import `{ main, FILES, CHANGELOG, SEMVER_RE }` and assert
 * on the returned code, stubbing `fs.readFileSync` / `fs.writeFileSync` via
 * the require-cache-clear + injection pattern from `license-check-self.test.cjs`.
 */

const fs = require('node:fs')
const path = require('node:path')

const FILES = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/frontend/package.json',
  'packages/collector/package.json',
  'packages/widget/package.json',
]

const CHANGELOG = 'CHANGELOG.md'

const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/

/**
 * Bump the version in all 6 package.json files + rename the CHANGELOG
 * `[Unreleased]` section. Returns the exit code (0 = success, 1 = failure).
 * Does NOT call `process.exit` — the CLI wrapper does that.
 * @param {string[]} argv CLI args (the wrapper passes `process.argv.slice(2)`)
 * @returns {number} 0 on success, 1 on validation/IO failure
 */
function main(argv) {
  if (!Array.isArray(argv)) argv = []
  const requested = argv[0]
  if (!requested) {
    console.error('Usage: pnpm version:bump <version>')
    return 1
  }

  // Strip a leading `v` if present (per D-04)
  const version = requested.replace(/^v/, '')

  // Validate SemVer BEFORE any write (fail-loud, no partial writes — T-172-01)
  if (!SEMVER_RE.test(version)) {
    console.error(
      'Invalid SemVer: ' + version + ' (expected X.Y.Z[-pre], e.g. 1.5.0)'
    )
    return 1
  }

  // 1. Bump all 6 package.json files
  for (const rel of FILES) {
    const file = path.resolve(__dirname, '..', rel)
    let pkg
    try {
      pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      console.error('✗ ' + rel + ': cannot read — ' + e.message)
      return 1
    }
    pkg.version = version
    try {
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
    } catch (e) {
      console.error('✗ ' + rel + ': cannot write — ' + e.message)
      return 1
    }
    console.log('✓ ' + rel + ': version → ' + version)
  }

  // 2. CHANGELOG interaction (per D-03)
  const clPath = path.resolve(__dirname, '..', CHANGELOG)
  let changelog
  try {
    changelog = fs.readFileSync(clPath, 'utf8')
  } catch (e) {
    console.error('✗ CHANGELOG.md: cannot read — ' + e.message)
    return 1
  }

  const unreleasedIdx = changelog.indexOf('## [Unreleased]')
  if (unreleasedIdx === -1) {
    // No [Unreleased] section — this is the idempotent case (already renamed)
    // OR a real error (CHANGELOG malformed). Per the fail-loud contract, if the
    // target version header already exists, treat as no-op (idempotent); if NOT,
    // it's a real error (the bump cannot rename a section that doesn't exist).
    const versionHeader = '## [v' + version + '] —'
    if (changelog.indexOf(versionHeader) !== -1) {
      // Already bumped to this version — idempotent no-op on the CHANGELOG
      console.log('· CHANGELOG.md: [v' + version + '] already present — no-op')
    } else {
      console.error(
        '✗ CHANGELOG.md missing "## [Unreleased]" section header — cannot rename'
      )
      return 1
    }
  } else {
    const versionHeader = '## [v' + version + '] —'
    if (changelog.indexOf(versionHeader) !== -1) {
      console.log('· CHANGELOG.md: [v' + version + '] already present — no-op')
    } else {
      const date = new Date().toISOString().slice(0, 10)
      const replacement = '## [Unreleased]\n\n## [v' + version + '] — ' + date
      const updated =
        changelog.slice(0, unreleasedIdx) +
        replacement +
        changelog.slice(unreleasedIdx + '## [Unreleased]'.length)
      try {
        fs.writeFileSync(clPath, updated)
      } catch (e) {
        console.error('✗ CHANGELOG.md: cannot write — ' + e.message)
        return 1
      }
      console.log('✓ CHANGELOG.md: [Unreleased] → [v' + version + '] — ' + date)
    }
  }

  console.log('Version bump complete: ' + version + ' (6 package.json + CHANGELOG)')
  return 0
}

module.exports = { main, FILES, CHANGELOG, SEMVER_RE }

// CLI entrypoint — only runs when invoked directly, not when required by tests.
if (require.main === module) {
  process.exit(main(process.argv.slice(2)))
}
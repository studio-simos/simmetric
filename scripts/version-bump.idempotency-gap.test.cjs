// @ts-nocheck
/**
 * Adversarial test for Phase 172 VER-02 idempotency gap (Nyquist audit).
 *
 * The PLAN must_haves truth states:
 *   "version:bump is idempotent — re-running with the already-set version
 *    is a no-op (no error, no duplicate CHANGELOG section)"
 *
 * The plan's idempotency contract section states:
 *   "if all 6 package.json files already carry the target version AND the
 *    CHANGELOG already has a ## [v<version>] header, the script is a no-op
 *    (re-reading and re-writing the same content is acceptable; do NOT
 *    create a duplicate [v<version>] section)"
 *
 * Existing test scenario 5 only tests the case where [Unreleased] is ABSENT
 * (already fully renamed). But after a REAL bump, the CHANGELOG has BOTH
 * a fresh empty [Unreleased] (inserted by the first run) AND the existing
 * [vX.Y.Z] header. Re-running in that state should be a no-op per the
 * requirement — no duplicate [vX.Y.Z] section.
 *
 * This test verifies that real post-bump re-run state.
 *
 * Standalone + jest-compatible (mirrors version-bump.test.cjs pattern).
 */

const assert = require('node:assert')

function makeScript(stubBuilder) {
  const realFs = require('node:fs')
  const orig = {
    readFileSync: realFs.readFileSync,
    writeFileSync: realFs.writeFileSync,
  }
  const writes = {}
  const stub = stubBuilder(orig, writes)
  if (stub.readFileSync) realFs.readFileSync = stub.readFileSync
  if (stub.writeFileSync) realFs.writeFileSync = stub.writeFileSync
  delete require.cache[require.resolve('./version-bump.cjs')]
  const origExit = process.exit
  process.exit = (code) => { /* capture, don't exit */ }
  let mainCode = null
  try {
    const mod = require('./version-bump.cjs')
    if (typeof mod.main === 'function') mainCode = mod.main(stub.__argv)
  } finally {
    process.exit = origExit
    realFs.readFileSync = orig.readFileSync
    realFs.writeFileSync = orig.writeFileSync
  }
  return { mainCode, writes }
}

const PKG_FILES = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/frontend/package.json',
  'packages/collector/package.json',
  'packages/widget/package.json',
]
const PKG_FILES_LONGEST = PKG_FILES.slice().sort((a, b) => b.length - a.length)

function stubFromFixture(pkgVersion, changelog, argv) {
  return (orig, writes) => ({
    __argv: argv,
    readFileSync: (file, enc) => {
      for (const rel of PKG_FILES_LONGEST) {
        if (file.endsWith(rel)) {
          return JSON.stringify({ name: rel, version: pkgVersion, license: 'AGPL-3.0-or-later' })
        }
      }
      if (file.endsWith('CHANGELOG.md')) return changelog
      return orig.readFileSync(file, enc)
    },
    writeFileSync: (file, content) => {
      for (const rel of PKG_FILES_LONGEST) {
        if (file.endsWith(rel)) { writes[rel] = content; return }
      }
      if (file.endsWith('CHANGELOG.md')) { writes['CHANGELOG.md'] = content; return }
      writes[file] = content
    },
  })
}

const today = new Date().toISOString().slice(0, 10)

// The real post-bump CHANGELOG state: a fresh empty [Unreleased] at top,
// followed by the just-released [v1.5.0] section, then older sections.
const POST_BUMP_CHANGELOG =
  '# Changelog\n\nAll notable changes are documented here.\n\n---\n\n' +
  '## [Unreleased]\n\n' +
  '## [v1.5.0] — ' + today + '\n\n### Added\n- new feature\n\n' +
  '## [v1.4] — 2026-08-27\n\n### Changed\n- thing\n'

const tests = [
  [
    'idempotency-gap: re-run version:bump 1.5.0 when [Unreleased] exists + [v1.5.0] already present → no duplicate [v1.5.0] section',
    async () => {
      const { mainCode, writes } = makeScript(
        stubFromFixture('1.5.0', POST_BUMP_CHANGELOG, ['1.5.0'])
      )
      // Must exit 0 (no error — idempotent)
      assert.strictEqual(
        mainCode, 0,
        'idempotent re-run should exit 0, got ' + mainCode
      )
      // If CHANGELOG was written, it must NOT contain a duplicate [v1.5.0] header
      if (writes['CHANGELOG.md']) {
        const cl = writes['CHANGELOG.md']
        const versionHeaderCount = (cl.match(/## \[v1\.5\.0\]/g) || []).length
        assert.strictEqual(
          versionHeaderCount, 1,
          'idempotent re-run must NOT create a duplicate [v1.5.0] section — found ' +
            versionHeaderCount + ' occurrences'
        )
      }
    },
  ],
]

// jest-compatible path
if (typeof describe === 'function' && typeof it === 'function') {
  describe('version-bump-idempotency-gap', () => {
    for (const [name, fn] of tests) {
      it(name, fn)
    }
  })
}

// Standalone path
if (require.main === module) {
  ;(async () => {
    let passed = 0
    let failed = 0
    for (const [name, fn] of tests) {
      try {
        await fn()
        console.log('  ✓', name)
        passed++
      } catch (e) {
        console.error('  ✗', name)
        console.error('   ', e.message)
        failed++
      }
    }
    console.log('\n' + passed + ' passed, ' + failed + ' failed')
    process.exit(failed === 0 ? 0 : 1)
  })()
}
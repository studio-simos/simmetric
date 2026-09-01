// @ts-nocheck
/**
 * Tests for scripts/version-bump.cjs (Phase 172, VER-02 / D-01 / D-03 / D-04).
 *
 * Standalone + jest-compatible: `node scripts/version-bump.test.cjs` runs the
 * assertions via the node `assert` module and exits 0/1; jest can also pick it
 * up because the file defines `test()` wrappers when `describe`/`it` are present.
 *
 * Stubs `fs.readFileSync` / `fs.writeFileSync` via the require-cache-clear +
 * injection pattern from `license-check-self.test.cjs`. The bump script reads
 * 6 package.json files + CHANGELOG.md and writes them back — the stub captures
 * the writes so tests can assert on the written content.
 *
 * 7 scenarios per the PLAN <behavior> block:
 *  1. happy path (1.4.0 → 1.5.0): all 6 pkg version → 1.5.0; CHANGELOG renamed
 *  2. invalid SemVer (1.4, no patch) → exit 1, no writes
 *  3. leading-v strip (v1.5.0 → 1.5.0) → exit 0
 *  4. pre-release (1.5.0-alpha.1) → exit 0
 *  5. idempotent (already 1.4.0, no [Unreleased]) → exit 0, no-op
 *  6. missing version arg → exit 1, usage message
 *  7. CHANGELOG missing [Unreleased] header → exit 1
 */

const assert = require('node:assert')

// Build a fresh module per scenario by clearing the require cache and injecting
// stubbed `fs.readFileSync` + `fs.writeFileSync`. The stub serves fixture
// content for the 6 package.json files + CHANGELOG.md, and captures writes.
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
  let exitCode = null
  const origExit = process.exit
  process.exit = (code) => {
    exitCode = code
  }
  let mod
  let mainCode = null
  try {
    mod = require('./version-bump.cjs')
    if (typeof mod.main === 'function') mainCode = mod.main(stub.__argv)
  } finally {
    process.exit = origExit
    realFs.readFileSync = orig.readFileSync
    realFs.writeFileSync = orig.writeFileSync
  }
  return { mod, exitCode, mainCode, writes }
}

const PKG_FILES = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/frontend/package.json',
  'packages/collector/package.json',
  'packages/widget/package.json',
]
// Sort longest-first so 'packages/shared/package.json' matches BEFORE the
// shorter 'package.json' suffix (which would otherwise capture every write).
const PKG_FILES_LONGEST = PKG_FILES.slice().sort((a, b) => b.length - a.length)

// Build a stub fs that serves the 6 package.json fixtures + CHANGELOG fixture.
// `pkgVersion` is the version ALL 6 package.json files carry before the bump.
// `changelog` is the CHANGELOG.md content. `argv` is the CLI args passed to main().
// `writes` captures all writeFileSync calls keyed by file suffix.
function stubFromFixture(pkgVersion, changelog, argv) {
  return (orig, writes) => {
    const builder = {
      __argv: argv,
      readFileSync: (file, enc) => {
        for (const rel of PKG_FILES_LONGEST) {
          if (file.endsWith(rel)) {
            // Return a package.json with the given version + a license field
            return JSON.stringify({
              name: rel.replace('/package.json', '').replace('package.json', 'root'),
              version: pkgVersion,
              license: 'AGPL-3.0-or-later',
            })
          }
        }
        if (file.endsWith('CHANGELOG.md')) {
          return changelog
        }
        return orig.readFileSync(file, enc)
      },
      writeFileSync: (file, content) => {
        // Capture writes by suffix (longest-first match) so the test can assert per-file
        for (const rel of PKG_FILES_LONGEST) {
          if (file.endsWith(rel)) {
            writes[rel] = content
            return
          }
        }
        if (file.endsWith('CHANGELOG.md')) {
          writes['CHANGELOG.md'] = content
          return
        }
        writes[file] = content
      },
    }
    return builder
  }
}

const UNRELEASED_HEADER = '## [Unreleased]\n'

function scenario(name, setup, expectedExit, assertWrites) {
  return async () => {
    const { mainCode, exitCode, writes } = makeScript(setup)
    const code = mainCode !== null ? mainCode : exitCode
    assert.strictEqual(
      code,
      expectedExit,
      name + ': expected exit ' + expectedExit + ', got ' + code
    )
    if (typeof assertWrites === 'function') {
      assertWrites(writes)
    }
  }
}

const today = new Date().toISOString().slice(0, 10)

const tests = [
  [
    '1. happy path: bump 1.4.0 → 1.5.0 → exit 0, all 6 pkgs + CHANGELOG renamed',
    scenario(
      'happy',
      stubFromFixture(
        '1.4.0',
        '# Changelog\n\n---\n\n## [Unreleased]\n\n### Added\n- item\n\n---\n\n## [v1.4] — 2026-08-27\n\n### Changed\n- thing\n',
        ['1.5.0']
      ),
      0,
      (writes) => {
        for (const rel of PKG_FILES) {
          assert.ok(writes[rel], 'expected write for ' + rel)
          const pkg = JSON.parse(writes[rel])
          assert.strictEqual(pkg.version, '1.5.0', rel + ' version should be 1.5.0')
        }
        assert.ok(writes['CHANGELOG.md'], 'expected CHANGELOG write')
        const cl = writes['CHANGELOG.md']
        assert.ok(cl.indexOf('## [Unreleased]') !== -1, 'CHANGELOG has [Unreleased]')
        assert.ok(
          cl.indexOf('## [v1.5.0] — ' + today) !== -1,
          'CHANGELOG has [v1.5.0] — ' + today
        )
        // New [Unreleased] should be ABOVE the renamed section
        assert.ok(
          cl.indexOf('## [Unreleased]') < cl.indexOf('## [v1.5.0]'),
          '[Unreleased] above [v1.5.0]'
        )
      }
    ),
  ],
  [
    '2. invalid SemVer (1.4, no patch) → exit 1, no writes',
    scenario(
      'invalid-semver',
      stubFromFixture('1.4.0', UNRELEASED_HEADER, ['1.4']),
      1,
      (writes) => {
        for (const rel of PKG_FILES) {
          assert.ok(!writes[rel], 'no write expected for ' + rel + ' on validation failure')
        }
        assert.ok(!writes['CHANGELOG.md'], 'no CHANGELOG write on validation failure')
      }
    ),
  ],
  [
    '3. leading-v strip (v1.5.0 → 1.5.0) → exit 0',
    scenario(
      'leading-v-strip',
      stubFromFixture('1.4.0', UNRELEASED_HEADER, ['v1.5.0']),
      0,
      (writes) => {
        const pkg = JSON.parse(writes['package.json'])
        assert.strictEqual(pkg.version, '1.5.0', 'v stripped → 1.5.0')
      }
    ),
  ],
  [
    '4. pre-release (1.5.0-alpha.1) → exit 0',
    scenario(
      'prerelease',
      stubFromFixture('1.4.0', UNRELEASED_HEADER, ['1.5.0-alpha.1']),
      0,
      (writes) => {
        const pkg = JSON.parse(writes['package.json'])
        assert.strictEqual(pkg.version, '1.5.0-alpha.1')
      }
    ),
  ],
  [
    '5. idempotent (already 1.4.0, no [Unreleased]) → exit 0, no CHANGELOG duplicate',
    scenario(
      'idempotent',
      stubFromFixture('1.4.0', '# Changelog\n\n## [v1.4.0] — 2026-08-27\n\n### Changed\n- x\n', [
        '1.4.0',
      ]),
      0,
      (writes) => {
        // package.json writes are acceptable (idempotent overwrite) — assert no DUPLICATE section in CHANGELOG
        if (writes['CHANGELOG.md']) {
          const cl = writes['CHANGELOG.md']
          const unreleasedCount = (cl.match(/## \[Unreleased\]/g) || []).length
          assert.ok(unreleasedCount <= 1, 'no duplicate [Unreleased] section')
        }
      }
    ),
  ],
  [
    '6. missing version arg → exit 1, usage message',
    scenario('missing-arg', stubFromFixture('1.4.0', UNRELEASED_HEADER, []), 1),
  ],
  [
    '7. CHANGELOG missing [Unreleased] header → exit 1',
    scenario(
      'missing-unreleased',
      stubFromFixture('1.4.0', '# Changelog\n\n## [v1.4] — 2026-08-27\n\n### Changed\n- x\n', [
        '1.5.0',
      ]),
      1
    ),
  ],
]

// jest-compatible path
if (typeof describe === 'function' && typeof it === 'function') {
  describe('version-bump', () => {
    for (const [name, fn] of tests) {
      it(name, fn)
    }
  })
}

// Standalone path: `node scripts/version-bump.test.cjs`
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
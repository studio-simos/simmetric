// @ts-nocheck
/**
 * Tests for scripts/changelog-check.cjs (Phase 173, CL-01 / D-01 / D-02 / D-03).
 *
 * Standalone + jest-compatible: `node scripts/changelog-check.test.cjs` runs the
 * assertions via the node `assert` module and exits 0/1; jest can also pick it
 * up because the file defines `test()` wrappers when `describe`/`it` are present.
 *
 * Stubs `fs.readFileSync` (for CHANGELOG.md) + `child_process.execSync` (for
 * `git diff --name-only`) via the require-cache-clear + injection pattern from
 * `version-check.test.cjs`. The stub passes through to the real methods for any
 * file/command that is NOT the stubbed target so Node's require() can still
 * load the script under test. Scenarios set/clear `process.env.GITHUB_BASE_REF`
 * around the `main()` call to exercise both diff paths (PR vs push, D-02).
 */

const assert = require('node:assert')

// Build a fresh module per scenario by clearing the require cache and injecting
// stubbed `fs.readFileSync` + `child_process.execSync`. Both must be stubbed:
// main() reads CHANGELOG.md via fs AND runs the git diff via execSync.
function makeScript(stubBuilder) {
  const realFs = require('node:fs')
  const realCp = require('node:child_process')
  const orig = {
    readFileSync: realFs.readFileSync,
    execSync: realCp.execSync,
  }
  const stub = stubBuilder(orig)
  if (stub.readFileSync) realFs.readFileSync = stub.readFileSync
  if (stub.execSync) realCp.execSync = stub.execSync
  delete require.cache[require.resolve('./changelog-check.cjs')]
  let exitCode = null
  const origExit = process.exit
  process.exit = (code) => {
    exitCode = code
  }
  let mod
  let mainCode = null
  try {
    mod = require('./changelog-check.cjs')
    if (typeof mod.main === 'function') mainCode = mod.main()
  } finally {
    process.exit = origExit
    realFs.readFileSync = orig.readFileSync
    realCp.execSync = orig.execSync
  }
  return { mod, exitCode, mainCode }
}

// The script resolves CHANGELOG.md via path.resolve(__dirname,'..','CHANGELOG.md');
// we match by suffix. The execSync stub returns the fixture diff output for any
// `git diff --name-only` command (PR and push paths), or throws when the fixture
// is null to simulate a git failure (fail-loud contract, T-173-02).
function stubFromMap(changelogFixture, diffFixture) {
  return (orig) => ({
    readFileSync: (file, enc) => {
      if (file.endsWith('CHANGELOG.md')) {
        return changelogFixture
      }
      return orig.readFileSync(file, enc)
    },
    execSync: (cmd, opt) => {
      if (cmd.startsWith('git diff --name-only')) {
        if (diffFixture === null) {
          const err = new Error('fatal: ambiguous argument \'HEAD~1\': unknown revision or path not in the working tree')
          err.code = 128
          throw err
        }
        return diffFixture
      }
      return orig.execSync(cmd, opt)
    },
  })
}

// baseRef: string → PR context (GITHUB_BASE_REF set); null → push context.
function scenario(name, changelogFixture, diffFixture, baseRef, expectedExit) {
  return async () => {
    const prev = process.env.GITHUB_BASE_REF
    if (baseRef === null) {
      delete process.env.GITHUB_BASE_REF
    } else {
      process.env.GITHUB_BASE_REF = baseRef
    }
    try {
      const { mainCode, exitCode, mod } = makeScript(stubFromMap(changelogFixture, diffFixture))
      const code = mainCode !== null ? mainCode : exitCode
      assert.strictEqual(
        code,
        expectedExit,
        name + ': expected exit ' + expectedExit + ', got ' + code
      )
    } finally {
      if (prev === undefined) {
        delete process.env.GITHUB_BASE_REF
      } else {
        process.env.GITHUB_BASE_REF = prev
      }
    }
  }
}

// Fixture CHANGELOG strings — lifted from the real file's shapes (two-part
// `v1.4` headers, custom categories, `[Unreleased]` last-section case).
const FIXTURE = {
  // `[Unreleased]` with bullets + a two-part released header (current-file shape).
  withBullets: [
    '# Changelog',
    '',
    '---',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '- item one',
    '- item two',
    '',
    '---',
    '',
    '## [v1.4] — 2026-08-27 — Horizontal Scale (Redis Layer Completion)',
    '',
    '### Changed',
    '- thing',
    '',
  ].join('\n'),
  // Category headers only, ZERO bullets (D-01: headers do not count as content).
  emptyWithCategoryHeaders: [
    '## [Unreleased]',
    '',
    '### Added',
    '### Changed',
    '',
    '---',
    '',
    '## [v1.4] — 2026-08-27',
    '',
    '### Changed',
    '- thing',
    '',
  ].join('\n'),
  // `[Unreleased]` is the LAST section (no trailing `## [` delimiter) + empty (D-01 EOF).
  emptyLastSection: [
    '## [v1.4] — 2026-08-27',
    '',
    '### Changed',
    '- thing',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
  ].join('\n'),
  // Released header with no `v` prefix and no em-dash (D-03 violation).
  malformedHeader: [
    '## [Unreleased]',
    '',
    '### Added',
    '- item',
    '',
    '---',
    '',
    '## [1.4] 2026-08-27',
    '',
    '### Changed',
    '- thing',
    '',
  ].join('\n'),
  // Category not in the allowlist (D-03 violation).
  unknownCategory: [
    '## [Unreleased]',
    '',
    '### Added',
    '- item',
    '',
    '---',
    '',
    '## [v1.4] — 2026-08-27',
    '',
    '### Foo',
    '- thing',
    '',
  ].join('\n'),
  // Real current-file shape: two-part header + custom `Breaking changes` category (D-03).
  twoPartHeader: [
    '## [Unreleased]',
    '',
    '### Added',
    '- item',
    '',
    '---',
    '',
    '## [v1.4] — 2026-08-27 — Horizontal Scale (Redis Layer Completion)',
    '',
    '### Breaking changes — operator action required',
    '- breaking thing',
    '',
  ].join('\n'),
  // No `## [Unreleased]` header at all (D-03 violation).
  missingUnreleased: [
    '## [v1.4] — 2026-08-27',
    '',
    '### Changed',
    '- thing',
    '',
  ].join('\n'),
}

const DIFF = {
  src: 'packages/server/src/routes/auth.ts\n',
  topLevelTests: 'packages/server/src/__tests__/auth.test.ts\n',
  nestedTests:
    'packages/server/src/agent/__tests__/x.test.ts\n' +
    'packages/frontend/src/components/ui/__tests__/y.test.ts\n',
  docs: 'docs/README.md\n',
}

const tests = [
  [
    '1. happy path (PR context): src file changed + [Unreleased] has bullets → exit 0',
    scenario('happy', FIXTURE.withBullets, DIFF.src, 'refs/heads/main', 0),
  ],
  [
    '2. CL-01 core: src file changed + [Unreleased] has category headers but ZERO bullets → exit 1',
    scenario('empty-src', FIXTURE.emptyWithCategoryHeaders, DIFF.src, null, 1),
  ],
  [
    '3. D-02 exclusion: ONLY top-level __tests__ file changed + empty [Unreleased] → exit 0',
    scenario('tests-only', FIXTURE.emptyWithCategoryHeaders, DIFF.topLevelTests, null, 0),
  ],
  [
    '3b. D-02 nested exclusion: ONLY nested __tests__ files changed (src/agent/__tests__/, src/components/ui/__tests__/) + empty [Unreleased] → exit 0',
    scenario('nested-tests-only', FIXTURE.emptyWithCategoryHeaders, DIFF.nestedTests, null, 0),
  ],
  [
    '4. D-02 scope: ONLY docs file changed + empty [Unreleased] → exit 0',
    scenario('docs-only', FIXTURE.emptyWithCategoryHeaders, DIFF.docs, null, 0),
  ],
  [
    '5. D-01 EOF robustness: [Unreleased] is the LAST section (no trailing ## [) + empty → exit 1',
    scenario('eof-empty', FIXTURE.emptyLastSection, DIFF.src, null, 1),
  ],
  [
    '6. CL-02 format: released header `## [1.4] 2026-08-27` (no v, no em-dash) → exit 1',
    scenario('malformed-header', FIXTURE.malformedHeader, DIFF.src, null, 1),
  ],
  [
    '7. CL-02 format: unknown category `### Foo` → exit 1',
    scenario('unknown-category', FIXTURE.unknownCategory, DIFF.src, null, 1),
  ],
  [
    '8. current-file format (planner catch): two-part header `## [v1.4] — 2026-08-27 — Horizontal Scale (Redis Layer Completion)` + custom category + bullets → exit 0',
    scenario('two-part-header', FIXTURE.twoPartHeader, DIFF.src, null, 0),
  ],
  [
    '9. CL-02 format: missing `## [Unreleased]` header → exit 1',
    scenario('missing-unreleased', FIXTURE.missingUnreleased, DIFF.src, null, 1),
  ],
  [
    "10. D-02 fail-loud: git diff fails (missing origin/main / shallow history) → exit 1, never a silent pass (T-173-02)",
    scenario('git-failure', FIXTURE.withBullets, null, 'refs/heads/main', 1),
  ],
]

// jest-compatible path
if (typeof describe === 'function' && typeof it === 'function') {
  describe('changelog-check', () => {
    for (const [name, fn] of tests) {
      it(name, fn)
    }
  })
}

// Standalone path: `node scripts/changelog-check.test.cjs`
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

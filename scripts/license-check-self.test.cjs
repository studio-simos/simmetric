// @ts-nocheck
/**
 * Tests for scripts/license-check-self.cjs (Phase 168, D-03 optional hardening).
 *
 * Standalone + jest-compatible: `node scripts/license-check-self.test.cjs` runs
 * the assertions via the node `assert` module and exits 0/1; jest can also pick
 * it up because the file exports a `run()` that returns a promise and defines
 * `test()` wrappers when `describe`/`it` are present.
 *
 * The script under test is refactored to export `{ main, FILES, EXPECTED }` and
 * `main()` RETURNS an exit code (0 = pass, 1 = fail) instead of calling
 * `process.exit`, so tests can capture the result. The thin
 * `if (require.main === module) process.exit(main())` wrapper runs it as a CLI.
 */

const assert = require('node:assert')

// Stub `fs` before requiring the script under test. We build a fresh module
// per scenario by clearing the require cache and injecting a stubbed `fs`.
// The stub receives the REAL fs methods so it can pass through reads that are
// NOT one of the 6 package.json targets (Node's require() calls readFileSync
// to load the script under test — that read must still succeed).
//
// `main()` is invoked WHILE the stub is active (inside the try block), before
// the finally restores the real fs — otherwise main() would read the real
// package.json files and ignore the fixture entirely.
function makeScript(stubBuilder) {
  const realFs = require('node:fs')
  const orig = {
    existsSync: realFs.existsSync,
    readFileSync: realFs.readFileSync,
  }
  const stub = stubBuilder(orig)
  if (stub.existsSync) realFs.existsSync = stub.existsSync
  if (stub.readFileSync) realFs.readFileSync = stub.readFileSync
  delete require.cache[require.resolve('./license-check-self.cjs')]
  let exitCode = null
  const origExit = process.exit
  process.exit = (code) => { exitCode = code }
  let mod
  let mainCode = null
  try {
    mod = require('./license-check-self.cjs')
    // Run main() under the stub so its fs reads hit the fixture, not disk.
    if (typeof mod.main === 'function') mainCode = mod.main()
  } finally {
    process.exit = origExit
    realFs.existsSync = orig.existsSync
    realFs.readFileSync = orig.readFileSync
  }
  return { mod, exitCode, mainCode }
}

// Build a stub fs that serves a fixture map: relPath -> { license } | null (missing)
// The script resolves each package.json via path.resolve(__dirname,'..',rel).
// We match by suffix so the stub works regardless of the absolute prefix.
const SUFFIXES = [
  'package.json',
  'packages/shared/package.json',
  'packages/server/package.json',
  'packages/frontend/package.json',
  'packages/collector/package.json',
  'packages/widget/package.json',
]
// (Kept for documentation/reference — stubFromMap derives its match keys from
// the fixture map itself, sorted longest-first to avoid the 'package.json'
// suffix matching every file.)
void SUFFIXES

function stubFromMap(map) {
  // The stub builder is invoked by makeScript with the real fs methods so the
  // pass-through path works while the stub is active.
  // Keys are full relative paths (e.g. 'packages/shared/package.json'); match
  // by suffix, longest-first so 'packages/shared/package.json' wins over the
  // shorter 'package.json' suffix (which would otherwise match every file).
  const keys = Object.keys(map).sort((a, b) => b.length - a.length)
  return (orig) => ({
    existsSync: (file) => {
      for (const key of keys) {
        if (file.endsWith(key)) return map[key] !== null
      }
      return orig.existsSync(file)
    },
    readFileSync: (file, enc) => {
      for (const key of keys) {
        if (file.endsWith(key)) {
          const v = map[key]
          if (v === null) {
            const err = new Error('ENOENT: ' + file)
            err.code = 'ENOENT'
            throw err
          }
          return JSON.stringify({ license: v })
        }
      }
      // Not a package.json we stub — delegate to the real readFileSync so
      // Node's require() can still load the script under test.
      return orig.readFileSync(file, enc)
    },
  })
}

const ALL_SIX = {
  'package.json': 'AGPL-3.0-or-later',
  'packages/shared/package.json': 'AGPL-3.0-or-later',
  'packages/server/package.json': 'AGPL-3.0-or-later',
  'packages/frontend/package.json': 'AGPL-3.0-or-later',
  'packages/collector/package.json': 'AGPL-3.0-or-later',
  'packages/widget/package.json': 'AGPL-3.0-or-later',
}

function scenario(name, map, expectedExit) {
  return async () => {
    const { mainCode, exitCode } = makeScript(stubFromMap(map))
    const code = mainCode !== null ? mainCode : exitCode
    assert.strictEqual(
      code,
      expectedExit,
      `${name}: expected exit ${expectedExit}, got ${code}`
    )
  }
}

const tests = [
  ['happy path — all 6 carry AGPL-3.0-or-later → exit 0', scenario('happy', ALL_SIX, 0)],
  ['one missing file → exit 1', scenario('missing', { ...ALL_SIX, 'packages/widget/package.json': null }, 1)],
  ['one wrong value (Apache-2.0) → exit 1', scenario('wrong', { ...ALL_SIX, 'package.json': 'Apache-2.0' }, 1)],
  ['one undefined license → exit 1', scenario('undefined', { ...ALL_SIX, 'packages/server/package.json': undefined }, 1)],
]

// jest-compatible path
if (typeof describe === 'function' && typeof it === 'function') {
  describe('license-check-self', () => {
    for (const [name, fn] of tests) {
      it(name, fn)
    }
  })
}

// Standalone path: `node scripts/license-check-self.test.cjs`
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
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })()
}
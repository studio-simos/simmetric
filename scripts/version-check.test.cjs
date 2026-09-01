// @ts-nocheck
/**
 * Tests for scripts/version-check.cjs (Phase 172, VER-01 / D-02).
 *
 * Standalone + jest-compatible: `node scripts/version-check.test.cjs` runs the
 * assertions via the node `assert` module and exits 0/1; jest can also pick it
 * up because the file defines `test()` wrappers when `describe`/`it` are present.
 *
 * Stubs `fs.readFileSync` (for package.json) + `child_process.execSync` (for
 * the git tag) via the require-cache-clear + injection pattern from
 * `license-check-self.test.cjs`. The stub passes through to the real methods
 * for any file/command that is NOT the stubbed target so Node's require() can
 * still load the script under test.
 */

const assert = require('node:assert')

// Build a fresh module per scenario by clearing the require cache and injecting
// stubbed `fs.readFileSync` + `child_process.execSync`. Both must be stubbed:
// main() reads package.json via fs AND reads the git tag via execSync.
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
  delete require.cache[require.resolve('./version-check.cjs')]
  let exitCode = null
  const origExit = process.exit
  process.exit = (code) => {
    exitCode = code
  }
  let mod
  let mainCode = null
  try {
    mod = require('./version-check.cjs')
    if (typeof mod.main === 'function') mainCode = mod.main()
  } finally {
    process.exit = origExit
    realFs.readFileSync = orig.readFileSync
    realCp.execSync = orig.execSync
  }
  return { mod, exitCode, mainCode }
}

// The script resolves root package.json via path.resolve(__dirname,'..','package.json').
// We match by suffix 'package.json' (the root file). The execSync stub returns the
// tag string (or throws to simulate no-tags).
function stubFromMap(pkgVersion, tag, opts) {
  opts = opts || {}
  return (orig) => ({
    readFileSync: (file, enc) => {
      if (file.endsWith('package.json') && !file.includes('packages/')) {
        return JSON.stringify({ version: pkgVersion })
      }
      return orig.readFileSync(file, enc)
    },
    execSync: (cmd, opt) => {
      if (typeof tag === 'string' && tag !== null) {
        return tag + '\n'
      }
      // Simulate no-tags: execSync throws
      const err = new Error('fatal: No names found, cannot describe anything.')
      err.code = 'ENOENT'
      throw err
    },
  })
}

function scenario(name, pkgVersion, tag, expectedExit) {
  return async () => {
    const { mainCode, exitCode, mod } = makeScript(stubFromMap(pkgVersion, tag))
    const code = mainCode !== null ? mainCode : exitCode
    assert.strictEqual(
      code,
      expectedExit,
      name + ': expected exit ' + expectedExit + ', got ' + code
    )
  }
}

const tests = [
  [
    '1. match (tag omits patch): pkg 1.4.0 ↔ tag v1.4 → exit 0',
    scenario('match-vXY', '1.4.0', 'v1.4', 0),
  ],
  [
    '2. mismatch (different minor): pkg 1.5.0 ↔ tag v1.4 → exit 1',
    scenario('mismatch-minor', '1.5.0', 'v1.4', 1),
  ],
  [
    '3. tag without v prefix, patch omitted: pkg 1.4.0 ↔ tag 1.4 → exit 0',
    scenario('bare-numeric-tag', '1.4.0', '1.4', 0),
  ],
  [
    '4. match (full SemVer tag): pkg 1.5.0 ↔ tag v1.5.0 → exit 0',
    scenario('match-full-semver', '1.5.0', 'v1.5.0', 0),
  ],
  [
    '5. same major.minor, different patch: pkg 1.5.1 ↔ tag v1.5.0 → exit 0',
    scenario('same-mm-diff-patch', '1.5.1', 'v1.5.0', 0),
  ],
  [
    '6. no tags (execSync throws) → exit 1',
    scenario('no-tags', '1.4.0', null, 1),
  ],
]

// jest-compatible path
if (typeof describe === 'function' && typeof it === 'function') {
  describe('version-check', () => {
    for (const [name, fn] of tests) {
      it(name, fn)
    }
  })
}

// Standalone path: `node scripts/version-check.test.cjs`
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
// @ts-nocheck
/**
 * Tests for .github/workflows/release.yml (Phase 175, CC-02 / D-01 / D-02).
 *
 * The release pipeline was created in Phase 168 and first exercised in Phase 175.
 * Phase 175 fixed two latent bugs:
 *  - D-01: the "Verify package.json version matches tag" step compared raw
 *    strings and failed for a two-part tag (v1.5) vs three-part package.json
 *    (1.5.0). Fix: normalize both sides to major.minor via `cut -d. -f1-2`.
 *  - D-02: the "Extract release notes from CHANGELOG.md" awk step passed the
 *    tag inside brackets `[$TAG]` which awk treats as a char class (matches a
 *    single char) — so it never matched a real `## [v1.5.0]` header. Fix:
 *    escape the brackets + make the patch component optional + dot-escape the
 *    interpolated tag/version so both `[v1.5]` and `[v1.5.0]` headers match.
 *
 * This is a behavioral test: it parses the REAL release.yml, extracts the awk
 * block and the verify-step shell logic, and runs them against synthetic
 * CHANGELOG fixtures and version/tag pairings. A regression that re-introduces
 * the raw-string compare or the unescaped-bracket awk will fail this test.
 *
 * Standalone + jest-compatible: `node scripts/release-yml.test.cjs` runs the
 * assertions via the node `assert` module and exits 0/1; jest can also pick it
 * up because the file defines `describe()`/`it()` wrappers when present.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const RELEASE_YML = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml')

function readReleaseYml() {
  return fs.readFileSync(RELEASE_YML, 'utf8')
}

// ---------------------------------------------------------------------------
// D-01: verify-step major.minor normalization
//
// The verify step in release.yml derives PKG_MM and TAG_MM via
// `cut -d. -f1-2` and compares those. We replicate that exact normalization
// (split on '.', take first 2 parts, join with '.') and assert the pairing
// the requirement demands: two-part tag v1.5 matches three-part package.json
// 1.5.0, and a mismatched tag fails. We also assert the release.yml file
// ITSELF contains the cut-based normalization (structural guard against a
// regression that swaps it back to a raw compare).
// ---------------------------------------------------------------------------

// Mirror the shell `cut -d. -f1-2` semantic exactly.
function majorMinor(v) {
  // Strip a leading 'v' if present (the tag comes in as e.g. "v1.5"; the
  // workflow's meta step strips the v into VERSION, but the verify step
  // compares TAG_VERSION which is the v-stripped form. We handle both.)
  const s = String(v).replace(/^v/, '')
  const parts = s.split('.')
  return parts.slice(0, 2).join('.')
}

function verifyStepAccepts(pkgVersion, tagVersion) {
  const pkgMm = majorMinor(pkgVersion)
  const tagMm = majorMinor(tagVersion)
  return pkgMm === tagMm
}

// ---------------------------------------------------------------------------
// D-02: awk release-notes extraction
//
// We extract the REAL awk program text from release.yml (the block under
// `id: notes`) and run it against synthetic CHANGELOG fixtures via `awk`.
// This proves the actual shipped awk matches both [v1.5] and [v1.5.0] headers
// and excludes other version sections. We do NOT re-implement the awk — we
// parse it out of the workflow file so a regression in the YAML is caught.
// ---------------------------------------------------------------------------

// Extract the awk program (the single-quoted string passed to `awk -v ...`)
// from the release.yml "Extract release notes" step. Returns the raw awk text
// with shell line-continuations joined.
function extractAwkProgram(yml) {
  // The awk invocation spans multiple YAML lines using trailing backslashes.
  // Match from `awk -v tag=` up to the closing `' CHANGELOG.md)`.
  const m = yml.match(/awk\s+-v[^]*?CHANGELOG\.md\)\s*\n/)
  if (!m) {
    throw new Error('Could not locate the awk invocation in release.yml')
  }
  let block = m[0]
  // The awk program is the last single-quoted argument. Pull it out.
  // The block looks like:
  //   NOTES=$(awk -v tag="$TAG_ESC" -v ver="$VER_ESC" '\
  //     $0 ~ "^## \\[" tag "(\\.[0-9]+)?\\] " { print; in_sec=1; next }\
  //     ...
  //   ' CHANGELOG.md)
  const q = block.match(/'([\s\S]*)'\s+CHANGELOG\.md\)\s*$/)
  if (!q) {
    throw new Error('Could not extract the awk program body from release.yml')
  }
  // Join the shell line-continuations (trailing backslash + newline).
  return q[1].replace(/\\\n/g, '\n')
}

// Run the extracted awk program against a fixture CHANGELOG, with the given
// TAG and VERSION (already in the form the workflow passes: TAG includes the
// 'v', VERSION is v-stripped). Returns the captured NOTES text.
//
// We write the awk program to a temp file and invoke `awk -f` to avoid the
// shell-quoting hell of passing a multi-line awk program as a single argv
// string (the backslashes in the regex patterns collide with both shell and
// JSON-string escaping). The -v variables are passed on the command line —
// their values are simple dot-escaped strings with no shell metachars after
// the escape.
const os = require('node:os')
function runAwk(awkProgram, changelog, tag, version) {
  // Mirror the workflow's sed dot-escape: TAG_ESC/VER_ESC.
  const tagEsc = tag.replace(/\./g, '\\.')
  const verEsc = version.replace(/\./g, '\\.')
  // Write the awk program to a file in the repo (not /tmp — it is
  // quota-limited in this environment per AGENTS.md). The file is a test
  // artifact under scripts/ and is cleaned up after each run. We use
  // .release-yml-awk.prog next to the test file.
  const progFile = path.join(__dirname, '.release-yml-awk.prog')
  fs.writeFileSync(progFile, awkProgram, 'utf8')
  try {
    // Feed the changelog via stdin; pass tag/ver as -v variables; read the
    // program from the file. The -v values are safe (dots escaped to `\.` —
    // backslash-dot; we single-quote them so the shell passes them verbatim).
    const cmd = `awk -v tag='${tagEsc}' -v ver='${verEsc}' -f ${progFile}`
    const result = execSync(cmd, { input: changelog, cwd: REPO_ROOT })
    return result.toString('utf8')
  } finally {
    try { fs.unlinkSync(progFile) } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

const tests = []

// --- D-01 structural guards (the release.yml file itself contains the fix) ---

tests.push([
  'D-01 structural: release.yml verify step derives PKG_MM via cut -d. -f1-2',
  () => {
    const yml = readReleaseYml()
    assert.ok(
      /PKG_MM=\$\(echo "\$PKG_VERSION" \| cut -d\. -f1-2\)/.test(yml),
      'release.yml must derive PKG_MM via `cut -d. -f1-2` on $PKG_VERSION'
    )
  },
])

tests.push([
  'D-01 structural: release.yml verify step derives TAG_MM via cut -d. -f1-2',
  () => {
    const yml = readReleaseYml()
    assert.ok(
      /TAG_MM=\$\(echo "\$TAG_VERSION" \| cut -d\. -f1-2\)/.test(yml),
      'release.yml must derive TAG_MM via `cut -d. -f1-2` on $TAG_VERSION'
    )
  },
])

tests.push([
  'D-01 structural: release.yml verify step compares $PKG_MM != $TAG_MM (not raw)',
  () => {
    const yml = readReleaseYml()
    assert.ok(
      /\[ "\$PKG_MM" != "\$TAG_MM" \]/.test(yml),
      'release.yml verify step must compare $PKG_MM != $TAG_MM (major.minor), not the raw versions'
    )
    // Guard against a regression to the raw compare.
    assert.ok(
      !/\[ "\$PKG_VERSION" != "\$TAG_VERSION" \]/.test(yml),
      'release.yml must NOT contain a raw $PKG_VERSION != $TAG_VERSION comparison (D-01 regression)'
    )
  },
])

// --- D-01 behavioral: the normalization semantic the requirement demands ---

tests.push([
  'D-01 behavior: two-part tag v1.5 matches three-part package.json 1.5.0',
  () => {
    assert.ok(
      verifyStepAccepts('1.5.0', '1.5'),
      'tag v1.5 (→ 1.5) must match package.json 1.5.0 (→ 1.5) under major.minor normalization'
    )
  },
])

tests.push([
  'D-01 behavior: full SemVer tag v1.5.0 matches package.json 1.5.0',
  () => {
    assert.ok(verifyStepAccepts('1.5.0', '1.5.0'))
  },
])

tests.push([
  'D-01 behavior: same major.minor different patch matches (1.5.1 ↔ v1.5.0)',
  () => {
    assert.ok(verifyStepAccepts('1.5.1', '1.5.0'))
  },
])

tests.push([
  'D-01 behavior: different minor FAILS (1.5.0 ↔ v1.4) — regression guard',
  () => {
    assert.ok(
      !verifyStepAccepts('1.5.0', '1.4'),
      'package.json 1.5.0 must NOT match tag v1.4 (different minor) — a mismatch must fail the verify step'
    )
  },
])

tests.push([
  'D-01 behavior: different major FAILS (2.0.0 ↔ v1.5) — regression guard',
  () => {
    assert.ok(!verifyStepAccepts('2.0.0', '1.5'))
  },
])

// --- D-02 structural guards ---

tests.push([
  'D-02 structural: release.yml awk uses escaped brackets \\[ and optional patch (\\.[0-9]+)?',
  () => {
    const yml = readReleaseYml()
    // The awk program in the YAML contains `^## \\[` (double-backslash + [)
    // and `(\\.[0-9]+)?` for the optional patch component. Use literal
    // .includes() to avoid regex-vs-escaping confusion.
    assert.ok(
      yml.includes('"^## \\\\['),
      'release.yml awk must escape the brackets (\\[) in the start patterns'
    )
    assert.ok(
      yml.includes('(\\\\.[0-9]+)?\\\\]'),
      'release.yml awk must include an optional patch component (\\.[0-9]+)? in the start patterns'
    )
  },
])

tests.push([
  'D-02 structural: release.yml awk preserves the terminator in_sec && /^## \\[/ { exit }',
  () => {
    const yml = readReleaseYml()
    assert.ok(
      /in_sec && \/\^## \\\[\/ \{ exit \}/.test(yml),
      'release.yml awk must preserve the `in_sec && /^## \\[/ { exit }` terminator'
    )
  },
])

tests.push([
  'D-02 structural: release.yml derives TAG_ESC/VER_ESC via sed dot-escape',
  () => {
    const yml = readReleaseYml()
    assert.ok(
      /TAG_ESC=\$\(printf '%s' "\$TAG" \| sed 's\/\\\.\/\\\\\.\/g'\)/.test(yml),
      'release.yml must derive TAG_ESC via sed dot-escape'
    )
  },
])

// --- D-02 behavioral: the real awk extracts the correct section ---

// Fixture with a THREE-part header (the shape version:bump produces).
const FIXTURE_THREE_PART = [
  '## [Unreleased]',
  '',
  '### Added',
  '- future bullet',
  '',
  '## [v1.5.0] — 2026-08-28',
  '',
  '### Added',
  '- v1.5 bullet one',
  '- v1.5 bullet two',
  '',
  '## [v1.4] — 2026-08-27 — Horizontal Scale',
  '',
  '### Added',
  '- v1.4 bullet',
  '',
  '## [v1.3] — 2026-08-20',
  '',
  '### Fixed',
  '- v1.3 fix',
  '',
].join('\n')

// Fixture with a TWO-part header (the legacy tag scheme shape).
const FIXTURE_TWO_PART = FIXTURE_THREE_PART.replace(
  '## [v1.5.0] — 2026-08-28',
  '## [v1.5] — 2026-08-28'
)

tests.push([
  'D-02 behavior: awk extracts the [v1.5.0] section (three-part header) for tag v1.5',
  () => {
    const yml = readReleaseYml()
    const prog = extractAwkProgram(yml)
    const notes = runAwk(prog, FIXTURE_THREE_PART, 'v1.5', '1.5')
    assert.ok(
      notes.includes('## [v1.5.0] — 2026-08-28'),
      'awk must capture the [v1.5.0] header for tag v1.5'
    )
    assert.ok(
      notes.includes('- v1.5 bullet one') && notes.includes('- v1.5 bullet two'),
      'awk must capture both v1.5 bullets'
    )
    assert.ok(
      !notes.includes('## [v1.4]'),
      'awk must NOT capture the v1.4 section (terminator must stop it)'
    )
    assert.ok(
      !notes.includes('future bullet'),
      'awk must NOT capture [Unreleased] content'
    )
    assert.ok(
      !notes.includes('v1.4 bullet'),
      'awk must NOT capture v1.4 bullets'
    )
  },
])

tests.push([
  'D-02 behavior: awk extracts the [v1.5] section (two-part header) for tag v1.5 — optional-patch match',
  () => {
    const yml = readReleaseYml()
    const prog = extractAwkProgram(yml)
    const notes = runAwk(prog, FIXTURE_TWO_PART, 'v1.5', '1.5')
    assert.ok(
      notes.includes('## [v1.5] — 2026-08-28'),
      'awk must capture the two-part [v1.5] header (optional-patch match)'
    )
    assert.ok(
      notes.includes('- v1.5 bullet one') && notes.includes('- v1.5 bullet two'),
      'awk must capture both v1.5 bullets from the two-part-header section'
    )
    assert.ok(
      !notes.includes('## [v1.4]'),
      'awk must NOT capture the v1.4 section'
    )
  },
])

tests.push([
  'D-02 behavior: awk extracts the [v1.5.0] section for a FULL SemVer tag v1.5.0',
  () => {
    const yml = readReleaseYml()
    const prog = extractAwkProgram(yml)
    const notes = runAwk(prog, FIXTURE_THREE_PART, 'v1.5.0', '1.5.0')
    assert.ok(
      notes.includes('## [v1.5.0] — 2026-08-28'),
      'awk must capture the [v1.5.0] section when the tag itself is v1.5.0'
    )
    assert.ok(
      notes.includes('- v1.5 bullet one'),
      'awk must capture the v1.5 bullets for a full-SemVer tag'
    )
  },
])

tests.push([
  'D-02 behavior: awk for tag v1.4 captures ONLY the v1.4 section (terminator stops before v1.5)',
  () => {
    const yml = readReleaseYml()
    const prog = extractAwkProgram(yml)
    const notes = runAwk(prog, FIXTURE_THREE_PART, 'v1.4', '1.4')
    assert.ok(
      notes.includes('## [v1.4] — 2026-08-27'),
      'awk must capture the v1.4 header for tag v1.4'
    )
    assert.ok(
      notes.includes('- v1.4 bullet'),
      'awk must capture the v1.4 bullet'
    )
    assert.ok(
      !notes.includes('v1.5 bullet'),
      'awk must NOT capture v1.5 content when extracting the v1.4 section'
    )
  },
])

tests.push([
  'D-02 behavior: awk for a non-existent tag falls back to empty (workflow substitutes placeholder)',
  () => {
    const yml = readReleaseYml()
    const prog = extractAwkProgram(yml)
    const notes = runAwk(prog, FIXTURE_THREE_PART, 'v9.9', '9.9')
    assert.strictEqual(
      notes.trim(),
      '',
      'awk must return empty for a tag with no matching section (the workflow then substitutes the placeholder)'
    )
  },
])

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

// jest-compatible path
if (typeof describe === 'function' && typeof it === 'function') {
  describe('release.yml (Phase 175 D-01/D-02)', () => {
    for (const [name, fn] of tests) {
      it(name, fn)
    }
  })
}

// Standalone path: `node scripts/release-yml.test.cjs`
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

module.exports = { tests, extractAwkProgram, runAwk, majorMinor, verifyStepAccepts }
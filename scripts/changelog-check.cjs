#!/usr/bin/env node
/**
 * Changelog discipline verifier (Phase 173, CL-01 / D-01 / D-02 / D-03).
 *
 * Asserts two things about the repo's CHANGELOG.md:
 *
 * 1. CL-01 / D-01 — a PR touching a package's `src/` tree (excluding
 *    `__tests__` dirs at ANY depth under `src/`) must add at least one bullet
 *    (`- ` or `* ` prefixed line) under `## [Unreleased]`.
 *    Category headers (`### Added`) without bullets do NOT count as content.
 *    Test-only / docs-only / CI-only changes need no entry.
 *
 * 2. CL-02 / D-03 — pragmatic Keep-a-Changelog 1.1.0 format validation of the
 *    project's ESTABLISHED conventions: the `## [Unreleased]` header exists,
 *    every other `## [` header matches `## [vX.Y.Z] — YYYY-MM-DD` (em-dash,
 *    `v` prefix, OPTIONAL patch component, optional ` — Title` suffix), and
 *    every `### ` category header is from the allowlist (incl. the custom
 *    `Breaking changes — operator action required` + `Infrastructure`).
 *    Version links at the bottom are NOT required. This is the SAME format
 *    `scripts/version-bump.cjs` generates (D-03) and `release.yml`'s awk
 *    extraction depends on (`## [TAG]` header shape staying stable).
 *
 * Diff-based PR detection (D-02): `git diff --name-only origin/main...HEAD`
 * (three-dot merge-base diff) when `GITHUB_BASE_REF` is set (PR context),
 * `git diff --name-only HEAD~1` otherwise (push context). A git failure
 * (missing `origin/main`, shallow history) is fail-LOUD exit 1 — a gate that
 * cannot see the diff must fail, never silently pass.
 *
 * The gate is READ-ONLY: it never modifies CHANGELOG.md (the v1.5 section
 * rename happens in Phase 175 via `version:bump`).
 *
 * Exit-code contract (mirrors `version-check.cjs`):
 *   0 = format valid AND (no src-touching files OR [Unreleased] has bullets)
 *   1 = format violation, OR src-touching PR with empty [Unreleased],
 *       OR CHANGELOG.md unreadable, OR git diff failed
 *
 * Plain-Node CJS Script Pattern: zero deps (only `node:fs` / `node:path` /
 * `node:child_process`), `main()` returns the exit code (the thin
 * `if (require.main === module)` wrapper performs the actual exit),
 * `module.exports` for testability. Paths resolve relative to `__dirname`
 * (NOT `process.cwd()`), so the script is location-independent.
 *
 * Testability: tests import `{ main, CHANGELOG, CATEGORIES, RELEASED_HEADER_RE,
 * SRC_RE, TESTS_RE, countUnreleasedBullets, validateFormat, getChangedFiles }`
 * and assert on the returned code, stubbing `fs.readFileSync` +
 * `child_process.execSync` via the require-cache-clear + injection pattern from
 * `version-check.test.cjs`.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const CHANGELOG = 'CHANGELOG.md'

// D-03: category allowlist (em-dash U+2014 in the Breaking-changes entry —
// copied verbatim from CHANGELOG.md line 85).
const CATEGORIES = [
  'Added',
  'Changed',
  'Fixed',
  'Removed',
  'Security',
  'Breaking changes — operator action required',
  'Infrastructure',
]

// D-03: released header format — em-dash, `v` prefix, OPTIONAL patch component
// (the current file's two-part `v1.4`/`v1.3` headers MUST match), optional
// ` — Title` suffix. The same format version-bump.cjs generates.
const RELEASED_HEADER_RE = /^## \[v\d+\.\d+(\.\d+)?\] — \d{4}-\d{2}-\d{2}( — .+)?$/

// D-02: the `packages/*/src/**` scope filter.
const SRC_RE = /^packages\/[^/]+\/src\//

// D-02: the exclusion — matches `__tests__` at ANY depth under `src/`
// (e.g. `packages/server/src/__tests__/`, `packages/server/src/agent/__tests__/`,
// `packages/frontend/src/components/ui/__tests__/`). A top-level-only regex
// would false-positive exit 1 on test-only PRs touching nested test dirs.
const TESTS_RE = /^packages\/[^/]+\/src\/(?:[^/]+\/)*__tests__\//

/**
 * Count bullet lines under the `## [Unreleased]` section (D-01).
 * Scans from the `## [Unreleased]` line to the next `## [` header or EOF
 * (the section may be LAST — read to EOF). Counts lines whose trimmed form
 * starts with `- ` or `* ` (bullet lines). Category headers (`### ...`),
 * whitespace-only lines, and `---` separators do NOT count.
 * Returns 0 when the header is absent.
 * @param {string} changelog full CHANGELOG.md content
 * @returns {number} bullet count under [Unreleased]
 */
function countUnreleasedBullets(changelog) {
  const headerIdx = changelog.indexOf('## [Unreleased]')
  if (headerIdx === -1) return 0
  const fromHeader = changelog.slice(headerIdx + '## [Unreleased]'.length)
  // Next `## [` header after the [Unreleased] line, or EOF.
  const nextHeaderMatch = fromHeader.match(/^## \[/m)
  const section =
    nextHeaderMatch === null ? fromHeader : fromHeader.slice(0, nextHeaderMatch.index)
  let count = 0
  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) count++
  }
  return count
}

/**
 * Validate the CHANGELOG format (CL-02 / D-03):
 *   (1) the literal `## [Unreleased]` header exists;
 *   (2) every other `## [` header matches `RELEASED_HEADER_RE`;
 *   (3) every `### ` category header is in `CATEGORIES`.
 * Version links at the bottom are NOT validated (D-03 item 4).
 * `ok` is true only when `errors` is empty.
 * @param {string} changelog full CHANGELOG.md content
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateFormat(changelog) {
  const errors = []
  if (!changelog.split('\n').includes('## [Unreleased]')) {
    errors.push('missing "## [Unreleased]" header')
  }
  for (const line of changelog.split('\n')) {
    if (!line.startsWith('## [')) continue
    if (line.startsWith('## [Unreleased]')) continue
    if (!RELEASED_HEADER_RE.test(line)) {
      errors.push('released header does not match "## [vX.Y.Z] — YYYY-MM-DD": ' + line)
    }
  }
  for (const line of changelog.split('\n')) {
    if (!line.startsWith('### ')) continue
    const category = line.slice('### '.length).trim()
    if (CATEGORIES.indexOf(category) === -1) {
      errors.push('unknown category header (allowlist: ' + CATEGORIES.join(', ') + '): ' + line)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Compute the changed files of the current change (D-02):
 * `git diff --name-only origin/main...HEAD` when `GITHUB_BASE_REF` is set
 * (PR context — three-dot = merge-base diff), `git diff --name-only HEAD~1`
 * otherwise (push context).
 * On execSync failure (missing `origin/main`, shallow history, no `HEAD~1`):
 * prints a ✗ error + hint and returns `null` (fail-loud — a gate that cannot
 * see the diff must fail, never silently pass).
 * @returns {string[]|null} changed file paths, or null on git failure
 */
function getChangedFiles() {
  const cmd =
    process.env.GITHUB_BASE_REF !== undefined
      ? 'git diff --name-only origin/main...HEAD'
      : 'git diff --name-only HEAD~1'
  let out
  try {
    out = execSync(cmd, { encoding: 'utf8' })
  } catch (e) {
    console.error('✗ cannot compute changed files — ' + e.message)
    console.error('  Run with a full clone (fetch-depth: 0) or `git fetch origin main`')
    return null
  }
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
}

/**
 * The changelog discipline gate. Returns the exit code (0 = pass, 1 = fail).
 * Does NOT call `process.exit` — the CLI wrapper does that.
 * @returns {number} 0 on pass, 1 on failure
 */
function main() {
  const clPath = path.resolve(__dirname, '..', CHANGELOG)
  let changelog
  try {
    changelog = fs.readFileSync(clPath, 'utf8')
  } catch (e) {
    console.error('✗ cannot read ' + CHANGELOG + ' — ' + e.message)
    return 1
  }

  // CL-02 is unconditional: format errors are ALWAYS fatal.
  const format = validateFormat(changelog)
  if (!format.ok) {
    for (const err of format.errors) {
      console.error('✗ ' + CHANGELOG + ': ' + err)
    }
    return 1
  }

  const changed = getChangedFiles()
  if (changed === null) return 1

  // D-02 scope filter: `packages/*/src/**` minus `packages/*/src/**/__tests__/**`.
  const srcFiles = changed.filter((f) => SRC_RE.test(f) && !TESTS_RE.test(f))
  if (srcFiles.length === 0) {
    console.log(
      '✓ no packages/*/src/** changes (excluding __tests__/ at any depth) — changelog entry not required'
    )
    return 0
  }

  const bullets = countUnreleasedBullets(changelog)
  if (bullets === 0) {
    console.error(
      '✗ [Unreleased] has no entries but this PR touches packages/*/src/**'
    )
    console.error('  Add a bullet under ## [Unreleased] in CHANGELOG.md (e.g. under ### Added)')
    return 1
  }
  console.log('✓ [Unreleased] has ' + bullets + ' entries — changelog discipline satisfied')
  return 0
}

module.exports = {
  main,
  CHANGELOG,
  CATEGORIES,
  RELEASED_HEADER_RE,
  SRC_RE,
  TESTS_RE,
  countUnreleasedBullets,
  validateFormat,
  getChangedFiles,
}

// CLI entrypoint — only runs when invoked directly, not when required by tests.
if (require.main === module) {
  process.exit(main())
}

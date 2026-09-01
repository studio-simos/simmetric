#!/usr/bin/env node
/**
 * Quick-task backlog triage verifier (Phase 171, QT-01).
 *
 * Asserts the planning-tree state satisfies the QT-01 success criteria that
 * Phase 171 established:
 *   1. Open quick-task count (dirs with no <id>-SUMMARY.md) is ≤ 20.
 *   2. Every open task has an <id>-NOTE.md with a valid target_milestone tag
 *      (v1.5 | v1.6 | backlog).
 *   3. Every closed task's <id>-SUMMARY.md frontmatter has status: done|stale
 *      and a non-empty one-line closure note in the body.
 *   4. triage-table.md exists with one data row per quick-task directory.
 *   5. STATE.md no longer carries the stale "130 incomplete quick tasks" row
 *      and reflects the Phase 171 post-triage open count.
 *
 * Plain-Node CJS Script Pattern: zero deps (only `node:fs` / `node:path`),
 * `main()` returns the exit code (the thin `if (require.main === module)`
 * wrapper performs the actual exit), `module.exports` for testability. Paths
 * resolve relative to the repo root via `process.cwd()` so the script can be
 * invoked from anywhere in the repo — the planning tree is at the repo root.
 *
 * Exit-code contract:
 *   0 = all QT-01 criteria satisfied
 *   1 = one or more criteria violated (messages on stderr)
 *
 * Testability: tests import `{ main, checkOpenCount, checkOpenTags,
 * checkClosedSummaries, checkTriageTable, checkStateMd }` and assert on the
 * returned result objects.
 */

const fs = require('node:fs')
const path = require('node:path')

const QUICK_DIR = '.planning/quick'
const TRIAGE_TABLE = '.planning/phases/171-quick-task-backlog-triage/triage-table.md'
const STATE_FILE = '.planning/STATE.md'
const MAX_OPEN = 20
const TARGET_RE = /target_milestone:\s*(v1\.5|v1\.6|backlog)/
const STATUS_RE = /status:\s*(done|stale)/

function listQuickDirs(rootDir) {
  const dir = path.join(rootDir, QUICK_DIR)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
}

/**
 * Criterion 1 — open count ≤ MAX_OPEN.
 * Returns { pass, open, closed, total, openList }.
 */
function checkOpenCount(rootDir) {
  const dirs = listQuickDirs(rootDir)
  const openList = []
  let closed = 0
  for (const d of dirs) {
    const sum = path.join(rootDir, QUICK_DIR, d, d + '-SUMMARY.md')
    if (fs.existsSync(sum)) {
      closed++
    } else {
      openList.push(d)
    }
  }
  return {
    pass: openList.length <= MAX_OPEN,
    open: openList.length,
    closed,
    total: dirs.length,
    openList,
  }
}

/**
 * Criterion 2 — every open task has NOTE.md with target_milestone.
 * Returns { pass, checked, violations }.
 */
function checkOpenTags(rootDir, openList) {
  const violations = []
  for (const d of openList) {
    const note = path.join(rootDir, QUICK_DIR, d, d + '-NOTE.md')
    if (!fs.existsSync(note)) {
      violations.push({ dir: d, reason: 'no NOTE.md' })
      continue
    }
    const t = fs.readFileSync(note, 'utf8')
    if (!TARGET_RE.test(t)) {
      violations.push({ dir: d, reason: 'missing target_milestone tag' })
    }
  }
  return { pass: violations.length === 0, checked: openList.length, violations }
}

/**
 * Criterion 3 — every closed SUMMARY has status: done|stale + non-empty body.
 * Returns { pass, checked, violations }.
 */
function checkClosedSummaries(rootDir) {
  const dirs = listQuickDirs(rootDir)
  const violations = []
  let checked = 0
  for (const d of dirs) {
    const sum = path.join(rootDir, QUICK_DIR, d, d + '-SUMMARY.md')
    if (!fs.existsSync(sum)) continue
    checked++
    const t = fs.readFileSync(sum, 'utf8')
    if (!STATUS_RE.test(t)) {
      violations.push({ dir: d, reason: 'missing status: done|stale' })
      continue
    }
    const body = t.replace(/^---[\s\S]*?---/, '').trim()
    if (body.length === 0) {
      violations.push({ dir: d, reason: 'empty closure note body' })
    }
  }
  return { pass: violations.length === 0, checked, violations }
}

/**
 * Criterion 4 — triage-table.md has one data row per quick-task dir.
 * Returns { pass, dirCount, rowCount }.
 */
function checkTriageTable(rootDir) {
  const ttPath = path.join(rootDir, TRIAGE_TABLE)
  if (!fs.existsSync(ttPath)) {
    return { pass: false, dirCount: 0, rowCount: 0, reason: 'triage-table.md missing' }
  }
  const tt = fs.readFileSync(ttPath, 'utf8')
  const dirCount = listQuickDirs(rootDir).length
  // Data rows: lines starting with "| " but not headers/separators.
  const rows = tt
    .split('\n')
    .filter((l) => /^\| [^|_-]/.test(l) && l.split('|').length >= 5).length
  return { pass: rows >= dirCount, dirCount, rowCount: rows }
}

/**
 * Criterion 5 — STATE.md no longer says "130 incomplete" and carries the
 * Phase 171 post-triage marker.
 * Returns { pass, hasStaleRow, hasPhaseMarker }.
 */
function checkStateMd(rootDir) {
  const stPath = path.join(rootDir, STATE_FILE)
  const st = fs.readFileSync(stPath, 'utf8')
  const hasStaleRow = /130 incomplete quick tasks/.test(st)
  const hasPhaseMarker = /open quick tasks after Phase 171/.test(st)
  return { pass: !hasStaleRow && hasPhaseMarker, hasStaleRow, hasPhaseMarker }
}

/**
 * Run all five QT-01 criteria. Returns { pass, results }.
 */
function main(rootDir) {
  rootDir = rootDir || process.cwd()
  const results = {}

  results.openCount = checkOpenCount(rootDir)
  results.openTags = checkOpenTags(rootDir, results.openCount.openList)
  results.closedSummaries = checkClosedSummaries(rootDir)
  results.triageTable = checkTriageTable(rootDir)
  results.stateMd = checkStateMd(rootDir)

  const pass = Object.values(results).every((r) => r.pass)
  return { pass, results }
}

module.exports = {
  main,
  checkOpenCount,
  checkOpenTags,
  checkClosedSummaries,
  checkTriageTable,
  checkStateMd,
  listQuickDirs,
  QUICK_DIR,
  TRIAGE_TABLE,
  STATE_FILE,
  MAX_OPEN,
}

if (require.main === module) {
  const { pass, results } = main()
  if (!pass) {
    for (const [name, r] of Object.entries(results)) {
      if (!r.pass) {
        console.error('FAIL ' + name + ': ' + JSON.stringify(r))
      }
    }
    process.exit(1)
  }
  console.log(
    'PASS: QT-01 triage state OK — ' +
      results.openCount.open +
      ' open (≤' +
      MAX_OPEN +
      '), ' +
      results.openCount.closed +
      ' closed, ' +
      results.openCount.total +
      ' total'
  )
  process.exit(0)
}
// @ts-nocheck
/**
 * Tests for scripts/quick-task-triage-check.cjs (Phase 171, QT-01).
 *
 * Standalone + jest-compatible: `node scripts/quick-task-triage-check.test.cjs`
 * runs the assertions via the node `assert` module and exits 0/1; jest can
 * also pick it up because the file defines `describe`/`it` wrappers when they
 * are present.
 *
 * Two test families:
 *   A. Live-state tests — assert the REAL .planning/ tree satisfies QT-01's
 *      five criteria (open count ≤ 20, all open tagged, all closed SUMMARYs
 *      have status + body, triage-table complete, STATE.md updated). These
 *      can FAIL if someone reverts the triage — that is the point.
 *   B. Logic tests — exercise each check function against synthetic fixtures
 *      (temp dirs) to prove the checks actually detect violations (false-pass
 *      guard). These ensure the verifier is not a tautology.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  main,
  checkOpenCount,
  checkOpenTags,
  checkClosedSummaries,
  checkTriageTable,
  checkStateMd,
  MAX_OPEN,
} = require('./quick-task-triage-check.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// Family A — live-state tests (the real .planning/ tree)
// ---------------------------------------------------------------------------

function liveTests() {
  const tests = [
    [
      'A1. live: open quick-task count is ≤ ' + MAX_OPEN + ' (QT-01 criterion 1)',
      () => {
        const r = checkOpenCount(REPO_ROOT)
        assert.ok(
          r.pass,
          'open=' + r.open + ' exceeds limit ' + MAX_OPEN + ': ' + r.openList.join(', ')
        )
      },
    ],
    [
      'A2. live: every open task has NOTE.md with target_milestone (QT-01 criterion 2)',
      () => {
        const oc = checkOpenCount(REPO_ROOT)
        const r = checkOpenTags(REPO_ROOT, oc.openList)
        assert.ok(r.pass, 'violations: ' + JSON.stringify(r.violations))
      },
    ],
    [
      'A3. live: every closed SUMMARY has status: done|stale + non-empty body (QT-01 criterion 3)',
      () => {
        const r = checkClosedSummaries(REPO_ROOT)
        assert.ok(r.pass, 'violations: ' + JSON.stringify(r.violations))
      },
    ],
    [
      'A4. live: triage-table.md has a row per quick-task dir (QT-01 criterion 4)',
      () => {
        const r = checkTriageTable(REPO_ROOT)
        assert.ok(
          r.pass,
          'triage-table rows=' + r.rowCount + ' < dir count=' + r.dirCount
        )
      },
    ],
    [
      'A5. live: STATE.md no longer carries stale 130-row and has Phase 171 marker (QT-01 criterion 5)',
      () => {
        const r = checkStateMd(REPO_ROOT)
        assert.ok(
          r.pass,
          'staleRow=' + r.hasStaleRow + ' phaseMarker=' + r.hasPhaseMarker
        )
      },
    ],
    [
      'A6. live: main() returns pass=true for the full .planning/ tree',
      () => {
        const { pass, results } = main(REPO_ROOT)
        assert.ok(pass, 'main() failed: ' + JSON.stringify(results, null, 0))
      },
    ],
  ]
  return tests
}

// ---------------------------------------------------------------------------
// Family B — logic tests (synthetic fixtures prove the checks detect violations)
// ---------------------------------------------------------------------------

function makeTempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qt171-'))
  const qd = path.join(root, '.planning/quick')
  fs.mkdirSync(qd, { recursive: true })
  const ph = path.join(root, '.planning/phases/171-quick-task-backlog-triage')
  fs.mkdirSync(ph, { recursive: true })
  return root
}

function makeDir(qd, name) {
  const d = path.join(qd, name)
  fs.mkdirSync(d, { recursive: true })
  return d
}

function writeSummary(d, name, status, body) {
  const bodyLine = body || 'Done — shipped in v0.7.'
  fs.writeFileSync(
    path.join(d, name + '-SUMMARY.md'),
    '---\nphase: quick\nplan: ' + name + '\nstatus: ' + status + '\nclosed_in: Phase 171\n---\n' + bodyLine + '\n'
  )
}

function writeNote(d, name, milestone) {
  fs.writeFileSync(
    path.join(d, name + '-NOTE.md'),
    '---\ntarget_milestone: ' + milestone + '\n---\nOpen — real work.\n'
  )
}

function logicTests() {
  return [
    [
      'B1. checkOpenCount detects >20 open dirs as failure',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        for (let i = 0; i < 25; i++) {
          makeDir(qd, 'open-' + i)
        }
        const r = checkOpenCount(root)
        assert.strictEqual(r.open, 25)
        assert.strictEqual(r.pass, false)
      },
    ],
    [
      'B2. checkOpenCount accepts ≤20 open dirs',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        for (let i = 0; i < 10; i++) {
          makeDir(qd, 'open-' + i)
        }
        const r = checkOpenCount(root)
        assert.strictEqual(r.open, 10)
        assert.strictEqual(r.pass, true)
      },
    ],
    [
      'B3. checkOpenTags flags a missing NOTE.md',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        const d = makeDir(qd, 'untagged-task')
        // no NOTE.md
        const r = checkOpenTags(root, ['untagged-task'])
        assert.strictEqual(r.pass, false)
        assert.strictEqual(r.violations[0].reason, 'no NOTE.md')
      },
    ],
    [
      'B4. checkOpenTags flags a NOTE.md without target_milestone',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        const d = makeDir(qd, 'bad-tag-task')
        fs.writeFileSync(path.join(d, 'bad-tag-task-NOTE.md'), '---\nfoo: bar\n---\nno milestone\n')
        const r = checkOpenTags(root, ['bad-tag-task'])
        assert.strictEqual(r.pass, false)
        assert.strictEqual(r.violations[0].reason, 'missing target_milestone tag')
      },
    ],
    [
      'B5. checkOpenTags accepts a valid v1.6 tag',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        const d = makeDir(qd, 'good-task')
        writeNote(d, 'good-task', 'v1.6')
        const r = checkOpenTags(root, ['good-task'])
        assert.strictEqual(r.pass, true)
      },
    ],
    [
      'B6. checkClosedSummaries flags missing status field',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        const d = makeDir(qd, 'nostatus-task')
        fs.writeFileSync(path.join(d, 'nostatus-task-SUMMARY.md'), '---\nphase: quick\n---\nbody line\n')
        const r = checkClosedSummaries(root)
        assert.strictEqual(r.pass, false)
        assert.strictEqual(r.violations[0].reason, 'missing status: done|stale')
      },
    ],
    [
      'B7. checkClosedSummaries flags empty body',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        const d = makeDir(qd, 'nobody-task')
        fs.writeFileSync(path.join(d, 'nobody-task-SUMMARY.md'), '---\nstatus: done\n---\n\n')
        const r = checkClosedSummaries(root)
        assert.strictEqual(r.pass, false)
        assert.strictEqual(r.violations[0].reason, 'empty closure note body')
      },
    ],
    [
      'B8. checkClosedSummaries accepts valid done+stale SUMMARYs',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        const d1 = makeDir(qd, 'done-task')
        writeSummary(d1, 'done-task', 'done', 'Done — shipped in v0.7.')
        const d2 = makeDir(qd, 'stale-task')
        writeSummary(d2, 'stale-task', 'stale', 'Stale — Bree removed.')
        const r = checkClosedSummaries(root)
        assert.strictEqual(r.pass, true)
        assert.strictEqual(r.checked, 2)
      },
    ],
    [
      'B9. checkTriageTable flags missing file',
      () => {
        const root = makeTempTree()
        const r = checkTriageTable(root)
        assert.strictEqual(r.pass, false)
        assert.strictEqual(r.reason, 'triage-table.md missing')
      },
    ],
    [
      'B10. checkStateMd flags stale 130-row',
      () => {
        const root = makeTempTree()
        const stDir = path.join(root, '.planning')
        fs.mkdirSync(stDir, { recursive: true })
        fs.writeFileSync(path.join(stDir, 'STATE.md'), '... 130 incomplete quick tasks ...\n')
        const r = checkStateMd(root)
        assert.strictEqual(r.hasStaleRow, true)
        assert.strictEqual(r.pass, false)
      },
    ],
    [
      'B11. checkStateMd flags missing Phase 171 marker',
      () => {
        const root = makeTempTree()
        const stDir = path.join(root, '.planning')
        fs.mkdirSync(stDir, { recursive: true })
        fs.writeFileSync(path.join(stDir, 'STATE.md'), 'some other content\n')
        const r = checkStateMd(root)
        assert.strictEqual(r.hasPhaseMarker, false)
        assert.strictEqual(r.pass, false)
      },
    ],
    [
      'B12. main() returns pass=false on a tree with >20 open dirs',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        for (let i = 0; i < 25; i++) makeDir(qd, 'open-' + i)
        // main() calls all 5 checks; STATE.md must exist for checkStateMd
        fs.writeFileSync(path.join(root, '.planning/STATE.md'), 'content\n')
        const { pass, results } = main(root)
        assert.strictEqual(pass, false)
        assert.strictEqual(results.openCount.pass, false)
      },
    ],
    [
      'B13. main() returns pass=true on a fully-valid synthetic tree',
      () => {
        const root = makeTempTree()
        const qd = path.join(root, '.planning/quick')
        // 3 closed + 2 open (well under 20)
        for (const [n, st] of [['d1', 'done'], ['d2', 'stale'], ['d3', 'done']]) {
          const d = makeDir(qd, n)
          writeSummary(d, n, st, 'Note for ' + n)
        }
        for (const [n, m] of [['o1', 'v1.5'], ['o2', 'backlog']]) {
          const d = makeDir(qd, n)
          writeNote(d, n, m)
        }
        // triage-table with 5 rows
        const tt = path.join(root, '.planning/phases/171-quick-task-backlog-triage/triage-table.md')
        fs.writeFileSync(
          tt,
          '| dir | disposition | reason | note |\n|-----|-------------|--------|------|\n' +
            ['d1', 'd2', 'd3', 'o1', 'o2'].map((n) => '| ' + n + ' | x | y | z |').join('\n') +
            '\n'
        )
        // STATE.md valid
        const stDir = path.join(root, '.planning')
        fs.writeFileSync(
          path.join(stDir, 'STATE.md'),
          '... open quick tasks after Phase 171 triage ...\n'
        )
        const { pass, results } = main(root)
        assert.ok(pass, 'expected pass, got: ' + JSON.stringify(results, null, 0))
      },
    ],
  ]
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const allTests = liveTests().concat(logicTests())

if (typeof describe === 'function' && typeof it === 'function') {
  describe('quick-task-triage-check', () => {
    for (const [name, fn] of allTests) it(name, fn)
  })
}

if (require.main === module) {
  ;(async () => {
    let passed = 0
    let failed = 0
    for (const [name, fn] of allTests) {
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
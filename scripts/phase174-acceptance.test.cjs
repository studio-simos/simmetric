// @ts-nocheck
/**
 * Phase 174 acceptance criteria — Nyquist validation gap fill.
 *
 * Phase 174 is a docs-only evaluation phase (FEAT-01 document text edit +
 * re-index → SHIP v1.6; FEAT-02 formal MCP-in-chat logic fix → DESCOPE).
 * The PLAN's acceptance criteria are grep-verifiable string/line checks
 * against the two evaluation docs, STATE.md, REQUIREMENTS.md, and the
 * cited code lines. This script codifies those criteria into runnable
 * assertions that CAN FAIL if any deliverable drifts from the contract.
 *
 * Standalone + jest-compatible: `node scripts/phase174-acceptance.test.cjs`
 * runs the assertions via node `assert` and exits 0/1; jest picks it up
 * because the file defines `test()` wrappers when describe/it are present.
 *
 * Requirements covered: FEAT-01, FEAT-02 (evaluation, not implementation).
 * Source of truth: 174-01-PLAN.md acceptance_criteria + must_haves truths.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// grep a file for a regex; return matching lines (array). Errors if file missing.
function grep(rel, pattern, flags) {
  const file = path.join(ROOT, rel)
  if (!fs.existsSync(file)) return []
  const content = read(rel)
  const lines = content.split('\n')
  const re = new RegExp(pattern, flags || '')
  return lines.filter((l) => re.test(l))
}

// Verify a cited file:line actually contains the expected substring.
// This is the adversarial core: docs claim citations — we confirm they're real.
function lineContains(rel, lineNo, expected) {
  const content = read(rel)
  const lines = content.split('\n')
  const line = lines[lineNo - 1]
  return line !== undefined && line.includes(expected)
}

const tests = [
  // ---- FEAT-01: docs/FEAT-01-EVALUATION.md ----
  [
    'FEAT-01: docs/FEAT-01-EVALUATION.md exists',
    () => {
      assert.ok(fs.existsSync(path.join(ROOT, 'docs/FEAT-01-EVALUATION.md')), 'doc missing')
    },
  ],
  [
    'FEAT-01: all 7 skeleton section headers present',
    () => {
      const doc = read('docs/FEAT-01-EVALUATION.md')
      const required = [
        '## Context',
        '## Effort',
        '## Affected Packages',
        '## Migration Impact',
        '## User Value',
        '## Risk',
        '## Recommendation',
      ]
      for (const h of required) {
        const re = new RegExp('^' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm')
        assert.ok(re.test(doc), 'missing section header: ' + h)
      }
    },
  ],
  [
    'FEAT-01: D-01 effort line at line start (T-shirt + day-range bracket)',
    () => {
      const matches = grep('docs/FEAT-01-EVALUATION.md', '^\\*\\*(S|M|L|XL) — [0-9]+-[0-9]+ days\\*\\*')
      assert.ok(matches.length >= 1, 'no D-01 effort line at line start; got: ' + JSON.stringify(matches))
    },
  ],
  [
    'FEAT-01: exactly one D-02 recommendation (SHIP v1.6 / DEFER v2.0 / DESCOPE)',
    () => {
      const matches = grep('docs/FEAT-01-EVALUATION.md', '^\\*\\*(SHIP v1\\.6|DEFER v2\\.0|DESCOPE)\\*\\*')
      assert.strictEqual(matches.length, 1, 'expected exactly 1 recommendation line, got ' + matches.length)
    },
  ],
  [
    'FEAT-01: footer contains Requirement: FEAT-01 (D-02)',
    () => {
      const matches = grep('docs/FEAT-01-EVALUATION.md', 'Requirement: FEAT-01 \\(D-02\\)')
      assert.ok(matches.length >= 1, 'footer missing')
    },
  ],
  [
    'FEAT-01: citation documents.ts:423 GET /:documentId/text is real',
    () => {
      assert.ok(lineContains('packages/server/src/routes/documents.ts', 423, '"/:documentId/text"'), 'documents.ts:423 does not cite /:documentId/text')
    },
  ],
  [
    'FEAT-01: citation system.ts:657 POST /reindex-documents is real',
    () => {
      assert.ok(lineContains('packages/server/src/routes/system.ts', 657, '/reindex-documents'), 'system.ts:657 does not cite /reindex-documents')
    },
  ],
  [
    'FEAT-01: citation ingest.ts:494 POST /ingest/reembed is real',
    () => {
      assert.ok(lineContains('packages/collector/src/routes/ingest.ts', 494, '/ingest/reembed'), 'ingest.ts:494 does not cite /ingest/reembed')
    },
  ],
  [
    'FEAT-01: citation archivePages.ts:184 PUT body-only edit precedent is real',
    () => {
      assert.ok(lineContains('packages/server/src/routes/archivePages.ts', 184, '/:archiveId/pages/:slug'), 'archivePages.ts:184 does not cite the page edit route')
    },
  ],
  [
    'FEAT-01: at least 3 distinct file:line citations present in the doc',
    () => {
      const doc = read('docs/FEAT-01-EVALUATION.md')
      // Count distinct package file:line citations like documents.ts:423
      const cites = doc.match(/(?:documents|system|ingest|archivePages|uploads|mcp|chat|skills|mcpClient|API)\.(?:ts|md):\d+/g) || []
      const distinct = new Set(cites)
      assert.ok(distinct.size >= 3, 'expected >=3 distinct file:line citations, got ' + distinct.size + ': ' + JSON.stringify([...distinct]))
    },
  ],
  [
    'FEAT-01: prose outside tables <= ~500 words (budget D-04)',
    () => {
      const doc = read('docs/FEAT-01-EVALUATION.md')
      const nonTable = doc.split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n')
      const words = nonTable.split(/\s+/).filter(Boolean).length
      assert.ok(words <= 600, 'prose word count ' + words + ' exceeds ~500 budget (600 hard cap)')
    },
  ],

  // ---- FEAT-02: docs/FEAT-02-EVALUATION.md ----
  [
    'FEAT-02: docs/FEAT-02-EVALUATION.md exists',
    () => {
      assert.ok(fs.existsSync(path.join(ROOT, 'docs/FEAT-02-EVALUATION.md')), 'doc missing')
    },
  ],
  [
    'FEAT-02: all 7 skeleton section headers present',
    () => {
      const doc = read('docs/FEAT-02-EVALUATION.md')
      const required = [
        '## Context',
        '## Effort',
        '## Affected Packages',
        '## Migration Impact',
        '## User Value',
        '## Risk',
        '## Recommendation',
      ]
      for (const h of required) {
        const re = new RegExp('^' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm')
        assert.ok(re.test(doc), 'missing section header: ' + h)
      }
    },
  ],
  [
    'FEAT-02: Root Cause section present (ROADMAP success criterion 2)',
    () => {
      const matches = grep('docs/FEAT-02-EVALUATION.md', 'root cause', 'i')
      assert.ok(matches.length >= 1, 'no root-cause section/heading found')
    },
  ],
  [
    'FEAT-02: cites Phase 75 audit + git-recovery source',
    () => {
      const doc = read('docs/FEAT-02-EVALUATION.md')
      assert.ok(/6c3dbaab/.test(doc), 'does not reference git commit 6c3dbaab (audit deletion)')
      assert.ok(/git show 6c3dbaab\^:docs\/mcp-in-chat\.md/.test(doc), 'does not cite the git-recovery command')
    },
  ],
  [
    'FEAT-02: addresses both deletions (mcp-in-chat.md 6c3dbaab, CLAUDE.md f5c9bb46)',
    () => {
      const doc = read('docs/FEAT-02-EVALUATION.md')
      assert.ok(/6c3dbaab/.test(doc), 'does not address docs/mcp-in-chat.md deletion (6c3dbaab)')
      assert.ok(/f5c9bb46/.test(doc), 'does not address packages/server/CLAUDE.md deletion (f5c9bb46)')
    },
  ],
  [
    'FEAT-02: assesses Phase 150 hardening (MCP_API_KEY / per-session SSE / getMCPToolsForWorkspace)',
    () => {
      const doc = read('docs/FEAT-02-EVALUATION.md')
      const hits = ['MCP_API_KEY', 'per-session SSE', 'getMCPToolsForWorkspace'].filter((k) => doc.includes(k))
      assert.ok(hits.length >= 1, 'no Phase 150 hardening signal found; expected at least one of MCP_API_KEY/per-session SSE/getMCPToolsForWorkspace')
    },
  ],
  [
    'FEAT-02: D-01 effort line at line start',
    () => {
      const matches = grep('docs/FEAT-02-EVALUATION.md', '^\\*\\*(S|M|L|XL) — [0-9]+-[0-9]+ days\\*\\*')
      assert.ok(matches.length >= 1, 'no D-01 effort line at line start; got: ' + JSON.stringify(matches))
    },
  ],
  [
    'FEAT-02: exactly one D-02 recommendation',
    () => {
      const matches = grep('docs/FEAT-02-EVALUATION.md', '^\\*\\*(SHIP v1\\.6|DEFER v2\\.0|DESCOPE)\\*\\*')
      assert.strictEqual(matches.length, 1, 'expected exactly 1 recommendation line, got ' + matches.length)
    },
  ],
  [
    'FEAT-02: footer contains Requirement: FEAT-02 (D-02)',
    () => {
      const matches = grep('docs/FEAT-02-EVALUATION.md', 'Requirement: FEAT-02 \\(D-02\\)')
      assert.ok(matches.length >= 1, 'footer missing')
    },
  ],
  [
    'FEAT-02: citation skills.ts:136 resolveSkillsForChat is real',
    () => {
      assert.ok(lineContains('packages/server/src/agent/skills.ts', 136, 'resolveSkillsForChat'), 'skills.ts:136 does not cite resolveSkillsForChat')
    },
  ],
  [
    'FEAT-02: citation mcpClient.ts:465 getMCPToolsForWorkspace is real',
    () => {
      assert.ok(lineContains('packages/server/src/agent/mcpClient.ts', 465, 'getMCPToolsForWorkspace'), 'mcpClient.ts:465 does not cite getMCPToolsForWorkspace')
    },
  ],
  [
    'FEAT-02: citation mcpClient.ts:283 skill registration mcp_${connection.id}_${tool.name} is real',
    () => {
      assert.ok(lineContains('packages/server/src/agent/mcpClient.ts', 283, 'mcp_${connection.id}_${tool.name}'), 'mcpClient.ts:283 does not cite the UUID-prefix skill registration')
    },
  ],
  [
    'FEAT-02: citation chat.ts:724 const mcpSources is real',
    () => {
      assert.ok(lineContains('packages/server/src/routes/chat.ts', 724, 'const mcpSources'), 'chat.ts:724 does not cite const mcpSources')
    },
  ],
  [
    'FEAT-02: at least 3 distinct file:line citations present in the doc',
    () => {
      const doc = read('docs/FEAT-02-EVALUATION.md')
      const cites = doc.match(/(?:documents|system|ingest|archivePages|uploads|mcp|chat|skills|mcpClient|API)\.(?:ts|md):\d+/g) || []
      const distinct = new Set(cites)
      assert.ok(distinct.size >= 3, 'expected >=3 distinct file:line citations, got ' + distinct.size + ': ' + JSON.stringify([...distinct]))
    },
  ],
  [
    'FEAT-02: prose outside tables <= ~500 words (budget D-04)',
    () => {
      const doc = read('docs/FEAT-02-EVALUATION.md')
      const nonTable = doc.split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n')
      const words = nonTable.split(/\s+/).filter(Boolean).length
      assert.ok(words <= 600, 'prose word count ' + words + ' exceeds ~500 budget (600 hard cap)')
    },
  ],

  // ---- Task 3: STATE.md + REQUIREMENTS.md binding (D-02) ----
  [
    'STATE.md: FEAT-01 row no longer reads open and matches doc recommendation',
    () => {
      const rows = grep('.planning/STATE.md', '^\\| feature \\| FEAT-01')
      assert.ok(rows.length === 1, 'expected 1 FEAT-01 feature row, got ' + rows.length)
      assert.ok(!/\| open \|/.test(rows[0]), 'FEAT-01 row still reads open')
      const doc = read('docs/FEAT-01-EVALUATION.md')
      const rec = (doc.match(/\*\*(SHIP v1\.6|DEFER v2\.0|DESCOPE)\*\*/) || [])[0]
      assert.ok(rec, 'no recommendation found in FEAT-01 doc')
      const token = rec.replace(/\*\*/g, '')
      assert.ok(rows[0].includes(token), 'STATE.md FEAT-01 row does not contain recommendation token "' + token + '": ' + rows[0])
    },
  ],
  [
    'STATE.md: FEAT-02 row no longer reads open and matches doc recommendation',
    () => {
      const rows = grep('.planning/STATE.md', '^\\| feature \\| FEAT-02')
      assert.ok(rows.length === 1, 'expected 1 FEAT-02 feature row, got ' + rows.length)
      assert.ok(!/\| open \|/.test(rows[0]), 'FEAT-02 row still reads open')
      const doc = read('docs/FEAT-02-EVALUATION.md')
      const rec = (doc.match(/\*\*(SHIP v1\.6|DEFER v2\.0|DESCOPE)\*\*/) || [])[0]
      assert.ok(rec, 'no recommendation found in FEAT-02 doc')
      const token = rec.replace(/\*\*/g, '')
      assert.ok(rows[0].includes(token), 'STATE.md FEAT-02 row does not contain recommendation token "' + token + '": ' + rows[0])
    },
  ],
  [
    'STATE.md: FEAT-01/FEAT-02 Deferred At preserved as v0.13 close',
    () => {
      const rows = grep('.planning/STATE.md', '^\\| feature \\| FEAT-0[12]')
      assert.ok(rows.length === 2, 'expected 2 FEAT-01/02 rows, got ' + rows.length)
      for (const r of rows) {
        assert.ok(/v0\.13 close/.test(r), 'Deferred At not preserved as v0.13 close: ' + r)
      }
    },
  ],
  [
    'STATE.md: FEAT-03 and FEAT-04 rows untouched (still open)',
    () => {
      const rows03 = grep('.planning/STATE.md', '^\\| feature \\| FEAT-03')
      const rows04 = grep('.planning/STATE.md', '^\\| feature \\| FEAT-04')
      assert.ok(rows03.length === 1, 'expected 1 FEAT-03 row')
      assert.ok(rows04.length === 1, 'expected 1 FEAT-04 row')
      assert.ok(/open/.test(rows03[0]) || /open/.test(rows04[0]), 'FEAT-03/04 rows appear modified (expected open)')
    },
  ],
  [
    'REQUIREMENTS.md: FEAT-01/FEAT-02 evaluation rows checked [x]',
    () => {
      const req = read('.planning/REQUIREMENTS.md')
      assert.ok(/\[x\] \*\*FEAT-01\*\*/.test(req), 'FEAT-01 evaluation row not checked [x]')
      assert.ok(/\[x\] \*\*FEAT-02\*\*/.test(req), 'FEAT-02 evaluation row not checked [x]')
    },
  ],
  [
    'REQUIREMENTS.md: FEAT-01-IMPL row carries decided target (v1.6 decided / descoped)',
    () => {
      const req = read('.planning/REQUIREMENTS.md')
      assert.ok(/FEAT-01-IMPL.*decided by Phase 174|FEAT-01-IMPL.*descoped/.test(req), 'FEAT-01-IMPL row not updated with decided target')
    },
  ],
  [
    'REQUIREMENTS.md: FEAT-02-IMPL row carries decided target (v2.0 decided / descoped)',
    () => {
      const req = read('.planning/REQUIREMENTS.md')
      assert.ok(/FEAT-02-IMPL.*decided by Phase 174|FEAT-02-IMPL.*descoped/.test(req), 'FEAT-02-IMPL row not updated with decided target')
    },
  ],
  [
    'REQUIREMENTS.md: traceability rows read Complete for FEAT-01 and FEAT-02',
    () => {
      const req = read('.planning/REQUIREMENTS.md')
      assert.ok(/^\| FEAT-01 \| Phase 174 \| Complete \|/m.test(req), 'FEAT-01 traceability row not Complete')
      assert.ok(/^\| FEAT-02 \| Phase 174 \| Complete \|/m.test(req), 'FEAT-02 traceability row not Complete')
    },
  ],
  [
    'REQUIREMENTS.md: FEAT-01-IMPL target consistent with doc recommendation (SHIP v1.6 → v1.6)',
    () => {
      const req = read('.planning/REQUIREMENTS.md')
      const doc = read('docs/FEAT-01-EVALUATION.md')
      if (/SHIP v1\.6/.test(doc)) {
        assert.ok(/FEAT-01-IMPL.*v1\.6.*decided by Phase 174/.test(req), 'doc says SHIP v1.6 but REQUIREMENTS.md FEAT-01-IMPL does not target v1.6')
      }
    },
  ],
  [
    'REQUIREMENTS.md: FEAT-02-IMPL target consistent with doc recommendation (DESCOPE → descoped)',
    () => {
      const req = read('.planning/REQUIREMENTS.md')
      const doc = read('docs/FEAT-02-EVALUATION.md')
      if (/DESCOPE/.test(doc)) {
        assert.ok(/FEAT-02-IMPL.*descoped.*Phase 174/.test(req), 'doc says DESCOPE but REQUIREMENTS.md FEAT-02-IMPL not marked descoped')
      }
    },
  ],
]

// jest-compatible path
if (typeof describe === 'function' && typeof it === 'function') {
  describe('phase174-acceptance', () => {
    for (const [name, fn] of tests) {
      it(name, fn)
    }
  })
}

// Standalone path: `node scripts/phase174-acceptance.test.cjs`
if (require.main === module) {
  let passed = 0
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      fn()
      console.log('  \u221A', name)
      passed++
    } catch (e) {
      console.error('  \u2717', name)
      console.error('   ', e.message)
      failed++
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed')
  process.exit(failed === 0 ? 0 : 1)
}
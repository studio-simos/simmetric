// @ts-nocheck
/**
 * Phase 168 Nyquist gap-filling behavioral tests.
 *
 * Asserts the observable license-state requirements LIC-01, LIC-02, LIC-03
 * against the real repo artifacts on disk. Each test can FAIL — it does not
 * test a simpler behavior than the requirement demands. Runs as a standalone
 * node assertion script (the repo's root jest.config.cjs has no root project;
 * scripts/*.test.cjs is the established root-level test pattern — see the
 * deviation note in 168-01-SUMMARY.md).
 *
 * Invocation:  node scripts/license-artifacts.test.cjs
 * Exit code:   0 = all pass, 1 = at least one failure.
 *
 * The script under test is the repository itself — implementation files are
 * READ-ONLY; this file only reads artifacts and asserts their content.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

// LIC-01 — the community repo LICENSE is verbatim GNU AGPL-3.0 (FSF canonical
// form; any modification voids OSI approval). The first line and the byte size
// are the two stable fingerprints of the verbatim text.
function test_license_is_verbatim_agpl_3() {
  assert.ok(exists('LICENSE'), 'LICENSE missing at repo root')
  const text = read('LICENSE')
  const firstLine = text.split('\n', 1)[0]
  assert.strictEqual(
    firstLine.trim(),
    'GNU AFFERO GENERAL PUBLIC LICENSE',
    `LIC-01: LICENSE first line (trimmed) must be the AGPL-3.0 title — got ${JSON.stringify(firstLine)}`
  )
  assert.ok(
    text.includes('Version 3, 19 November 2007'),
    'LIC-01: LICENSE must declare "Version 3, 19 November 2007"'
  )
  // Verbatim AGPL-3.0 is exactly 34,522 bytes (FSF canonical). A drift here
  // means the text was edited — voids OSI approval.
  const stat = fs.statSync(path.join(ROOT, 'LICENSE'))
  assert.strictEqual(
    stat.size,
    34522,
    `LIC-01: LICENSE must be the verbatim 34,522-byte AGPL-3.0 text — got ${stat.size} bytes`
  )
}

// LIC-01 — all 6 package.json license fields are AGPL-3.0-or-later (the SPDX
// expression; NOT "AGPL-3.0-only" or bare "AGPL-3.0"). Mirrors what
// license-check-self.cjs asserts, but as a direct behavioral test against the
// real files so a regression is caught even if the script is unwired.
function test_all_six_package_json_license_fields() {
  const files = [
    'package.json',
    'packages/shared/package.json',
    'packages/server/package.json',
    'packages/frontend/package.json',
    'packages/collector/package.json',
    'packages/widget/package.json',
  ]
  for (const rel of files) {
    assert.ok(exists(rel), `LIC-01: ${rel} missing`)
    const pkg = JSON.parse(read(rel))
    assert.strictEqual(
      pkg.license,
      'AGPL-3.0-or-later',
      `LIC-01: ${rel} license must be "AGPL-3.0-or-later" — got ${JSON.stringify(pkg.license)}`
    )
  }
}

// LIC-01 — release.yml OCI label matches the package.json SPDX expression
// exactly (the AGPL-3.0-or-later triple-consistency invariant: source headers
// == package.json == OCI label).
function test_release_oci_label_matches_spdx() {
  assert.ok(exists('.github/workflows/release.yml'), 'release.yml missing')
  const yml = read('.github/workflows/release.yml')
  assert.ok(
    yml.includes('org.opencontainers.image.licenses=AGPL-3.0-or-later'),
    'LIC-01: release.yml must carry org.opencontainers.image.licenses=AGPL-3.0-or-later'
  )
}

// LIC-01 — source files carry the AGPL-3.0 copyright header (D-04). Verifies
// (a) the count is in the documented range (~975) and (b) one representative
// file per package carries the 4-line header block. A header that drops the
// SPDX-License-Identifier line breaks the AGPL-3.0 obligations (sections 4-5).
function test_source_file_agpl_headers() {
  const dirs = [
    'packages/shared/src',
    'packages/server/src',
    'packages/frontend/src',
    'packages/collector/src',
    'packages/widget/src',
  ]
  let total = 0
  const samples = {}
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir)
    if (!fs.existsSync(abs)) continue
    const files = listTsFiles(abs)
    let withHeader = 0
    let firstHeader = null
    for (const f of files) {
      const head = fs.readFileSync(f, 'utf8').split('\n').slice(0, 6).join('\n')
      if (head.includes('SPDX-License-Identifier: AGPL-3.0-or-later')) {
        withHeader++
        if (firstHeader === null) firstHeader = f
      }
    }
    samples[dir] = { total: files.length, withHeader, firstHeader }
    total += withHeader
  }
  // Count must be in the documented range (975 per SUMMARY; allow 950+ to
  // tolerate minor additions/removals without going soft on a real drop).
  assert.ok(
    total >= 950,
    `LIC-01/D-04: expected ~975 source files with AGPL header — found ${total}`
  )
  // One representative file per package must carry the header.
  for (const dir of dirs) {
    const s = samples[dir]
    if (!s) continue
    assert.ok(
      s.withHeader > 0,
      `LIC-01/D-04: ${dir} has no file carrying the AGPL-3.0 header`
    )
  }
}

function listTsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

// LIC-02 — LICENSE_EE.md is proprietary commercial (NOT AGPL text). The
// opening header must carry the all-rights-reserved copyright line.
function test_license_ee_is_proprietary() {
  assert.ok(exists('LICENSE_EE.md'), 'LICENSE_EE.md missing at repo root')
  const text = read('LICENSE_EE.md')
  const head = text.split('\n').slice(0, 5).join('\n')
  assert.ok(
    /Copyright \(c\) 2026 Simmetric Chat\.?\s*All rights reserved/i.test(head),
    'LIC-02: LICENSE_EE.md must open with the proprietary all-rights-reserved copyright line'
  )
  // Must NOT be AGPL text (the community license is in LICENSE, not here).
  assert.ok(
    !text.startsWith('GNU AFFERO GENERAL PUBLIC LICENSE'),
    'LIC-02: LICENSE_EE.md must NOT be AGPL text (it is proprietary commercial)'
  )
}

// LIC-02 — NOTICE is a plain-text dual-license explanation with the package
// boundaries table mapping all 6 packages to their license. The table is the
// single source of truth per D-02.
function test_notice_dual_license_and_boundaries_table() {
  assert.ok(exists('NOTICE'), 'NOTICE missing at repo root')
  const text = read('NOTICE')
  // Plain text, not markdown front-matter — but it MAY contain a markdown
  // table (the boundaries table). The requirement is that it explains the
  // dual-license model and carries the boundaries table.
  assert.ok(
    /dual[\s-]?license/i.test(text),
    'LIC-02: NOTICE must explain the dual-license model'
  )
  // Boundaries table must reference all 6 packages.
  const expectedPackages = [
    'packages/shared',
    'packages/server',
    'packages/collector',
    'packages/frontend',
    'packages/widget',
    '@simmetric-chat/enterprise',
  ]
  for (const pkg of expectedPackages) {
    assert.ok(
      text.includes(pkg),
      `LIC-02: NOTICE boundaries table must reference ${pkg}`
    )
  }
}

// LIC-03 — user-facing docs use "open source" framing, NOT "source-available"
// (AGPL-3.0 is OSI-approved). README and CONTRIBUTING must not contain
// "source-available". (LICENSE_DECISION.md legitimately references the term
// in its analysis of alternatives — that is excluded.)
function test_no_source_available_in_user_facing_docs() {
  for (const rel of ['README.md', 'CONTRIBUTING.md']) {
    assert.ok(exists(rel), `${rel} missing`)
    const text = read(rel)
    assert.ok(
      !/source-available/i.test(text),
      `LIC-03: ${rel} must not use "source-available" framing — AGPL-3.0 is open source`
    )
  }
}

// LIC-03 — no stale Apache-2.0 references in user-facing docs, excluding the
// 5 docs that legitimately reference Apache-2.0 for dependencies or historical
// analysis (LICENSE_AUDIT.md, COPY_VERDICTS.md, LICENSE_DECISION.md,
// ENTERPRISE_LICENSE_TERMS.md, ENTERPRISE_PLUGIN.md). This is the behavioral
// mirror of the CI stale-Apache grep gate.
function test_no_stale_apache_in_user_facing_docs() {
  const excludes = new Set([
    'docs/LICENSE_AUDIT.md',
    'docs/COPY_VERDICTS.md',
    'docs/LICENSE_DECISION.md',
    'docs/ENTERPRISE_LICENSE_TERMS.md',
    'docs/ENTERPRISE_PLUGIN.md',
  ])
  const targets = []
  // docs/
  const docsDir = path.join(ROOT, 'docs')
  if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir)) {
      if (f.endsWith('.md')) {
        const rel = `docs/${f}`
        if (!excludes.has(rel)) targets.push(rel)
      }
    }
  }
  targets.push('README.md', 'CONTRIBUTING.md')
  const stale = []
  for (const rel of targets) {
    if (!exists(rel)) continue
    const text = read(rel)
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (/Apache-2\.0/.test(line)) stale.push(`${rel}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepStrictEqual(
    stale,
    [],
    `LIC-03: stale Apache-2.0 references found in user-facing docs (should be AGPL-3.0):\n${stale.join('\n')}`
  )
}

// LIC-03 — README carries the AGPL-3.0 license badge and a License section
// linking the license artifacts.
function test_readme_license_section_and_badge() {
  assert.ok(exists('README.md'), 'README.md missing')
  const text = read('README.md')
  assert.ok(
    /badge\/license-AGPL--3\.0/.test(text),
    'LIC-03: README must carry the AGPL-3.0 license badge'
  )
  assert.ok(/^## License$/m.test(text), 'LIC-03: README must have a ## License section')
}

// LIC-03 / D-01 — CONTRIBUTING references the CLA (dual-license-aware CLA
// v1.0 signing instructions).
function test_contributing_cla_section() {
  assert.ok(exists('CONTRIBUTING.md'), 'CONTRIBUTING.md missing')
  const text = read('CONTRIBUTING.md')
  assert.ok(
    /Contributor License Agreement/i.test(text) && /CLA\.md/.test(text),
    'LIC-03/D-01: CONTRIBUTING.md must reference the CLA (CLA.md)'
  )
  assert.ok(exists('CLA.md'), 'CLA.md missing at repo root')
}

const tests = [
  ['LIC-01: LICENSE is verbatim GNU AGPL-3.0 (34,522 bytes)', test_license_is_verbatim_agpl_3],
  ['LIC-01: all 6 package.json license fields are AGPL-3.0-or-later', test_all_six_package_json_license_fields],
  ['LIC-01: release.yml OCI label matches SPDX expression', test_release_oci_label_matches_spdx],
  ['LIC-01/D-04: source files carry AGPL-3.0 copyright headers', test_source_file_agpl_headers],
  ['LIC-02: LICENSE_EE.md is proprietary commercial (all rights reserved)', test_license_ee_is_proprietary],
  ['LIC-02: NOTICE dual-license + package boundaries table (all 6 packages)', test_notice_dual_license_and_boundaries_table],
  ['LIC-03: no "source-available" framing in README/CONTRIBUTING', test_no_source_available_in_user_facing_docs],
  ['LIC-03: no stale Apache-2.0 in user-facing docs (5 excludes)', test_no_stale_apache_in_user_facing_docs],
  ['LIC-03: README license badge + License section', test_readme_license_section_and_badge],
  ['LIC-03/D-01: CONTRIBUTING CLA section + CLA.md present', test_contributing_cla_section],
]

if (require.main === module) {
  let passed = 0
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      fn()
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
}

module.exports = { tests }
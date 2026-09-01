#!/usr/bin/env node
/**
 * Regenerate the auto-generated license disclosure sections (Phase 134 —
 * PUB-03-01, PUB-03-04, D-07).
 *
 * Emits TWO files from a single `pnpm licenses list --json --prod` call so the
 * CI drift-gate is a single script invocation (D-06 + RESEARCH Open Question 3):
 *
 *   1. THIRD_PARTY_NOTICES.md — sentinel-delimited auto-gen section inserted
 *      between the BEGIN/END markers; manual narrative sections (Open WebUI,
 *      Mintplex Labs, Disclaimer) are preserved untouched.
 *   2. docs/LICENSE_AUDIT.md  — full SPDX report, regenerated from scratch
 *      every run (no manual narrative; a defensible audit names every
 *      dependency — 972+ packages individually enumerated).
 *
 * `pnpm licenses list` reports `Unknown` for 3 packages (combine-errors,
 * flatbuffers, pause) where the license is detected from a LICENSE file
 * rather than the `package.json` field; the report footnotes their actual
 * licenses (MIT, Apache-2.0, MIT) detected by license-checker-rseidelsohn
 * so the audit is complete.
 *
 * Exit code: 0 = both files regenerated; 1 = sentinels missing or pnpm call
 * failed (fails loudly, never silently corrupts the notices file).
 */

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const NOTICE_FILE = path.join(ROOT, 'THIRD_PARTY_NOTICES.md')
const AUDIT_FILE = path.join(ROOT, 'docs', 'LICENSE_AUDIT.md')

const BEGIN = '<!-- BEGIN AUTO-GENERATED — do not edit below this line, run `node scripts/generate-notices.cjs` -->'
const END = '<!-- END AUTO-GENERATED -->'

// The 3 `Unknown` packages reported by `pnpm licenses list` and their actual
// licenses as detected by license-checker-rseidelsohn (Pitfall 5).
const UNKNOWN_FOOTNOTES = [
  { name: 'combine-errors', actual: 'MIT' },
  { name: 'pause', actual: 'MIT' },
  { name: 'flatbuffers', actual: 'Apache-2.0 (detected as "Custom: LICENSE.txt" by license-checker-rseidelsohn)' },
]

function fetchLicenses() {
  try {
    const raw = execSync('pnpm licenses list --json --prod', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(raw)
  } catch (e) {
    console.error('Failed to run `pnpm licenses list --json --prod`:')
    console.error((e.stderr || '') + (e.stdout || ''))
    process.exit(1)
  }
}

/**
 * Derive a stable "generated at" timestamp from the last commit that touched
 * `pnpm-lock.yaml`. This makes the audit file byte-stable across regenerations
 * (the CI drift-gate requires `git diff --exit-code docs/LICENSE_AUDIT.md` to
 * be clean after re-running this script) — the timestamp only changes when
 * the dependency tree actually changes, not on every run.
 */
function stableGeneratedAt() {
  try {
    return execSync('git log -1 --format=%cI -- pnpm-lock.yaml', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    // Not a git repo or no commits yet — fall back to a fixed epoch so the
    // output is still stable across runs (the drift-gate is a no-op in that
    // environment anyway).
    return '1970-01-01T00:00:00Z'
  }
}

function buildDependencyTableRows(licenses) {
  // Returns rows: [{ license, name, versions, homepage }]
  const rows = []
  for (const [license, pkgs] of Object.entries(licenses)) {
    for (const pkg of pkgs) {
      rows.push({
        license,
        name: pkg.name || '—',
        versions: (pkg.versions || []).join(', ') || '—',
        homepage: pkg.homepage || '—',
      })
    }
  }
  rows.sort((a, b) => a.license.localeCompare(b.license) || a.name.localeCompare(b.name))
  return rows
}

function buildAuditRows(licenses) {
  // Full enumeration table with Author column (License | Package | Version(s) | Homepage | Author)
  const rows = []
  for (const [license, pkgs] of Object.entries(licenses)) {
    for (const pkg of pkgs) {
      rows.push({
        license,
        name: pkg.name || '—',
        versions: (pkg.versions || []).join(', ') || '—',
        homepage: pkg.homepage || '—',
        author: pkg.author || '—',
      })
    }
  }
  rows.sort((a, b) => a.license.localeCompare(b.license) || a.name.localeCompare(b.name))
  return rows
}

function renderNoticeTable(rows) {
  const lines = [
    '| License | Package | Version(s) | Homepage |',
    '|---------|---------|------------|----------|',
  ]
  for (const r of rows) {
    lines.push(`| ${r.license} | ${r.name} | ${r.versions} | ${r.homepage} |`)
  }
  return lines.join('\n')
}

function renderAuditFile(rows, total, generatedAt) {
  const lines = []
  lines.push('# License Audit (SPDX Report)')
  lines.push('')
  lines.push(`**Generated:** ${generatedAt}`)
  lines.push('**Command:** `pnpm licenses list --json --prod`')
  lines.push(`**Total packages:** ${total}`)
  lines.push('')
  lines.push('> Full enumeration of every production dependency in the pnpm workspace,')
  lines.push('> grouped by license ID. A defensible audit names each dependency, not')
  lines.push('> just counts. Regenerate with `node scripts/generate-notices.cjs`; the CI')
  lines.push('> drift-gate (`license-policy-check` job) fails if the committed file is')
  lines.push('> stale relative to the dependency tree.')
  lines.push('')
  lines.push('| License | Package | Version(s) | Homepage | Author |')
  lines.push('|---------|---------|------------|----------|--------|')
  for (const r of rows) {
    lines.push(`| ${r.license} | ${r.name} | ${r.versions} | ${r.homepage} | ${r.author} |`)
  }
  lines.push('')
  lines.push('## Footnote: `Unknown` licenses')
  lines.push('')
  lines.push('`pnpm licenses list` reports `Unknown` for packages whose license is')
  lines.push('detected from a LICENSE file rather than the `package.json` field. The')
  lines.push('actual licenses (detected by `license-checker-rseidelsohn`) are:')
  lines.push('')
  lines.push('| Package | Actual license |')
  lines.push('|---------|-----------------|')
  for (const f of UNKNOWN_FOOTNOTES) {
    lines.push(`| ${f.name} | ${f.actual} |`)
  }
  lines.push('')
  return lines.join('\n')
}

function updateNotices(rows, total) {
  const content = fs.readFileSync(NOTICE_FILE, 'utf8')
  const beginIdx = content.indexOf(BEGIN)
  const endIdx = content.indexOf(END)

  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    console.error(`Sentinel markers not found in ${NOTICE_FILE}`)
    console.error(`Expected:\n${BEGIN}\n...\n${END}`)
    console.error('The manual narrative sections must be preserved; only the')
    console.error('auto-generated dependency list between the sentinels is replaced.')
    process.exit(1)
  }

  const table = renderNoticeTable(rows)
  const updated =
    content.slice(0, beginIdx + BEGIN.length) +
    '\n' +
    table +
    '\n' +
    content.slice(endIdx)

  fs.writeFileSync(NOTICE_FILE, updated)
  console.log(`Regenerated dependency table in THIRD_PARTY_NOTICES.md (${total} packages)`)
}

function writeAudit(rows, total, generatedAt) {
  const auditDir = path.dirname(AUDIT_FILE)
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true })
  const body = renderAuditFile(rows, total, generatedAt)
  fs.writeFileSync(AUDIT_FILE, body)
  console.log(`Regenerated SPDX report in docs/LICENSE_AUDIT.md (${total} packages)`)
}

function main() {
  const generatedAt = stableGeneratedAt()
  const licenses = fetchLicenses()
  const total = Object.values(licenses).flat().length

  updateNotices(buildDependencyTableRows(licenses), total)
  writeAudit(buildAuditRows(licenses), total, generatedAt)
  console.log(`\nDone. ${total} production dependencies enumerated.`)
}

main()
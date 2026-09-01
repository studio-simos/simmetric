#!/usr/bin/env node
/**
 * scripts/verify-protocol-table.cjs
 *
 * Phase 136 (PUB-05-02) — protocol-table completeness check.
 *
 * Derives every `simmetric:*` literal from `packages/widget/src/` via ripgrep
 * and asserts each one appears in `docs/WIDGET.md`. This is the "don't
 * hand-roll" gate (research §"Don't Hand-Roll"): the source of truth is the
 * codebase, not a hand-maintained list, so the doc cannot drift from the
 * code.
 *
 * Zero external dependencies — only node:child_process, node:fs, node:path.
 * The repo root is ESM ("type": "module"), so this file uses .cjs (CommonJS).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const WIDGET_SRC = path.join(REPO_ROOT, 'packages/widget/src');
const WIDGET_MD = path.join(REPO_ROOT, 'docs/WIDGET.md');

if (!fs.existsSync(WIDGET_MD)) {
  console.error(`MISSING: docs/WIDGET.md not found at ${WIDGET_MD}`);
  process.exit(1);
}
if (!fs.existsSync(WIDGET_SRC)) {
  console.error(`MISSING: packages/widget/src not found at ${WIDGET_SRC}`);
  process.exit(1);
}

// Derive every simmetric:<word> literal from the widget source. -o prints only
// the match, --no-filename keeps output clean, -r '$0' emits the match verbatim.
let literals;
try {
  const out = execSync(
    `rg -o "simmetric:\\w+" "${WIDGET_SRC}" -r '$0' --no-filename`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  literals = Array.from(new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))).sort();
} catch (err) {
  // rg returns exit 1 when there are no matches — not an error here, but the
  // protocol has known literals so an empty result is suspicious.
  if (err.status === 1) {
    console.error('WARN: rg returned no matches for simmetric:\\w+ in packages/widget/src');
    literals = [];
  } else {
    console.error(`ERROR: rg failed (exit ${err.status}): ${err.message}`);
    process.exit(1);
  }
}

if (literals.length === 0) {
  console.error('FAIL: no simmetric:* literals found in packages/widget/src — the protocol table cannot be verified.');
  process.exit(1);
}

const widgetMd = fs.readFileSync(WIDGET_MD, 'utf8');
const missing = [];
for (const lit of literals) {
  if (!widgetMd.includes(lit)) missing.push(lit);
}

if (missing.length > 0) {
  console.error('Protocol table incomplete — missing from docs/WIDGET.md:');
  for (const m of missing) console.error(`  MISSING: ${m}`);
  console.error(`\n${missing.length} missing type(s); ${literals.length - missing.length}/${literals.length} verified.`);
  process.exit(1);
}

console.log(`Protocol table complete: ${literals.length} message types verified`);
process.exit(0);
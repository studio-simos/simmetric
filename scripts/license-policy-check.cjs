#!/usr/bin/env node
/**
 * License policy gate (Phase 134 — PUB-03-02, D-02, D-05).
 *
 * Wraps `license-checker-rseidelsohn --onlyAllow` per workspace package and
 * exits non-zero on the first disallowed license string. Per-package
 * invocation is required because pnpm's symlink-based node_modules means the
 * repo root only sees hoisted packages (5), not the full transitive tree
 * (972) — see RESEARCH.md Pitfall 1 (VERIFIED).
 *
 * `--onlyAllow` does EXACT string matching, not SPDX expression parsing:
 * "MIT" does NOT match "MIT-0", "(MIT OR CC0-1.0)", or "MIT*" (Pitfall 2,
 * VERIFIED). Every distinct license string present in the tree is listed
 * below; each non-standard addition is documented in docs/COPY_VERDICTS.md
 * (D-05: no silent passes).
 *
 * Exit code: 0 = all 5 packages pass; 1 = at least one package has a
 * disallowed license (the offending package + license is printed).
 */

const { execSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const PACKAGES = ['server', 'frontend', 'collector', 'widget', 'shared']

// Every distinct license string present in the production dependency tree,
// enumerated from `license-checker-rseidelsohn --json` output across all 5
// workspace packages (verified 2026-08-12).
//
// The 8 core allowlist licenses (D-02) are listed first; the extended entries
// are permissive-compatible or weak-copyleft licenses actually present in
// the tree, each justified in docs/COPY_VERDICTS.md § License Justifications.
const ALLOWLIST = [
  // Core allowlist (D-02)
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC',
  '0BSD', 'CC0-1.0', 'Unlicense',
  // Permissive / compatible licenses present in the tree
  'MIT-0',                    // MIT zero-clause variant (nodemailer, @csstools)
  'MIT*',                     // Guessed MIT from LICENSE file (combine-errors, pause, seq-queue)
  'BSD',                      // duck package.json license field (invalid SPDX; license-checker reports BSD*)
  'BSD*',                     // duck@0.1.12 — license-checker marks the "BSD" field as guessed (BSD*)
  'MIT AND ISC',              // victory-vendor
  'MIT and ISC',              // @visx/vendor (case variation — Pitfall 6)
  '(MIT OR CC0-1.0)',         // type-fest
  '(MIT OR GPL-3.0-or-later)', // jszip (MIT branch is permissive)
  '(MIT AND Zlib)',           // pako
  '(MPL-2.0 OR Apache-2.0)',  // dompurify (Apache-2.0 branch is permissive)
  'BlueOak-1.0.0',            // isaacs npm packages (glob, lru-cache, etc.)
  'Python-2.0',               // argparse (PSF, permissive)
  'OFL-1.1',                  // fontsource fonts (SIL Open Font License)
  'CC-BY-4.0',                // caniuse-lite (data license, attribution required)
  'EPL-2.0',                  // elkjs (Eclipse Public License, weak copyleft, file-level)
  'MPL-2.0',                  // web-push (Mozilla Public License, weak copyleft, file-level)
  // Defensive: present on Linux CI runners where the platform-specific
  // sharp-libvips binary is installed; not present on this dev machine but
  // the gate must pass in CI. See COPY_VERDICTS.md § system library exception.
  'LGPL-3.0-or-later',        // @img/sharp-libvips-* (system library exception)
  'Custom: LICENSE.txt',      // flatbuffers (Apache-2.0 in LICENSE.txt, misdetected)
].join(';')

// Resolve the installed binary path (devDependency) — avoids `npx` network
// fetch in CI and is reproducible from the lockfile.
const BINARY = path.resolve(__dirname, '..', 'node_modules', '.bin', 'license-checker-rseidelsohn')

function checkPackage(pkg) {
  const start = path.join('packages', pkg)
  if (!fs.existsSync(start)) {
    // A workspace package that doesn't exist on disk is a config error, not a
    // license violation — but we surface it loudly so it's not silently skipped.
    console.error(`✗ packages/${pkg}: directory not found`)
    return false
  }
  try {
    execSync(
      `"${BINARY}" --production --start ${start} --excludePrivatePackages --onlyAllow "${ALLOWLIST}"`,
      { stdio: 'pipe', encoding: 'utf8' }
    )
    console.log(`✓ packages/${pkg}: license policy PASS`)
    return true
  } catch (e) {
    const msg = (e.stderr || '') + (e.stdout || '')
    console.error(`✗ packages/${pkg}: license policy FAIL`)
    console.error(msg)
    return false
  }
}

function main() {
  if (!fs.existsSync(BINARY)) {
    console.error(`license-checker-rseidelsohn binary not found at ${BINARY}`)
    console.error('Run `pnpm install` (it is a root devDependency).')
    process.exit(1)
  }

  let failed = false
  for (const pkg of PACKAGES) {
    if (!checkPackage(pkg)) failed = true
  }

  if (failed) {
    console.error('\nLicense policy gate: FAIL')
    console.error('See docs/COPY_VERDICTS.md for license justifications.')
    process.exit(1)
  }
  console.log('\nLicense policy gate: PASS (all 5 packages)')
}

main()
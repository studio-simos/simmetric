/**
 * Public-release preparation (PUB-01-01, D-01/D-02).
 *
 * Assembles a clean publication tree from the tracked files of this repo
 * (git ls-files — never cp -r, never a directory copy) minus an explicit
 * exclude list, then runs machine gates on the OUTPUT tree:
 *
 *   --check mode:
 *     (a) personal-data grep  — author name / sfoschi / /home/simmetric /
 *                               Simmetric Studio / protonmail → exit 1 on any hit
 *     (b) branding-token grep — simmetric-family tokens → report hit count and
 *                               continue (Phase 133 clears them; hard-fails
 *                               only from PUB-02 onward)
 *     (c) negative assertions  — no license-tools/ dir in the output; the
 *                               published .gitignore must not mention
 *                               license-tools or .planning
 *     (d) exclusion assertions — output tree lacks .planning/, node_modules,
 *                               storage, dist, vibe_loop.sh,
 *                               istruzioni-widget-apikey.txt, src-tauri/,
 *                               test-widget.html, .claude/ while containing
 *                               the tracked root .env.example and the regenerated
 *                               .env.test
 *
 * Why .cjs (not .ts): runs under plain Node (no tsx), mirroring
 * packages/server/scripts/check-build-freshness.cjs — the only plain-Node CJS
 * script in the repo and the established analog for fs-only tooling.
 *
 * Exit-code contract: 0 = clean assembly and gates pass; 1 = gate failure
 * (grep hit, missing file, or negative assertion).
 */

const fs = require('fs');
const path = require('path');

const TOOL = '[prepare-public-release]';

// Anchored exclude list — every entry is a repo-relative path or glob.
// Source: 132-RESEARCH.md §Publication Manifest Draft (verified tracked
// inventory 2026-08-11). `.env*` is excluded EXCEPT the tracked root
// .env.example and the regenerated `.env.test` (kept for unit-test/E2E parity).
const EXCLUDE = [
  '.planning/',
  '.git/',
  '.claude/',
  '.vscode/',
  '.omo/',
  '.codegraph',
  'graphify-out/',
  'node_modules/',
  '.pnpm-store/',
  '.turbo/',
  '.jest-cache/',
  'test-results/',
  '.tmp-e2e/',
  'storage/',
  'dist/',
  'dist-widget/',
  '*.tsbuildinfo',
  'license-tools/',
  'src-tauri/',
  'packages/server/scripts.claude/',
  'e2e/.tmp/',
  '*.db',
  '*.db-journal',
  '.migration-audit.json',
  'test-widget.html',
  'vibe_loop.sh',
  'docs/hf-cache-layout-verdict.md',
  'packages/server/scripts/istruzioni-widget-apikey.txt',
];

// Tracked env files that MUST survive the `.env*` exclusion.
// The root .env.example is THE single exhaustive template (server + collector
// + widget schema keys, per-package sections). The per-package .env.example
// files were removed in the Phase 177 cleanup.
const ENV_KEEP = [
  '.env.example',
  'packages/server/.env.test',
];

// Files whose personal-data tokens are INTENTIONAL and must be excluded from
// the personal-data grep (the LICENSE copyright line is the Apache-2.0
// attribution per PUB-03-04 — the grep gate's `:!LICENSE` analog; THIS SCRIPT
// itself carries the token list as its configuration, so it must also be
// excluded from the output-tree gate — the source-tree gate uses `:!.planning`
// `:!LICENSE` `:!scripts/prepare-public-release.cjs`).
const PERSONAL_GREP_EXCLUDE = ['LICENSE', 'scripts/prepare-public-release.cjs'];

// Personal-data tokens — the real safety net (D-02). Any hit on the output
// tree exits 1.
const PERSONAL_PATTERNS = [
  "Simone Foschi",
  "sfoschi",
  "/home/simmetric",
  "Studio Simos",
  "protonmail",
];

// Old-name branding tokens — the gate targets the OLD name (simos-chat),
// which should be 0 after Phase 133's rename. Reported, not fatal.
// The NEW name (simmetric-chat) is expected in the output tree — it's the
// correct post-rename state, not a gate target.
const BRANDING_PATTERNS = [
  'simos-chat',
  'simoschat',
  '@simos-chat',
  'simos.chat',
];

function isExcluded(relPath) {
  for (const ex of EXCLUDE) {
    if (ex.endsWith('/')) {
      if (relPath === ex.slice(0, -1) || relPath.startsWith(ex)) return true;
    } else if (ex.includes('*')) {
      const re = new RegExp('^' + ex.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (re.test(relPath)) return true;
    } else if (relPath === ex) {
      return true;
    }
  }
  return false;
}

function isEnvKept(relPath) {
  return ENV_KEEP.includes(relPath);
}

function isEnvExcluded(relPath) {
  const base = path.basename(relPath);
  return base === '.env' || base.startsWith('.env.');
}

/**
 * Assemble the publication tree: copy every tracked file (git ls-files) that
 * is not excluded into `outDir`, preserving relative paths.
 * @param {string} outDir absolute path to the output directory
 * @returns {{copied: number, skipped: string[]}}
 */
function assemble(outDir) {
  const { execSync } = require('child_process');
  const tracked = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const skipped = [];
  let copied = 0;

  for (const rel of tracked) {
    if (isExcluded(rel)) {
      skipped.push(rel);
      continue;
    }
    if (isEnvExcluded(rel) && !isEnvKept(rel)) {
      skipped.push(rel);
      continue;
    }
    const src = path.resolve(rel);
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;
  }
  return { copied, skipped };
}

/**
 * Run the output-tree gates. Returns an array of failure messages (empty =
 * all gates pass).
 * @param {string} outDir absolute path to the output tree
 * @returns {string[]}
 */
function runGates(outDir) {
  const failures = [];
  const { execSync } = require('child_process');

  // (a) personal-data grep — fatal (LICENSE excluded: intentional copyright)
  for (const pat of PERSONAL_PATTERNS) {
    try {
      const hits = execSync(
        `grep -rl --include='*' -e ${JSON.stringify(pat)} .`,
        { cwd: outDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const filtered = hits
        .split('\n')
        .filter((f) => !PERSONAL_GREP_EXCLUDE.some((x) => f === './' + x || f.endsWith('/' + x)))
        .join('\n');
      if (filtered) failures.push(`personal-data token "${pat}" found in output tree:\n${filtered}`);
    } catch {
      // grep exit 1 = no matches — expected
    }
  }

  // (b) branding-token grep — report only (Phase 133 clears)
  let brandingCount = 0;
  for (const pat of BRANDING_PATTERNS) {
    try {
      const hits = execSync(
        `grep -rl --include='*' -e ${JSON.stringify(pat)} .`,
        { cwd: outDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (hits) brandingCount += hits.split('\n').length;
    } catch {
      // no matches
    }
  }
  console.log(`${TOOL} old-name branding-token hits in output tree: ${brandingCount} (expected 0 post-rename)`);

  // (c) negative assertions
  if (fs.existsSync(path.join(outDir, 'license-tools'))) {
    failures.push('license-tools/ present in output tree — must never ship');
  }
  const pubGitignore = path.join(outDir, '.gitignore');
  if (fs.existsSync(pubGitignore)) {
    // The private repo's .gitignore legitimately mentions license-tools
    // (line 65) and .planning — the PUBLISHED copy must not. Filter those
    // lines out of the copied file so the negative assertion holds.
    const gi = fs.readFileSync(pubGitignore, 'utf8');
    const filtered = gi
      .split('\n')
      .filter((l) => !/^\s*license-tools\s*$/.test(l) && !/^\s*\.planning\s*$/.test(l))
      .join('\n');
    if (filtered !== gi) {
      fs.writeFileSync(pubGitignore, filtered);
      console.log(`${TOOL} filtered license-tools/.planning lines from published .gitignore`);
    }
    if (fs.readFileSync(pubGitignore, 'utf8').includes('license-tools')) {
      failures.push('published .gitignore mentions license-tools');
    }
    if (fs.readFileSync(pubGitignore, 'utf8').includes('.planning')) {
      failures.push('published .gitignore mentions .planning');
    }
  }

  // (d) exclusion assertions
  const mustBeAbsent = [
    '.planning', 'node_modules', 'storage', 'dist', 'vibe_loop.sh',
    'packages/server/scripts/istruzioni-widget-apikey.txt', 'src-tauri',
    'test-widget.html', '.claude',
  ];
  for (const p of mustBeAbsent) {
    if (fs.existsSync(path.join(outDir, p))) {
      failures.push(`excluded path present in output tree: ${p}`);
    }
  }
  const mustBePresent = [
    '.env.example',
    'packages/server/.env.test',
  ];
  for (const p of mustBePresent) {
    if (!fs.existsSync(path.join(outDir, p))) {
      failures.push(`required env file missing from output tree: ${p}`);
    }
  }

  return failures;
}

function main() {
  const ROOT = path.resolve(__dirname, '..');
  const OUT = path.join(ROOT, '.public-release');

  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.error(`${TOOL} not inside a git worktree — refusing to run.`);
    process.exit(1);
  }

  const { copied, skipped } = assemble(OUT);
  console.log(`${TOOL} copied ${copied} tracked files to ${OUT}`);
  console.log(`${TOOL} skipped ${skipped.length} excluded paths`);

  const failures = runGates(OUT);
  if (failures.length) {
    console.error(`${TOOL} ${failures.length} gate failure(s):\n` + failures.join('\n'));
    process.exit(1);
  }
  console.log(`${TOOL} OK — publication tree is clean (personal-data gate, negative assertions, exclusions)`);
}

if (require.main === module) main();

module.exports = { assemble, runGates, isExcluded, isEnvKept, isEnvExcluded, EXCLUDE, PERSONAL_PATTERNS, BRANDING_PATTERNS };

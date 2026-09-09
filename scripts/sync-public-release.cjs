/**
 * Public-release sync (tree-based snapshot publishing).
 *
 * Replaces the manual worktree/cherry-pick flow: publishes the CURRENT dev
 * tree to the public repo as ONE snapshot commit, keeping public history
 * append-only (never rewritten, never merged with dev history).
 *
 * Flow:
 *   1. Reuses prepare-public-release.cjs to assemble + gate the clean tree
 *      into .public-release/ (personal-data grep, exclusions, negative
 *      assertions — see that script for the full contract).
 *   2. In the dedicated public clone (../simmetric-public, a PLAIN clone of
 *      studio-simos/simmetric — not a worktree: a real .git dir survives
 *      quota/environment flakiness that made worktree gitdir pointers vanish):
 *        - `git rm -rq` the live tree, copy in the fresh one, commit.
 *        - Snapshot commit message: release metadata (dev sha + timestamp).
 *   3. Pushes origin main (dry-run: prints the commands instead).
 *
 * Idempotence: if the assembled tree is identical to the current public tree
 * (git status --porcelain empty after sync), nothing is committed or pushed.
 *
 * Usage:
 *   node scripts/sync-public-release.cjs [--dry-run]
 *   node scripts/sync-public-release.cjs --check   # assemble+gate only, no git
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOOL = '[sync-public-release]';

const DEV_ROOT = path.resolve(__dirname, '..');
// Sibling plain clone of the public repo (auto-created on first run).
const PUBLIC_REPO_URL = 'git@github.com:studio-simos/simmetric.git';
const PUBLIC_CLONE = path.resolve(DEV_ROOT, '..', 'simmetric-public');
const OUT_DIR = path.join(DEV_ROOT, '.public-release');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CHECK_ONLY = args.includes('--check');

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts });
}

function fail(msg) {
  console.error(`${TOOL} ${msg}`);
  process.exit(1);
}

function ensurePublicClone() {
  if (fs.existsSync(path.join(PUBLIC_CLONE, '.git'))) return;
  if (fs.existsSync(PUBLIC_CLONE)) {
    fail(`${PUBLIC_CLONE} exists but is not a git repo — inspect/remove it manually`);
  }
  console.log(`${TOOL} cloning public repo into ${PUBLIC_CLONE} ...`);
  sh(`git clone --single-branch ${PUBLIC_REPO_URL} ${JSON.stringify(PUBLIC_CLONE)}`);
}

function main() {
  // ── Step 1: assemble + gate the clean tree (reuses the PUB-01 gates) ──
  const prepare = path.join(__dirname, 'prepare-public-release.cjs');
  sh(`node ${JSON.stringify(prepare)}`, { stdio: 'inherit' });
  if (!fs.existsSync(path.join(OUT_DIR, 'package.json'))) {
    fail(`assembled tree missing at ${OUT_DIR}`);
  }
  console.log(`${TOOL} assembly + gates OK`);

  if (CHECK_ONLY) {
    console.log(`${TOOL} --check: stopping before git operations`);
    return;
  }

  ensurePublicClone();
  const repo = { cwd: PUBLIC_CLONE };

  // Verify the clone is really the public repo on main.
  const originUrl = sh('git remote get-url origin', repo).trim();
  if (!/studio-simos\/simmetric(\.git)?$/.test(originUrl)) {
    fail(`unexpected origin in ${PUBLIC_CLONE}: ${originUrl}`);
  }
  sh('git checkout -q main', repo);
  sh('git pull -q --ff-only origin main', repo);

  const devSha = sh('git rev-parse HEAD', { cwd: DEV_ROOT }).trim();
  const ts = new Date().toISOString();

  // Replace the live tree with the assembled one. rsync --delete mirrors
  // deletions; `git add -A` then stages adds/modifies/deletes in one step
  // (no `git rm` — it fails on re-runs because of leftover staged state).
  sh(`rsync -a --delete --exclude=.git/ ${JSON.stringify(OUT_DIR)}/ ${JSON.stringify(PUBLIC_CLONE)}/`);
  // Version metadata for the snapshot commit message.
  let version = 'unknown';
  try {
    version = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'package.json'), 'utf8')).version || 'unknown';
  } catch { /* best-effort */ }

  sh('git add -A', repo);
  const status = sh('git status --porcelain', repo).trim();
  if (!status) {
    console.log(`${TOOL} public tree already up to date — nothing to commit`);
    sh(`rm -rf ${JSON.stringify(OUT_DIR)}`);
    return;
  }
  const changed = status.split('\n').length;
  console.log(`${TOOL} ${changed} path(s) changed vs public/main`);

  const msg = `chore(release): sync from dev ${devSha.slice(0, 11)} — v${version} (${ts})`;
  if (DRY_RUN) {
    console.log(`${TOOL} DRY RUN — changed paths:`);
    console.log(status.split('\n').slice(0, 40).join('\n'));
    if (changed > 40) console.log(`${TOOL} ... and ${changed - 40} more`);
    console.log(`${TOOL} DRY RUN — would commit: ${msg}`);
    console.log(`${TOOL} DRY RUN — would push: git push origin main (in ${PUBLIC_CLONE})`);
    return;
  }
  sh(`git commit -m ${JSON.stringify(msg)}`, repo);
  console.log(`${TOOL} committed snapshot: ${msg}`);

  // ── Step 3: push ──
  sh('git push origin main', repo);
  console.log(`${TOOL} pushed public main`);

  // Cleanup: the assembled tree is disposable.
  sh(`rm -rf ${JSON.stringify(OUT_DIR)}`);
  console.log(`${TOOL} OK`);
}

main();
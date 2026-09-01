/**
 * Build-freshness check (DISC-02).
 *
 * Walks packages/server/src (all .ts files, recursively) and verifies that
 * each non-test source file has a matching dist .js mirror whose mtime is
 * greater than or equal to the source mtime. Exits non-zero when any dist
 * file is missing or stale (src newer than dist), so `pnpm start` refuses
 * to launch a stale server (the recurring 502 trap).
 *
 * Why .cjs (not .ts): the script runs from `pnpm start` BEFORE any build,
 * under plain Node (no tsx). Mirrors scripts/fix-prisma-pnpm.cjs which runs
 * inside `db:generate` for the same reason.
 *
 * Filesystem-only check (no `git diff`): dist/ is gitignored (.gitignore:5),
 * so the only reliable signal is an mtime + existence walk (59-RESEARCH
 * Pattern 2 / Pitfall 2).
 */

const fs = require('fs');
const path = require('path');

// Exclude set mirrors tsconfig.build.json (lines 11-14): test files and test
// fixture directories are not emitted to dist/ and must not be reported.
// `.d.ts` declaration files are also excluded — tsc emits `.d.ts` (not `.js`)
// for them, so checking for a `.js` mirror would produce false positives.
const EXCLUDE = /(__tests__|__mocks__|\.test\.ts$|\.spec\.ts$|\.d\.ts$)/;

/**
 * Recursively collect non-excluded .ts files under `dir`.
 * @param {string} dir
 * @param {string[]} acc
 * @returns {string[]}
 */
function walkTs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDE.test(p)) walkTs(p, acc);
    } else if (e.name.endsWith('.ts') && !EXCLUDE.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Walk `srcDir` and for each non-excluded .ts file, check the corresponding
 * `distDir` mirror (relative path with .ts -> .js). Returns an array of
 * human-readable stale/missing entries; empty when dist/ is fresh.
 *
 * @param {string} srcDir absolute path to the src/ tree
 * @param {string} distDir absolute path to the dist/ tree
 * @returns {string[]} stale/missing entries (empty = fresh)
 */
function findStaleFiles(srcDir, distDir) {
  return walkTs(srcDir)
    .map((srcFile) => {
      const rel = path.relative(srcDir, srcFile).replace(/\.ts$/, '.js');
      const distFile = path.join(distDir, rel);
      if (!fs.existsSync(distFile)) {
        return `${rel}: missing in dist/`;
      }
      if (fs.statSync(srcFile).mtimeMs > fs.statSync(distFile).mtimeMs) {
        return `${rel}: src newer than dist (stale)`;
      }
      return null;
    })
    .filter(Boolean);
}

function main() {
  const SERVER_DIR = path.resolve(__dirname, '..');
  const SRC = path.join(SERVER_DIR, 'src');
  const DIST = path.join(SERVER_DIR, 'dist');

  if (!fs.existsSync(SRC)) {
    console.error(`[build-freshness] src/ not found at ${SRC}`);
    process.exit(1);
  }
  if (!fs.existsSync(DIST)) {
    console.error(
      `[build-freshness] dist/ not found at ${DIST} — run \`pnpm build\` before starting the server.`,
    );
    process.exit(1);
  }

  const stale = findStaleFiles(SRC, DIST);
  if (stale.length) {
    console.error(
      `[build-freshness] ${stale.length} stale/missing dist file(s):\n` +
        stale.join('\n'),
    );
    console.error(
      '[build-freshness] Run `pnpm build` before starting the server.',
    );
    process.exit(1);
  }
  console.log('[build-freshness] OK — dist/ is fresh relative to src/');
}

if (require.main === module) main();

module.exports = { findStaleFiles, walkTs };
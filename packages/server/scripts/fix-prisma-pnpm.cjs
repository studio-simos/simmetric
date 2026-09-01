/**
 * Fix Prisma 7 + pnpm compatibility.
 *
 * Prisma 7's prisma-client-js generator writes to an output directory (default:
 * node_modules/.prisma/client) and @prisma/client looks for it via a .prisma
 * symlink. In pnpm, @prisma/client is itself a symlink into the virtual store,
 * so Node's `.prisma/client/default` relative require and TypeScript's
 * `export * from '.prisma/client/default'` both fail to resolve.
 *
 * This script:
 *   1. Creates node_modules/@prisma/client/.prisma → node_modules/.prisma
 *   2. Patches @prisma/client entry files (index.js, default.js, and their
 *      .d.ts counterparts) to use direct paths instead of the broken
 *      .prisma/client/default lookup.
 *
 * Run after `prisma generate` — invoked by the `db:generate` package script.
 */
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..');
const GENERATED_CLIENT = path.join(SERVER_DIR, 'node_modules', '.prisma', 'client');
const PRISMA_CLIENT_LINK = path.join(SERVER_DIR, 'node_modules', '@prisma', 'client');

// ── Resolve the real @prisma/client directory ──────────────────────────
let prismaClientDir;
try {
  // require.resolve follows pnpm symlinks to the real package
  prismaClientDir = path.dirname(
    require.resolve('@prisma/client/package.json', { paths: [SERVER_DIR] })
  );
} catch {
  console.error('fix-prisma-pnpm: Cannot resolve @prisma/client/package.json');
  process.exit(1);
}

// ── Check generated client exists ─────────────────────────────────────
if (!fs.existsSync(GENERATED_CLIENT)) {
  console.error(`fix-prisma-pnpm: ${GENERATED_CLIENT} not found — did prisma generate run?`);
  process.exit(1);
}

// ── 1. Create .prisma symlink ─────────────────────────────────────────
const symlinkTarget = path.join(SERVER_DIR, 'node_modules', '.prisma');
const symlinkPath = path.join(prismaClientDir, '.prisma');
try { fs.unlinkSync(symlinkPath); } catch { /* not a file */ }
try { fs.rmSync(symlinkPath, { recursive: true, force: true }); } catch { /* not a dir */ }
fs.symlinkSync(symlinkTarget, symlinkPath, 'dir');

// ── 2. Compute relative path for patches ──────────────────────────────
const relativeGenerated = path.relative(prismaClientDir, GENERATED_CLIENT);

// ── 3. Patch .js entry files ──────────────────────────────────────────
const jsOverride = [
  '// Patched by scripts/fix-prisma-pnpm.mjs for Prisma 7 + pnpm',
  '// Uses __dirname-relative path instead of .prisma/client/default',
  "const path = require('path');",
  `const generated = process.env.PRISMA_GENERATED_DIR`,
  `  || path.resolve(__dirname, '${relativeGenerated}/default');`,
  'module.exports = require(generated);',
  '',
].join('\n');

for (const f of ['index.js', 'default.js']) {
  fs.writeFileSync(path.join(prismaClientDir, f), jsOverride);
}

// ── 4. Patch .d.ts entry files (TypeScript 6 + pnpm compat) ──────────
const tsOverride = [
  '// Patched by scripts/fix-prisma-pnpm.mjs for Prisma 7 + TypeScript 6 + pnpm',
  `export * from '${relativeGenerated}/default';`,
  '',
].join('\n');

for (const f of ['index.d.ts', 'default.d.ts']) {
  fs.writeFileSync(path.join(prismaClientDir, f), tsOverride);
}

console.log('fix-prisma-pnpm: OK');
console.log(`  .prisma symlink: ${symlinkPath} -> ${symlinkTarget}`);
console.log(`  patched: ${prismaClientDir}/{index,default}.{js,d.ts}`);

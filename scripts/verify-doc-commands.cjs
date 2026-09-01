#!/usr/bin/env node
/**
 * scripts/verify-doc-commands.cjs
 *
 * Phase 136 (PUB-05-01, D-01) — CI-runnable verification gate for shell commands
 * embedded in the 9 canonical docs + INDEX + WIDGET.
 *
 * What it does:
 *   1. Extracts fenced ```bash and ```sh code blocks from each doc via regex.
 *   2. Splits each block into individual command lines.
 *   3. SKIP_PATTERNS: commands that require a running server/DB/Docker/Ollama/Redis
 *      are skipped with a logged note (not run).
 *   4. DENYLIST: commands the script will NEVER run, even if they don't match
 *      SKIP_PATTERNS — sudo, rm -rf, curl|sh, wget|sh, nc, ssh, scp, chmod 777.
 *      A denylist match is a hard error (exit 1) so a malicious doc command
 *      can never silently execute in CI (T-136-01).
 *   5. Runnable commands are executed via execSync in the repo root with a
 *      60s timeout; non-zero exit is a failure.
 *   6. Prints a summary and exits 0 on success / 1 on any failure or denylist hit.
 *
 * Zero external dependencies — only node:fs, node:child_process, node:path.
 * The repo root is ESM ("type": "module"), so this file uses .cjs (CommonJS).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// --dry-run: list the commands that WOULD be run, skipped, and denied, but
// execute nothing. Useful for CI sanity checks and for the plan's verify gate
// (which needs to confirm the script parses the docs correctly without
// paying the multi-minute cost of actually running pnpm install/build/test).
const DRY_RUN = process.argv.includes('--dry-run');

const DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'docs/INDEX.md',
  'docs/ARCHITECTURE.md',
  'docs/GETTING_STARTED.md',
  'docs/DEVELOPMENT.md',
  'docs/TESTING.md',
  'docs/CONFIGURATION.md',
  'docs/API.md',
  'docs/DEPLOYMENT.md',
  'docs/WIDGET.md',
];

// Commands that require a running service / DB / Docker / Ollama / Redis.
// Skipped with a logged note — NOT run. Use RegExp literals (ripgrep-style
// alternations don't apply here; each entry is its own pattern).
const SKIP_PATTERNS = [
  /docker compose/,
  /pnpm dev/,
  /pnpm --filter \w+ dev/,
  /curl http:\/\/localhost/,
  /curl http:\/\/127\.0\.0\.1/,
  /curl -X POST http:\/\/localhost/,
  /curl -N http:\/\/localhost/,
  /psql /,
  /prisma migrate/,
  /pnpm db:migrate/,
  /pnpm db:seed/,
  /ollama pull/,
  /ollama run/,
  /ollama serve/,
  /ollama list/,
  /docker exec/,
  /docker run/,
  /docker logs/,
  /docker stats/,
  /docker stop/,
  /docker compose/,
  /redis-cli/,
  /pnpm test:e2e/,
  /pnpm test:integration/,
  /pnpm --filter server test --/,
  /pnpm --filter server test:integration/,
  /pnpm --filter collector test:integration/,
  /smoke:/,
  /pnpm smoke:/,
  /kill /,
  /sudo /,
  /pnpm tauri:dev/,
  /pnpm tauri:build/,
  /pnpm tauri /,
  /prisma migrate reset/,
  /npx prisma migrate reset/,
  /redis-cli ping/,
];

// Commands the script will NEVER run, even if they don't match SKIP_PATTERNS.
// A denylist match is a HARD ERROR (exit 1) — T-136-01 mitigation.
const DENYLIST = [
  /sudo /,
  /rm -rf/,
  /rm -r /,
  /chmod 777/,
  /curl.*\| sh/,
  /curl.*\| bash/,
  /wget.*\| sh/,
  /wget.*\| bash/,
  /nc /,
  /ssh /,
  /scp /,
  /:(){ :|:& };:/, // fork bomb
];

// Heuristic: a line is a shell command (not a config snippet or comment) if it
// starts with a known command prefix or an export/ENV assignment. Lines
// starting with # are comments; blank lines are skipped.
const COMMAND_PREFIXES = [
  'pnpm', 'npm', 'npx', 'node', 'git', 'docker', 'cp', 'mkdir', 'curl', 'psql',
  'ollama', 'corepack', 'kill', 'ss', 'redis-cli', 'prisma', 'cd ', 'export ',
  'DATABASE_URL=', 'JWT_SECRET=', 'COLLECTOR_SECRET=', 'LICENSE_KEY=',
  'ENCRYPTION_KEY=', 'REDIS_URL=', 'OLLAMA_BASE_URL=', 'LLM_PROVIDER=',
  'SERVER_URL=', 'COLLECTOR_URL=', 'WIDGET_API_KEY=', 'HF_CACHE_DIR=',
  'XENOVA_CACHE_DIR=', 'STORAGE_PATH=', 'EMBEDDING_PROVIDER=', 'VECTOR_DB_PROVIDER=',
  'LLM_MODEL=', 'SEED_BOOTSTRAP_ADMIN=', 'ALLOW_REGISTRATION=', 'NODE_ENV=',
  'DISABLE_TELEMETRY=', 'LOG_LEVEL=', 'SMTP_HOST=', 'VAPID_SUBJECT=',
  'SCIM_BEARER_TOKEN=', 'AGENT_WALLCLOCK_TIMEOUT_MS=', 'OPENAI_API_KEY=',
];

function isShellCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  // Inline env-var assignment before a command: FOO=bar pnpm ...
  if (/^[\w_]+=\S+\s+\w/.test(trimmed)) return true;
  for (const prefix of COMMAND_PREFIXES) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}

function matchesAny(cmd, patterns) {
  return patterns.some((re) => re.test(cmd));
}

// Extract fenced ```bash / ```sh blocks from a markdown file.
function extractBashBlocks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = [];
  const lines = content.split('\n');
  let inBlock = false;
  let blockLines = [];
  let blockStartLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```(bash|sh)\b/.test(line)) {
      inBlock = true;
      blockLines = [];
      blockStartLine = i + 2; // 1-indexed line of first content line
      continue;
    }
    if (inBlock && /^```/.test(line)) {
      inBlock = false;
      blocks.push({ startLine: blockStartLine, lines: blockLines });
      continue;
    }
    if (inBlock) blockLines.push(line);
  }
  return blocks;
}

let ran = 0;
let skipped = 0;
let denied = 0;
let failures = 0;
const failureDetails = [];
const skipDetails = [];
const denyDetails = [];

for (const doc of DOCS) {
  const abs = path.join(REPO_ROOT, doc);
  if (!fs.existsSync(abs)) {
    console.error(`WARN: doc not found: ${doc}`);
    continue;
  }
  const blocks = extractBashBlocks(abs);
  for (const block of blocks) {
    for (let i = 0; i < block.lines.length; i++) {
      const raw = block.lines[i];
      if (!isShellCommand(raw)) continue;
      const cmd = raw.trim();
      // Strip a leading "$ " prompt if present
      const cleanCmd = cmd.replace(/^\$\s+/, '');
      const lineRef = `${doc}:${block.startLine + i}`;

      if (matchesAny(cleanCmd, DENYLIST)) {
        denied++;
        denyDetails.push(`${lineRef}: ${cleanCmd}`);
        continue;
      }

      if (matchesAny(cleanCmd, SKIP_PATTERNS)) {
        skipped++;
        skipDetails.push(`SKIP (requires running service): ${lineRef}: ${cleanCmd}`);
        continue;
      }

      ran++;
      if (DRY_RUN) {
        console.log(`  [dry-run] would run: ${lineRef}: ${cleanCmd}`);
        continue;
      }
      try {
        execSync(cleanCmd, {
          cwd: REPO_ROOT,
          stdio: 'pipe',
          timeout: 60000,
        });
      } catch (err) {
        failures++;
        const code = err.status ?? 'signal';
        failureDetails.push(`${lineRef}: FAILED (exit ${code}) — ${cleanCmd}`);
      }
    }
  }
}

console.log('--- verify-doc-commands.cjs summary ---');
const modeLabel = DRY_RUN ? ' [dry-run]' : '';
console.log(`${modeLabel} Ran ${ran} commands, skipped ${skipped}, denied ${denied}. ${failures} failures.`);
if (skipDetails.length) {
  console.log('\nSkipped (requires running service):');
  for (const s of skipDetails) console.log(`  ${s}`);
}
if (denyDetails.length) {
  console.log('\nDENYLIST matches (review the doc — these must not be auto-run):');
  for (const d of denyDetails) console.log(`  ${d}`);
}
if (failureDetails.length) {
  console.log('\nFailures:');
  for (const f of failureDetails) console.log(`  ${f}`);
}

if (failures > 0 || denied > 0) {
  console.error('\nverify-doc-commands: FAIL');
  process.exit(1);
}
console.log('\nverify-doc-commands: OK');
process.exit(0);
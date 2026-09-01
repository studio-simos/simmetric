#!/usr/bin/env node
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Publication secret audit (Phase 181 PUB-11) — pre-push gate for the
 * public-release runbook. Scans every TRACKED file for credential-shaped
 * patterns that gitleaks' default rules may miss in this repo's context
 * (embedded RS256 public keys are fine; private keys / minted JWTs /
 * API keys are not). Complements (does not replace) the CI gitleaks job.
 *
 * Usage:
 *   node scripts/audit-publication-secrets.cjs            # audit git ls-files
 *   node scripts/audit-publication-secrets.cjs --staged    # audit `git diff --cached --name-only`
 *
 * Exit 0 = clean · Exit 1 = at least one hit (block the push, fix first).
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const PATTERNS = [
  { name: "JWT body (eyJ…eyJ…)", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { name: "OpenAI-style key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "Stripe live key", re: /sk_live_[A-Za-z0-9]+/ },
  { name: "GitHub PAT", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "GitLab PAT", re: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]+/ },
  { name: "generic assignment secret", re: /(?:LICENSE_KEY|JWT_SECRET|ENCRYPTION_KEY|API_KEY_HMAC_SECRET|WIDGET_API_KEY|COLLECTOR_SECRET)\s*=\s*(?!change-)(?!.*-in-production\b)(?!ci-test)(?!test-key\b)[A-Za-z0-9+/=_.-]{20,}/ },
];

// Files whose CONTENT is a known-safe fixture (test keys, docs examples)
// or CI-internal (never ships in the orphan public commit — .planning/ is
// untracked at publication time per the runbook).
const FILE_ALLOWLIST = [
  "packages/server/.env.test",
  "e2e/globalSetup.ts",
  "e2e/lib/",
  "scripts/smoke-multi-instance.ts",
  "docs/API_KEY_MIGRATION.md",
  "docs/ENCRYPTION_KEY_ROTATION.md",
  ".github/workflows/ci.yml",
  "docs/ENTERPRISE_PLUGIN.md",
  "docs/TESTING.md",
  ".gitleaks.toml",
  ".planning/",
  "__tests__/",
  "packages/server/src/services/license-public-key.ts",
];

// Known-safe literal fixtures (the CI test API key + fake AWS key — both
// documented in .gitleaks.toml and used as test constants).
const VALUE_ALLOWLIST = new Set([
  "sk-c6a7b6662ab64f4c9582bf83e147675b",
  "AKIAABCDEFGHIJKLMNOP",
]);

function listFiles() {
  const args = process.argv.includes("--staged")
    ? ["diff", "--cached", "--name-only"]
    : ["ls-files"];
  return execFileSync("git", args, { encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);
}

function main() {
  const files = listFiles().filter(
    (f) => !FILE_ALLOWLIST.some((a) => f === a || f.startsWith(a) || f.includes(a))
  );
  const hits = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // deleted/binary
    }
    if (content.includes("\u0000")) continue; // binary
    const lines = content.split("\n");
    for (const { name, re } of PATTERNS) {
      for (let i = 0; i < lines.length; i += 1) {
        const value = lines[i].match(re);
        if (!value) continue;
        if (VALUE_ALLOWLIST.has(value[0])) continue;
        hits.push({ file, line: i + 1, name, value: value[0] });
      }
    }
  }
  if (hits.length > 0) {
    console.error(`SECRET AUDIT FAILED — ${hits.length} candidate hit(s):`);
    for (const h of hits) {
      console.error(`  [${h.name}] ${h.file}:${h.line} → ${h.value.slice(0, 12)}…`);
    }
    console.error(
      "\nReview each hit: if it is a real credential, remove it (and rotate it — it may have already leaked)."
    );
    process.exit(1);
  }
  console.log(`Secret audit PASSED — ${files.length} tracked files scanned, 0 credential-shaped hits.`);
}

main();

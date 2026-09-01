#!/usr/bin/env node
const fs = require('fs');
const { execSync } = require('child_process');

const HEADER = `// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

`;

const result = execSync(
  "find packages/shared/src packages/server/src packages/frontend/src packages/collector/src packages/widget/src -type f \\( -name '*.ts' -o -name '*.tsx' \\) 2>/dev/null",
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
).trim();

const files = result.split('\n').filter(Boolean);
let added = 0, skipped = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (content.startsWith('// Simmetric Chat — Copyright')) {
    skipped++;
    continue;
  }
  if (!content.trim()) {
    skipped++;
    continue;
  }
  fs.writeFileSync(file, HEADER + content, 'utf8');
  added++;
}

console.log(`Added: ${added} | Skipped: ${skipped} | Total: ${files.length}`);
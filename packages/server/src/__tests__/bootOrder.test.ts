// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 140 (EPA-01) — Boot-order invariant test (D-08, D-13).
 *
 * Source-string assertion: reads `packages/server/src/index.ts` as UTF-8
 * and asserts that `loadEnterprisePlugin(app)` appears AFTER
 * `await prisma.$connect()` and `initLicense()`, and BEFORE the
 * `if (env.NODE_ENV === "production")` scheduler block.
 *
 * Pattern adapted verbatim from
 * `packages/frontend/src/__tests__/mainImportOrder.test.ts` (the
 * established source-string test convention in this repo).
 *
 * This test FAILS the build if someone reorders the boot sequence and
 * breaks the D-08 invariant (plugin must load after prisma+license and
 * before schedulers). That is its sole purpose.
 */

const fs = require("fs");
const path = require("path");

function readIndexTsSource(): string {
  return fs.readFileSync(
    path.resolve(__dirname, "../index.ts"),
    "utf8",
  );
}

function lineNumberOfFirstMatch(lines: string[], pattern: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i]!)) return i + 1; // 1-based
  }
  return -1;
}

describe("index.ts boot order (D-08)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  // Regex matches both `loadEnterprisePlugin(app)` and
  // `await loadEnterprisePlugin(app)` (per RESEARCH Open Question 1/A3).
  const loaderLine = lineNumberOfFirstMatch(
    lines,
    /loadEnterprisePlugin\s*\(\s*app\s*\)/,
  );
  // PITFALL 3: initLicense() is synchronous — no `await`. Regex must NOT
  // require `await`.
  const initLicenseLine = lineNumberOfFirstMatch(lines, /initLicense\s*\(\s*\)/);
  const prismaConnectLine = lineNumberOfFirstMatch(
    lines,
    /await\s+prisma\.\$connect\s*\(\s*\)/,
  );
  const schedulerBlockLine = lineNumberOfFirstMatch(
    lines,
    /if\s*\(\s*env\.NODE_ENV\s*===\s*["']production["']\s*\)/,
  );

  test("loadEnterprisePlugin(app) is present in index.ts", () => {
    expect(loaderLine).toBeGreaterThan(0);
  });

  test("loadEnterprisePlugin(app) runs AFTER await prisma.$connect()", () => {
    expect(prismaConnectLine).toBeGreaterThan(0);
    expect(loaderLine).toBeGreaterThan(prismaConnectLine);
  });

  test("loadEnterprisePlugin(app) runs AFTER initLicense()", () => {
    expect(initLicenseLine).toBeGreaterThan(0);
    expect(loaderLine).toBeGreaterThan(initLicenseLine);
  });

  test("loadEnterprisePlugin(app) runs BEFORE the NODE_ENV===production scheduler block", () => {
    expect(schedulerBlockLine).toBeGreaterThan(0);
    expect(loaderLine).toBeLessThan(schedulerBlockLine);
  });

  test("shutdownEnterprisePlugin is called in gracefulShutdown BEFORE prisma.$disconnect()", () => {
    const shutdownPluginLine = lineNumberOfFirstMatch(
      lines,
      /shutdownEnterprisePlugin\s*\(\s*\)/,
    );
    const prismaDisconnectLine = lineNumberOfFirstMatch(
      lines,
      /await\s+prisma\.\$disconnect\s*\(\s*\)/,
    );
    expect(shutdownPluginLine).toBeGreaterThan(0);
    expect(prismaDisconnectLine).toBeGreaterThan(0);
    // Both the call and the prisma.$disconnect must be inside
    // gracefulShutdown. The shutdown call must precede the disconnect.
    expect(shutdownPluginLine).toBeLessThan(prismaDisconnectLine);
  });
});

// Phase 152 (WIZ-02, D-04, RESEARCH Pitfall 1): the setup_wizard_mode
// derivation MUST run AFTER seedConfigDefaults (the row must exist) and
// BEFORE seedBootstrapAdmin (the skip guard reads the derived value).
// Reordering reopens the seed-vs-wizard race: if derivation runs after
// seedBootstrapAdmin, the seeder creates admin/admin123 before the wizard
// mode is derived, so the wizard never shows on a truly fresh install.
describe("index.ts boot order — setup_wizard_mode (Phase 152, WIZ-02)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const seedConfigDefaultsLine = lineNumberOfFirstMatch(
    lines,
    /await\s+seedConfigDefaults\s*\(\s*\)/,
  );
  const ensureSetupWizardModeLine = lineNumberOfFirstMatch(
    lines,
    /await\s+ensureSetupWizardMode\s*\(\s*\)/,
  );
  const seedBootstrapAdminLine = lineNumberOfFirstMatch(
    lines,
    /await\s+seedBootstrapAdmin\s*\(\s*\)/,
  );

  test("ensureSetupWizardMode() is present in index.ts", () => {
    expect(ensureSetupWizardModeLine).toBeGreaterThan(0);
  });

  test("ensureSetupWizardMode() runs AFTER seedConfigDefaults()", () => {
    expect(seedConfigDefaultsLine).toBeGreaterThan(0);
    expect(ensureSetupWizardModeLine).toBeGreaterThan(seedConfigDefaultsLine);
  });

  test("ensureSetupWizardMode() runs BEFORE seedBootstrapAdmin()", () => {
    expect(seedBootstrapAdminLine).toBeGreaterThan(0);
    expect(ensureSetupWizardModeLine).toBeLessThan(seedBootstrapAdminLine);
  });

  test("ensureSetupWizardMode is imported from systemConfigService", () => {
    const importLine = lineNumberOfFirstMatch(
      lines,
      /import\s*\{[^}]*ensureSetupWizardMode[^}]*\}\s*from\s*["']\.\/services\/systemConfigService["']/,
    );
    expect(importLine).toBeGreaterThan(0);
  });
});

// Phase 162 (ENC-01, D-01): the server must FAIL LOUD at boot when
// ENCRYPTION_KEY is unset in production — logger.error + process.exit(1),
// replacing the Phase 157 advisory logger.warn. The hard-default block is
// placed inside the app.listen callback, AFTER the
// `logger.info([server] Listening on port` line and BEFORE
// `await prisma.$connect()` (D-01: fires even if the DB is unreachable). The
// message must mention ENCRYPTION_KEY, scryptSync (the legacy fallback
// mechanism that rotating JWT_SECRET would invalidate), and point at
// docs/ENCRYPTION_KEY_ROTATION.md. The guard uses env.ENCRYPTION_KEY (the
// getEnv() Zod-validated cached path), NOT process.env.ENCRYPTION_KEY
// (Pitfall 3: index.ts is the validated entry point). Source-string
// assertion — fails the build if the block is reordered, loses the
// required tokens, or reverts to logger.warn.
describe("index.ts boot order — ENCRYPTION_KEY hard-default (Phase 162, ENC-01)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  // The hard-default guard line: `if (env.NODE_ENV === "production" && !env.ENCRYPTION_KEY)`
  // — match the ENCRYPTION_KEY token co-located with `production` on an `if (` guard
  // line (NOT a comment — the Phase 162 comment also contains both tokens).
  const encryptionKeyWarningLine = lineNumberOfFirstMatch(
    lines,
    /^\s*if\b.*(?:ENCRYPTION_KEY.*production|production.*ENCRYPTION_KEY)/,
  );
  const listeningLine = lineNumberOfFirstMatch(
    lines,
    /logger\.info\(\s*`?\[server\]\s*Listening on port/,
  );
  const prismaConnectLine = lineNumberOfFirstMatch(
    lines,
    /await\s+prisma\.\$connect\s*\(\s*\)/,
  );
  // The Phase 161 REDIS_URL block starts after the ENCRYPTION_KEY block.
  const redisUrlWarningLine = lineNumberOfFirstMatch(
    lines,
    /REDIS_URL.*production|production.*REDIS_URL/,
  );

  test("ENCRYPTION_KEY production hard-default block is present in index.ts", () => {
    expect(encryptionKeyWarningLine).toBeGreaterThan(0);
  });

  test("ENCRYPTION_KEY hard-default fires AFTER logger.info Listening (D-01 placement)", () => {
    expect(listeningLine).toBeGreaterThan(0);
    expect(encryptionKeyWarningLine).toBeGreaterThan(listeningLine);
  });

  test("ENCRYPTION_KEY hard-default fires BEFORE await prisma.$connect() (D-01 placement)", () => {
    expect(prismaConnectLine).toBeGreaterThan(0);
    expect(encryptionKeyWarningLine).toBeLessThan(prismaConnectLine);
  });

  test("ENCRYPTION_KEY block uses logger.error + process.exit(1) (Phase 162 escalation, not Phase 157 warn)", () => {
    // Extract the source substring of the ENCRYPTION_KEY block: from the
    // guard line up to (but not including) the REDIS_URL block (or the next
    // blank line / prisma.$connect if REDIS_URL were absent).
    const blockStart = encryptionKeyWarningLine - 1; // 0-based index
    const blockEnd = redisUrlWarningLine > 0 ? redisUrlWarningLine - 1 : prismaConnectLine - 1;
    const block = lines.slice(blockStart, blockEnd).join("\n");
    expect(block).toContain("logger.error");
    expect(block).toContain("process.exit(1)");
    // The Phase 157 logger.warn is GONE from this block.
    expect(block).not.toContain("logger.warn");
  });

  test("ENCRYPTION_KEY hard-default message names ENCRYPTION_KEY, scryptSync/scrypt, and the runbook path (content invariant)", () => {
    expect(src).toContain("ENCRYPTION_KEY");
    expect(src).toContain("scryptSync");
    expect(src).toContain("ENCRYPTION_KEY_ROTATION.md");
  });

  test("ENCRYPTION_KEY guard uses env.ENCRYPTION_KEY (getEnv() path), not process.env.ENCRYPTION_KEY (Pitfall 3)", () => {
    const guardLine = lines[encryptionKeyWarningLine - 1]!;
    expect(guardLine).toContain("env.ENCRYPTION_KEY");
    expect(guardLine).not.toContain("process.env.ENCRYPTION_KEY");
  });

  test("REDIS_URL warning still fires AFTER the ENCRYPTION_KEY block (Phase 161 block ordering preserved)", () => {
    expect(redisUrlWarningLine).toBeGreaterThan(0);
    expect(redisUrlWarningLine).toBeGreaterThan(encryptionKeyWarningLine);
  });
});

// Phase 161 (DR-04): the server must emit a logger.warn at boot when
// REDIS_URL is unset in production. The warning is placed inside the
// app.listen callback, AFTER the Phase 162 ENCRYPTION_KEY hard-default block and
// BEFORE `await prisma.$connect()` (D-02: fires even if the DB is
// unreachable). The message must mention REDIS_URL and "single-instance"
// (D-02 content). It must use `env.REDIS_URL` (the getEnv() cached,
// Zod-validated path that redisService.ts consumes) NOT `process.env.REDIS_URL`.
// Logs the key NAME only — never the value (V7 Logging, T-161-12).
// Source-string assertion — fails the build if the block is reordered or its
// wording loses the required tokens.
describe("index.ts boot order — REDIS_URL warning (Phase 161, DR-04)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  // The warning guard line: `if (env.NODE_ENV === "production" && !env.REDIS_URL)`
  // — match the REDIS_URL token co-located with `production` on an `if (` guard
  // line (NOT a comment).
  const redisUrlWarningLine = lineNumberOfFirstMatch(
    lines,
    /^\s*if\b.*(?:REDIS_URL.*production|production.*REDIS_URL)/,
  );
  const listeningLine = lineNumberOfFirstMatch(
    lines,
    /logger\.info\(\s*`?\[server\]\s*Listening on port/,
  );
  const prismaConnectLine = lineNumberOfFirstMatch(
    lines,
    /await\s+prisma\.\$connect\s*\(\s*\)/,
  );
  const encryptionKeyWarningLine = lineNumberOfFirstMatch(
    lines,
    /^\s*if\b.*(?:ENCRYPTION_KEY.*production|production.*ENCRYPTION_KEY)/,
  );

  test("REDIS_URL production warning block is present in index.ts", () => {
    expect(redisUrlWarningLine).toBeGreaterThan(0);
  });

  test("REDIS_URL warning fires AFTER logger.info Listening (D-02 placement)", () => {
    expect(listeningLine).toBeGreaterThan(0);
    expect(redisUrlWarningLine).toBeGreaterThan(listeningLine);
  });

  test("REDIS_URL warning fires BEFORE await prisma.$connect() (D-02 placement — fires even if DB unreachable)", () => {
    expect(prismaConnectLine).toBeGreaterThan(0);
    expect(redisUrlWarningLine).toBeLessThan(prismaConnectLine);
  });

  test("REDIS_URL warning fires AFTER the ENCRYPTION_KEY hard-default block (Phase 162 block, not before it)", () => {
    expect(encryptionKeyWarningLine).toBeGreaterThan(0);
    expect(redisUrlWarningLine).toBeGreaterThan(encryptionKeyWarningLine);
  });

  test("warning message mentions REDIS_URL + single-instance (D-02 content)", () => {
    expect(src).toContain("REDIS_URL");
    expect(src).toContain("single-instance");
  });

  test("warning uses getEnv().REDIS_URL (env.REDIS_URL) not process.env.REDIS_URL (Zod-validated, cached path)", () => {
    expect(src).toContain("env.REDIS_URL");
    // The DR-04 warning guard must NOT read process.env.REDIS_URL directly.
    // Find the DR-04 guard line and assert it uses env.REDIS_URL not process.env.
    const redisUrlGuardLine = lines[redisUrlWarningLine - 1]!;
    expect(redisUrlGuardLine).toContain("env.REDIS_URL");
    expect(redisUrlGuardLine).not.toContain("process.env.REDIS_URL");
  });
});

// Phase 164 (SCALE-04, Q-01/Q-04, D-03/D-04): pg-boss job-queue boot-order
// invariants. Source-string assertion — reads index.ts and asserts:
//   - startJobQueue() runs AFTER await prisma.$connect() (D-03)
//   - startJobQueue() runs BEFORE the NODE_ENV==="production" scheduler block (D-03)
//   - stopJobQueue() runs AFTER shutdownMCPConnections() (the last of the 7
//     scheduler shutdowns) and BEFORE shutdownEnterprisePlugin() +
//     prisma.$disconnect() (D-04 — drains in-flight jobs while the DB is up).
// Reuses the module-level readIndexTsSource() + lineNumberOfFirstMatch()
// helpers (defined above — do NOT redefine). Fails the build if the boot
// sequence is reordered and breaks the invariants.
describe("index.ts boot order — pg-boss (Phase 164, Q-01/Q-04)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const prismaConnectLine = lineNumberOfFirstMatch(
    lines,
    /await\s+prisma\.\$connect\s*\(\s*\)/,
  );
  // Match the `await startJobQueue();` call site (NOT the import line, NOT the
  // function definition in jobQueue.ts, NOT comment lines). The `await` prefix
  // excludes the import and the definition; comment lines that mention
  // `startJobQueue` without `await` are also excluded.
  const jobQueueStartLine = lineNumberOfFirstMatch(
    lines,
    /await\s+startJobQueue\s*\(\s*\)/,
  );
  const schedulerBlockLine = lineNumberOfFirstMatch(
    lines,
    /if\s*\(\s*env\.NODE_ENV\s*===\s*["']production["']\s*\)/,
  );
  // `await shutdownMCPConnections();` — the `await` prefix excludes comment
  // lines that mention the function name in prose.
  const shutdownMCPConnectionsLine = lineNumberOfFirstMatch(
    lines,
    /await\s+shutdownMCPConnections\s*\(\s*\)/,
  );
  const jobQueueStopLine = lineNumberOfFirstMatch(
    lines,
    /await\s+stopJobQueue\s*\(\s*\)/,
  );
  // `await shutdownEnterprisePlugin();` — the `await` prefix excludes the
  // comment at line ~635 (`shutdownEnterprisePlugin()'s schedulers.stop()`)
  // which would otherwise match the bare-name regex.
  const shutdownEnterpriseLine = lineNumberOfFirstMatch(
    lines,
    /await\s+shutdownEnterprisePlugin\s*\(\s*\)/,
  );
  const prismaDisconnectLine = lineNumberOfFirstMatch(
    lines,
    /await\s+prisma\.\$disconnect\s*\(\s*\)/,
  );

  test("startJobQueue() call site is present in index.ts", () => {
    expect(jobQueueStartLine).toBeGreaterThan(0);
  });

  test("startJobQueue() runs AFTER await prisma.$connect() (D-03)", () => {
    expect(prismaConnectLine).toBeGreaterThan(0);
    expect(jobQueueStartLine).toBeGreaterThan(prismaConnectLine);
  });

  test("startJobQueue() runs BEFORE the NODE_ENV===production scheduler block (D-03)", () => {
    expect(schedulerBlockLine).toBeGreaterThan(0);
    expect(jobQueueStartLine).toBeLessThan(schedulerBlockLine);
  });

  test("stopJobQueue() call site is present in index.ts", () => {
    expect(jobQueueStopLine).toBeGreaterThan(0);
  });

  test("stopJobQueue() runs BEFORE await prisma.$disconnect() (D-04 — drain while DB is up)", () => {
    expect(prismaDisconnectLine).toBeGreaterThan(0);
    expect(jobQueueStopLine).toBeLessThan(prismaDisconnectLine);
  });

  test("stopJobQueue() runs BEFORE shutdownEnterprisePlugin() (D-04)", () => {
    expect(shutdownEnterpriseLine).toBeGreaterThan(0);
    expect(jobQueueStopLine).toBeLessThan(shutdownEnterpriseLine);
  });

  test("stopJobQueue() runs AFTER shutdownMCPConnections() (D-04 — after MCP teardown)", () => {
    expect(shutdownMCPConnectionsLine).toBeGreaterThan(0);
    expect(jobQueueStopLine).toBeGreaterThan(shutdownMCPConnectionsLine);
  });
});

// Phase 165 (SCALE-04, Q-02/Q-03): scheduler-init-async boot-order
// invariants. Source-string assertion — reads index.ts and asserts:
//   - all 8 init*Scheduler() calls are preceded by `await` (Pitfall 4 — the
//     `await\s+` prefix excludes import lines + comment lines that mention
//     the function name in prose)
//   - the 8 init calls run AFTER `await startJobQueue()` (pg-boss must be up
//     first — T-165-12)
//   - the 7 per-scheduler shutdown* calls are ABSENT from the source
//     (removed from gracefulShutdown; pg-boss stopJobQueue drains workers —
//     T-165-14)
//   - stopJobQueue is still present (Phase 164 preserved, not removed)
//   - the 2 non-migrated 10s pollers (initOcrPipelineScheduler,
//     initSynthesisPipelineScheduler) are still present and NOT awaited
//     (D-01 — they stay sync setInterval)
// Reuses the module-level readIndexTsSource() + lineNumberOfFirstMatch()
// helpers (defined above — do NOT redefine). Fails the build if the boot
// sequence is reordered and breaks the invariants.
describe("index.ts boot order — scheduler init async (Phase 165, Q-02)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  // Pitfall 4: the `await\s+` prefix excludes import lines (`import { init... }`)
  // and comment lines that mention the function name in prose. Each test
  // asserts the call site (the awaited invocation) is present in the source.
  const initMCPReaperLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initMCPReaperScheduler\s*\(\s*\)/,
  );
  const initSynthesisReaperLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initSynthesisReaperScheduler\s*\(\s*\)/,
  );
  const initVectorCleanupLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initVectorCleanupScheduler\s*\(\s*\)/,
  );
  const initMCPHealthCheckLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initMCPHealthCheckScheduler\s*\(\s*\)/,
  );
  const initUploadDraftReaperLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initUploadDraftReaperScheduler\s*\(\s*\)/,
  );
  const initChatMessageReaperLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initChatMessageReaperScheduler\s*\(\s*\)/,
  );
  const initFidelitySamplingLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initFidelitySamplingScheduler\s*\(\s*\)/,
  );
  const initWikiConsistencyLine = lineNumberOfFirstMatch(
    lines,
    /await\s+initWikiConsistencyScheduler\s*\(\s*\)/,
  );
  const jobQueueStartLine = lineNumberOfFirstMatch(
    lines,
    /await\s+startJobQueue\s*\(\s*\)/,
  );
  const jobQueueStopLine = lineNumberOfFirstMatch(
    lines,
    /await\s+stopJobQueue\s*\(\s*\)/,
  );

  test("initMCPReaperScheduler is awaited (async pg-boss registration)", () => {
    expect(initMCPReaperLine).toBeGreaterThan(0);
  });

  test("initSynthesisReaperScheduler is awaited (async pg-boss registration)", () => {
    expect(initSynthesisReaperLine).toBeGreaterThan(0);
  });

  test("initVectorCleanupScheduler is awaited (async pg-boss registration)", () => {
    expect(initVectorCleanupLine).toBeGreaterThan(0);
  });

  test("initMCPHealthCheckScheduler is awaited (async pg-boss registration)", () => {
    expect(initMCPHealthCheckLine).toBeGreaterThan(0);
  });

  test("initUploadDraftReaperScheduler is awaited (async pg-boss registration)", () => {
    expect(initUploadDraftReaperLine).toBeGreaterThan(0);
  });

  test("initChatMessageReaperScheduler is awaited (async pg-boss registration)", () => {
    expect(initChatMessageReaperLine).toBeGreaterThan(0);
  });

  test("initFidelitySamplingScheduler is awaited (async pg-boss registration, Plan 04)", () => {
    expect(initFidelitySamplingLine).toBeGreaterThan(0);
  });

  test("initWikiConsistencyScheduler is awaited (async pg-boss registration)", () => {
    expect(initWikiConsistencyLine).toBeGreaterThan(0);
  });

  test("scheduler inits run AFTER startJobQueue (pg-boss must be up first — T-165-12)", () => {
    expect(jobQueueStartLine).toBeGreaterThan(0);
    // Use initMCPReaperScheduler as the representative — all 8 inits are in the
    // same production block, so if one is after startJobQueue they all are.
    expect(initMCPReaperLine).toBeGreaterThan(jobQueueStartLine);
  });

  test("gracefulShutdown no longer calls shutdownMCPReaper (T-165-14)", () => {
    expect(src).not.toMatch(/await\s+shutdownMCPReaper\s*\(\s*\)/);
  });

  test("gracefulShutdown no longer calls shutdownSynthesisReaper (T-165-14)", () => {
    expect(src).not.toMatch(/await\s+shutdownSynthesisReaper\s*\(\s*\)/);
  });

  test("gracefulShutdown no longer calls shutdownVectorCleanup (T-165-14)", () => {
    expect(src).not.toMatch(/await\s+shutdownVectorCleanup\s*\(\s*\)/);
  });

  test("gracefulShutdown no longer calls shutdownMCPHealthCheck (T-165-14)", () => {
    expect(src).not.toMatch(/await\s+shutdownMCPHealthCheck\s*\(\s*\)/);
  });

  test("gracefulShutdown no longer calls shutdownUploadDraftReaper (T-165-14)", () => {
    expect(src).not.toMatch(/await\s+shutdownUploadDraftReaper\s*\(\s*\)/);
  });

  test("gracefulShutdown no longer calls shutdownChatMessageReaper (T-165-14)", () => {
    expect(src).not.toMatch(/await\s+shutdownChatMessageReaper\s*\(\s*\)/);
  });

  test("gracefulShutdown no longer calls shutdownWikiConsistency (T-165-14)", () => {
    expect(src).not.toMatch(/await\s+shutdownWikiConsistency\s*\(\s*\)/);
  });

  test("stopJobQueue is still present in gracefulShutdown (Phase 164 preserved)", () => {
    expect(jobQueueStopLine).toBeGreaterThan(0);
  });

  test("the 2 non-migrated 10s pollers are still present and NOT awaited (D-01)", () => {
    // OCR + synthesis pipeline pollers stay sync setInterval (D-01 — 10s
    // latency-sensitive, cron min granularity is 1min). Assert presence:
    expect(src).toMatch(/initOcrPipelineScheduler\s*\(\s*\)/);
    expect(src).toMatch(/initSynthesisPipelineScheduler\s*\(\s*\)/);
    // Assert NOT awaited (D-01 — they must not gain an await prefix):
    expect(src).not.toMatch(/await\s+initOcrPipelineScheduler/);
    expect(src).not.toMatch(/await\s+initSynthesisPipelineScheduler/);
  });
});
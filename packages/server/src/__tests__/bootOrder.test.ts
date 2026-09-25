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

// Phase 202 (PLGM-04, D-06): gracefulShutdown moved VERBATIM to
// services/shutdownSequence.ts — the teardown-order pins read BOTH sources
// (the body's new home + index.ts handler lines).
function readShutdownSequenceSource(): string {
  return fs.readFileSync(
    path.resolve(__dirname, "../services/shutdownSequence.ts"),
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
    // Phase 202 (D-06): the gracefulShutdown body lives in
    // services/shutdownSequence.ts — the teardown pins read that source.
    const seqLines = readShutdownSequenceSource().split(/\r?\n/);
    const shutdownPluginLine = lineNumberOfFirstMatch(
      seqLines,
      /shutdownEnterprisePlugin\s*\(\s*\)/,
    );
    const prismaDisconnectLine = lineNumberOfFirstMatch(
      seqLines,
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
  // Phase 202 (D-06): the shutdown body moved to services/shutdownSequence.ts —
  // the teardown-order pins read THAT source (the `await\s+` prefix convention
  // is preserved verbatim).
  const seqLines = readShutdownSequenceSource().split(/\r?\n/);
  // `await shutdownMCPConnections();` — the `await` prefix excludes comment
  // lines that mention the function name in prose.
  const shutdownMCPConnectionsLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+shutdownMCPConnections\s*\(\s*\)/,
  );
  const jobQueueStopLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+stopJobQueue\s*\(\s*\)/,
  );
  // `await shutdownEnterprisePlugin();` — the `await` prefix excludes the
  // comment that mentions the function name in prose.
  const shutdownEnterpriseLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+shutdownEnterprisePlugin\s*\(\s*\)/,
  );
  const prismaDisconnectLine = lineNumberOfFirstMatch(
    seqLines,
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

  test("stopJobQueue() call site is present in the gracefulShutdown body (shutdownSequence.ts — Phase 202 D-06 extraction)", () => {
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
  // Phase 202 (D-06): the stopJobQueue call site lives in the extracted
  // gracefulShutdown body (shutdownSequence.ts) — read that source.
  const jobQueueStopLine = lineNumberOfFirstMatch(
    readShutdownSequenceSource().split(/\r?\n/),
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

// Phase 195 (MCPO-01 D-12): the OAuth refresh scheduler is awaited in the
// production block AFTER initDlpBackfillScheduler() and BEFORE the
// initializeMCPConnections() fire-and-forget. Source-string assertion —
// fails the build if the insert position drifts (boot-order invariant).
describe("index.ts boot order — mcp-oauth-refresh scheduler (Phase 195, D-12)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const dlpBackfillLine = lineNumberOfFirstMatch(lines, /await\s+initDlpBackfillScheduler\s*\(\s*\)/);
  const oauthRefreshLine = lineNumberOfFirstMatch(lines, /await\s+initMCPOAuthRefreshScheduler\s*\(\s*\)/);
  const initializeMCPLine = lineNumberOfFirstMatch(lines, /initializeMCPConnections\s*\(\s*\)\s*\.catch/);
  const schedulerBlockLine = lineNumberOfFirstMatch(
    lines,
    /if\s*\(\s*env\.NODE_ENV\s*===\s*["']production["']\s*\)/,
  );

  test("initMCPOAuthRefreshScheduler is awaited (async pg-boss registration)", () => {
    expect(oauthRefreshLine).toBeGreaterThan(0);
  });

  test("initMCPOAuthRefreshScheduler runs AFTER initDlpBackfillScheduler (D-12 insert position)", () => {
    expect(dlpBackfillLine).toBeGreaterThan(0);
    expect(oauthRefreshLine).toBeGreaterThan(dlpBackfillLine);
  });

  test("initMCPOAuthRefreshScheduler runs BEFORE the initializeMCPConnections fire-and-forget", () => {
    expect(initializeMCPLine).toBeGreaterThan(0);
    expect(oauthRefreshLine).toBeLessThan(initializeMCPLine);
  });

  test("initMCPOAuthRefreshScheduler is inside the production-only scheduler block", () => {
    expect(schedulerBlockLine).toBeGreaterThan(0);
    expect(oauthRefreshLine).toBeGreaterThan(schedulerBlockLine);
  });
});

// Phase 200 (ECCO-06, D-09): the connector health-check scheduler is awaited
// in the production block immediately after initMCPOAuthRefreshScheduler().
// Source-string assertion — fails the build if the insert position drifts
// (boot-order invariant, same shape as the mcp-oauth-refresh pins above).
describe("index.ts boot order — connector-health scheduler (Phase 200, D-09)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const connectorHealthLine = lineNumberOfFirstMatch(lines, /await\s+initConnectorHealthCheckScheduler\s*\(\s*\)/);
  const oauthRefreshLine = lineNumberOfFirstMatch(lines, /await\s+initMCPOAuthRefreshScheduler\s*\(\s*\)/);
  const schedulerBlockLine = lineNumberOfFirstMatch(
    lines,
    /if\s*\(\s*env\.NODE_ENV\s*===\s*["']production["']\s*\)/,
  );

  test("initConnectorHealthCheckScheduler is awaited (async pg-boss registration)", () => {
    expect(connectorHealthLine).toBeGreaterThan(0);
  });

  test("initConnectorHealthCheckScheduler runs AFTER initMCPOAuthRefreshScheduler (D-09 insert position)", () => {
    expect(oauthRefreshLine).toBeGreaterThan(0);
    expect(connectorHealthLine).toBeGreaterThan(oauthRefreshLine);
  });

  test("initConnectorHealthCheckScheduler is inside the production-only scheduler block (mcpHealthCheck precedent)", () => {
    expect(schedulerBlockLine).toBeGreaterThan(0);
    expect(connectorHealthLine).toBeGreaterThan(schedulerBlockLine);
  });
});

// Phase 195 (MCPO-01 D-07/Pitfall 2): the PUBLIC OAuth callback router mounts
// at /api/mcp-connections BEFORE the admin-gated mcpRoutes — Express matches
// app.use in registration order, and mcpRoutes' router-level
// authMiddleware+tenant+requireAdmin would 401 the IdP browser redirect
// before any handler ran. Source-string assertion — fails the build if the
// mount order drifts.
describe("index.ts mount order — mcpOAuthCallbackRouter before mcpRoutes (Phase 195, D-07)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const callbackRouterLine = lineNumberOfFirstMatch(
    lines,
    /app\.use\s*\(\s*["']\/api\/mcp-connections["']\s*,\s*mcpOAuthCallbackRouter\s*\)/,
  );
  const adminRouterLine = lineNumberOfFirstMatch(
    lines,
    /app\.use\s*\(\s*["']\/api\/mcp-connections["']\s*,\s*mcpRoutes\s*\)/,
  );

  test("mcpOAuthCallbackRouter mount is present in createApp()", () => {
    expect(callbackRouterLine).toBeGreaterThan(0);
  });

  test("mcpOAuthCallbackRouter mounts BEFORE mcpRoutes (Pitfall 2)", () => {
    expect(adminRouterLine).toBeGreaterThan(0);
    expect(callbackRouterLine).toBeLessThan(adminRouterLine);
  });

  test("mcpOAuthCallbackRouter is imported in index.ts", () => {
    expect(
      lineNumberOfFirstMatch(lines, /import\s+mcpOAuthCallbackRouter\s+from\s+["']\.\/routes\/mcpOAuthCallback["']/)
    ).toBeGreaterThan(0);
  });
});

// Phase 186 (SAAS-05, D-10): SaaS plugin boot-order + reverse-teardown
// invariants. Source-string assertion — reads index.ts and asserts:
//   - await loadSaaSPlugin(app) appears AFTER loadEnterprisePlugin and
//     BEFORE mountCatchAlls (plugin routes registered before the catch-alls
//     — T-186-06: catch-alls stay LAST)
//   - await shutdownSaaSPlugin() appears BEFORE shutdownEnterprisePlugin()
//     (D-10 reverse load order) and both BEFORE prisma.$disconnect()
//   - the SaaS load stays BEFORE the production scheduler block (both
//     plugin loads precede it)
//   - probe edge (T-186-08, mechanism (b)): both plugin loads are DIRECT
//     awaited statements in the boot block (`await\s+` prefix convention) —
//     a register throw in loadSaaSPlugin exits the process BEFORE control
//     can continue on to the catch-all mount line (mechanism (a) — the
//     loader-core-level register-throw → __PROCESS_EXIT__ test — lives in
//     saasLoader.test.ts; the sequential-await structure here makes
//     "exit before mount" structural: an exit inside the awaited load can
//     never continue past it).
// Reuses the module-level readIndexTsSource() + lineNumberOfFirstMatch()
// helpers (defined above — do NOT redefine). Fails the build if the boot
// sequence is reordered and breaks the invariants.
describe("index.ts boot order — SaaS plugin (Phase 186, SAAS-05 D-10)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const enterpriseLine = lineNumberOfFirstMatch(
    lines,
    /await\s+loadEnterprisePlugin\s*\(\s*app\s*\)/,
  );
  const saasLine = lineNumberOfFirstMatch(
    lines,
    /await\s+loadSaaSPlugin\s*\(\s*app\s*\)/,
  );
  const catchAllsLine = lineNumberOfFirstMatch(
    lines,
    // Anchor at statement start: the call site is a bare statement (sync),
    // not awaited — a plain-name regex would first hit the createApp() doc
    // comment that mentions the call ("mounted by mountCatchAlls(app)").
    // The ^\s* prefix excludes `//` comment lines (Phase 165 convention).
    /^\s*mountCatchAlls\s*\(\s*app\s*\)/,
  );
  const schedulerBlockLine = lineNumberOfFirstMatch(
    lines,
    /if\s*\(\s*env\.NODE_ENV\s*===\s*["']production["']\s*\)/,
  );
  // Phase 202 (D-06): the shutdown body moved to shutdownSequence.ts — the
  // teardown pins read THAT source.
  const seqLines = readShutdownSequenceSource().split(/\r?\n/);
  const shutdownSaaSLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+shutdownSaaSPlugin\s*\(\s*\)/,
  );
  const shutdownEnterpriseLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+shutdownEnterprisePlugin\s*\(\s*\)/,
  );
  const prismaDisconnectLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+prisma\.\$disconnect\s*\(\s*\)/,
  );

  test("loadSaaSPlugin(app) is present as an awaited boot step", () => {
    expect(saasLine).toBeGreaterThan(0);
  });

  test("loadSaaSPlugin(app) runs AFTER loadEnterprisePlugin(app) (D-10)", () => {
    expect(enterpriseLine).toBeGreaterThan(0);
    expect(saasLine).toBeGreaterThan(enterpriseLine);
  });

  test("loadSaaSPlugin(app) runs BEFORE mountCatchAlls(app) (T-186-06 — catch-alls stay LAST)", () => {
    expect(catchAllsLine).toBeGreaterThan(0);
    expect(saasLine).toBeLessThan(catchAllsLine);
  });

  test("loadSaaSPlugin(app) runs BEFORE the NODE_ENV===production scheduler block (both plugin loads precede it)", () => {
    expect(schedulerBlockLine).toBeGreaterThan(0);
    expect(saasLine).toBeLessThan(schedulerBlockLine);
  });

  test("loadSaaSPlugin(app) is a direct awaited statement in the boot block (probe-edge mechanism (b) — T-186-08)", () => {
    // The await\s+ prefix proves the load is a sequential awaited step in
    // the boot block: an exit (process.exit(1) on register throw, proven at
    // loader-core level in saasLoader.test.ts) inside it cannot continue on
    // to the catch-all mount — no half-mounted route surface.
    expect(lines[saasLine - 1]).toMatch(/^\s*await\s+loadSaaSPlugin\s*\(\s*app\s*\)/);
  });

  test("shutdownSaaSPlugin is called in gracefulShutdown BEFORE shutdownEnterprisePlugin (D-10 reverse load order)", () => {
    expect(shutdownSaaSLine).toBeGreaterThan(0);
    expect(shutdownEnterpriseLine).toBeGreaterThan(0);
    expect(shutdownSaaSLine).toBeLessThan(shutdownEnterpriseLine);
  });

  test("both plugin shutdowns run BEFORE prisma.$disconnect (teardown can still hit the DB)", () => {
    expect(prismaDisconnectLine).toBeGreaterThan(0);
    expect(shutdownSaaSLine).toBeLessThan(prismaDisconnectLine);
    expect(shutdownEnterpriseLine).toBeLessThan(prismaDisconnectLine);
  });
});

// Phase 193 (LDAP-01, D-13): the community composite login route mounts
// AFTER both plugin loads and BEFORE mountCatchAlls — the defer-then-serve
// window. The enterprise LDAP route (mounted via the plugin loader) next()s
// fallback-eligible requests on this SAME /api/auth path; the composite
// router is the sole local-auth fallback arm. Source-string assertion —
// fails the build if the mount is reordered (before the plugins = enterprise
// requests would double-handle; after the catch-alls = deferred requests
// would 404 instead of falling back).
describe("index.ts boot order — authLdapComposite mount (Phase 193, D-13)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const enterpriseLine = lineNumberOfFirstMatch(
    lines,
    /await\s+loadEnterprisePlugin\s*\(\s*app\s*\)/,
  );
  const saasLine = lineNumberOfFirstMatch(
    lines,
    /await\s+loadSaaSPlugin\s*\(\s*app\s*\)/,
  );
  const compositeLine = lineNumberOfFirstMatch(
    lines,
    /app\.use\s*\(\s*["']\/api\/auth["']\s*,\s*createAuthLdapCompositeRouter\s*\(\s*\)\s*\)/,
  );
  const catchAllsLine = lineNumberOfFirstMatch(
    lines,
    /^\s*mountCatchAlls\s*\(\s*app\s*\)/,
  );

  test("createAuthLdapCompositeRouter mount is present in index.ts", () => {
    expect(compositeLine).toBeGreaterThan(0);
  });

  test("the composite mount runs AFTER loadEnterprisePlugin (defer receiver, not competitor)", () => {
    expect(enterpriseLine).toBeGreaterThan(0);
    expect(compositeLine).toBeGreaterThan(enterpriseLine);
  });

  test("the composite mount runs AFTER loadSaaSPlugin", () => {
    expect(saasLine).toBeGreaterThan(0);
    expect(compositeLine).toBeGreaterThan(saasLine);
  });

  test("the composite mount runs BEFORE mountCatchAlls (deferred requests must reach it, not the 404)", () => {
    expect(catchAllsLine).toBeGreaterThan(0);
    expect(compositeLine).toBeLessThan(catchAllsLine);
  });

  test("the composite router factory is imported in index.ts", () => {
    const importLine = lineNumberOfFirstMatch(
      lines,
      /import\s*\{[^}]*createAuthLdapCompositeRouter[^}]*\}\s*from\s*["']\.\/routes\/authLdapComposite["']/,
    );
    expect(importLine).toBeGreaterThan(0);
  });
});

// Phase 199 (199-03, D-05/Pitfall 5): the DISCORD boot-registry lesson —
// index.ts must side-effect-import BOTH the adapter (discord.ts, module-load
// registerAdapter) AND the gateway manager (discordGateway.ts), call
// initDiscordGateway() in the dev+prod scheduler cluster BESIDE
// initConnectorPollScheduler(), and closeDiscordGateway() FIRST in the
// graceful shutdown sequence BEFORE prisma.$disconnect(). Source-string
// assertion — fails the build if the wiring drifts (the 198-04 regression,
// discord edition).
describe("index.ts boot order — discord gateway (Phase 199, D-05/Pitfall 5)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);

  const telegramImportLine = lineNumberOfFirstMatch(
    lines,
    /import\s+["']\.\/services\/connectors\/telegram["']/,
  );
  const discordImportLine = lineNumberOfFirstMatch(
    lines,
    /import\s+["']\.\/services\/connectors\/discord["']/,
  );
  const gatewayImportLine = lineNumberOfFirstMatch(
    lines,
    /from\s+["']\.\/services\/connectors\/discordGateway["']/,
  );
  const pollInitLine = lineNumberOfFirstMatch(
    lines,
    /^\s*initConnectorPollScheduler\s*\(\s*\)/,
  );
  const discordInitLine = lineNumberOfFirstMatch(
    lines,
    /^\s*initDiscordGateway\s*\(\s*\)\s*\.catch/,
  );
  // Phase 202 (D-06): the shutdown body moved to shutdownSequence.ts — the
  // closeDiscordGateway teardown pin reads THAT source.
  const seqLines = readShutdownSequenceSource().split(/\r?\n/);
  const closeGatewayLine = lineNumberOfFirstMatch(
    seqLines,
    /closeDiscordGateway\s*\(\s*\)/,
  );
  const prismaDisconnectLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+prisma\.\$disconnect\s*\(\s*\)/,
  );

  test("both discord side-effect imports are present in index.ts", () => {
    expect(telegramImportLine).toBeGreaterThan(0);
    expect(discordImportLine).toBeGreaterThan(0);
    expect(gatewayImportLine).toBeGreaterThan(0);
  });

  test("initDiscordGateway() is called in the scheduler cluster BESIDE initConnectorPollScheduler()", () => {
    expect(pollInitLine).toBeGreaterThan(0);
    expect(discordInitLine).toBeGreaterThan(0);
    // Same cluster — the discord init immediately follows the poller init.
    expect(discordInitLine).toBeGreaterThan(pollInitLine);
    expect(discordInitLine - pollInitLine).toBeLessThanOrEqual(12);
  });

  test("initDiscordGateway is fire-and-forget with a logged catch (boot must not block)", () => {
    expect(discordInitLine).toBeGreaterThan(0);
    expect(lines[discordInitLine - 1]).toMatch(/\.catch/);
  });

  test("closeDiscordGateway is called in gracefulShutdown BEFORE prisma.$disconnect()", () => {
    expect(closeGatewayLine).toBeGreaterThan(0);
    expect(prismaDisconnectLine).toBeGreaterThan(0);
    expect(closeGatewayLine).toBeLessThan(prismaDisconnectLine);
  });
});
// Phase 202 (PLGM-02/03/04, D-09/D-06): the plugin-manager boot wiring pins.
// Source-string assertion (the established convention in this file):
//   - resolveInstanceLicenseFromDB() sits between initLicense() and the
//     enterprise plugin load (Pitfall 1 — additive async boot step)
//   - loadManagedPlugins(app) sits after loadSaaSPlugin(app), before
//     authLdapComposite AND mountCatchAlls (research Open Q 2 chain)
//   - gracefulShutdown lives ONLY in shutdownSequence.ts — index.ts imports
//     it and points BOTH signal handlers at it (D-06 single path)
//   - teardown order in shutdownSequence.ts: managed → SaaS → enterprise →
//     prisma.$disconnect (D-09)
//   - the storage/plugins boot block: idempotent mkdir + `.tmp-*` orphan
//     sweep (Edge E6)
describe("index.ts boot order — plugin manager (Phase 202, PLGM-02/03/04)", () => {
  const src = readIndexTsSource();
  const lines = src.split(/\r?\n/);
  const seqSrc = readShutdownSequenceSource();
  const seqLines = seqSrc.split(/\r?\n/);

  const initLicenseLine = lineNumberOfFirstMatch(lines, /initLicense\s*\(\s*\)/);
  const resolveInstanceLicenseLine = lineNumberOfFirstMatch(
    lines,
    /await\s+resolveInstanceLicenseFromDB\s*\(\s*\)/,
  );
  const enterpriseLine = lineNumberOfFirstMatch(
    lines,
    /loadEnterprisePlugin\s*\(\s*app\s*\)/,
  );
  const saasLine = lineNumberOfFirstMatch(lines, /await\s+loadSaaSPlugin\s*\(\s*app\s*\)/);
  const managedLine = lineNumberOfFirstMatch(lines, /await\s+loadManagedPlugins\s*\(\s*app\s*\)/);
  // Anchor at statement start (Phase 165 convention) — excludes comment lines
  // that mention the router in prose.
  const ldapCompositeLine = lineNumberOfFirstMatch(
    lines,
    /^\s*app\.use\("\/api\/auth",\s*createAuthLdapCompositeRouter\s*\(\s*\)\s*\)/,
  );
  const catchAllsLine = lineNumberOfFirstMatch(
    lines,
    /^\s*mountCatchAlls\s*\(\s*app\s*\)/,
  );

  const managedShutdownLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+shutdownManagedPlugins\s*\(\s*\)/,
  );
  const seqSaasLine = lineNumberOfFirstMatch(seqLines, /await\s+shutdownSaaSPlugin\s*\(\s*\)/);
  const seqEnterpriseLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+shutdownEnterprisePlugin\s*\(\s*\)/,
  );
  const seqDisconnectLine = lineNumberOfFirstMatch(
    seqLines,
    /await\s+prisma\.\$disconnect\s*\(\s*\)/,
  );

  test("resolveInstanceLicenseFromDB() is an awaited boot step (Pitfall 1 — additive async step)", () => {
    expect(resolveInstanceLicenseLine).toBeGreaterThan(0);
    expect(lines[resolveInstanceLicenseLine - 1]).toMatch(
      /^\s*await\s+resolveInstanceLicenseFromDB\s*\(\s*\)/,
    );
  });

  test("resolveInstanceLicenseFromDB() runs AFTER initLicense() and BEFORE the enterprise plugin load (D-07)", () => {
    expect(initLicenseLine).toBeGreaterThan(0);
    expect(enterpriseLine).toBeGreaterThan(0);
    expect(resolveInstanceLicenseLine).toBeGreaterThan(initLicenseLine);
    expect(resolveInstanceLicenseLine).toBeLessThan(enterpriseLine);
  });

  test("loadManagedPlugins(app) is an awaited boot step", () => {
    expect(managedLine).toBeGreaterThan(0);
    expect(lines[managedLine - 1]).toMatch(/^\s*await\s+loadManagedPlugins\s*\(\s*app\s*\)/);
  });

  test("loadManagedPlugins(app) runs AFTER loadSaaSPlugin(app) (D-09 chain)", () => {
    expect(saasLine).toBeGreaterThan(0);
    expect(managedLine).toBeGreaterThan(saasLine);
  });

  test("loadManagedPlugins(app) runs BEFORE authLdapComposite AND mountCatchAlls (research Open Q 2 chain)", () => {
    expect(ldapCompositeLine).toBeGreaterThan(0);
    expect(catchAllsLine).toBeGreaterThan(0);
    expect(managedLine).toBeLessThan(ldapCompositeLine);
    expect(managedLine).toBeLessThan(catchAllsLine);
  });

  test("gracefulShutdown is NO LONGER inline in index.ts (D-06 extraction complete)", () => {
    expect(src).not.toMatch(/const\s+gracefulShutdown\s*=/);
  });

  test("index.ts imports gracefulShutdown from shutdownSequence and points BOTH signal handlers at it (D-06 single path)", () => {
    expect(src).toMatch(/from\s+["']\.\/services\/shutdownSequence["']/);
    expect(src).toMatch(/gracefulShutdown\s*\(\s*["']SIGTERM["']\s*\)/);
    expect(src).toMatch(/gracefulShutdown\s*\(\s*["']SIGINT["']\s*\)/);
  });

  test("shutdownSequence.ts teardown order: managed → SaaS → enterprise → prisma.$disconnect (D-09)", () => {
    expect(managedShutdownLine).toBeGreaterThan(0);
    expect(seqSaasLine).toBeGreaterThan(0);
    expect(seqEnterpriseLine).toBeGreaterThan(0);
    expect(seqDisconnectLine).toBeGreaterThan(0);
    expect(managedShutdownLine).toBeLessThan(seqSaasLine);
    expect(seqSaasLine).toBeLessThan(seqEnterpriseLine);
    expect(seqEnterpriseLine).toBeLessThan(seqDisconnectLine);
  });

  test("storage/plugins boot block: idempotent mkdir + .tmp-* orphan sweep present (Edge E6)", () => {
    expect(src).toMatch(/fs\.mkdirSync\(PLUGINS_STORAGE_DIR,\s*\{\s*recursive:\s*true\s*\}\)/);
    expect(src).toMatch(/\.tmp-/);
    expect(src).toMatch(/rmSync/);
  });
});

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * pluginShutdown.integration.test.ts — SC-3 graceful shutdown on SIGTERM.
 *
 * Phase 146 (EPA-06) Plan 01 originally booted the server as a subprocess
 * with `GSD_TEST_MOCK_PLUGIN=1` (an env-var seam in production code).
 * Phase 180 (PUB-02) removed that seam: the subprocess is now spawned as
 * `npx tsx -r <bootstrap> <server entry>` where the bootstrap fixture
 * (`__tests__/fixtures/enterpriseMockBootstrap.ts`) overrides the loader's
 * `__pluginResolver` INSIDE the child before index.ts boots — the same
 * two-step seam the in-process jest tests inject through, no production
 * env-var read required. (NODE_PATH was rejected: the parent node_modules
 * chain wins over NODE_PATH, so the real link dep shadows the fixture on
 * any machine with the private sibling checked out.)
 *
 * The test sends SIGTERM and asserts:
 *   - the process exits in <10s (race against a 10s timeout)
 *   - no `.backup.tmp` files remain in the temp dir (the onShutdown
 *     callback ran and cleaned up)
 *   - no `PrismaClientInitializationError` in stderr (the shutdown
 *     sequence completed before prisma was torn down)
 *
 * Uses real Postgres (`.integration.test.ts` — `.env.test` has
 * `localhost:5434`). Jest timeout 30000ms (10s shutdown + boot).
 *
 * Phase 146 (EPA-06) — Plan 01 (D-04, D-05, SC-3); Phase 180 PUB-02.
 */
// @ts-nocheck — test file; AGENTS.md permits @ts-nocheck in __tests__/.

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

describe("SC-3: graceful shutdown on SIGTERM (Phase 146 D-04/D-05, Phase 180 PUB-02)", () => {
  it("exits <10s with no .backup.tmp files + no PrismaClientInitializationError", async () => {
    const tmpBackupDir = mkdtempSync(join(tmpdir(), "backup-shutdown-"));
    const serverPath = resolve(__dirname, "../index.ts");
    const bootstrapPath = resolve(__dirname, "fixtures/enterpriseMockBootstrap.ts");

    const child = spawn("npx", ["tsx", "-r", bootstrapPath, serverPath], {
      env: {
        ...process.env,
        // The mock plugin's onShutdown callback writes+deletes here.
        BACKUP_TMP_DIR: tmpBackupDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));

    // Wait for the server to boot (listen for the "Listening on port" log).
    await new Promise<void>((bootResolve, bootReject) => {
      const bootTimeout = setTimeout(() => {
        bootReject(new Error("server did not boot within 30s"));
      }, 30000);
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        if (text.includes("Listening on port")) {
          clearTimeout(bootTimeout);
          bootResolve();
        }
      });
      child.on("error", (err) => {
        clearTimeout(bootTimeout);
        bootReject(err);
      });
      child.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(bootTimeout);
          bootReject(new Error(`server exited before boot with code ${code}`));
        }
      });
    });

    // Send SIGTERM.
    process.kill(child.pid!, "SIGTERM");

    // Assert exit <10s (race against a 10s timeout).
    const exitPromise = new Promise<number>((exitResolve) =>
      child.on("exit", (code) => exitResolve(code ?? 0)),
    );
    const timeout = new Promise<number>((timeoutResolve) =>
      setTimeout(() => timeoutResolve(-1), 10000),
    );
    const exitCode = await Promise.race([exitPromise, timeout]);
    expect(exitCode).not.toBe(-1); // -1 = timeout

    // Assert no .backup.tmp files remain.
    if (existsSync(tmpBackupDir)) {
      const tmpFiles = readdirSync(tmpBackupDir).filter((f) =>
        f.endsWith(".backup.tmp"),
      );
      expect(tmpFiles).toEqual([]);
    }

    // Assert no PrismaClientInitializationError in stderr.
    const stderr = stderrChunks.join("");
    expect(stderr).not.toContain("PrismaClientInitializationError");

    // Cleanup the temp dir.
    try {
      rmSync(tmpBackupDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }, 30000); // 30s jest timeout (10s shutdown + boot)
});
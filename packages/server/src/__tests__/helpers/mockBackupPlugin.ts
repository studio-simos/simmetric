// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * mockBackupPlugin.ts — mock enterprise plugin for the pluginShutdown
 * integration test (SC-3, D-04, D-05).
 *
 * Phase 146 (EPA-06) Plan 01: this mock is loaded by the community
 * `enterpriseLoader.ts` `__pluginResolver.resolve` when the
 * `GSD_TEST_MOCK_PLUGIN=1` env var is set (Layer 3 — Open Question 4). It
 * registers a scheduler + an onShutdown callback that creates a `.backup.tmp`
 * file then deletes it (proving the callback runs during graceful shutdown).
 * The test (`pluginShutdown.integration.test.ts`) spawns the server as a
 * subprocess with this env var, sends SIGTERM, and asserts the process exits
 * in <10s with no `.backup.tmp` files left behind.
 *
 * The mock is a community test helper (NOT the real enterprise package) —
 * it exists ONLY to prove the shutdown SEQUENCE works, not the
 * backup-specific teardown.
 *
 * Phase 146 (EPA-06) — Plan 01
 */

const mockBackupPlugin = {
  apiVersion: 1,
  register(ctx: {
    registerScheduler: (name: string, scheduler: { start: () => void; stop: () => void | Promise<void> }) => void;
    onShutdown: (fn: () => void | Promise<void>) => void;
  }): void {
    ctx.registerScheduler("backup", {
      start: async () => {
        // no-op — the mock scheduler does nothing at boot.
      },
      stop: async () => {
        // simulate cleanup — a real scheduler.stop() would stop Bree workers.
      },
    });
    ctx.onShutdown(async () => {
      // Simulate the backup tmp cleanup callback (D-01). Creates a
      // `.backup.tmp` file then deletes it — proving the onShutdown callback
      // runs during graceful shutdown. The test asserts no `.backup.tmp`
      // files remain after the process exits.
      const fs = require("fs");
      const p = require("path");
      const dir = process.env.BACKUP_TMP_DIR;
      if (dir && fs.existsSync(dir)) {
        const f = p.join(dir, "test.backup.tmp");
        fs.writeFileSync(f, "test");
        fs.unlinkSync(f);
      }
    });
  },
};

module.exports = mockBackupPlugin;
module.exports.default = mockBackupPlugin;
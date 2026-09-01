// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * enterpriseMockPlugin.cjs — the loadable mock enterprise plugin for the
 * pluginShutdown integration test (Phase 180 PUB-02).
 *
 * Loaded by the `tsx -r` bootstrap (enterpriseMockBootstrap.ts) via the
 * loader's `__pluginResolver.load` seam. Plain CJS on purpose: `require`d
 * inside the child process without a further transform step.
 *
 * Same contract as the old `__tests__/helpers/mockBackupPlugin.ts`
 * (which this fixture replaces): registers a scheduler + an onShutdown
 * callback that creates then deletes a `.backup.tmp` file, proving the
 * shutdown SEQUENCE works (SC-3, D-04, D-05) — not the backup-specific
 * teardown.
 */

const mockBackupPlugin = {
  apiVersion: 1,
  register(ctx) {
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
      // `.backup.tmp` file then deletes it — proving the onShutdown
      // callback runs during graceful shutdown. The test asserts no
      // `.backup.tmp` files remain after the process exits.
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
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * enterpriseMockBootstrap.ts — `tsx -r` bootstrap for the pluginShutdown
 * integration test (Phase 180 PUB-02; replaces the GSD_TEST_MOCK_PLUGIN
 * env-var seam from Phase 146).
 *
 * Spawned as `npx tsx -r <this file> <server entry>`: Node requires this
 * module BEFORE the server entry boots, INSIDE the child process. It
 * overrides the loader's `__pluginResolver` seam (the same internal export
 * the in-process jest tests inject through) so the subprocess loads the
 * community mock plugin instead of resolving the real enterprise package.
 *
 * Why not NODE_PATH (the research Option A): CJS resolution walks the
 * parent node_modules chain BEFORE NODE_PATH, so on any machine with the
 * private sibling repo checked out (`packages/server/node_modules/
 * @simmetric-chat/enterprise` → link target exists) the REAL package wins
 * and the fixture is never reached. The `tsx -r` override works identically
 * with and without the sibling present (verified on this tree).
 *
 * Why not the env var (Phase 146's GSD_TEST_MOCK_PLUGIN): it required a
 * production-code read of a test-only env var — the seam PUB-02 removes.
 *
 * The mock plugin behavior is identical to the old
 * `__tests__/helpers/mockBackupPlugin.ts` (which this fixture replaces):
 * registers a scheduler + an onShutdown callback that creates then deletes
 * a `.backup.tmp` file, proving the shutdown SEQUENCE runs (SC-3).
 */

const path = require("path");

const loaderPath = path.resolve(__dirname, "../../services/enterpriseLoader");
const { __pluginResolver } = require(loaderPath);

const mockPlugin = {
  apiVersion: 1,
  register(ctx: {
    registerScheduler: (
      name: string,
      scheduler: { start: () => void; stop: () => void | Promise<void> },
    ) => void;
    onShutdown: (fn: () => void | Promise<void>) => void;
  }): void {
    ctx.registerScheduler("backup", {
      start: async () => {
        /* no-op — the mock scheduler does nothing at boot. */
      },
      stop: async () => {
        /* simulate cleanup — a real scheduler.stop() would stop Bree workers. */
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

// Same two-step contract as production (D-05): resolve → load.
__pluginResolver.resolve = (_specifier: string): string =>
  path.resolve(__dirname, "./enterpriseMockPlugin.cjs");
__pluginResolver.load = (modulePath: string): unknown => require(modulePath);

// The loadable plugin artifact (plain CJS so `require` in the child works
// without a further transform step): written as a sibling fixture file —
// see enterpriseMockPlugin.cjs. This module only wires the resolver.
export { mockPlugin };
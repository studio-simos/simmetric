// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Manual CommonJS mock for pg-boss (Phase 164, SCALE-04).
//
// pg-boss v12.28.0 ships as pure ESM (`"type": "module"`, `import EventEmitter
// from 'node:events'`), which throws `SyntaxError: Cannot use import statement
// outside a module` under the server's @swc/jest CommonJS transform when a test
// transitively loads `src/index.ts` (which statically imports
// `./services/jobQueue` → `pg-boss`). Adding pg-boss to `transformIgnorePatterns`
// would require also allowlisting its many transitive ESM deps (cron-parser,
// serialize-error, etc.) — fragile. A manual mock is the established pattern in
// this repo (see __mocks__/puppeteer.ts for the same ESM-in-CJS issue).
//
// This stub satisfies the surface `jobQueue.ts` touches: the `PgBoss` named
// export with a constructor whose instances expose start/stop/on/schedule/
// createQueue. The dedicated unit tests in `jobQueue.test.ts` use their own
// `jest.mock("pg-boss", ...)` factory (per-test control of start/stop behavior);
// this manual mock only exists so that test suites which transitively load
// index.ts (settings.test.ts, etc.) don't crash on the ESM import. Those suites
// never call start/stop — they mock prisma and routes at a higher level.

class PgBossStub {
  start = jest.fn().mockResolvedValue(undefined);
  stop = jest.fn().mockResolvedValue(undefined);
  on = jest.fn();
  schedule = jest.fn().mockResolvedValue(undefined);
  createQueue = jest.fn().mockResolvedValue(undefined);
  // Phase 165 (Pitfall 6): transitive-load test suites that boot index.ts call
  // boss.work() at scheduler registration. Without this stub those suites crash
  // with "boss.work is not a function". Returns a placeholder worker id.
  work = jest.fn().mockResolvedValue("worker-id");
}

module.exports = { PgBoss: PgBossStub };
module.exports.PgBoss = PgBossStub;
module.exports.__esModule = true;
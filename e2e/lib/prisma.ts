/**
 * E2E shared Prisma helper — Prisma 7 driver-adapter pattern.
 *
 * Source of truth: `packages/server/src/utils/prisma.ts` (server runtime init).
 * This helper replicates the SAME driver-adapter pattern (`PrismaPg` + `Pool`)
 * for the E2E test context. Replication is mandatory because:
 *
 *  - Prisma 7.x REJECTS the constructor datasource-url option (Prisma 5/6 era).
 *    Passing `{ db: { url } }` inside the PrismaClient constructor throws.
 *  - Prisma 7.x no-arg PrismaClient init does NOT pick up DATABASE_URL from
 *    the env automatically — a driver adapter (`PrismaPg` over a `pg.Pool`)
 *    is required to establish the connection.
 *
 * See `.planning/phases/66-e2e-playwright/66-HUMAN-UAT.md` GAP-01 for the live
 * UAT failure that surfaced this anti-pattern in widget-embed.spec.ts:79 and
 * synthesis-run.spec.ts:72 (and the latent fallback at globalSetup.ts:75).
 *
 * Modules are resolved from `packages/server/node_modules` via `createRequire`
 * because pnpm strict isolation does NOT hoist `@prisma/client`,
 * `@prisma/adapter-pg`, or `pg` into the root `node_modules`. The root worktree
 * node_modules only contains dev tools (Playwright, ts-jest, etc.).
 *
 * Security (T-66-DB-LEAK mitigation): this helper MUST NOT log DATABASE_URL.
 * The connection string stays in the gitignored root `.env`.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

/**
 * Build a PrismaClient connected to `databaseUrl` using the Prisma 7
 * driver-adapter pattern (PrismaPg over a pg.Pool). Returns a standard
 * `PrismaClient` instance — same API as the server's singleton, so callers
 * can `await prisma.$disconnect()` in their `finally` blocks as usual.
 *
 * @param databaseUrl PostgreSQL connection string (from the root `.env`
 *   or `process.env.DATABASE_URL`). MUST be defined — the helper throws
 *   synchronously with a clear message if undefined, rather than letting
 *   Prisma crash with a cryptic error later.
 */
export function makeE2ePrisma(databaseUrl: string): PrismaClient {
  if (!databaseUrl || typeof databaseUrl !== "string") {
    throw new Error(
      "makeE2ePrisma: databaseUrl is required (Prisma 7 driver-adapter " +
        "does not fall back to env — pass an explicit connection string)"
    );
  }
  const requireFromServer = createRequire(path.resolve("packages/server"));
  const { PrismaClient } = requireFromServer("@prisma/client") as typeof import("@prisma/client");
  const { PrismaPg } = requireFromServer("@prisma/adapter-pg") as typeof import("@prisma/adapter-pg");
  const { Pool } = requireFromServer("pg") as typeof import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}
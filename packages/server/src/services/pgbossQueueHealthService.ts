// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// pg-boss queue-table health guard (debug session pgboss-queue-pkey-duplicate).
//
// ROOT CAUSE (2026-09-16): pgboss.queue_pkey (PRIMARY KEY on queue.name) suffered
// index/heap divergence — every btree entry pointed at dead heap tuples while the
// index was still marked valid. With no live index entries, pg-boss's
// `create_queue` (INSERT ... ON CONFLICT DO NOTHING) missed conflicts and restart
// waves on 2026-09-08 inserted duplicate queue rows. From then on every
// monitor/queue-cache UPDATE (trySetQueueMonitorTime, cacheQueueStats) matched
// multiple rows with the same name and self-conflicted:
//   duplicate key value violates unique constraint "queue_pkey"
// — surfacing as `[jobQueue] pg-boss error` warns on every monitor cycle and
// aborting pg-boss's monitor/maintenance passes (job expiry + cleanup skipped).
//
// Self-heal strategy (idempotent, run once per boot BEFORE any pg-boss work):
//   1. SELECT duplicates in pgboss.queue (name groups with count > 1). A healthy
//      table returns none — the check is a single cheap aggregate on a ≤tens-of-
//      rows table.
//   2. Duplicate set found → repair transaction:
//      - `SET session_replication_role = replica` disables FK triggers (the
//        ON DELETE RESTRICT triggers on pgboss.job_common are NOT deferrable and
//        fire immediately on any queue-row delete, because job rows reference the
//        queue by NAME — a name the surviving row keeps).
//      - DELETE the duplicated names entirely (identical column values — they are
//        re-executions of the same create_queue call; created_on of the newest
//        generation is restored on re-create).
//      - restore `session_replication_role = DEFAULT` (trigger-disabling window is
//        transaction-scoped; pgboss.schedule rows survive because cascades are also
//        trigger-driven and stay disabled — they re-satisfy the FK once the
//        re-created queue row exists).
//      - re-create each deleted queue via pgboss.create_queue(name, policy) —
//        the SAME function pg-boss's Manager.createQueue() calls, so the row is
//        byte-identical to what pg-boss would have written (standard policy,
//        QUEUE_DEFAULTS).
//   3. REINDEX INDEX pgboss.queue_pkey — rebuilds the btree against the live heap,
//      removing every dead entry (the actual corruption). Runs AFTER dedup because
//      REINDEX of a unique index fails while duplicates remain (verified live).
//
// Why the guard lives at boot: the corruption's origin (torn crash between table
// and index WAL flush / container kill) is outside the app's control and cannot
// be prevented from TypeScript. What we CAN do is detect the surviving damage at
// every boot and self-heal before the schedulers register — the server restarts
// far more often than the corruption recurs, so a healthy boot is a no-op
// (single aggregate query) and a corrupted boot repairs itself without operator
// intervention.
//
// Degradation contract (mirrors D-05 in jobQueue.ts): any failure here logs at
// warn and continues boot — the queue is a scale feature, not boot-critical.

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

// Single schema name: pg-boss uses its DEFAULT schema (D-02, jobQueue.ts) — no
// custom name is passed anywhere in this codebase, and the guard only needs to
// cover the schema the server itself created.
const PGBROSS_SCHEMA = "pgboss";

const DUPLICATE_CHECK_SQL = `
  SELECT name, count(*)::int AS dup_count
  FROM ${PGBROSS_SCHEMA}.queue
  GROUP BY name
  HAVING count(*) > 1
`;

/**
 * Detect duplicate rows in pgboss.queue and heal when found.
 *
 * Returns `true` when a repair was applied (dedup + reindex + queue re-create),
 * `false` when the table was already healthy. Throws nothing — callers may
 * fire-and-forget; failures are logged at warn and leave the existing state.
 */
export async function healPgbossQueueDuplicates(): Promise<boolean> {
  let duplicates: Array<{ name: string; dup_count: number }>;
  try {
    duplicates = await prisma.$queryRawUnsafe<Array<{ name: string; dup_count: number }>>(
      DUPLICATE_CHECK_SQL,
    );
  } catch (err: unknown) {
    // pgboss schema may not exist yet (first boot, D-05 degradation) — silent no-op.
    logger.debug("[pgbossHealth] queue duplicate check skipped", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (!duplicates.length) {
    return false;
  }

  const dupNames = duplicates.map((d) => d.name);
  logger.warn("[pgbossHealth] duplicate pgboss.queue rows detected — self-healing", {
    duplicates: JSON.stringify(duplicates),
  });

  try {
    // Repair transaction. job_common's RESTRICT triggers are non-deferrable and
    // every queue name is referenced from job_common, so FK triggers must be
    // disabled for the delete window (session_replication_role = replica does
    // exactly that, transaction-scoped by the surrounding BEGIN/COMMIT).
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET session_replication_role = replica`,
      ),
      prisma.$executeRawUnsafe(
        `DELETE FROM ${PGBROSS_SCHEMA}.queue WHERE name = ANY($1::text[])`,
        // Prisma parameterizes $executeRawUnsafe via tagged templates only — for
        // the unsafe variant parameters are passed as varargs ($1, $2, ...).
        dupNames,
      ),
      prisma.$executeRawUnsafe(
        `SET session_replication_role = DEFAULT`,
      ),
    ]);

    // Re-create the queues through pg-boss's own create_queue function with the
    // standard policy (what Manager.createQueue() writes by default).
    for (const name of dupNames) {
      await prisma.$executeRawUnsafe(
        `SELECT ${PGBROSS_SCHEMA}.create_queue($1::text, '{"policy":"standard"}'::jsonb)`,
        name,
      );
    }

    // Rebuild the corrupt unique index. With duplicates gone this succeeds; if
    // anything re-duplicated in between, the REINDEX failure is logged loudly and
    // boot continues (the monitor cycle would error again — visible, not silent).
    await prisma.$executeRawUnsafe(`REINDEX INDEX ${PGBROSS_SCHEMA}.queue_pkey`);

    logger.info("[pgbossHealth] pgboss.queue repaired (dedup + reindex)", {
      healed: dupNames,
    });
    return true;
  } catch (err: unknown) {
    logger.error(
      "[pgbossHealth] pgboss.queue self-heal failed — manual REINDEX + dedup required",
      {
        error: err instanceof Error ? err.message : String(err),
        duplicates: dupNames,
      },
    );
    return false;
  }
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Prisma } from "@prisma/client";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "./eventLogService";

const ACCUMULATION_WINDOW_MS = 10 * 60 * 1000; // 10 minutes (D-04)
const COOLDOWN_DURATION_MS = 60 * 60 * 1000;   // 1 hour (D-03)

/**
 * D-11: typed $queryRaw row for the PENDING→PROCESSING claim query.
 * Field names match the SELECT aliases exactly (camelCase preserved by
 * Postgres quoted identifiers, Pitfall 3): `claimed."archiveId"` and
 * `claimed."createdBy"` project as `archiveId`/`createdBy` (NOT
 * `archive_id`/`created_by`).
 */
interface TriggerRow {
  id: string;
  archiveId: string;
  createdBy: string;
}

/**
 * Fire-and-forget trigger called when an OCR/URL job reaches COMPLETED status.
 *
 * - If a PENDING SynthesisRun was created within the last 10 minutes, update
 *   the existing run's previewJson to accumulate new source content metadata,
 *   and reset its createdAt to now (extending the accumulation window).
 * - If the most recent non-PENDING SynthesisRun was created less than 1 hour
 *   ago, skip with a cooldown log.
 * - Otherwise, create a new PENDING SynthesisRun.
 *
 * This function is wrapped in try/catch and must never throw.
 */
export async function onOcrJobCompleted(
  jobId: string,
  archiveId: string,
): Promise<void> {
  try {
    // Fetch the OCR job to get the creator's userId
    const ocrJob = await prisma.ocrJob.findUnique({
      where: { id: jobId },
      select: { createdBy: true, sourceFileName: true, result: true },
    });

    if (!ocrJob) {
      logger.warn(
        `[synthesis] onOcrJobCompleted: OCR job ${jobId} not found, skipping trigger`,
      );
      return;
    }

    const userId = ocrJob.createdBy;

    // Check for a recent PENDING run for accumulation (D-04 idle timer)
    const recentPendingRun = await prisma.synthesisRun.findFirst({
      where: {
        archiveId,
        status: "PENDING",
        createdAt: {
          gte: new Date(Date.now() - ACCUMULATION_WINDOW_MS),
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (recentPendingRun) {
      // Accumulate: update the existing PENDING run's previewJson
      const existingPreview: Record<string, unknown> =
        (recentPendingRun.previewJson as Record<string, unknown>) || {};
      const accumulatedSources: Array<Record<string, unknown>> =
        (existingPreview["accumulatedSources"] as Array<Record<string, unknown>>) || [];

      accumulatedSources.push({
        jobId,
        sourceFileName: ocrJob.sourceFileName || "unknown",
        addedAt: new Date().toISOString(),
      });

      existingPreview["accumulatedSources"] = accumulatedSources;

      await prisma.synthesisRun.update({
        where: { id: recentPendingRun.id },
        data: {
          previewJson: existingPreview as Prisma.InputJsonValue,
          createdAt: new Date(), // Reset accumulation window
        },
      });

      logger.info(
        `[synthesis] Accumulated source into existing PENDING run ${recentPendingRun.id} for archive ${archiveId}`,
      );
      return;
    }

    // Check cooldown: most recent non-PENDING run within last hour
    const cooldownActive = await isCooldownActive(archiveId);
    if (cooldownActive) {
      logger.info(
        `[synthesis] Cooldown active, skipping trigger for archive ${archiveId}`,
      );
      return;
    }

    // Create a new PENDING SynthesisRun
    const newRun = await prisma.synthesisRun.create({
      data: {
        archiveId,
        status: "PENDING",
        createdBy: userId,
        previewJson: {
          accumulatedSources: [
            {
              jobId,
              sourceFileName: ocrJob.sourceFileName || "unknown",
              addedAt: new Date().toISOString(),
            },
          ],
        },
      },
    });

    logger.info(
      `[synthesis] Created new PENDING SynthesisRun ${newRun.id} for archive ${archiveId}`,
    );

    // Log the event (fire-and-forget)
    logEvent("synthesis_run", newRun.id, "synthesis.triggered", userId, {
      archiveId,
      jobId,
    }).catch((err) =>
      logger.error("[synthesis] Failed to log synthesis.triggered event", {
        error: err.message,
      }),
    );
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] onOcrJobCompleted failed", {
      error: message,
      jobId,
      archiveId,
    });
  }
}

/**
 * Called by the Bree scheduler every 10 seconds (D-03).
 * Atomically transitions the oldest PENDING SynthesisRun to PROCESSING.
 *
 * Returns the synthesisRunId and archiveId if a job was claimed, or null if
 * no PENDING runs exist.
 */
export async function getNextSynthesisJob(): Promise<{
  synthesisRunId: string;
  archiveId: string;
  createdBy: string;
} | null> {
  try {
    // Atomically claim a PENDING job with SELECT ... FOR UPDATE SKIP LOCKED
    // to prevent TOCTOU races between concurrent Bree instances or workers.
    // D-14: set expiresAt = NOW() + INTERVAL '2 hours' on claim so the
    // in-process reaper can flip orphaned PROCESSING rows (crash recovery)
    // to FAILED with "Aborted: orphaned PROCESSING (reaper)".
    const result: Array<TriggerRow> = await prisma.$queryRaw<Array<TriggerRow>>`
      WITH claimed AS (
        SELECT id, "archiveId", "createdBy"
        FROM synthesis_runs
        WHERE status = 'PENDING'
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE synthesis_runs
      SET status = 'PROCESSING', "expiresAt" = NOW() + INTERVAL '2 hours'
      FROM claimed
      WHERE synthesis_runs.id = claimed.id
      RETURNING claimed.id, claimed."archiveId", claimed."createdBy"
    `;

    if (result.length === 0) {
      return null;
    }

    const row = result[0];
    if (!row) {
      return null;
    }

    logger.info(
      `[synthesis] Claimed SynthesisRun ${row.id} for archive ${row.archiveId} (PENDING -> PROCESSING)`,
    );

    return {
      synthesisRunId: row.id,
      archiveId: row.archiveId,
      createdBy: row.createdBy,
    };
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] getNextSynthesisJob failed", {
      error: message,
    });
    return null;
  }
}

/**
 * Returns the count of PENDING SynthesisRun records.
 * If archiveId is provided, filters by archive.
 * Used by the frontend badge polling.
 */
export async function getPendingSynthesisCount(
  archiveId?: string,
): Promise<number> {
  try {
    const where: Record<string, unknown> = { status: "PENDING" };
    if (archiveId) {
      where.archiveId = archiveId;
    }
    return await prisma.synthesisRun.count({ where });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] getPendingSynthesisCount failed", {
      error: message,
      archiveId,
    });
    return 0;
  }
}

/**
 * Returns true if the most recent SynthesisRun (any status except PENDING)
 * was created less than 1 hour ago (D-03 cooldown check).
 */
export async function isCooldownActive(archiveId: string): Promise<boolean> {
  try {
    const mostRecent = await prisma.synthesisRun.findFirst({
      where: {
        archiveId,
        status: { not: "PENDING" },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    if (!mostRecent) {
      return false;
    }

    const elapsed = Date.now() - mostRecent.createdAt.getTime();
    return elapsed < COOLDOWN_DURATION_MS;
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] isCooldownActive failed", {
      error: message,
      archiveId,
    });
    // Fail-closed: assume cooldown is active to prevent rapid re-triggering
    return true;
  }
}

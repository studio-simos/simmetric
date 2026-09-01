// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { checkCollectorHealth } from "../services/hybridSearchService";

const router = Router();

// GET / — Root uptime endpoint.
router.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// GET /api/health — Main health check: DB, collector, disk.
router.get("/api/health", async (_req: Request, res: Response) => {
  const start = Date.now();

  const [dbResult, collectorResult, diskResult] = await Promise.allSettled([
    // Database check — lightweight SELECT 1
    (async () => {
      try {
        await prisma.$queryRawUnsafe("SELECT 1");
        return { ok: true };
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    })(),

    // Collector check — reuse existing checkCollectorHealth
    (async () => {
      try {
        const result = await checkCollectorHealth();
        if (result.reachable) return { ok: true };
        return { ok: false, error: result.error || "Collector unreachable" };
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    })(),

    // Disk check — statfsSync (fast kernel call, synchronous is fine here)
    (() => {
      try {
        const stats = fs.statfsSync("/");
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        const percentFree = total > 0 ? Math.round((free / total) * 100) : 0;
        return {
          ok: true,
          total,
          free,
          percentFree,
        };
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    })(),
  ]);

  const db = dbResult.status === "fulfilled" ? dbResult.value : { ok: false, error: "DB check threw an unhandled exception" };
  const collector = collectorResult.status === "fulfilled" ? collectorResult.value : { ok: false, error: "Collector check threw an unhandled exception" };
  const disk = diskResult.status === "fulfilled" ? diskResult.value : { ok: false, error: "Disk check threw an unhandled exception" };

  const allOk = db.ok && collector.ok && disk.ok;
  const status = allOk ? "ok" : "degraded";

  const details: Array<{ check: string; error: string }> = [];
  if (!db.ok) details.push({ check: "database", error: db.error || "Unknown database error" });
  if (!collector.ok) details.push({ check: "collector", error: collector.error || "Unknown collector error" });
  if (!disk.ok) details.push({ check: "disk", error: disk.error || "Unknown disk error" });

  const response: Record<string, unknown> = {
    status,
    timestamp: new Date().toISOString(),
    checks: {
      database: db.ok,
      collector: collector.ok,
      disk: {
        ok: disk.ok,
        total: disk.ok ? (disk.total ?? 0) : 0,
        free: disk.ok ? (disk.free ?? 0) : 0,
        percentFree: disk.ok ? (disk.percentFree ?? 0) : 0,
      },
    },
  };

  if (details.length > 0) {
    response.details = details;
  }

  const elapsed = Date.now() - start;
  if (status === "ok") {
    logger.info(`[health] GET /api/health ok (${elapsed}ms)`, { checks: response.checks });
  } else {
    logger.warn(`[health] GET /api/health degraded (${elapsed}ms)`, { failedChecks: details });
  }

  res.json(response);
});

// GET /api/health/rag — RAG health check (backward-compatible with the old inline endpoint).
router.get("/api/health/rag", async (_req: Request, res: Response) => {
  const collector = await checkCollectorHealth();
  res.json({
    status: collector.reachable ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks: {
      collector: {
        reachable: collector.reachable,
        error: collector.error || null,
      },
      postgres_fts: "enabled",
    },
    hint: collector.reachable
      ? "RAG search is operational (vector + full-text)."
      : "Collector is unreachable — only PostgreSQL full-text search is available. Start the collector service for vector search.",
  });
});

export default router;

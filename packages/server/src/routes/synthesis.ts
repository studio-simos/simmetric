// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import {
  synthesisApproveRejectSchema,
  synthesisTriggerSchema,
  renameSynthesisRunSchema,
  graphWikiTriggerSchema,
} from "@simmetric-chat/shared";
import type { SynthesisPreview } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";
import { defaultRunName, defaultWikiGraphRunName } from "../services/synthesisService";
import { runWikiGraphPipeline } from "../services/wikiGraphStage";

const router = Router();

// All synthesis endpoints require authentication
router.use(authMiddleware);

// ===========================================================================
// GET /api/synthesis/status
// ===========================================================================
router.get("/status", async (req: Request, res: Response) => {
  try {
    const archiveId = req.query.archiveId as string | undefined;

    const where: Record<string, unknown> = {};
    if (archiveId) {
      where.archiveId = archiveId;
    }

    // Include the archive relation so the frontend can resolve archive names
    // (e.g. the "Filter by archive" dropdown on the synthesis dashboard).
    // Without this, runs only carry the raw archiveId UUID, which the UI would
    // render as an unreadable identifier instead of the archive's name.
    const runs = await prisma.synthesisRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { archive: { select: { slug: true, name: true } } },
    });

    res.json(runs);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] GET /status error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// GET /api/synthesis/pending/count
// ===========================================================================
router.get("/pending/count", async (_req: Request, res: Response) => {
  try {
    const count = await prisma.synthesisRun.count({
      where: { status: "PENDING" },
    });

    res.json({ count });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] GET /pending/count error", {
      error: message,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// POST /api/synthesis/trigger — manual trigger (admin-only, recovery/testing)
// ===========================================================================
router.post(
  "/trigger",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const parsed = synthesisTriggerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { archiveId } = parsed.data;

      // Verify archive exists
      const archive = await prisma.archive.findFirst({
        where: { id: archiveId, deletedAt: null },
      });
      if (!archive) {
        res.status(404).json({ error: "Archive not found" });
        return;
      }

      const run = await prisma.synthesisRun.create({
        data: {
          archiveId,
          status: "PENDING",
          createdBy: req.userId!,
          previewJson: {},
          // D-11: computed default name so the run row is readable in the UI
          // before the user renames it.
          name: defaultRunName({ name: archive.name }, new Date()),
        },
      });

      // Fire-and-forget event log
      logEvent("synthesis_run", run.id, "synthesis.triggered", req.userId!, {
        archiveId,
      }).catch((err: Error) =>
        logger.error("[synthesis] Failed to log trigger event", {
          error: err.message,
        }),
      );

      logger.info("[synthesis] Manual trigger created", {
        runId: run.id,
        archiveId,
      });

      res.status(201).json(run);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] POST /trigger error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/synthesis/trigger-graph-wiki — admin-only graph-wiki trigger
// (Plan 153-02 / WIKI-01 / D-01)
// ===========================================================================
// Diverges from the LLM /trigger route: this endpoint creates a SynthesisRun
// row (PENDING) for observability and fires `runWikiGraphPipeline` (a SEPARATE
// no-LLM pipeline — A2) fire-and-forget. The admin gets 201 immediately and
// observes progress via GET /api/synthesis/:runId (the existing route). The
// graph-wiki pipeline does NOT run the LLM 5-pass runPipelineStages and does
// NOT consume the BudgetTracker — it is a pure-function pipeline (graph +
// seed → markdown → DB rows). Threat T-153-04 mitigation:
// requirePermission("archive:write") — same gate as /trigger.
router.post(
  "/trigger-graph-wiki",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const parsed = graphWikiTriggerSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { archiveId } = parsed.data;

      // Verify archive exists (404 if missing or soft-deleted).
      const archive = await prisma.archive.findFirst({
        where: { id: archiveId, deletedAt: null },
      });
      if (!archive) {
        res.status(404).json({ error: "Archive not found" });
        return;
      }

      // D-11-style human-readable name. The "Wiki Graph" prefix distinguishes
      // graph-wiki runs from LLM synthesis runs ("Sintesi · …") in the UI list.
      // WR-05: the name format is sourced from the shared
      // `defaultWikiGraphRunName` helper (synthesisService → synthesisStages)
      // so the dd/mm/yyyy hh:mm formatting + "Senza nome" fallback live in one
      // place, mirroring the /trigger route's `defaultRunName(...)` call.
      const run = await prisma.synthesisRun.create({
        data: {
          archiveId,
          status: "PENDING",
          createdBy: req.userId!,
          previewJson: {},
          name: defaultWikiGraphRunName({ name: archive.name }, new Date()),
        },
      });

      // Fire-and-forget: the admin gets 201 immediately; the pipeline updates
      // the run row async (PROCESSING → COMPLETED/FAILED). The .catch handler
      // logs a pipeline failure without throwing into the request cycle (the
      // run row is marked FAILED by runWikiGraphPipeline's own catch path).
      // A6: createdBy = req.userId (the triggering admin) — passed to the
      // pipeline so generated pages attribute correctly.
      runWikiGraphPipeline(archiveId, req.userId!, run.id).catch(
        (err: unknown) =>
          logger.error("[wiki-graph] pipeline failed", {
            runId: run.id,
            archiveId,
            error: err instanceof Error ? err.message : String(err),
          }),
      );

      // Fire-and-forget event log.
      logEvent(
        "synthesis_run",
        run.id,
        "wiki_graph.triggered",
        req.userId!,
        { archiveId },
      ).catch((err: Error) =>
        logger.error("[synthesis] Failed to log wiki-graph trigger event", {
          error: err.message,
        }),
      );

      logger.info("[synthesis] Wiki-graph trigger created", {
        runId: run.id,
        archiveId,
      });

      res.status(201).json(run);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] POST /trigger-graph-wiki error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// GET /api/synthesis/:runId — full preview with ownership check
// ===========================================================================
router.get("/:runId", async (req: Request, res: Response) => {
  try {
    const runId = String(req.params.runId);

    // Ownership check: find run joined with archive where archive.createdBy matches
    const run = await prisma.synthesisRun.findFirst({
      where: {
        id: runId,
        archive: { createdBy: req.userId! },
      },
    });

    if (!run) {
      res.status(404).json({ error: "Synthesis run not found" });
      return;
    }

    res.json(run);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[synthesis] GET /:runId error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// POST /api/synthesis/:runId/approve — approve and apply changes
// ===========================================================================
router.post(
  "/:runId/approve",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);

      // Validate request body
      const parsed = synthesisApproveRejectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { pageSlugs } = parsed.data;

      // Load the SynthesisRun with ownership verification
      const run = await prisma.synthesisRun.findFirst({
        where: {
          id: runId,
          archive: { createdBy: req.userId! },
        },
      });

      if (!run) {
        res.status(404).json({ error: "Synthesis run not found" });
        return;
      }

      if (run.status !== "COMPLETED" && run.status !== "PARTIAL") {
        res.status(400).json({
          error: "Only completed or partial runs can be approved",
        });
        return;
      }

      const preview = run.previewJson as unknown as SynthesisPreview;

      if (!preview || !preview.changes || preview.changes.length === 0) {
        res.status(400).json({ error: "Run has no changes to approve" });
        return;
      }

      // Determine which slugs to approve
      const approvedSlugs =
        pageSlugs && pageSlugs.length > 0
          ? pageSlugs
          : preview.changes.map((c) => c.pageSlug);

      // Dynamic import applyApprovedChanges
      const { applyApprovedChanges } = await import(
        "../services/synthesisPageWriter"
      );

      const result = await applyApprovedChanges(
        run.archiveId,
        preview,
        approvedSlugs,
        req.userId!,
      );

      // Update SynthesisRun status
      const totalChanges = preview.changes.length;
      const allApproved = approvedSlugs.length >= totalChanges;
      const newStatus = allApproved ? "APPROVED" : "PARTIAL";

      // D-02: persist pagesApplied from applyApprovedChanges result.applied
      // so the row tracks the real write count (not the proposal count).
      await prisma.synthesisRun.update({
        where: { id: runId },
        data: { status: newStatus, pagesApplied: result.applied },
      });

      // Log the approval event (fire-and-forget)
      logEvent("synthesis_run", runId, "synthesis.approved", req.userId!, {
        archiveId: run.archiveId,
        appliedCount: result.applied,
        conflictCount: result.conflicts.length,
        pagesApplied: result.applied,
      }).catch((err: Error) =>
        logger.error("[synthesis] Failed to log approval event", {
          error: err.message,
        }),
      );

      logger.info("[synthesis] Changes approved", {
        runId,
        archiveId: run.archiveId,
        applied: result.applied,
        conflicts: result.conflicts.length,
      });

      res.json({ applied: result.applied, conflicts: result.conflicts });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] POST /:runId/approve error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/synthesis/:runId/reject — reject entire run or specific pages
// ===========================================================================
router.post(
  "/:runId/reject",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);

      // Validate request body
      const parsed = synthesisApproveRejectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { pageSlugs } = parsed.data;

      // Load the SynthesisRun with ownership verification
      const run = await prisma.synthesisRun.findFirst({
        where: {
          id: runId,
          archive: { createdBy: req.userId! },
        },
      });

      if (!run) {
        res.status(404).json({ error: "Synthesis run not found" });
        return;
      }

      if (run.status !== "COMPLETED" && run.status !== "PARTIAL") {
        res.status(400).json({
          error: "Only completed or partial runs can be rejected",
        });
        return;
      }

      // If specific pageSlugs provided, only reject those; otherwise reject all
      if (pageSlugs && pageSlugs.length > 0) {
        type SynthesisChange = { pageSlug?: string; rejected?: boolean };
        const preview = run.previewJson as Record<string, unknown> | null;
        const changes = (preview?.changes as SynthesisChange[]) ?? [];
        if (preview && Array.isArray(preview?.changes)) {
          let allRejected = true;

          for (const change of changes) {
            if (pageSlugs.includes(change.pageSlug ?? "")) {
              change.rejected = true;
            } else if (!change.rejected) {
              allRejected = false;
            }
          }

          // Update previewJson with rejection markings
          const newStatus = allRejected ? "REJECTED" : "PARTIAL";

          await prisma.synthesisRun.update({
            where: { id: runId },
            data: {
              status: newStatus,
              previewJson: preview as Prisma.InputJsonValue,
            },
          });
        } else {
          // No changes to reject — mark as rejected anyway
          await prisma.synthesisRun.update({
            where: { id: runId },
            data: { status: "REJECTED" },
          });
        }
      } else {
        // Reject the entire run
        await prisma.synthesisRun.update({
          where: { id: runId },
          data: { status: "REJECTED" },
        });
      }

      // Log the rejection event (fire-and-forget)
      logEvent("synthesis_run", runId, "synthesis.rejected", req.userId!, {
        archiveId: run.archiveId,
        pageSlugs: pageSlugs ?? null,
      }).catch((err: Error) =>
        logger.error("[synthesis] Failed to log rejection event", {
          error: err.message,
        }),
      );

      logger.info("[synthesis] Run rejected", {
        runId,
        archiveId: run.archiveId,
      });

      res.json({ message: "Rejected successfully" });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] POST /:runId/reject error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// DELETE /api/synthesis/:runId — delete a synthesis run
// ===========================================================================
router.delete(
  "/:runId",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);

      const run = await prisma.synthesisRun.findFirst({
        where: {
          id: runId,
          archive: { createdBy: req.userId! },
        },
      });

      if (!run) {
        res.status(404).json({ error: "Synthesis run not found" });
        return;
      }

      await prisma.synthesisRun.delete({
        where: { id: runId },
      });

      logEvent("synthesis_run", runId, "synthesis.deleted", req.userId!, {
        archiveId: run.archiveId,
        status: run.status,
      }).catch((err: Error) =>
        logger.error("[synthesis] Failed to log deletion event", {
          error: err.message,
        }),
      );

      logger.info("[synthesis] Run deleted", { runId, archiveId: run.archiveId });

      res.json({ message: "Synthesis run deleted" });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] DELETE /:runId error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// PATCH /api/synthesis/:runId/rename — rename a synthesis run (SYN-03, D-13)
// ===========================================================================
// Diverges from chat rename (renameChatSchema max 200 optional): name is
// NOT optional and max 100 (short labels in a dense list). Ownership check
// mirrors the approve route via archive.createdBy; returns 404 (NOT 403) on
// another user's run to avoid leaking run existence (T-74-IDOR). No
// requireFeatureLimit — rename consumes no LLM budget (mirrors DELETE).
router.patch(
  "/:runId/rename",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);

      const parsed = renameSynthesisRunSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const run = await prisma.synthesisRun.findFirst({
        where: {
          id: runId,
          archive: { createdBy: req.userId! },
        },
      });

      if (!run) {
        res.status(404).json({ error: "Synthesis run not found" });
        return;
      }

      const updated = await prisma.synthesisRun.update({
        where: { id: runId },
        data: { name: parsed.data.name },
      });

      // Fire-and-forget audit log (T-74-REPUTATION mitigation)
      logEvent("synthesis_run", runId, "synthesis.renamed", req.userId!, {
        archiveId: run.archiveId,
        oldName: run.name,
        newName: parsed.data.name,
      }).catch((err: Error) =>
        logger.error("[synthesis] Failed to log rename event", {
          error: err.message,
        }),
      );

      logger.info("[synthesis] Run renamed", {
        runId,
        archiveId: run.archiveId,
        oldName: run.name,
        newName: parsed.data.name,
      });

      res.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[synthesis] PATCH /:runId/rename error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;

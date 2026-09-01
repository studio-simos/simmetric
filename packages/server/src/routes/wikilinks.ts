// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import matter from "gray-matter";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { wikilinkResolveSchema, mergePagesSchema } from "@simmetric-chat/shared";
import { resolveWikilinks, redirectWikilinks } from "../services/wikiLinkService";
import { getMaintenanceSuggestions } from "../services/archiveMaintenanceService";
import { createPage, getPage } from "../services/archivePageService";
import { logEvent } from "../services/eventLogService";
import { slugify } from "../utils/slugify";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

const router = Router();

// All endpoints require authentication
router.use(authMiddleware);

// ===========================================================================
// GET /api/wikilinks/maintenance/:archiveId — Proactive maintenance suggestions
// ===========================================================================
router.get(
  "/maintenance/:archiveId",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.archiveId);
      z.string().uuid().parse(archiveId);

      // Archive-scoped resolution; workspaceId is unused by getMaintenanceSuggestions
      const { suggestions, mergeSuggestions } = await getMaintenanceSuggestions("", archiveId);

      // D-10: backward-compatible — `suggestions` field preserved, `mergeSuggestions` added
      res.json({ suggestions, mergeSuggestions });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid archive ID" });
        return;
      }
      logger.error("[wikilinks] GET /maintenance/:archiveId error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/wikilinks/maintenance/:archiveId/merge — Human-triggered page merge (D-10/D-11)
// Creates page C with combined body, soft-deletes A and B (deletedAt set, files kept),
// redirects [[A]]/[[B]] → [[C]] via propagateRename, and audit-logs archive_page.merged.
// Gated by authMiddleware (router.use) + requirePermission("archive:write") + UUID + Zod.
// ===========================================================================
router.post(
  "/maintenance/:archiveId/merge",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.archiveId);
      z.string().uuid().parse(archiveId);

      const parsed = mergePagesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid merge body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { pageA, pageB, title, slug } = parsed.data;

      // 1. Load A and B — getPage is archive-scoped + deletedAt:null (IDOR-safe,
      // T-79-03: cross-archive slug returns 404 hiding existence).
      let pageARec: Awaited<ReturnType<typeof getPage>>;
      let pageBRec: Awaited<ReturnType<typeof getPage>>;
      try {
        pageARec = await getPage(archiveId, pageA);
        pageBRec = await getPage(archiveId, pageB);
      } catch {
        res.status(404).json({ error: "Page not found" });
        return;
      }

      // 2. Compose C body + Fonti frontmatter (RESEARCH D-11 example).
      const mergedBody = `${pageARec.bodyText}\n\n## Merged from ${pageBRec.title}\n\n${pageBRec.bodyText}`;
      const fonti = [
        ...(((pageARec.frontmatter as Record<string, unknown> | null)?.Fonti as string[]) || []),
        ...(((pageBRec.frontmatter as Record<string, unknown> | null)?.Fonti as string[]) || []),
      ];
      const content = matter.stringify(mergedBody, { Fonti: fonti, merged_from: [pageA, pageB] });
      const finalSlug = slug || slugify(title, "page");

      // 3. Create C FIRST (RESEARCH Pitfall 6 — abort-safe: if this fails, nothing to clean up).
      const pageC = await createPage(
        archiveId,
        {
          title,
          content,
          category: (pageARec.category as "entities" | "concepts" | "decisions") || "entities",
        },
        req.userId!,
      );

      // 4. Soft-delete A and B (DB only — RESEARCH Pitfall 5: inline update, NOT the
      // hard-delete helper which unlinks the .md file; files are kept for git history).
      await prisma.archivePage.update({
        where: { id: pageARec.id },
        data: { deletedAt: new Date() },
      });
      await prisma.archivePage.update({
        where: { id: pageBRec.id },
        data: { deletedAt: new Date() },
      });

      // 5. Redirect wikilinks [[A]]/[[B]] → [[C]] (best-effort per-page via propagateRename).
      await redirectWikilinks(
        archiveId,
        { [pageA]: finalSlug, [pageB]: finalSlug },
        req.userId!,
      );

      // 6. Audit log (fire-and-forget — pattern from archivePageService.ts:236).
      logEvent("archive_page", pageC.id, "archive_page.merged", req.userId ?? null, {
        archiveId,
        pageA,
        pageB,
        pageC: finalSlug,
      }).catch(() => {
        /* best-effort audit */
      });

      res.status(201).json({ pageC: finalSlug, message: "Merge complete" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid archive ID" });
        return;
      }
      logger.error("[wikilinks] POST /maintenance/:archiveId/merge error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/wikilinks/resolve — Batch wikilink resolution
// ===========================================================================
router.post("/resolve", async (req: Request, res: Response) => {
  try {
    const parsed = wikilinkResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { slugs, archiveId } = parsed.data;
    const resolved = await resolveWikilinks(slugs, archiveId);

    logger.info("[wikilinks] Resolved", { count: resolved.length });
    res.json({ resolved });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[wikilinks] POST /resolve error", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// GET /api/wiki-edits/:archiveId — Wiki edit history
// ===========================================================================
router.get(
  "/:archiveId",
  requirePermission("archive:read"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.archiveId);
      z.string().uuid().parse(archiveId);

      const slug = req.query.slug as string | undefined;

      const runs = await prisma.wikiEditRun.findMany({
        where: {
          archiveId,
          createdBy: req.userId!,
          ...(slug && { pageSlug: slug }),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          pageSlug: true,
          action: true,
          status: true,
          previewJson: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.json(runs);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid archive ID" });
        return;
      }
      logger.error("[wikilinks] GET /:archiveId error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// GET /api/wiki-edits/:archiveId/:pageSlug — Per-page edit history
// ===========================================================================
router.get(
  "/:archiveId/:pageSlug",
  requirePermission("archive:read"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.archiveId);
      const pageSlug = String(req.params.pageSlug);
      z.string().uuid().parse(archiveId);

      const runs = await prisma.wikiEditRun.findMany({
        where: {
          archiveId,
          pageSlug,
          createdBy: req.userId!,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          pageSlug: true,
          action: true,
          status: true,
          previewJson: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.json(runs);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid archive ID" });
        return;
      }
      logger.error("[wikilinks] GET /:archiveId/:pageSlug error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;

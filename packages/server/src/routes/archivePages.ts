// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import matter from "gray-matter";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import {
  createPageSchema,
  updatePageSchema,
} from "@simmetric-chat/shared";
import type { CreatePageInput, UpdatePageInput } from "@simmetric-chat/shared";
import { createPage, getPage, getPages, updatePage, deletePage } from "../services/archivePageService";
import { generateIndexFile } from "../services/archiveIndexService";
import { logEvent } from "../services/eventLogService";
import { logger } from "../utils/logger";
import { validatePageContent, validateSlugAgainstConvention } from "../services/archiveSchemaValidator";
import { getArchiveConfig } from "../services/archiveConfigService";

const router = Router();

// GET /:archiveId/pages — List pages in an archive
router.get("/:archiveId/pages", authMiddleware, async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    const category = req.query.category as string | undefined;
    const pages = await getPages(archiveId, category);

    // Quick 260723-ke9: augment each page with a read-only `relatedCount`
    // (number of OTHER pages in the archive on the same topic, via
    // token-overlap Jaccard ≥ 0.10). Computed over the WHOLE archive
    // (category-agnostic) so cross-category topic neighbors still surface.
    // Best-effort: a computation failure never breaks the list.
    // D-08 (TYP-02): let inference flow from `getPages` (returns
    // `prisma.archivePage.findMany(...)` -> `ArchivePage[]`). The plan's
    // `Prisma.ArchivePage[]` is not a namespace export — model payload types
    // are top-level (`export type ArchivePage`), only the *Args/*Input types
    // live under the `Prisma` namespace. Dropping the `: any[]` annotation
    // surfaces the correct inferred type; the map callback `p` infers
    // `ArchivePage`, and the spread result is a structural superset assignable
    // back to the inferred `ArchivePage[]`.
    let pagesWithRelated = pages;
    try {
      const { computeRelatedCounts } = await import("../services/archiveRelatedService");
      const relatedCounts = await computeRelatedCounts(archiveId);
      pagesWithRelated = pages.map((p) => ({
        ...p,
        relatedCount: relatedCounts[p.slug] ?? 0,
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("[archivePages] relatedCount computation failed; returning without it", {
        error: message,
        archiveId,
      });
    }

    res.json(pagesWithRelated);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archivePages] Error listing pages", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:archiveId/pages — Create a new page
router.post("/:archiveId/pages", authMiddleware, requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    const result = createPageSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    const validatedData: CreatePageInput = result.data;

    try {
      const config = await getArchiveConfig(archiveId);
      const validation = validatePageContent(validatedData.content || "", config, "human");
      // D-12: title is optional — when omitted, the service derives the title
      // (and therefore the slug) from content. Skip slug-convention validation
      // in that case because the slug is not yet known at the route layer.
      const slugValidation = validatedData.title
        ? validateSlugAgainstConvention(validatedData.title, config)
        : { valid: true as const, violations: [], warnings: [] };
      if (!validation.valid || !slugValidation.valid) {
        return res.status(400).json({
          error: "Schema validation failed",
          violations: [...validation.violations.map((v) => v.message), ...slugValidation.violations.map((v) => v.message)],
          warnings: [...validation.warnings.map((v) => v.message), ...slugValidation.warnings.map((v) => v.message)],
        });
      }
      const allWarnings = [...validation.warnings, ...slugValidation.warnings];

      const page = await createPage(archiveId, validatedData, req.userId!);

      // Regenerate _index.md for the category
      generateIndexFile(archiveId, page.category).catch((err) => {
        logger.error("[archivePages] Failed to regenerate index file", { error: err.message });
      });

      res.status(201).json({ ...page, warnings: allWarnings.map((w) => w.message) });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (message?.includes("Path traversal")) {
        res.status(400).json({ error: "Invalid page path: path traversal detected" });
        return;
      }
      if (message?.includes("not found")) {
        res.status(404).json({ error: "Archive not found" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archivePages] Error creating page", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:archiveId/pages/:slug — Get a single page
router.get("/:archiveId/pages/:slug", authMiddleware, async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;
    const slug = req.params.slug as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    // Validate slug against [a-z0-9-]+ pattern (path traversal defense)
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({
        error: "Invalid page slug: must contain only lowercase letters, numbers, and hyphens",
      });
      return;
    }

    try {
      const page = await getPage(archiveId, slug);
      res.json(page);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (message?.includes("not found")) {
        res.status(404).json({ error: "Page not found" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archivePages] Error fetching page", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /:archiveId/pages/:slug — Update a page
router.put("/:archiveId/pages/:slug", authMiddleware, requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;
    const slug = req.params.slug as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    // Validate slug against [a-z0-9-]+ pattern (path traversal defense)
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({
        error: "Invalid page slug: must contain only lowercase letters, numbers, and hyphens",
      });
      return;
    }

    const result = updatePageSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Invalid request body",
        details: result.error.flatten().fieldErrors,
      });
      return;
    }

    const validatedData: UpdatePageInput = result.data;

    try {
      // Capture old category before update to regenerate old category's index
      const oldPage = await getPage(archiveId, slug);
      const oldCategory = oldPage.category;

      // D-04 (Phase 77): body-only edit branch. When the client sends `body`
      // (KBPG-03 frontend edit-text feature), recompose the full markdown file
      // as `frontmatter (existing) + body (new)` via gray-matter before
      // passing it to `updatePage` as `content`. This preserves the existing
      // frontmatter — including the Phase 79 WIKI-01 `Fonti` source-lineage
      // field — which would otherwise be lost when `updatePage` writes
      // `input.content ?? existing.bodyText` verbatim as the whole .md file
      // (archivePageService.ts:307). `validatePageContent` runs on the raw
      // user body, NOT the recomposed file, so YAML frontmatter never trips
      // content lint rules (Pitfall 2). `oldPage.frontmatter` is already in
      // scope from the `getPage` call above — zero extra DB cost.
      let contentToService: string | undefined = validatedData.content;
      let contentToValidate: string;
      if (validatedData.body !== undefined) {
        // `oldPage.frontmatter` is `Prisma.JsonValue` — only JsonObject is
        // valid YAML frontmatter data (primitives/arrays would stringify as
        // a bare scalar, which is not what we want). Guard to {} otherwise.
        const fm =
          oldPage.frontmatter !== null &&
          typeof oldPage.frontmatter === "object" &&
          !Array.isArray(oldPage.frontmatter)
            ? oldPage.frontmatter
            : {};
        const recomposed = matter.stringify(validatedData.body, fm);
        contentToService = recomposed;
        contentToValidate = validatedData.body;
      } else {
        contentToValidate = validatedData.content || oldPage.bodyText;
      }

      const config = await getArchiveConfig(archiveId);
      const validation = validatePageContent(contentToValidate, config, "human");
      const slugValidation = validateSlugAgainstConvention(validatedData.slug || slug, config);
      if (!validation.valid || !slugValidation.valid) {
        return res.status(400).json({
          error: "Schema validation failed",
          violations: [...validation.violations.map((v) => v.message), ...slugValidation.violations.map((v) => v.message)],
          warnings: [...validation.warnings.map((v) => v.message), ...slugValidation.warnings.map((v) => v.message)],
        });
      }
      const allWarnings = [...validation.warnings, ...slugValidation.warnings];

      // Pass the recomposed `content` (frontmatter + body) to the service.
      // The service re-parses with `matter(newContent)` and recomputes
      // `frontmatter` / `bodyText` / `wikilinks` / `contentHash` from the
      // recomposed file. We intentionally do NOT call logEvent for the
      // `*.updated` action here — the service already logs it at
      // archivePageService.ts:386-395 (D-09 landmine: a second logEvent
      // would double-log every update).
      const updated = await updatePage(
        archiveId,
        slug,
        { ...validatedData, content: contentToService },
        req.userId!,
      );

      // Regenerate _index.md for new category
      generateIndexFile(archiveId, updated.category).catch((err) => {
        logger.error("[archivePages] Failed to regenerate index file", { error: err.message });
      });

      // Regenerate _index.md for old category if it changed
      if (oldCategory !== updated.category) {
        generateIndexFile(archiveId, oldCategory).catch((err) => {
          logger.error("[archivePages] Failed to regenerate old category index file", { error: err.message });
        });
      }

      res.json({ ...updated, warnings: allWarnings.map((w) => w.message) });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (message?.includes("not found")) {
        res.status(404).json({ error: "Page not found" });
        return;
      }
      if (message?.includes("Conflict")) {
        res.status(409).json({ error: "Page was modified concurrently. Please reload and try again." });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archivePages] Error updating page", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:archiveId/pages/:slug — Soft-delete a page
router.delete("/:archiveId/pages/:slug", authMiddleware, requirePermission("archive:write"), async (req: Request, res: Response) => {
  try {
    const archiveId = req.params.archiveId as string;
    const slug = req.params.slug as string;

    // Validate archiveId as UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(archiveId)) {
      res.status(400).json({ error: "Invalid archive ID: must be a valid UUID" });
      return;
    }

    // Validate slug against [a-z0-9-]+ pattern (path traversal defense)
    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({
        error: "Invalid page slug: must contain only lowercase letters, numbers, and hyphens",
      });
      return;
    }

    try {
      // Get page before delete to know its category for index regeneration
      const pageBeforeDelete = await getPage(archiveId, slug);
      const result = await deletePage(archiveId, slug);

      // Regenerate _index.md for the category
      generateIndexFile(archiveId, pageBeforeDelete.category).catch((err) => {
        logger.error("[archivePages] Failed to regenerate index file after delete", { error: err.message });
      });

      // Log event (service doesn't log for delete)
      logEvent("archive_page", `${archiveId}/${slug}`, "archive_page.deleted", req.userId!, {
        archiveId,
        slug,
      }).catch((err) => {
        logger.error("[archivePages] Failed to log event", { error: err.message });
      });

      res.json(result);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      if (message?.includes("not found")) {
        res.status(404).json({ error: "Page not found" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[archivePages] Error deleting page", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

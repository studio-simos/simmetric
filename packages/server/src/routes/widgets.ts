// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { authMiddleware } from "../middleware/auth";
import { requireAdmin } from "../middleware/rbac";
import { requireFeature, requireFeatureLimit } from "../middleware/license";
import { isFeatureEnabled, getLicenseInfo } from "../services/licenseService";
import { createWidgetSchema, updateWidgetSchema, widgetAnalyticsQuerySchema } from "@simmetric-chat/shared";
import { Parser } from "@json2csv/plainjs";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  getWidgetAnalyticsDaily,
  getWidgetTopicDistribution,
  getWidgetAnalyticsSummary,
} from "../services/widgetAnalyticsService";
import { fireWidgetCacheBust } from "../services/widgetCacheBustService";

const router = Router();
router.use(authMiddleware, requireAdmin);

// Tri-state Json write translation (D-04, D-08): the shared schemas accept
// `.nullable()` on the localization blobs, but Prisma 7's InputJsonValue
// disallows top-level null for Json fields — plain null is a compile-time
// error (verified landmine, RESEARCH.md Pitfall 3). null → Prisma.DbNull
// (SQL NULL = "not configured"), object/array → InputJsonValue (jsonb),
// undefined → undefined (field omitted — leave unchanged on update).
function toJsonWriteValue(
  v: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (v === null) return Prisma.DbNull;
  if (v === undefined) return undefined;
  return v as Prisma.InputJsonValue;
}

// ===== Widget Analytics Endpoints (ADM-03) =====
// Must be registered before /:id parameterized routes to avoid "analytics" being matched as an :id

/**
 * @openapi
 * /widgets/analytics/daily:
 *   get:
 *     tags: [Widgets]
 *     summary: Get daily widget analytics (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: days
 *         in: query
 *         schema: { type: number, enum: [7, 30, 90], default: 30 }
 *       - name: widgetId
 *         in: query
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Daily conversation analytics }
 *       400: { description: Invalid query parameters }
 *       401: { description: Authentication required }
 *       403: { description: Admin access required }
 */
// GET /api/widgets/analytics/daily -- daily conversation counts per ADM-03
router.get("/analytics/daily", async (req: Request, res: Response) => {
  try {
    const parsed = widgetAnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { days, widgetId } = parsed.data;
    const daily = await getWidgetAnalyticsDaily(widgetId ?? null, days);
    res.json(daily);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error fetching daily analytics", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets/analytics/topics:
 *   get:
 *     tags: [Widgets]
 *     summary: Get widget topic distribution (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: days
 *         in: query
 *         schema: { type: number, enum: [7, 30, 90], default: 30 }
 *       - name: widgetId
 *         in: query
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Topic distribution }
 *       400: { description: Invalid query parameters }
 *       401: { description: Authentication required }
 *       403: { description: Admin access required }
 */
// GET /api/widgets/analytics/topics -- topic distribution per ADM-03
router.get("/analytics/topics", async (req: Request, res: Response) => {
  try {
    const parsed = widgetAnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { days, widgetId } = parsed.data;
    const topics = await getWidgetTopicDistribution(widgetId ?? null, days);
    res.json(topics);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error fetching topic distribution", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets/analytics/summary:
 *   get:
 *     tags: [Widgets]
 *     summary: Get widget analytics summary (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: days
 *         in: query
 *         schema: { type: number, enum: [7, 30, 90], default: 30 }
 *       - name: widgetId
 *         in: query
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Analytics summary }
 *       400: { description: Invalid query parameters }
 *       401: { description: Authentication required }
 *       403: { description: Admin access required }
 */
// GET /api/widgets/analytics/summary -- aggregate metrics per ADM-03
router.get("/analytics/summary", async (req: Request, res: Response) => {
  try {
    const parsed = widgetAnalyticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { days, widgetId } = parsed.data;
    const summary = await getWidgetAnalyticsSummary(widgetId ?? null, days);
    res.json(summary);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error fetching analytics summary", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== Widget CRUD Endpoints =====

/**
 * @openapi
 * /widgets:
 *   get:
 *     tags: [Widgets]
 *     summary: List all widgets (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Array of widgets }
 *       401: { description: Authentication required }
 *       403: { description: Admin access required }
 */
// GET /api/widgets -- list all widgets (admin only)
router.get("/", async (_req: Request, res: Response) => {
  try {
    const widgets = await prisma.widget.findMany({
      where: { deletedAt: null },
      include: {
        workspaces: { select: { workspaceId: true } },
        _count: { select: { sessions: true, leads: true } },
        creator: { select: { id: true, username: true } },
      },
    });

    res.json(widgets);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error listing widgets", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets:
 *   post:
 *     tags: [Widgets]
 *     summary: Create a widget (admin only, license-gated)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: "Support Widget" }
 *               welcomeMessage: { type: string }
 *               fallbackMessage: { type: string }
 *               position: { type: string, enum: ["bottom-right", "bottom-left"] }
 *               primaryColor: { type: string, example: "#4c6ef5" }
 *               botName: { type: string, example: "AI Assistant" }
 *               logoUrl: { type: string }
 *               avatarUrl: { type: string }
 *     responses:
 *       201: { description: Widget created }
 *       400: { description: Validation error }
 *       401: { description: Authentication required }
 *       402: { description: Feature not available or limit reached }
 *       403: { description: Admin access required }
 */
// POST /api/widgets -- create widget (license-gated per INFRA-02 and D-12)
router.post("/", requireFeature("widget_enabled"), requireFeatureLimit("max_widgets", "widget"), async (req: Request, res: Response) => {
  try {
    const parsed = createWidgetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const widget = await prisma.widget.create({
      data: {
        ...parsed.data,
        localizedTexts: toJsonWriteValue(parsed.data.localizedTexts),
        suggestedQuestions: toJsonWriteValue(parsed.data.suggestedQuestions),
        credits: toJsonWriteValue(parsed.data.credits),
        createdBy: req.userId!,
      },
      include: {
        workspaces: { select: { workspaceId: true } },
        _count: { select: { sessions: true } },
      },
    });

    res.status(201).json(widget);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error creating widget", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets/{id}:
 *   get:
 *     tags: [Widgets]
 *     summary: Get a single widget (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Widget details }
 *       404: { description: Widget not found }
 */
// GET /api/widgets/:id -- get single widget
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const widget = await prisma.widget.findFirst({
      where: { id, deletedAt: null },
      include: {
        workspaces: { select: { workspaceId: true } },
        _count: { select: { sessions: true } },
        creator: { select: { id: true, username: true } },
      },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    res.json(widget);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error getting widget", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets/{id}:
 *   put:
 *     tags: [Widgets]
 *     summary: Update a widget (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               welcomeMessage: { type: string }
 *               fallbackMessage: { type: string }
 *               position: { type: string }
 *               isActive: { type: boolean }
 *               primaryColor: { type: string }
 *               botName: { type: string }
 *               logoUrl: { type: string }
 *               avatarUrl: { type: string }
 *     responses:
 *       200: { description: Widget updated }
 *       400: { description: Validation error }
 *       404: { description: Widget not found }
 */
// PUT /api/widgets/:id -- update widget
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const parsed = updateWidgetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }

    const widgetId = req.params.id as string;
    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    // Quick 260826-hx5 (T-hx5-01): gate credits WRITES behind the
    // `widget_credits_editing` flag. The gate fires ONLY when the body's
    // `credits` field differs from the stored value — a no-op credits write
    // (or absent credits) must keep working so non-credits PUTs (name,
    // position, branding) are not blocked on Community. JSON.stringify on
    // both sides compares the Prisma JsonValue cleanly (null-vs-object and
    // object-vs-null both count as "differs"). Inline (not requireFeature
    // middleware) so the gate scopes to the credits field only.
    if (parsed.data.credits !== undefined) {
      const incoming = JSON.stringify(parsed.data.credits);
      const stored = JSON.stringify(widget.credits);
      if (incoming !== stored && !isFeatureEnabled("widget_credits_editing")) {
        res.status(402).json({
          error: "This feature requires an Enterprise license",
          feature: "widget_credits_editing",
          tier: getLicenseInfo().tier,
        });
        return;
      }
    }

    const updated = await prisma.widget.update({
      where: { id: widgetId },
      data: {
        ...parsed.data,
        localizedTexts: toJsonWriteValue(parsed.data.localizedTexts),
        suggestedQuestions: toJsonWriteValue(parsed.data.suggestedQuestions),
        credits: toJsonWriteValue(parsed.data.credits),
      },
      include: {
        workspaces: { select: { workspaceId: true } },
        _count: { select: { sessions: true } },
      },
    });

    // WID-04: fire-and-forget push cache-bust to the widget service. Never
    // block the PUT response — the helper catches its own rejections and the
    // 5-min TTL on the widget side is the safety net.
    try {
      fireWidgetCacheBust(widgetId);
    } catch {
      /* never block — defensive only, helper catches internally */
    }

    res.json(updated);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error updating widget", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets/{id}:
 *   delete:
 *     tags: [Widgets]
 *     summary: Soft-delete a widget (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Widget deleted }
 *       404: { description: Widget not found }
 */
// DELETE /api/widgets/:id -- soft-delete widget
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const widget = await prisma.widget.findFirst({
      where: { id, deletedAt: null },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    await prisma.widget.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    res.json({ message: "Widget deleted successfully" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error deleting widget", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets/{id}/workspaces:
 *   put:
 *     tags: [Widgets]
 *     summary: Set workspace whitelist for a widget (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceIds]
 *             properties:
 *               workspaceIds: { type: array, items: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Workspace whitelist updated }
 *       404: { description: Widget not found }
 */
// PUT /api/widgets/:id/workspaces -- set workspace whitelist (ADM-02 per D-10, D-11)
router.put("/:id/workspaces", async (req: Request, res: Response) => {
  try {
    const { workspaceIds } = req.body;
    if (!Array.isArray(workspaceIds) || !workspaceIds.every((id: string) => typeof id === "string")) {
      res.status(400).json({ error: "Invalid request body", details: { workspaceIds: ["Must be an array of UUID strings"] } });
      return;
    }

    const widgetId = req.params.id as string;
    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }
    await prisma.$transaction([
      prisma.widgetWorkspace.deleteMany({ where: { widgetId } }),
      prisma.widgetWorkspace.createMany({
        data: workspaceIds.map((workspaceId: string) => ({ widgetId, workspaceId })),
      }),
    ]);

    res.json({ message: "Workspace whitelist updated" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error updating workspace whitelist", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /widgets/{id}/workspaces:
 *   get:
 *     tags: [Widgets]
 *     summary: List linked workspaces for a widget (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Array of linked workspaces }
 *       404: { description: Widget not found }
 */
// GET /api/widgets/:id/workspaces -- list linked workspaces
router.get("/:id/workspaces", async (req: Request, res: Response) => {
  try {
    const widgetId = req.params.id as string;
    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null },
    });

    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    const workspaces = await prisma.widgetWorkspace.findMany({
      where: { widgetId },
      include: { workspace: { select: { id: true, name: true } } },
    });

    res.json(workspaces);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error listing workspaces", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/widgets/:id/leads -- list leads for a widget (admin only, ADM-04 per D-11)
router.get("/:id/leads", async (req: Request, res: Response) => {
  try {
    const widgetId = req.params.id as string;
    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null },
    });
    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (page - 1) * limit;

    const [leads, total] = await Promise.all([
      prisma.widgetLead.findMany({
        where: { widgetId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          createdAt: true,
          sessionId: true,
        },
      }),
      prisma.widgetLead.count({ where: { widgetId } }),
    ]);

    res.json({ leads, total, page, limit });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error listing leads", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/widgets/:id/leads/export -- CSV export with date filter, column selection (ADM-04 per D-12/D-16)
// Phase 140: commodity flag `lead_export` removed — always-ON.
router.get("/:id/leads/export", async (req: Request, res: Response) => {
  try {
    const widgetId = req.params.id as string;
    const widget = await prisma.widget.findFirst({
      where: { id: widgetId, deletedAt: null },
    });
    if (!widget) {
      res.status(404).json({ error: "Widget not found" });
      return;
    }

    // Parse query params
    const from = req.query.from ? new Date(req.query.from as string) : undefined;
    const to = req.query.to ? new Date(req.query.to as string) : undefined;
    const columnsParam = (req.query.columns as string) || "name,email,transcript,date";

    // Build date filter
    const where: Record<string, unknown> = { widgetId };
    const createdAt: Record<string, unknown> = {};
    if (from) createdAt.gte = from;
    if (to) createdAt.lte = to;
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

    const leads = await prisma.widgetLead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 10000, // Max 10k rows per D-12
    });

    // Column selection
    const selectedColumns = columnsParam.split(",").map(c => c.trim());
    const fields = selectedColumns.map(col => {
      switch (col) {
        case "name":
          return { label: "Name", value: (row: Record<string, unknown>) => (row.name as string) || "" };
        case "email":
          return { label: "Email", value: "email" };
        case "transcript":
          return {
            label: "Transcript",
            value: (row: Record<string, unknown>) => {
              const transcript = row.transcript;
              if (typeof transcript === "string") return transcript.slice(0, 500);
              if (Array.isArray(transcript)) return JSON.stringify(transcript).slice(0, 500);
              return "";
            },
          };
        case "date":
          return { label: "Date", value: (row: Record<string, unknown>) => (row.createdAt as Date).toISOString() };
        default:
          return { label: col, value: col };
      }
    });

    const parser = new Parser({ fields });
    const csv = parser.parse(leads as unknown as Record<string, unknown>[]);

    const filename = `leads-${widgetId}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error exporting leads", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/widgets/:id/leads/:leadId -- view single lead with transcript (ADM-04 per D-11)
router.get("/:id/leads/:leadId", async (req: Request, res: Response) => {
  try {
    const widgetId = req.params.id as string;
    const leadId = req.params.leadId as string;

    const lead = await prisma.widgetLead.findFirst({
      where: { id: leadId, widgetId },
    });

    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    res.json(lead);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    logger.error("[widgets] Error getting lead", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
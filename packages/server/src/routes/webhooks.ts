// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireAdmin } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { Prisma } from "@prisma/client";

const router = Router();

// All webhook management requires admin access (Phase 140: commodity flag
// `webhooks` removed — always-ON; authMiddleware + requireAdmin preserved).
router.use(authMiddleware, tenantContextMiddleware, requireAdmin);

// GET /api/webhooks — list all webhooks
router.get("/", async (_req: Request, res: Response) => {
  try {
    const webhooks = await prisma.webhook.findMany({
      orderBy: { createdAt: "desc" as const },
    });
    // Parse events JSON for each webhook
    const parsed = webhooks.map((wh) => ({
      ...wh,
      events: JSON.parse(wh.events),
    }));
    res.json(parsed);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/webhooks — create a new webhook
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, url, events, secret } = req.body;

    if (!name || !url || !events || !Array.isArray(events)) {
      res.status(400).json({ error: "name, url, and events array are required" });
      return;
    }

    const webhook = await prisma.webhook.create({
      data: {
        name,
        url,
        events: JSON.stringify(events),
        secret: secret || null,
        createdBy: req.userId!,
        // CR-03 (185-05, D-04): explicit org stamp (Webhook is Tier-A).
        organizationId: req.organizationId!,
      },
    });

    res.status(201).json({
      ...webhook,
      events: JSON.parse(webhook.events),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// PUT /api/webhooks/:webhookId — update a webhook
router.put("/:webhookId", async (req: Request, res: Response) => {
  try {
    const webhookId = req.params.webhookId as string;
    const { name, url, events, secret, enabled } = req.body;

    const data: Prisma.WebhookUpdateInput = {};
    if (name !== undefined) data.name = name;
    if (url !== undefined) data.url = url;
    if (events !== undefined) data.events = JSON.stringify(events);
    if (secret !== undefined) data.secret = secret;
    if (enabled !== undefined) data.enabled = enabled;

    const webhook = await prisma.webhook.update({
      where: { id: webhookId },
      data,
    });

    res.json({
      ...webhook,
      events: JSON.parse(webhook.events),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/webhooks/:webhookId — delete a webhook
router.delete("/:webhookId", async (req: Request, res: Response) => {
  try {
    const webhookId = req.params.webhookId as string;
    await prisma.webhook.delete({ where: { id: webhookId } });
    res.json({ message: "Webhook deleted" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// POST /api/webhooks/:webhookId/test — send a test payload
router.post("/:webhookId/test", async (req: Request, res: Response) => {
  try {
    const webhookId = req.params.webhookId as string;
    const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } });

    // T-185-10 org assertion (Pitfall-2 grep-gate, option b): cross-org
    // webhook hides as 404 — fail-closed, never 403 (existence leak).
    if (!webhook || webhook.organizationId !== req.organizationId) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    // Import and dispatch a test event
    const { dispatchWebhookEvent } = await import("../services/webhookService");
    dispatchWebhookEvent("webhook.test", {
      message: "This is a test webhook delivery",
      webhookId,
      triggeredBy: req.userId!,
    }).catch(() => {});

    res.json({ message: "Test webhook dispatched" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import {
  wikiWritePreviewSchema,
  wikiWriteApproveRejectSchema,
  wikiDistillSchema,
} from "@simmetric-chat/shared";
import {
  generatePreview,
  applyWikiEdit,
  revertWikiEdit,
} from "../services/wikiWriteService";
import { createPage } from "../services/archivePageService";
import { resolveProviderConfig } from "../services/providerService";
import { streamLLM } from "../agent/llmStreaming";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";

const router = Router();

// All wiki-write endpoints require authentication
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Iterative Summarization Helpers
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 20;
const TOKEN_CHUNK_TARGET = 3000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function summarizeChunk(
  chunkText: string,
  chunkIndex: number,
  totalChunks: number,
  title: string,
  providerConfig: Awaited<ReturnType<typeof resolveProviderConfig>>,
): Promise<string> {
  const systemPrompt = `You are summarizing part ${chunkIndex + 1} of ${totalChunks} of a conversation for a wiki page titled "${title}". Extract key entities, concepts, and decisions from this section. Output a concise Markdown summary. Use [[wikilinks]] for important terms. Do NOT simply repeat the conversation — synthesize the information.`;

  const result = await streamLLM(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: chunkText },
    ],
    providerConfig!,
    () => {},
  );
  return result.content;
}

async function mergeSummaries(
  summaries: string[],
  title: string,
  providerConfig: Awaited<ReturnType<typeof resolveProviderConfig>>,
): Promise<string> {
  const systemPrompt = `You are merging multiple partial summaries of a conversation into a single comprehensive wiki page titled "${title}". Combine the following summaries into a well-structured Markdown wiki page covering entities, concepts, and decisions. Use [[wikilinks]] where appropriate. Remove redundant information.`;

  const combinedSummaries = summaries
    .map((s, i) => `## Summary Part ${i + 1}\n\n${s}`)
    .join("\n\n---\n\n");

  const result = await streamLLM(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: combinedSummaries },
    ],
    providerConfig!,
    () => {},
  );
  return result.content;
}

async function iterativeSummarize(
  messages: Array<{ role: string; content: string }>,
  title: string,
  providerConfig: Awaited<ReturnType<typeof resolveProviderConfig>>,
): Promise<string> {
  const fullText = messages
    .map((m) => `**${m.role}**: ${m.content}`)
    .join("\n\n");

  if (estimateTokens(fullText) <= TOKEN_CHUNK_TARGET) {
    const systemPrompt = `Summarize the following conversation into a well-structured Markdown wiki page titled "${title}". Include key concepts, decisions, and entities discussed. Use wikilinks [[like this]] where appropriate. Do NOT simply repeat the conversation — synthesize and reorganize the information into a knowledge base article.`;

    const result = await streamLLM(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: fullText },
      ],
      providerConfig!,
      () => {},
    );

    if (!result.content || result.content.trim().length === 0) {
      return formatConversationAsWikiPage(messages, title);
    }
    if (looksLikeRawConversation(result.content, messages)) {
      logger.warn("[wiki-write] LLM output looks like raw conversation, using fallback format");
      return formatConversationAsWikiPage(messages, title);
    }
    return result.content;
  }

  const chunks: Array<Array<{ role: string; content: string }>> = [];
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    chunks.push(messages.slice(i, i + CHUNK_SIZE));
  }

  logger.info("[wiki-write] Distilling in chunks", {
    totalChunks: chunks.length,
    totalMessages: messages.length,
  });

  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i]!
      .map((m) => `**${m.role}**: ${m.content}`)
      .join("\n\n");
    const summary = await summarizeChunk(
      chunkText,
      i,
      chunks.length,
      title,
      providerConfig,
    );
    chunkSummaries.push(summary);
  }

  return mergeSummaries(chunkSummaries, title, providerConfig);
}

function formatConversationAsWikiPage(
  messages: Array<{ role: string; content: string }>,
  title: string,
): string {
  const lines = [`# ${title}\n`];
  for (const m of messages) {
    const label = m.role === "assistant" ? "Assistant" : m.role === "user" ? "User" : "System";
    lines.push(`## ${label}\n\n${m.content}\n`);
  }
  return lines.join("\n");
}

function looksLikeRawConversation(
  llmOutput: string,
  messages: Array<{ role: string; content: string }>,
): boolean {
  const output = llmOutput.toLowerCase();
  let rawMatches = 0;
  for (const m of messages) {
    const content = m.content.trim();
    if (content.length < 20) continue;
    const snippet = content.slice(0, Math.min(content.length, 60)).toLowerCase();
    if (output.includes(snippet)) {
      rawMatches++;
    }
  }
  return rawMatches >= Math.ceil(messages.length * 0.5);
}

// ===========================================================================
// POST /api/wiki-write/preview — Generate a dry-run preview
// ===========================================================================

/**
 * @openapi
 * /wiki-write/preview:
 *   post:
 *     tags: [Wiki]
 *     summary: Generate a dry-run preview of a wiki edit
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [archiveId, slug, title, content, action]
 *             properties:
 *               archiveId: { type: string, format: uuid }
 *               slug: { type: string }
 *               title: { type: string }
 *               content: { type: string }
 *               action: { type: string, enum: [create, update] }
 *               category: { type: string, enum: [entities, concepts, decisions], default: entities }
 *     responses:
 *       201:
 *         description: Preview created
 *       400: { description: Invalid request }
 *       500: { description: Internal error }
 */
router.post(
  "/preview",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const parsed = wikiWritePreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { archiveId, slug, content, action } = parsed.data;

      const run = await generatePreview(
        archiveId,
        slug,
        content,
        req.userId!,
        action,
      );

      logger.info("[wiki-write] Preview generated", {
        runId: run.id,
        archiveId,
        slug,
      });

      res.status(201).json(run);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[wiki-write] POST /preview error", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/wiki-write/:runId/approve — Apply a pending wiki edit
// ===========================================================================

/**
 * @openapi
 * /wiki-write/{runId}/approve:
 *   post:
 *     tags: [Wiki]
 *     summary: Apply a pending wiki edit
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: runId, in: path, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [runId]
 *             properties:
 *               runId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Edit applied
 *       400: { description: Invalid request or run status }
 *       404: { description: Run not found }
 *       500: { description: Internal error }
 */
router.post(
  "/:runId/approve",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);

      // Validate param
      z.string().uuid().parse(runId);

      // Validate request body
      const parsed = wikiWriteApproveRejectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      // Load the WikiEditRun with ownership verification
      const run = await prisma.wikiEditRun.findFirst({
        where: {
          id: runId,
          archive: { createdBy: req.userId! },
        },
      });

      if (!run) {
        res.status(404).json({ error: "Wiki edit run not found" });
        return;
      }

      if (run.status !== "PENDING" && run.status !== "APPROVED") {
        res.status(400).json({
          error: "Only pending or approved runs can be applied",
        });
        return;
      }

      const result = await applyWikiEdit(runId, req.userId!);

      // Log event (fire-and-forget)
      logEvent("wiki_edit", runId, "wiki_edit.approved", req.userId!, {
        archiveId: run.archiveId,
        pageSlug: run.pageSlug,
      }).catch((err: Error) =>
        logger.error("[wiki-write] Failed to log approval event", {
          error: err.message,
        }),
      );

      logger.info("[wiki-write] Edit approved", {
        runId,
        archiveId: run.archiveId,
        pageSlug: run.pageSlug,
      });

      res.json({ success: true, commitHash: result.commitHash });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[wiki-write] POST /:runId/approve error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/wiki-write/:runId/reject — Reject a pending wiki edit
// ===========================================================================

/**
 * @openapi
 * /wiki-write/{runId}/reject:
 *   post:
 *     tags: [Wiki]
 *     summary: Reject a pending wiki edit
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: runId, in: path, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [runId]
 *             properties:
 *               runId: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Edit rejected
 *       400: { description: Invalid request or run status }
 *       404: { description: Run not found }
 *       500: { description: Internal error }
 */
router.post(
  "/:runId/reject",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);

      // Validate param
      z.string().uuid().parse(runId);

      // Validate request body
      const parsed = wikiWriteApproveRejectSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      // Load the WikiEditRun with ownership verification
      const run = await prisma.wikiEditRun.findFirst({
        where: {
          id: runId,
          archive: { createdBy: req.userId! },
        },
      });

      if (!run) {
        res.status(404).json({ error: "Wiki edit run not found" });
        return;
      }

      if (run.status !== "PENDING") {
        res.status(400).json({ error: "Only pending runs can be rejected" });
        return;
      }

      await prisma.wikiEditRun.update({
        where: { id: runId },
        data: { status: "REJECTED" },
      });

      // Log event (fire-and-forget)
      logEvent("wiki_edit", runId, "wiki_edit.rejected", req.userId!, {
        archiveId: run.archiveId,
        pageSlug: run.pageSlug,
      }).catch((err: Error) =>
        logger.error("[wiki-write] Failed to log rejection event", {
          error: err.message,
        }),
      );

      logger.info("[wiki-write] Edit rejected", {
        runId,
        archiveId: run.archiveId,
        pageSlug: run.pageSlug,
      });

      res.json({ message: "Edit rejected" });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[wiki-write] POST /:runId/reject error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/wiki-write/:runId/undo — Revert an applied wiki edit
// ===========================================================================

/**
 * @openapi
 * /wiki-write/{runId}/undo:
 *   post:
 *     tags: [Wiki]
 *     summary: Revert an applied wiki edit
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: runId, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: Edit reverted
 *       400: { description: Invalid request or run status }
 *       404: { description: Run not found }
 *       500: { description: Internal error }
 */
router.post(
  "/:runId/undo",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const runId = String(req.params.runId);

      // Validate runId UUID
      z.string().uuid().parse(runId);

      // Load the WikiEditRun with ownership verification
      const run = await prisma.wikiEditRun.findFirst({
        where: {
          id: runId,
          archive: { createdBy: req.userId! },
        },
      });

      if (!run) {
        res.status(404).json({ error: "Wiki edit run not found" });
        return;
      }

      if (run.status !== "APPLIED") {
        res.status(400).json({ error: "Only applied runs can be undone" });
        return;
      }

      const previewJson = run.previewJson as Record<string, any>;
      if (!previewJson?.commitHash) {
        res.status(400).json({ error: "Run has no commit hash to revert" });
        return;
      }

      await revertWikiEdit(runId, req.userId!);

      // Log event (fire-and-forget)
      logEvent("wiki_edit", runId, "wiki_edit.undone", req.userId!, {
        archiveId: run.archiveId,
        pageSlug: run.pageSlug,
      }).catch((err: Error) =>
        logger.error("[wiki-write] Failed to log undo event", {
          error: err.message,
        }),
      );

      logger.info("[wiki-write] Edit undone", {
        runId,
        archiveId: run.archiveId,
        pageSlug: run.pageSlug,
      });

      res.json({ success: true });
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[wiki-write] POST /:runId/undo error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// GET /api/wiki-write/history/:archiveId — List wiki edit history
// ===========================================================================

/**
 * @openapi
 * /wiki-write/history/{archiveId}:
 *   get:
 *     tags: [Wiki]
 *     summary: List wiki edit history for an archive
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: archiveId, in: path, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200:
 *         description: List of wiki edit runs
 *       400: { description: Invalid archive ID }
 *       500: { description: Internal error }
 */
router.get(
  "/history/:archiveId",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const archiveId = String(req.params.archiveId);

      // Validate archiveId UUID
      z.string().uuid().parse(archiveId);

      const runs = await prisma.wikiEditRun.findMany({
        where: {
          archiveId,
          createdBy: req.userId!,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      res.json(runs);
    } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
      logger.error("[wiki-write] GET /history/:archiveId error", {
        error: message,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// POST /api/wiki-write/distill — Convert a chat conversation into a wiki page
// ===========================================================================

/**
 * @openapi
 * /wiki-write/distill:
 *   post:
 *     tags: [Wiki]
 *     summary: Convert a chat conversation into a wiki page
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [archiveId, title, chatId]
 *             properties:
 *               archiveId: { type: string, format: uuid }
 *               title: { type: string }
 *               category: { type: string, enum: [entities, concepts, decisions], default: entities }
 *               chatId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Wiki page created from conversation
 *       400: { description: Invalid request }
 *       404: { description: Archive or chat not found }
 *       503: { description: No LLM provider configured }
 *       500: { description: Internal error }
 */
router.post(
  "/distill",
  requirePermission("archive:write"),
  async (req: Request, res: Response) => {
    try {
      const parsed = wikiDistillSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { archiveId, title, category, chatId, messageIds } = parsed.data;

      // Verify archive ownership
      const archive = await prisma.archive.findFirst({
        where: { id: archiveId, createdBy: req.userId!, deletedAt: null },
      });
      if (!archive) {
        res.status(404).json({ error: "Archive not found" });
        return;
      }

      // Fetch chat messages: filtered by messageIds or last 100
      let messages;
      if (messageIds && messageIds.length > 0) {
        messages = await prisma.chatMessage.findMany({
          where: { chatId, id: { in: messageIds } },
          orderBy: { createdAt: "asc" },
        });
      } else {
        messages = await prisma.chatMessage.findMany({
          where: { chatId },
          orderBy: { createdAt: "asc" },
          take: 100,
        });
      }

      if (!messages.length) {
        res.status(404).json({ error: "No messages found for this chat" });
        return;
      }

      // Resolve LLM provider config
      const providerConfig = await resolveProviderConfig();
      if (!providerConfig) {
        res.status(503).json({ error: "No LLM provider configured" });
        return;
      }

      // Generate wiki content via iterative summarization
      const generatedContent = await iterativeSummarize(
        messages.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content })),
        title,
        providerConfig,
      );

      // Create the wiki page
      const page = await createPage(
        archiveId,
        { title, content: generatedContent, category },
        req.userId!,
      );

      // Log event (fire-and-forget)
      logEvent("wiki_edit", page.id, "wiki.distilled", req.userId!, {
        archiveId,
        chatId,
      }).catch((err: Error) =>
        logger.error("[wiki-write] Failed to log distill event", {
          error: err.message,
        }),
      );

      logger.info("[wiki-write] Distilled page created", {
        pageId: page.id,
        archiveId,
        chatId,
      });

      res.status(201).json(page);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[wiki-write] POST /distill error", { error: message });

      const errorMessage = message || "";
      if (errorMessage.includes("HTTP 400") || errorMessage.includes("context window")) {
        res.status(400).json({
          error:
            "The conversation is too long for the current model's context window. Try selecting fewer messages.",
        });
      } else if (
        errorMessage.includes("CLOUD_MODEL_AUTH_FAILED") ||
        errorMessage.includes("CLOUD_MODEL_OFFLINE")
      ) {
        res.status(502).json({ error: errorMessage });
      } else if (
        errorMessage.includes("not found") ||
        errorMessage.includes("Run 'ollama pull'")
      ) {
        res.status(503).json({ error: errorMessage });
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  },
);

export default router;

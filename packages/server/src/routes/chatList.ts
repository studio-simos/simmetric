// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requireWorkspaceAccess } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { parseMetadata } from "../utils/parseMetadata";
import { chatListQuerySchema } from "@simmetric-chat/shared";
import {
  sendError,
  sendInternalServerError,
  encodeCursor,
  decodeCursor,
  keysetWhere,
} from "../utils/httpError";

const router = Router();
router.use(authMiddleware);
// Phase 185 (D-09): chain order auth → tenant → permission. The tenant
// middleware resolves req.organizationId (D-01 membership lookup) and opens
// the ALS tenant run before any rbac/license gate.
router.use(tenantContextMiddleware);

// GET /api/workspaces/:workspaceId/chats — list chats in workspace
/**
 * @openapi
 * /workspaces/{workspaceId}/chats:
 *   get:
 *     tags: [Chat]
 *     summary: List chats in a workspace (workspace-access gated)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: workspaceId
 *         in: path
 *         required: true
 *         schema: { type: string }
 *       - name: limit
 *         in: query
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *       - name: cursor
 *         in: query
 *         schema: { type: string }
 *         description: "Opaque keyset cursor (base64url v1|updatedAt|id)"
 *     responses:
 *       200: { description: "Legacy bare array OR the items/nextCursor envelope in cursor mode" }
 *       400: { description: Invalid query parameters or cursor }
 *       403: { description: Not a workspace member }
 */
router.get("/:workspaceId/chats", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;

  try {
    // api-design sweep (2026-09-24): opt-in keyset pagination (documents.list
    // twin). No query params → legacy bare array (byte-identical); `cursor`
    // or `limit` → {items, nextCursor} envelope. Keyset on (updatedAt DESC,
    // id DESC) — the id tiebreaker makes the order total.
    const listQuery = chatListQuerySchema.safeParse(req.query);
    if (!listQuery.success) {
      sendError(res, 400, "invalid_query", "Invalid query parameters", listQuery.error.flatten().fieldErrors);
      return;
    }
    const { cursor, limit: rawLimit } = listQuery.data;
    const envelopeMode = cursor !== undefined || rawLimit !== undefined;
    const limit = rawLimit ?? 50;

    const where: Record<string, unknown> = { workspaceId, deletedAt: null };
    let cursorWhere: Record<string, unknown> | null = null;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        sendError(res, 400, "invalid_cursor", "Invalid cursor");
        return;
      }
      cursorWhere = keysetWhere("updatedAt", decoded);
    }

    const chats = await prisma.chat.findMany({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cursor-mode AND-composition over the typed base where
      where: cursorWhere ? ({ AND: [cursorWhere, where] } as any) : (where as any),
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }] as const,
      take: envelopeMode ? limit : undefined,
      include: {
        _count: { select: { messages: true } },
        pins: { where: { userId: req.userId! } },
        // Phase 199 (ECCO-05 §7.9-1, D-10): zero-migration platform badge join —
        // the include is transitive and tenant-safe (the route sits behind
        // requireWorkspaceAccess) and the select narrows to `platform` only, so
        // no connector secret column is reachable through the projection
        // (T-199-12 mitigation).
        connectorSessions: {
          include: { connector: { select: { platform: true } } },
        },
      },
    });
    const rows = chats.map(
      (c: {
        _count: { messages: number };
        pins: unknown[];
        connectorSessions?: { connector?: { platform: string | null } }[];
      }) => ({
        ...c,
        isPinned: c.pins.length > 0,
        messageCount: c._count.messages,
        // D-10 nullable mapping: a chat with zero connector sessions (every
        // human-created chat) serializes null — the response shape stays
        // byte-identical for non-connector chats apart from the additive
        // null field, and nothing rides the row that can't render.
        connectorPlatform:
          c.connectorSessions?.[0]?.connector?.platform ?? null,
      }),
    );
    if (!envelopeMode) {
      res.json(rows);
      return;
    }
    const last = chats[chats.length - 1];
    const nextCursor = chats.length === limit && last ? encodeCursor(last.updatedAt, last.id) : null;
    res.json({ items: rows, nextCursor });
  } catch (err: unknown) {
    sendInternalServerError(res, err);
  }
});

// GET /api/workspaces/:workspaceId/chats/:chatId/messages — get chat messages
router.get("/:workspaceId/chats/:chatId/messages", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const chatId = req.params.chatId as string;

  try {
    const messages = await prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: "asc" } as const,
    });

    // Resolve attached document names
    const docIds = messages.map((m: { attachedDocumentId: string | null }) => m.attachedDocumentId).filter((id): id is string => id !== null);
    const docs = docIds.length > 0
      ? await prisma.document.findMany({
          where: { id: { in: docIds }, deletedAt: null },
          select: { id: true, name: true },
        })
      : [];
    const docMap = new Map(docs.map((d) => [d.id, d.name]));

    // Parse metadata JSON for each message.
    // CSW-04: parseMetadata never returns null (it returns {} on bad/empty
    // JSON), but the ternary preserves the "no metadata column → null" shape
    // callers expect (absent vs. empty metadata).
    const parsed = messages.map((m: { attachedDocumentId: string | null; metadata: string | null }) => ({
      ...m,
      metadata: m.metadata ? parseMetadata(m.metadata) : null,
      attachedDocumentName: m.attachedDocumentId ? docMap.get(m.attachedDocumentId) || null : null,
    }));

    res.json(parsed);
  } catch (err: unknown) {
    res.status(500).json({ error: (err instanceof Error ? err.message : String(err)) });
  }
});

export default router;

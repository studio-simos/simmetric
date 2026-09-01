// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { authMiddleware } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";
import {
  createMemorySchema,
  updateMemorySchema,
  memoryIdParamSchema,
  memoryExportQuerySchema,
  memoryListQuerySchema,
} from "@simmetric-chat/shared";

const router = Router();

/**
 * Phase 97 (MEM-01 D-03 + D-08) — per-user-per-workspace Memory CRUD + GDPR.
 *
 * Pitfall 3 invariants enforced here:
 *   * IDOR workspace-scoped: every query filters `where: { userId: req.userId!, workspaceId }`.
 *     A user can only ever read/modify their own memories; cross-user access is
 *     structurally impossible even if the user guesses another user's memory id.
 *   * `embedding` (Unsupported("vector(384)?")) is NEVER pulled back via `findMany`/
 *     `findUnique` without a `select` that excludes it — Prisma cannot deserialize
 *     the column and would throw at runtime (RESEARCH §Common Pitfalls). Every
 *     read query below uses an explicit `select` listing only non-embedding fields.
 *   * GDPR export/erase (GET /export, DELETE /) are NOT license-gated — they are a
 *     legal right, not an enterprise feature (D-08). They span ALL the user's
 *     workspaces (per-user, not per-workspace — GDPR right to access/erasure is total).
 *   * Phase 140 (EPA-02): commodity feature gates removed. `memory_enabled` and
 *     `max_memories_per_user` are no longer in `FEATURE_FLAGS` — memory CRUD is
 *     always-ON in community builds. The old `requireFeature("memory_enabled")`
 *     middleware and the inline `enforceMemoryLimit` count check were removed.
 *     GET / and GET /:id remain NOT auth-gated beyond `authMiddleware` (users can
 *     always review what's been stored — read is a privacy right, not a feature).
 */

/** Non-embedding fields — every read query uses this `select` to avoid Prisma's
 *  Unsupported-column deserialize error. `embedding` is write-only (via $executeRaw). */
const MEMORY_SELECT = {
  id: true,
  userId: true,
  workspaceId: true,
  type: true,
  path: true,
  content: true,
  sourceMessageId: true,
  sensitivity: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Verify the authenticated user can access the given workspace (IDOR defense). */
async function userCanAccessWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  // The user owns the parent project, OR has explicit WorkspaceAccess, OR has
  // ProjectAccess on the parent project. Admins are short-circuited by the
  // `requirePermission("memory:write")` check already having passed; we still
  // verify access here so an admin can manage memories in any workspace.
  const ws = await prisma.workspace.findFirst({
    where: { id: workspaceId, deletedAt: null },
    include: { project: true },
  });
  if (!ws) return false;
  if (ws.project?.createdBy === userId) return true;
  const [wsAccess, projAccess] = await Promise.all([
    prisma.workspaceAccess.findFirst({ where: { userId, workspaceId } }),
    prisma.projectAccess.findFirst({ where: { userId, projectId: ws.project?.id ?? "" } }),
  ]);
  return Boolean(wsAccess || projAccess);
}

/** Enforce `max_memories_per_user` — REMOVED in Phase 140 (D-11).
 * Commodity features are always-ON in community; the numeric cap is gone
 * entirely. The enterprise override path is Phase 147 (`ctx.overrideFeatureLimit`). */

// ===== GDPR routes — registered BEFORE /:id so "export" is not matched as an id =====

/**
 * @openapi
 * /memories/export:
 *   get:
 *     tags: [Memory]
 *     summary: GDPR right to access — export all the user's memories across all workspaces (JSON)
 *     description: Returns every memory authored by the authenticated user, across all workspaces. NOT license-gated (legal right, not a feature).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: format
 *         in: query
 *         schema: { type: string, enum: [json, csv], default: json }
 *     responses:
 *       200: { description: All the user's memories (excludes the embedding column) }
 *       401: { description: Authentication required }
 */
router.get("/export", authMiddleware, async (req: Request, res: Response) => {
  try {
    const parsed = memoryExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const userId = req.userId!;
    const memories = await prisma.memory.findMany({
      where: { userId },
      select: MEMORY_SELECT,
      orderBy: { createdAt: "desc" },
    });
    await logEvent("memory", userId, "gdpr.export", userId, { count: memories.length });
    if (parsed.data.format === "csv") {
      // Minimal CSV — the JSON shape is the canonical GDPR export; CSV is a
      // user-friendly follow-up. Escape per RFC 4180 (quotes doubled, comma-delimited).
      const header = "id,userId,workspaceId,type,path,content,sourceMessageId,sensitivity,createdAt,updatedAt\n";
      const escape = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const rows = memories.map((m) =>
        [m.id, m.userId, m.workspaceId, m.type, m.path ?? "", m.content, m.sourceMessageId ?? "", m.sensitivity, m.createdAt.toISOString(), m.updatedAt.toISOString()]
          .map(escape).join(","),
      ).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=\"memories.csv\"");
      res.status(200).send(header + rows);
      return;
    }
    res.status(200).json({ memories, count: memories.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[memories] Error exporting memories", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /memories:
 *   delete:
 *     tags: [Memory]
 *     summary: GDPR right to erasure — erase ALL the user's memories across all workspaces
 *     description: Deletes every memory authored by the authenticated user, across all workspaces. NOT license-gated (legal right). Returns the count erased.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: All memories erased, returns count }
 *       401: { description: Authentication required }
 */
router.delete("/", authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const result = await prisma.memory.deleteMany({ where: { userId } });
    await logEvent("memory", userId, "gdpr.erase", userId, { count: result.count });
    res.status(200).json({ message: "All memories erased", count: result.count });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[memories] Error erasing all memories", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== CRUD routes — IDOR-scoped reads, always-ON writes (Phase 140 EPA-02 removed commodity gating) =====

/**
 * @openapi
 * /memories:
 *   get:
 *     tags: [Memory]
 *     summary: List the user's memories in a workspace (paginated)
 *     description: Returns memories authored by the authenticated user, scoped to the given workspace. IDOR — the userId filter is load-bearing (cross-user isolation).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: workspaceId
 *         in: query
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: limit
 *         in: query
 *         schema: { type: number, default: 50, minimum: 1, maximum: 100 }
 *       - name: offset
 *         in: query
 *         schema: { type: number, default: 0, minimum: 0 }
 *     responses:
 *       200: { description: User's memories in the workspace (excludes embedding column) }
 *       400: { description: Invalid query parameters }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 */
router.get("/", authMiddleware, requirePermission("memory:read"), async (req: Request, res: Response) => {
  try {
    const parsed = memoryListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { workspaceId, limit, offset } = parsed.data;
    const userId = req.userId!;
    const [memories, count] = await Promise.all([
      prisma.memory.findMany({
        where: { userId, workspaceId },
        select: MEMORY_SELECT,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.memory.count({ where: { userId, workspaceId } }),
    ]);
    await logEvent("memory", userId, "list", null, { workspaceId, count });
    res.status(200).json({ memories, count });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[memories] Error listing memories", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /memories:
 *   post:
 *     tags: [Memory]
 *     summary: Create a user-edited memory
 *     description: Creates a memory authored by the authenticated user, scoped to a workspace. `sourceMessageId` is null (user-edited — embeddings come from auto-extraction in 97-03). Always-ON since Phase 140 (EPA-02 — `memory_enabled` commodity gate removed). A path change conflicting with the unique constraint returns 409.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId: { type: string, format: uuid }
 *               type: { type: string, enum: [user, context] }
 *               path: { type: string, nullable: true, description: "Dotted path, e.g. preferences.theme" }
 *               content: { type: string, minLength: 1, maxLength: 5000 }
 *               sensitivity: { type: string, enum: [low, medium, high], default: low }
 *     responses:
 *       201: { description: Memory created (excludes embedding column) }
 *       400: { description: Invalid request body }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions or workspace access denied }
 *       409: { description: A memory with this path already exists for this user in this workspace }
 */
router.post("/", authMiddleware, requirePermission("memory:write"), async (req: Request, res: Response) => {
  try {
    const parsed = createMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const userId = req.userId!;
    const { workspaceId, type, path, content, sensitivity } = parsed.data;

    // IDOR: verify the user can access the target workspace before writing into it.
    if (!(await userCanAccessWorkspace(userId, workspaceId))) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }

    // Phase 140 (D-11): the per-user max_memories_per_user cap is removed —
    // memory is always-ON with no count limit in community. Enterprise
    // override arrives in Phase 147 via ctx.overrideFeatureLimit.

    try {
      // Prisma does NOT expose `create`/`createMany` on models with non-nullable
      // `Unsupported` columns (the `embedding vector(384)?` column can't be typed
      // in Prisma's create API — only `findMany`/`update`/`deleteMany` are
      // generated). Writes go through `$executeRaw` INSERT; the row is then
      // fetched via `findUnique` with an explicit `select` that EXCLUDES the
      // embedding column (Unsupported columns can't be deserialized by Prisma).
      // 97-03 writes the embedding separately via `$executeRaw` UPDATE.
      const id = crypto.randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "memories"
          ("id", "userId", "workspaceId", "type", "path", "content", "sourceMessageId", "sensitivity", "createdAt", "updatedAt")
        VALUES
          (${id}, ${userId}, ${workspaceId}, ${type}::"MemoryType", ${path}, ${content}, NULL, ${sensitivity}::"MemorySensitivity", NOW(), NOW())
      `;
      const memory = await prisma.memory.findUnique({ where: { id }, select: MEMORY_SELECT });
      // `memory` is non-null — we just created it. Defensive fallback for TS.
      if (!memory) {
        res.status(500).json({ error: "Internal server error" });
        return;
      }
      await logEvent("memory", userId, "create", memory.id, { workspaceId, path, type });
      res.status(201).json(memory);
    } catch (err: unknown) {
      // P2002 = unique constraint violation on @@unique([userId, workspaceId, path])
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        res.status(409).json({ error: "A memory with this path already exists for this user in this workspace" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[memories] Error creating memory", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /memories/{id}:
 *   get:
 *     tags: [Memory]
 *     summary: Get a single memory by id (IDOR ownership-checked)
 *     description: Returns the memory if it belongs to the authenticated user. Cross-user access returns 404 (not 403, to avoid leaking existence).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: The memory (excludes embedding column) }
 *       400: { description: Invalid id }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       404: { description: Memory not found (or belongs to another user) }
 */
router.get("/:id", authMiddleware, requirePermission("memory:read"), async (req: Request, res: Response) => {
  try {
    const parsed = memoryIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid memory ID", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const userId = req.userId!;
    const memory = await prisma.memory.findFirst({
      where: { id: parsed.data.id, userId }, // IDOR: userId filter load-bearing
      select: MEMORY_SELECT,
    });
    if (!memory) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.status(200).json(memory);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[memories] Error getting memory", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /memories/{id}:
 *   patch:
 *     tags: [Memory]
 *     summary: Update a memory's content/path/type/sensitivity (IDOR ownership-checked)
 *     description: Updates a memory owned by the authenticated user. At least one field must be provided. Always-ON since Phase 140 (EPA-02 — `memory_enabled` commodity gate removed). A path change conflicting with the unique constraint returns 409.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type: { type: string, enum: [user, context] }
 *               path: { type: string, nullable: true }
 *               content: { type: string, minLength: 1, maxLength: 5000 }
 *               sensitivity: { type: string, enum: [low, medium, high] }
 *     responses:
 *       200: { description: Updated memory (excludes embedding column) }
 *       400: { description: Invalid body or no fields provided }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       404: { description: Memory not found (or belongs to another user) }
 *       409: { description: Path conflict with an existing memory for this user/workspace }
 */
router.patch("/:id", authMiddleware, requirePermission("memory:write"), async (req: Request, res: Response) => {
  try {
    const parsedParams = memoryIdParamSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({ error: "Invalid memory ID", details: parsedParams.error.flatten().fieldErrors });
      return;
    }
    const parsed = updateMemorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const userId = req.userId!;
    const existing = await prisma.memory.findFirst({
      where: { id: parsedParams.data.id, userId }, // IDOR: load-bearing userId filter
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    try {
      const updated = await prisma.memory.update({
        where: { id: existing.id },
        data: parsed.data,
        select: MEMORY_SELECT,
      });
      await logEvent("memory", userId, "update", existing.id, { fields: Object.keys(parsed.data) });
      res.status(200).json(updated);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        res.status(409).json({ error: "Path conflict with an existing memory for this user/workspace" });
        return;
      }
      throw err;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[memories] Error updating memory", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * @openapi
 * /memories/{id}:
 *   delete:
 *     tags: [Memory]
 *     summary: Delete a single memory (IDOR ownership-checked)
 *     description: Deletes a memory owned by the authenticated user. Always-ON since Phase 140 (EPA-02 — `memory_enabled` commodity gate removed).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Deleted successfully }
 *       400: { description: Invalid id }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 *       404: { description: Memory not found (or belongs to another user) }
 */
router.delete("/:id", authMiddleware, requirePermission("memory:write"), async (req: Request, res: Response) => {
  try {
    const parsed = memoryIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid memory ID", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const userId = req.userId!;
    const existing = await prisma.memory.findFirst({
      where: { id: parsed.data.id, userId }, // IDOR: load-bearing userId filter
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    await prisma.memory.delete({ where: { id: existing.id } });
    await logEvent("memory", userId, "delete", existing.id, {});
    res.status(200).json({ message: "Deleted successfully" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[memories] Error deleting memory", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
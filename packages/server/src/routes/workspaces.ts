// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { scopeToOrg } from "../utils/tenantContext";
// Phase 189 (D-13, Plan 04 gate swap): the graded requireWorkspaceWriteAccess
// is the SOLE enforcement gate on the swept write routes (the binary
// requireWorkspaceAccess gate retired at the flip — flag persisted "true" via
// scripts/set-workspace-role-enforcement.cjs). GET routes + the access trio
// (grant/bulk/list/revoke) keep requireWorkspaceAccess: reads are binary
// (viewer+), and the access endpoints carry their in-handler owner-or-admin
// gate. GET /api/workspaces is the OR-filter list — never gated.
import {
  requireWorkspaceAccess,
  requirePermission,
  requireAdmin,
  requireWorkspaceWriteAccess,
} from "../middleware/rbac";
import { requireFeatureLimit } from "../middleware/license";
import prisma, { withSoftDelete } from "../utils/prisma";
import { createWorkspaceSchema, updateWorkspaceSchema, createFolderSchema, updateFolderSchema, grantWorkspaceAccessRouteSchema, bulkGrantWorkspaceAccessSchema, permanentDeleteWorkspacesSchema } from "@simmetric-chat/shared";
import { logEvent } from "../services/eventLogService";
import { isAdmin } from "../utils/auth";

const router = Router();

router.use(authMiddleware);
// Phase 185 (D-09): chain order auth → tenant → permission. The tenant
// middleware resolves req.organizationId from the FIRST live membership
// (D-01) and opens the ALS tenant run before any rbac/license gate — the
// tracer slot; the full router sweep is Plan 02.
router.use(tenantContextMiddleware);

/**
 * @openapi
 * /workspaces:
 *   get:
 *     tags: [Workspaces]
 *     summary: List workspaces accessible to the current user
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Array of workspaces }
 */
// GET /api/workspaces — list workspaces accessible to the current user
router.get("/", async (req: Request, res: Response) => {
  try {
    const showDeleted = req.query.deleted === "true";

    let workspaces;
    if (isAdmin(req.user)) {
      workspaces = await prisma.workspace.findMany({
        where: withSoftDelete(showDeleted ? { deletedAt: { not: null } } : { deletedAt: null }),
        include: {
          project: { select: { createdBy: true, name: true, creator: { select: { username: true, firstName: true, lastName: true } } } },
          _count: { select: { chats: true, documents: true } },
          agentConfig: true,
        },
      });
    } else {
      workspaces = await prisma.workspace.findMany({
        where: {
          ...(showDeleted ? { deletedAt: { not: null } } : { deletedAt: null }),
          OR: [
            { project: { createdBy: req.userId! } },
            { accessGrants: { some: { userId: req.userId! } } },
            { project: { accessGrants: { some: { userId: req.userId! } } } },
          ],
        },
        include: {
          project: { select: { createdBy: true, name: true, creator: { select: { username: true, firstName: true, lastName: true } } } },
          _count: { select: { chats: true, documents: true } },
          agentConfig: true,
        },
      });
    }

    res.json(workspaces);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /workspaces:
 *   post:
 *     tags: [Workspaces]
 *     summary: Create a workspace in a project
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, projectId]
 *             properties:
 *               name: { type: string, example: "My Workspace" }
 *               projectId: { type: string }
 *               instructions: { type: string }
 *               embeddingModel: { type: string, example: "Xenova/all-MiniLM-L6-v2" }
 *               templateId: { type: string }
 *               systemPrompt: { type: string }
 *               skills: { type: array, items: { type: string } }
 *     responses:
 *       201: { description: Workspace created }
 *       400: { description: Validation error }
 *       402: { description: Workspace limit reached (Community tier) }
 *       403: { description: Access denied to project }
 *       404: { description: Project not found }
 */
// POST /api/workspaces — create a workspace in a project
router.post("/", requirePermission("workspace:create"), requireFeatureLimit("max_workspaces", "workspace"), async (req: Request, res: Response) => {
  try {
    const validated = createWorkspaceSchema.parse(req.body);

    // Verify user has access to the parent project
    const project = await prisma.project.findFirst({
      where: withSoftDelete({ id: validated.projectId, deletedAt: null }),
    });

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const admin = isAdmin(req.user);
    const isOwner = project.createdBy === req.userId;
    const hasAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: validated.projectId },
    });

    if (!admin && !isOwner && !hasAccess) {
      res.status(403).json({ error: "Access denied to this project" });
      return;
    }

    // Resolve configuration: request body > template > defaults
    let embeddingModel = validated.embeddingModel;
    let systemPrompt: string | undefined;
    let enabledSkills: string | undefined;

    if (validated.templateId) {
      // T-185-10 (Pitfall-2 grep-gate): PK-keyed template lookup restructured
      // to a scoped findFirst — a cross-org templateId resolves null and the
      // create proceeds with defaults (byte-identical to the not-found arm;
      // template was optional before, fail-soft semantics preserved).
      const template = await prisma.workspaceTemplate.findFirst(
        { where: scopeToOrg(req.organizationId!, { id: validated.templateId }) },
      );

      if (template) {
        // Template's embeddingModel overrides the default if set
        if (template.embeddingModel) {
          embeddingModel = template.embeddingModel;
        }
        systemPrompt = template.systemPrompt;
        enabledSkills = template.skills; // already JSON string
      }
    }

    // Request body overrides take precedence over template values
    if (validated.systemPrompt !== undefined) {
      systemPrompt = validated.systemPrompt;
    }
    if (validated.skills !== undefined) {
      enabledSkills = JSON.stringify(validated.skills);
    }
    if (validated.embeddingModel !== undefined && validated.embeddingModel !== "") {
      // User explicitly set an embedding model (or template set one)
      embeddingModel = validated.embeddingModel;
    }

    const workspace = await prisma.workspace.create({
      data: {
        projectId: validated.projectId,
        name: validated.name,
        instructions: validated.instructions,
        embeddingModel,
        templateId: validated.templateId || null,
        allowMemberUploads: validated.allowMemberUploads,
        icon: validated.icon || null,
        // CR-03 (185-05, D-04): explicit org stamp — non-default-org rows
        // must be self-visible and license-counted per-org (the @default
        // alone lands every create in the DEFAULT org, making org-b rows
        // self-invisible and max_workspaces fail-open).
        organizationId: req.organizationId!,
      },
    });

    // Create agent config with resolved configuration
    // T-185-10 disposition (Pitfall-2 grep-gate): parent-verified — the
    // workspace row was created by THIS request (org assigned at create,
    // D-04), so the child upsert cannot cross orgs.
    await prisma.workspaceAgentConfig.upsert({
      where: { workspaceId: workspace.id },
      update: {},
      create: {
        workspaceId: workspace.id,
        systemPrompt: systemPrompt || "You are a helpful AI assistant with access to workspace documents and tools.",
        enabledSkills: enabledSkills || "[\"rag_search\",\"workspace_memory\"]",
        constraints: validated.constraints ? JSON.stringify(validated.constraints) : "{}",
        parsingConfig: validated.parsingConfig ? JSON.stringify(validated.parsingConfig) : "{}",
      },
    });

    await logEvent("workspace", workspace.id, "create", req.userId!);

    // Preventive auto-grant (D-07 follow-up): when the creator is NOT the
    // project owner (e.g. an admin creating inside another admin's project),
    // the strict upload/document gate (assertWorkspaceAccess, D-07 — admins
    // do NOT bypass) would 403 their own first upload. Seed the creator's
    // WorkspaceAccess so the workspace is usable immediately; owner-of-
    // project and admin-with-project-access paths already pass the gate.
    const isProjectOwner = project.createdBy === req.userId;
    const hasProjectAccess = await prisma.projectAccess.findFirst({
      where: { userId: req.userId!, projectId: project.id },
    });
    if (!isProjectOwner && !hasProjectAccess) {
      // Phase 189 (D-12 class): the create arm carries role:"editor" — the
      // auto-grant exists precisely so a non-owner creator can USE the
      // workspace (chat-create/upload, the same ability class pre-phase
      // binary grants carried); Plan 01's migration column default 'viewer'
      // would silently under-grant the creator the moment enforcement
      // flips. Update arm stays empty — the row is fresh by construction
      // (workspace.id was created by THIS request). CR-02: explicit org
      // stamp (same tenant-visibility class as the grant/bulk arms — the
      // workspace row above was stamped req.organizationId at create).
      await prisma.workspaceAccess.upsert({
        where: {
          userId_workspaceId: { userId: req.userId!, workspaceId: workspace.id },
        },
        create: { userId: req.userId!, workspaceId: workspace.id, role: "editor", organizationId: req.organizationId! },
        update: {},
      });
    }

    res.status(201).json(workspace);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "A workspace with this name already exists in this project" });
      return;
    }
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// GET /api/workspaces/:workspaceId — get a specific workspace
router.get("/:workspaceId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: req.params.workspaceId as string, deletedAt: null }),
      include: {
        documents: { where: withSoftDelete({ deletedAt: null }) },
        agentConfig: true,
      },
    });

    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    res.json(workspace);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/workspaces/:workspaceId — update a workspace
router.put("/:workspaceId", requireWorkspaceWriteAccess(), async (req: Request, res: Response) => {
  try {
    const validated = updateWorkspaceSchema.parse(req.body);

    const {
      name,
      instructions,
      embeddingModel,
      allowMemberUploads,
      dlpDocumentScanEnabled,
      icon,
      templateId,
      systemPrompt,
      constraints,
      parsingConfig,
      skills,
    } = validated;

    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId as string },
      data: {
        ...(name !== undefined && { name }),
        ...(instructions !== undefined && { instructions }),
        ...(embeddingModel !== undefined && { embeddingModel }),
        ...(allowMemberUploads !== undefined && { allowMemberUploads }),
        // Phase 192 (D-05): per-workspace document-scan toggle — rides the
        // same conditional-spread as allowMemberUploads. Turning OFF is never
        // blocked (UI-SPEC rule 1 is binding server-side too); the DLP-05
        // eval gate lives on enablement surfaces + the backfill 409, never here.
        ...(dlpDocumentScanEnabled !== undefined && { dlpDocumentScanEnabled }),
        ...(icon !== undefined && { icon }),
        ...(templateId !== undefined && { template: templateId ? { connect: { id: templateId } } : { disconnect: true } }),
      },
    });

    if (systemPrompt !== undefined || skills !== undefined || constraints !== undefined || parsingConfig !== undefined) {
      const agentConfigData: {
        systemPrompt?: string;
        enabledSkills?: string;
        constraints?: string;
        parsingConfig?: string;
      } = {};
      if (systemPrompt !== undefined) agentConfigData.systemPrompt = systemPrompt;
      if (skills !== undefined) agentConfigData.enabledSkills = JSON.stringify(skills) as string;
      if (constraints !== undefined) agentConfigData.constraints = JSON.stringify(constraints);
      if (parsingConfig !== undefined) agentConfigData.parsingConfig = JSON.stringify(parsingConfig);

      // T-185-10 disposition (Pitfall-2 grep-gate): parent-verified — the
      // route chain runs requireWorkspaceWriteAccess on the SAME workspaceId
      // param (scopeToOrg'd workspace read upstream), so the child upsert
      // is org-safe.
      await prisma.workspaceAgentConfig.upsert({
        where: { workspaceId: req.params.workspaceId as string },
        update: agentConfigData,
        create: {
          workspaceId: req.params.workspaceId as string,
          systemPrompt: agentConfigData.systemPrompt ?? "You are a helpful AI assistant with access to workspace documents and tools.",
          enabledSkills: agentConfigData.enabledSkills ?? "[\"rag_search\",\"workspace_memory\"]",
          constraints: agentConfigData.constraints ?? "{}",
          parsingConfig: agentConfigData.parsingConfig ?? "{}",
        },
      });
    }

    await logEvent("workspace", workspace.id, "update", req.userId!);

    res.json(workspace);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "A workspace with this name already exists in this project" });
      return;
    }
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * @openapi
 * /workspaces/permanent:
 *   delete:
 *     tags: [Workspaces]
 *     summary: Permanently delete multiple soft-deleted workspaces (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids: { type: array, items: { type: string } }
 *     responses:
 *       200: { description: Workspaces permanently deleted }
 *       400: { description: Validation error }
 *       403: { description: Admin access required }
 */
router.delete("/permanent", requireAdmin, async (req: Request, res: Response) => {
  try {
    const validated = permanentDeleteWorkspacesSchema.parse(req.body);
    const result = await prisma.workspace.deleteMany({
      where: { id: { in: validated.ids }, deletedAt: { not: null } },
    });

    res.json({ deleted: result.count });

    setImmediate(() => {
      for (const id of validated.ids) {
        logEvent("workspace", id, "permanent-delete", req.userId!).catch(() => {});
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/workspaces/:workspaceId — soft-delete a workspace
router.delete("/:workspaceId", requireWorkspaceWriteAccess(), async (req: Request, res: Response) => {
  try {
    await prisma.workspace.update({
      where: { id: req.params.workspaceId as string },
      data: { deletedAt: new Date() },
    });

    await logEvent("workspace", req.params.workspaceId as string, "delete", req.userId!);

    res.json({ message: "Workspace deleted" });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * @openapi
 * /workspaces/{workspaceId}/restore:
 *   put:
 *     tags: [Workspaces]
 *     summary: Restore a soft-deleted workspace
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Workspace restored }
 *       404: { description: Workspace not found }
 */
// PUT /api/workspaces/:workspaceId/restore — restore a soft-deleted workspace
router.put("/:workspaceId/restore", requireWorkspaceWriteAccess(), async (req: Request, res: Response) => {
  try {
    const workspace = await prisma.workspace.update({
      where: { id: req.params.workspaceId as string },
      data: { deletedAt: null },
    });

    await logEvent("workspace", workspace.id, "restore", req.userId!);

    res.json(workspace);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/workspaces/:workspaceId/access — grant workspace access
// Phase 189 (D-15/D-18): UPGRADED IN PLACE (pre-existing handler from the
// Phase-70 D-07 follow-up) — owner-or-admin gate, safeParse via
// grantWorkspaceAccessRouteSchema (workspaceId comes from the URL, not the
// body), role+grantedBy persisted in BOTH upsert arms, D-22 audit event.
router.post("/:workspaceId/access", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;

    // Owner-or-admin gate (D-15): load the workspace with project.createdBy
    // (withSoftDelete-scoped — existence hiding, SC-4) and require the
    // caller to be the implicit project owner OR an admin.
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: workspaceId, deletedAt: null }),
      include: { project: { select: { id: true, createdBy: true } } },
    });
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const admin = isAdmin(req.user);
    const isOwner = workspace.project.createdBy === req.userId;
    if (!admin && !isOwner) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }

    // D-18: safeParse against the route schema (no workspaceId in the body).
    // NEVER .parse() — bad input is a 400 with details, never a 500.
    const parsed = grantWorkspaceAccessRouteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const validated = parsed.data;

    // Target-user lookup — prevents dangling grants to deleted users
    // (projects.ts:388 idiom).
    const targetUser = await prisma.user.findUnique({ where: { id: validated.userId } });
    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // T-185-10 disposition (Pitfall-2 grep-gate): parent-verified —
    // requireWorkspaceAccess proved the grantor's access to workspaceId (the
    // access trio keeps the binary gate — the endpoint's own owner-or-admin
    // gate below is the authorization) AND
    // the owner-or-admin gate above re-loaded the same withSoftDelete-scoped
    // workspace; the composite-unique upsert keys (userId, workspaceId),
    // both of which are access-checked parameters (no org column on the
    // composite beyond the inherited parent org at create).
    await prisma.workspaceAccess.upsert({
      where: {
        userId_workspaceId: { userId: validated.userId, workspaceId },
      },
      // Phase 189 (D-15): persist the role in BOTH arms — the pre-existing
      // handler validated the role then discarded it with an empty update arm.
      // 189-REVIEW CR-02: explicit org stamp — WorkspaceAccess is in
      // TENANT_READ_MODELS, so without it the row lands in the schema
      // @default org and is invisible to the tenant-scoped read path for
      // every non-default org (resolveWorkspaceRole / list / deleteMany all
      // AND-filter by req.organizationId → grants silently ineffective).
      create: { userId: validated.userId, workspaceId, role: validated.role, grantedBy: req.userId!, organizationId: req.organizationId! },
      update: { role: validated.role, grantedBy: req.userId! },
    });

    // D-22: audit event (shim never throws on audit failure).
    await logEvent("workspace", workspaceId, "workspace.access.granted", req.userId!, {
      targetUserId: validated.userId,
      role: validated.role,
      grantedBy: req.userId,
    });

    res.json({ message: "Access granted", role: validated.role });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// POST /api/workspaces/:workspaceId/access/bulk — bulk grant (Phase 189 D-17)
// The ONLY genuinely NEW registration among the access routes — registered
// ADJACENT to the grant route (Pitfall 5 / A5: literal path, before any
// conflicting param route). One atomic $transaction; result shape
// { granted: N, failed: [{userId, error}] }.
router.post("/:workspaceId/access/bulk", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;

    // Same owner-or-admin gate as the single grant (D-15).
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: workspaceId, deletedAt: null }),
      include: { project: { select: { id: true, createdBy: true } } },
    });
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const admin = isAdmin(req.user);
    const isOwner = workspace.project.createdBy === req.userId;
    if (!admin && !isOwner) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }

    // D-17: safeParse the bulk body ({ userIds: uuid[], role }).
    const parsed = bulkGrantWorkspaceAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const validated = parsed.data;

    // Target-user existence pre-check — missing ids land in failed[] without
    // attempting the upsert.
    const existingUsers = await prisma.user.findMany({
      where: { id: { in: validated.userIds } },
      select: { id: true },
    });
    const existingIds = new Set(existingUsers.map((u) => u.id));
    const failed: Array<{ userId: string; error: string }> = [];
    const survivors = validated.userIds.filter((uid) => {
      if (!existingIds.has(uid)) {
        failed.push({ userId: uid, error: "User not found" });
        return false;
      }
      return true;
    });

    // ONE atomic $transaction (array form — widgets.ts:604-616 idiom) with
    // role+grantedBy in both upsert arms (T-185-10 parent-verified: the same
    // owner-or-admin-gated workspace as the single grant). CR-02: explicit
    // org stamp on the create arm (same tenant-visibility class as above).
    const results = await prisma.$transaction(
      survivors.map((uid) =>
        prisma.workspaceAccess.upsert({
          where: { userId_workspaceId: { userId: uid, workspaceId } },
          create: { userId: uid, workspaceId, role: validated.role, grantedBy: req.userId!, organizationId: req.organizationId! },
          update: { role: validated.role, grantedBy: req.userId! },
        }),
      ),
    );

    // D-22: one bulk event (bulk as a single audit record).
    await logEvent("workspace", workspaceId, "workspace.access.granted", req.userId!, {
      targetUserIds: validated.userIds,
      role: validated.role,
      grantedBy: req.userId,
    });

    res.json({ granted: results.length, failed });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// GET /api/workspaces/:workspaceId/access — list workspace access grants
// Phase 189 (D-15): EXTENDED IN PLACE — owner-or-admin gate added + response
// reshaped to {userId, username, role, grantedAt, grantedBy} (the raw
// user:{id,email,...} passthrough leaked emails/roles metadata — T-189-11).
router.get("/:workspaceId/access", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;

    // Owner-or-admin gate (same idiom as grant).
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: workspaceId, deletedAt: null }),
      include: { project: { select: { id: true, createdBy: true } } },
    });
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const admin = isAdmin(req.user);
    const isOwner = workspace.project.createdBy === req.userId;
    if (!admin && !isOwner) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }

    const grants = await prisma.workspaceAccess.findMany({
      where: { workspaceId },
      include: {
        user: { select: { username: true } },
      },
      orderBy: { grantedAt: "desc" },
    });
    // D-15 wire shape: grantedAt serializes ISO over JSON; grantedBy is
    // null for legacy rows (D-12 audit marker).
    res.json(
      grants.map((g) => ({
        userId: g.userId,
        workspaceId: g.workspaceId,
        username: g.user?.username ?? null,
        role: g.role,
        grantedAt: g.grantedAt instanceof Date ? g.grantedAt.toISOString() : (g.grantedAt as unknown as string),
        grantedBy: g.grantedBy ?? null,
      })),
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// DELETE /api/workspaces/:workspaceId/access/:userId — revoke a workspace access grant
// Phase 189 (D-16/D-22): REWRITTEN IN PLACE — workspace load with existence
// hiding (404 "Workspace not found" — NEW, the old handler never loaded the
// workspace), owner-or-admin gate BEFORE the anti-lockout check (avoids the
// 400-vs-403 enumeration oracle), anti-lockout 400 "Cannot revoke project
// owner", D-22 audit event with the namespaced action (replaces the bare
// pre-existing revoke event name). NO cache invalidation (Pitfall 9 —
// per-request resolution IS the next-request-effectiveness contract).
router.delete("/:workspaceId/access/:userId", requireWorkspaceAccess, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.workspaceId as string;
    const targetUserId = req.params.userId as string;

    // Existence hiding: withSoftDelete-scoped workspace load — an unknown
    // workspace 404s BEFORE the grant-miss check.
    const workspace = await prisma.workspace.findFirst({
      where: withSoftDelete({ id: workspaceId, deletedAt: null }),
      include: { project: { select: { id: true, createdBy: true } } },
    });
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    // Owner-or-admin gate FIRST (D-15): a non-owner self-revoke attempt and
    // any grantee probing project ownership are both stopped here — the
    // gate precedes the anti-lockout check so unauthorized actors cannot
    // enumerate which userId is the project owner (D-16 ordering note).
    const admin = isAdmin(req.user);
    const isOwner = workspace.project.createdBy === req.userId;
    if (!admin && !isOwner) {
      res.status(403).json({ error: "Access denied to this workspace" });
      return;
    }

    // Anti-lockout (D-16): the implicit project owner can never be revoked
    // (transfer-ownership is explicitly out of scope v1).
    if (targetUserId === workspace.project.createdBy) {
      res.status(400).json({ error: "Cannot revoke project owner" });
      return;
    }

    // deleteMany — no P2025 on an absent row; idempotent revoke.
    const result = await prisma.workspaceAccess.deleteMany({
      where: { workspaceId, userId: targetUserId },
    });

    if (result.count === 0) {
      res.status(404).json({ error: "Access grant not found" });
      return;
    }

    // D-22: the bare pre-existing event name is replaced by the namespaced one.
    await logEvent("workspace", workspaceId, "workspace.access.revoked", req.userId!, {
      targetUserId,
      revokedBy: req.userId,
    });
    res.json({ message: "Access revoked" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /api/workspaces/:workspaceId/folders — list folders in workspace
router.get("/:workspaceId/folders", requireWorkspaceAccess, async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  try {
    const folders = await prisma.chatFolder.findMany({
      where: { workspaceId, deletedAt: null },
    });
    res.json(folders);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /api/workspaces/:workspaceId/folders — create a folder
router.post("/:workspaceId/folders", requireWorkspaceWriteAccess(), async (req: Request, res: Response) => {
  const workspaceId = req.params.workspaceId as string;
  try {
    const validated = createFolderSchema.parse(req.body);
    const folder = await prisma.chatFolder.create({
      data: {
        workspaceId,
        name: validated.name,
        // CR-03 (185-05, D-04): explicit org stamp (ChatFolder is in
        // TENANT_READ_MODELS) — same self-visibility class as the workspace.
        organizationId: req.organizationId!,
      },
    });
    res.status(201).json(folder);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// PUT /api/workspaces/:workspaceId/folders/:folderId — update a folder
router.put("/:workspaceId/folders/:folderId", requireWorkspaceWriteAccess(), async (req: Request, res: Response) => {
  const folderId = req.params.folderId as string;
  const workspaceId = req.params.workspaceId as string;
  try {
    const validated = updateFolderSchema.parse(req.body);
    const folder = await prisma.chatFolder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: null },
    });
    if (!folder) {
      res.status(404).json({ error: "Folder not found" });
      return;
    }
    const updated = await prisma.chatFolder.update({
      where: { id: folderId },
      data: { name: validated.name },
    });
    res.json(updated);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

// DELETE /api/workspaces/:workspaceId/folders/:folderId — soft-delete a folder
router.delete("/:workspaceId/folders/:folderId", requireWorkspaceWriteAccess(), async (req: Request, res: Response) => {
  const folderId = req.params.folderId as string;
  const cascade = req.query.cascade === "true";
  try {
    if (cascade) {
      await prisma.$transaction([
        prisma.chat.updateMany({
          where: { folderId, deletedAt: null },
          data: { deletedAt: new Date() },
        }),
        prisma.chatFolder.update({
          where: { id: folderId },
          data: { deletedAt: new Date() },
        }),
      ]);
    } else {
      await prisma.$transaction([
        prisma.chat.updateMany({
          where: { folderId, deletedAt: null },
          data: { folderId: null },
        }),
        prisma.chatFolder.update({
          where: { id: folderId },
          data: { deletedAt: new Date() },
        }),
      ]);
    }
    res.json({ message: "Folder deleted", cascade });
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// PUT /api/workspaces/:workspaceId/folders/:folderId/restore — restore a soft-deleted folder
router.put("/:workspaceId/folders/:folderId/restore", requireWorkspaceWriteAccess(), async (req: Request, res: Response) => {
  const folderId = req.params.folderId as string;
  const workspaceId = req.params.workspaceId as string;
  try {
    const folder = await prisma.chatFolder.findFirst({
      where: { id: folderId, workspaceId, deletedAt: { not: null } },
    });
    if (!folder) {
      res.status(404).json({ error: "Folder not found or not deleted" });
      return;
    }
    const restored = await prisma.chatFolder.update({
      where: { id: folderId },
      data: { deletedAt: null },
    });
    res.json(restored);
  } catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

export default router;
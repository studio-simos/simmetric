// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 190 (SKIL-01/03/05) — custom-skill CRUD + test-preview.
 *
 * TWO routers in one file (Pitfall 2 mount-path trap):
 *  - `default` — the pre-existing read-only /api/agent/skills route, mounted at
 *    app.use("/api/agent", skillsRoutes) — BYTE-IDENTICAL consumers
 *    (WorkspaceCreatePanel/WorkspaceRow).
 *  - `skillsCrudRouter` — the D-21 CRUD + test-preview surface, mounted at
 *    app.use("/api/skills", …) (index.ts). Both share auth → tenantContext;
 *    permissions go per-route (Phase 185 D-09 chain order).
 *
 * Decisions implemented (190-CONTEXT.md):
 *  - D-05/D-07: scoping is derived SERVER-SIDE (never trust the client) —
 *    personal → userId=caller; global → admin-only; workspace → editor+ via
 *    the Phase 189 resolveWorkspaceRole (null → 404 existence hiding, viewer
 *    → 403). Workspace-scoped rows persist userId: NULL so the row resolves
 *    via the D-05 workspace OR-arm ONLY (a creator-stamped row would ALSO
 *    satisfy the personal arm in a different workspace — cross-workspace leak).
 *  - D-16/D-21: builtin rows are non-editable/non-deletable (400).
 *  - D-17/D-18: CREATE only is gated by requireFeatureLimit("max_skills",
 *    "skill") — org-scoped count-at-provision (invocation-gating would 402
 *    mid-chat — rejected).
 *  - D-20/A5: POST /:id/test compiles LOCALLY with RAW params (the preview is
 *    not a chat surface — NO DLP masking, NO LLM call) and emits through the
 *    same wrapSpotlightedTemplate the chat executor uses (defense-in-depth).
 *  - SC-1: lifecycle invalidation is per-request DB resolution in the
 *    resolution path — these mutations need no hooks.
 *  - T-190-11: mutations logEvent("skill", …) per the repo convention.
 *
 * Prohibition (structural): this file NEVER imports the orchestrator/agent
 * run path — the test-preview arm is a pure string transform.
 */

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { requirePermission, resolveWorkspaceRole } from "../middleware/rbac";
import { requireFeatureLimit } from "../middleware/license";
import { getAllBuiltinSkills } from "../agent/skills";
import "../agent/builtinSkills"; // Ensure skills are registered
import prisma from "../utils/prisma";
import { isAdmin } from "../utils/auth";
import { logger } from "../utils/logger";
import { logEvent } from "../services/eventLogService";
import {
  createSkillSchema,
  updateSkillSchema,
  testSkillSchema,
  skillIdParamSchema,
} from "@simmetric-chat/shared";
import {
  compileTemplate,
  wrapSpotlightedTemplate,
  allowedKeysFrom,
} from "../services/skillService";

const router = Router();
router.use(authMiddleware);
// Phase 185 (D-09): chain order auth → tenant → permission. The tenant
// middleware resolves req.organizationId (D-01 membership lookup) and opens
// the ALS tenant run before any rbac/license gate.
router.use(tenantContextMiddleware);

// GET /api/agent/skills — list all available skills
router.get("/skills", (_req: Request, res: Response) => {
  const skills = getAllBuiltinSkills().map((s) => ({
    name: s.name,
    displayName: s.displayName,
    description: s.description,
    type: s.type,
  }));
  res.json(skills);
});

export default router;

/**
 * Phase 190 (SKIL-01, Pitfall 2) — the CRUD + test-preview router. Mounted at
 * app.use("/api/skills", skillsCrudRouter); shares the auth → tenant chain.
 */
export const skillsCrudRouter = Router();
skillsCrudRouter.use(authMiddleware);
skillsCrudRouter.use(tenantContextMiddleware);

/** Safe JSON shape for a row on the wire (config/inputSchema parsed back). */
function toRowJson(row: {
  id: string;
  slug: string;
  name: string;
  description: string;
  skillMode: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  userId: string | null;
  workspaceId: string | null;
  createdBy: string | null;
  config: string | Record<string, unknown>;
  inputSchema: string | Record<string, unknown>;
}) {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }
  let inputSchema: Record<string, unknown> = { properties: {}, required: [] };
  try {
    const parsed: unknown =
      typeof row.inputSchema === "string" ? JSON.parse(row.inputSchema) : row.inputSchema;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      inputSchema = parsed as Record<string, unknown>;
    }
  } catch {
    inputSchema = { properties: {}, required: [] };
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    skillMode: row.skillMode,
    scope: row.workspaceId !== null ? ("workspace" as const) : row.userId !== null ? ("personal" as const) : ("global" as const),
    isEnabled: row.isEnabled,
    workspaceId: row.workspaceId,
    createdBy: row.createdBy,
    config: {
      template: typeof config.template === "string" ? config.template : "",
      defaultParams: (config.defaultParams as Record<string, string>) ?? {},
      injectAs: typeof config.injectAs === "string" ? config.injectAs : "user",
    },
    inputSchema,
  };
}

/**
 * SKIL-03 — the caller's viewer+ workspace id set (explicit WorkspaceAccess
 * rows + ProjectAccess-implied editor workspaces — the SAME workspace set the
 * Phase 189 access inputs resolveWorkspaceRole consults). The org filter
 * rides the tenant ALS scope.
 */
async function resolveAccessibleWorkspaceIds(userId: string): Promise<string[]> {
  const [callerWorkspaceAccess, callerProjectAccess] = await Promise.all([
    prisma.workspaceAccess.findMany({ where: { userId } }),
    prisma.projectAccess.findMany({
      where: { userId },
      include: { project: { include: { workspaces: { select: { id: true } } } } },
    }),
  ]);
  return [
    ...new Set(
      [
        ...callerWorkspaceAccess.map((wa: { workspaceId: string }) => wa.workspaceId),
        ...callerProjectAccess.map(
          (pa: { project: { workspaces: { id: string }[] } | null }) =>
            pa.project?.workspaces?.map((w: { id: string }) => w.id) ?? [],
        ).flat(),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

// GET /api/skills — management list: builtin catalog + custom rows visible to
// the caller + the D-05-resolution-shaped `accessible` array (other users'
// workspace-scoped rows in workspaces the caller holds viewer+ on — the chat
// palette/parser source, SKIL-03; Plan 05 consumes it).
skillsCrudRouter.get("/", requirePermission("skill:read"), async (req: Request, res: Response) => {
  try {
    const builtin = getAllBuiltinSkills().map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      type: s.type,
    }));

    const isAdminCaller = isAdmin(req.user);
    const accessibleWorkspaceIds = isAdminCaller
      ? []
      : await resolveAccessibleWorkspaceIds(req.userId!);

    // CR-01 (D-05/SKIL-03): the management list is `type: "custom"` ONLY
    // (builtin catalog rows render from the registry — a missing type filter
    // leaked the 7 seeded builtin rows into this array). Workspace-scoped rows
    // (userId NULL by the create pin) resolve via the workspace arm ONLY:
    //   custom = own personal ∪ globals ∪ caller-owned rows in viewer+ ws
    //   accessible = OTHER users' rows in viewer+ workspaces
    // — a caller-owned workspace row (createdBy = caller) rides `custom` and
    // is excluded from `accessible`, so the palette union stays duplicate-free.
    // Admins see all org rows in `custom`; `accessible` stays empty (already
    // covered — no duplicates).
    const visibility = isAdminCaller
      ? { deletedAt: null, type: "custom" as const }
      : {
          deletedAt: null,
          type: "custom" as const,
          OR: [
            { userId: req.userId! },
            { userId: null, workspaceId: null },
            ...(accessibleWorkspaceIds.length
              ? [
                  {
                    userId: null,
                    workspaceId: { in: accessibleWorkspaceIds },
                    createdBy: req.userId!,
                  },
                ]
              : []),
          ],
        };
    const customRows = await prisma.agentSkill.findMany({ where: visibility });
    // Existence-hiding is done by the tenant filter; builtin catalog rows are
    // display-only (isBuiltIn) — they render in the read-only section from
    // the registry, but a PUT/DELETE targets them (400), so they stay listed.
    const custom = customRows.map(toRowJson);

    // SKIL-03 accessible arm — other users' workspace-scoped rows in
    // workspaces the caller holds viewer+ on. CR-01: the previous
    // `userId: { not: caller }` shape NEVER returned production rows (Prisma's
    // `not` on a nullable column excludes NULL, and the create pin persists
    // workspace rows with userId NULL) — fixtures masked the dead arm by
    // hand-setting userId. The caller's own workspace rows are excluded via
    // `createdBy` (they ride `custom` above).
    const accessibleRows =
      accessibleWorkspaceIds.length > 0 && !isAdminCaller
        ? await prisma.agentSkill.findMany({
            where: {
              deletedAt: null,
              type: "custom",
              userId: null,
              workspaceId: { in: accessibleWorkspaceIds },
              createdBy: { not: req.userId! },
            },
          })
        : [];
    const accessible = accessibleRows.map(toRowJson);

    res.json({ builtin, custom, accessible });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[skills] Error listing skills", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/skills — create (permission THEN license, projects.ts:51 precedent).
skillsCrudRouter.post(
  "/",
  requirePermission("skill:create"),
  requireFeatureLimit("max_skills", "skill"),
  async (req: Request, res: Response) => {
    try {
      const parsed = createSkillSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
        return;
      }
      const { slug, name, description, config, inputSchema, scope, workspaceId } = parsed.data;

      // D-05/D-07 — scope arbitration SERVER-SIDE (never trust the client).
      let userId: string | null = null;
      let resolvedWorkspaceId: string | null = null;
      if (scope === "personal") {
        userId = req.userId!;
      } else if (scope === "global") {
        if (!isAdmin(req.user)) {
          res.status(403).json({ error: "Only admins can create global skills" });
          return;
        }
        userId = null;
      } else {
        // scope "workspace" — editor+ required (admin bypass rides the resolver).
        const role = await resolveWorkspaceRole(req.userId!, workspaceId!, req.user);
        if (role === null) {
          // Existence hiding — an absent/no-access workspace is "not found".
          res.status(404).json({ error: "Workspace not found" });
          return;
        }
        if (role === "viewer") {
          res.status(403).json({ error: "Access denied to this workspace" });
          return;
        }
        // D-05 personal-arm hazard: a workspace-scoped row carrying the
        // creator's userId would ALSO satisfy the D-05 personal OR-arm in a
        // DIFFERENT workspace. The row must be reachable via the workspace
        // arm ONLY → userId stays NULL.
        userId = null;
        resolvedWorkspaceId = workspaceId!;
      }

      const row = await prisma.agentSkill.create({
        data: {
          name: `custom_${slug}`,
          slug,
          displayName: name,
          description,
          type: "custom",
          skillMode: "prompt",
          config: JSON.stringify(config),
          inputSchema: JSON.stringify(inputSchema),
          isEnabled: true,
          organizationId: req.organizationId!,
          userId,
          workspaceId: resolvedWorkspaceId,
          createdBy: req.userId!,
        },
      });

      await logEvent("skill", row.id, "create", req.userId!, { slug, scope });

      res.status(201).json(toRowJson(row));
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "P2002") {
        res.status(409).json({ error: "A skill with this slug already exists" });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[skills] Error creating skill", { error: message });
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * WR-01 (D-05/D-07 IDOR guard family) — the D-05 visibility predicate for a
 * non-admin findFirst: own personal rows ∪ globals ∪ workspace rows in
 * viewer+ workspaces (the SAME predicate the GET list uses post-CR-01).
 * Other users' personal rows match NO arm → the route 404s (existence
 * hiding), consistent with the list's hiding and the write gates'
 * owner-or-admin posture.
 */
function visibilityOrFor(
  userId: string,
  accessibleWorkspaceIds: string[],
): Array<Record<string, unknown>> {
  return [
    { userId },
    { userId: null, workspaceId: null },
    ...(accessibleWorkspaceIds.length
      ? [{ userId: null, workspaceId: { in: accessibleWorkspaceIds } }]
      : []),
  ];
}

/** Resolve the row by id behind the D-05 visibility gate (WR-01). */
async function findVisibleSkillRow(req: Request, id: string) {
  const where: Record<string, unknown> = { id, deletedAt: null };
  if (!isAdmin(req.user)) {
    const accessibleWorkspaceIds = await resolveAccessibleWorkspaceIds(req.userId!);
    where.OR = visibilityOrFor(req.userId!, accessibleWorkspaceIds);
  }
  return prisma.agentSkill.findFirst({ where });
}

// GET /api/skills/:id
skillsCrudRouter.get("/:id", requirePermission("skill:read"), async (req: Request, res: Response) => {
  try {
    const param = skillIdParamSchema.safeParse(req.params);
    if (!param.success) {
      res.status(400).json({ error: "Invalid skill ID", details: param.error.flatten().fieldErrors });
      return;
    }
    const row = await findVisibleSkillRow(req, param.data.id);
    if (!row) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(toRowJson(row));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[skills] Error reading skill", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/skills/:id — owner(createdBy)-or-admin; builtin → 400 (D-16/D-21).
skillsCrudRouter.put("/:id", requirePermission("skill:write"), async (req: Request, res: Response) => {
  try {
    const param = skillIdParamSchema.safeParse(req.params);
    if (!param.success) {
      res.status(400).json({ error: "Invalid skill ID", details: param.error.flatten().fieldErrors });
      return;
    }
    const row = await prisma.agentSkill.findFirst({
      where: { id: param.data.id, deletedAt: null },
    });
    if (!row) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    if (row.isBuiltIn) {
      res.status(400).json({ error: "Cannot edit built-in skill" });
      return;
    }
    if (row.createdBy !== req.userId && !isAdmin(req.user)) {
      res.status(403).json({ error: "Only the skill owner or an admin can edit this skill" });
      return;
    }
    const parsed = updateSkillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const { name, description, config, inputSchema, scope, workspaceId } = parsed.data;

    // Workspace-scope edits re-run the Phase 189 write gate (D-07).
    let workspacePatch: { workspaceId: string | null } | undefined;
    if (scope === "workspace") {
      const targetWorkspaceId = workspaceId ?? row.workspaceId;
      if (!targetWorkspaceId) {
        res.status(400).json({ error: "workspaceId is required when scope is 'workspace'" });
        return;
      }
      const role = await resolveWorkspaceRole(req.userId!, targetWorkspaceId, req.user);
      if (role === null) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
      if (role === "viewer") {
        res.status(403).json({ error: "Access denied to this workspace" });
        return;
      }
      workspacePatch = { workspaceId: targetWorkspaceId };
    } else if (scope === "global") {
      if (!isAdmin(req.user)) {
        res.status(403).json({ error: "Only admins can make a skill global" });
        return;
      }
      workspacePatch = { workspaceId: null };
    } else if (scope === "personal") {
      workspacePatch = { workspaceId: null };
    }

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = `custom_${row.slug}`;
    if (description !== undefined) data.description = description;
    if (config !== undefined) data.config = JSON.stringify(config);
    if (inputSchema !== undefined) data.inputSchema = JSON.stringify(inputSchema);
    if (scope !== undefined) {
      data.workspaceId = workspacePatch?.workspaceId ?? null;
      // Scope personal re-stamps the caller (D-05 personal arm); global keeps
      // userId null; workspace keeps userId null (personal-arm hazard closed).
      data.userId = scope === "personal" ? req.userId! : null;
    }

    const updated = await prisma.agentSkill.update({
      where: { id: row.id },
      data,
    });

    await logEvent("skill", row.id, "update", req.userId!, { slug: row.slug });

    res.json(toRowJson(updated));
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "P2002") {
      res.status(409).json({ error: "A skill with this slug already exists" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[skills] Error updating skill", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/skills/:id — soft delete (tombstones free the slug via the
// partial unique); builtin → 400 (D-16/D-21).
skillsCrudRouter.delete("/:id", requirePermission("skill:delete"), async (req: Request, res: Response) => {
  try {
    const param = skillIdParamSchema.safeParse(req.params);
    if (!param.success) {
      res.status(400).json({ error: "Invalid skill ID", details: param.error.flatten().fieldErrors });
      return;
    }
    const row = await prisma.agentSkill.findFirst({
      where: { id: param.data.id, deletedAt: null },
    });
    if (!row) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    if (row.isBuiltIn) {
      res.status(400).json({ error: "Cannot delete built-in skill" });
      return;
    }
    if (row.createdBy !== req.userId && !isAdmin(req.user)) {
      res.status(403).json({ error: "Only the skill owner or an admin can delete this skill" });
      return;
    }
    await prisma.agentSkill.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });

    await logEvent("skill", row.id, "delete", req.userId!, { slug: row.slug });

    res.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[skills] Error deleting skill", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/skills/:id/test — compiled-prompt preview. NO LLM call, NO DLP
// masking (raw params per A5 — the preview is not a chat surface); emits
// through wrapSpotlightedTemplate (the SAME spotlight wrapper the chat
// executor uses — D-14 defense-in-depth).
skillsCrudRouter.post("/:id/test", requirePermission("skill:read"), async (req: Request, res: Response) => {
  try {
    const param = skillIdParamSchema.safeParse(req.params);
    if (!param.success) {
      res.status(400).json({ error: "Invalid skill ID", details: param.error.flatten().fieldErrors });
      return;
    }
    // WR-01: the preview is gated by the SAME D-05 visibility predicate as
    // GET /:id — a caller without visibility on the row gets a 404 (a
    // compiled-prompt preview must not disclose another user's personal
    // skill the list already hides).
    const row = await findVisibleSkillRow(req, param.data.id);
    if (!row) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    const parsed = testSkillSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten().fieldErrors });
      return;
    }
    let config: Record<string, unknown> = {};
    try {
      const pc: unknown = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      if (pc !== null && typeof pc === "object" && !Array.isArray(pc)) {
        config = pc as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
    const template = typeof config.template === "string" ? config.template : "";
    const defaults = (config.defaultParams as Record<string, unknown>) ?? {};
    const compiled = compileTemplate(
      template,
      parsed.data.params,
      defaults,
      allowedKeysFrom(row.inputSchema, defaults),
    );
    res.json({ compiledPrompt: wrapSpotlightedTemplate(compiled) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[skills] Error testing skill", { error: message });
    res.status(500).json({ error: "Internal server error" });
  }
});
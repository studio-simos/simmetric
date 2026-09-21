// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-01, D-05) — lazy personal-workspace provisioning.
 *
 * The ONLY creation seam for personal workspaces (D-01: lazy on-demand —
 * no auto-create at registration, login, or migration time). Creates, in
 * ONE idempotent flow: personal Project (createdBy=userId, isPersonal:true,
 * org-stamped per CR-03) + Workspace (wizard-supplied name) +
 * WorkspaceAgentConfig (parity with POST /workspaces) + hasOnboarded=true.
 *
 * QUOTA-EXEMPTION BY CONSTRUCTION (Pitfall 3 / A2 — RESEARCH-RECOMMENDED):
 * this service creates the Project DIRECTLY via the prisma singleton — it
 * is NOT the generic POST /api/projects route and deliberately carries NO
 * max_projects license-limit middleware (no feature-limit gate of any
 * kind). Routing the wizard through the generic project route would 402 a
 * Community user already at max_projects on their very first use (the
 * onboarding flow must never 402). The personal-workspace QUOTA exemption itself is the D-04
 * max_workspaces count-filter (license.ts) — invariant-pinned in
 * license.test.ts (N personal workspaces never consume shared quota).
 *
 * Race tolerance (ensureDefaultOrgMembership idiom, organizationService.ts):
 *   1. Idempotency fast path — a live personal workspace
 *      (project.createdBy === userId && project.isPersonal) returns early;
 *      the wizard's name input is ignored on repeat (D-05 idempotent).
 *   2. Interactive $transaction — Project + Workspace + agentConfig + the
 *      hasOnboarded flip commit atomically.
 *   3. P2002 tolerance — a concurrent first-use (both callers raced past
 *      the find-first; the loser hits projects_createdBy_name_key or
 *      workspaces_projectId_name_key) re-runs the find-first: if the
 *      winner's personal workspace now exists, return it (lost race is the
 *      desired outcome, never a crash). A P2002 WITHOUT a personal
 *      workspace — the tombstone name collision class (Pitfall 8: the
 *      plain workspaces_projectId_name_key unique blocks re-create under a
 *      soft-deleted sibling) — maps to PersonalWorkspaceConflictError,
 *      rendered by the route as 409 with the workspaces.ts byte shape.
 *
 * Cache discipline (Pitfall 4): invalidateAuthCache(userId) runs after
 * every success arm so the /auth/me consumer observes hasOnboarded=true on
 * the next fetch (the Redis auth:user:{id} cache would otherwise serve the
 * stale pre-flip row for the SESSION_EXPIRY TTL). The service NEVER adds a
 * workspace-role cache (Pitfall 9 — per-request resolution is the
 * revocation contract). No license middleware anywhere on this path (D-21
 * — community core; the only license touch in the phase is the D-04
 * count-filter, landed in Plan 02).
 */

import prisma from "../utils/prisma";
import { invalidateAuthCache } from "./authService";

/** Thrown when a P2002 has no personal-workspace explanation (Pitfall 8 tombstone collision). */
export class PersonalWorkspaceConflictError extends Error {
  constructor() {
    super("A workspace with this name already exists in this project");
    this.name = "PersonalWorkspaceConflictError";
  }
}

/** The D-05 fast-path probe: the user's live personal workspace, if any. */
function personalWorkspaceFindFirst(userId: string) {
  return {
    where: {
      deletedAt: null,
      project: { createdBy: userId, isPersonal: true, deletedAt: null },
    },
    include: { project: true },
  } as const;
}

export async function createPersonalWorkspace(
  userId: string,
  workspaceName: string,
  organizationId: string,
) {
  // (1) Idempotency fast path — repeated wizard calls return the existing
  // personal workspace; the name input is ignored on repeat (D-05).
  const existing = await prisma.workspace.findFirst(personalWorkspaceFindFirst(userId));
  if (existing) {
    // Defensive cache invalidation on the repeat arm too — a re-issued
    // invalidation is a no-op when the cache is already fresh (Pitfall 4).
    await invalidateAuthCache(userId);
    return existing;
  }

  // (2) Interactive transaction — Project + Workspace + agentConfig parity
  // (POST /workspaces upsert shape) + the hasOnboarded flip, atomically.
  // CR-03: explicit org stamp on BOTH rows (the @default alone would land
  // every create in the DEFAULT org).
  try {
    const workspace = await prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        // D-02: isPersonal is the identity (the name literal is display-only,
        // A1); createdBy=userId makes this user the implicit owner (D-08).
        data: { name: "Personal", createdBy: userId, isPersonal: true, organizationId },
      });
      const workspace = await tx.workspace.create({
        data: { projectId: project.id, name: workspaceName, organizationId },
      });
      // POST /workspaces parity (:188 idiom) — a personal workspace ships
      // with the same agentConfig row a normal create gets.
      await tx.workspaceAgentConfig.upsert({
        where: { workspaceId: workspace.id },
        update: {},
        create: { workspaceId: workspace.id },
      });
      await tx.user.update({
        where: { id: userId },
        data: { hasOnboarded: true },
      });
      return workspace;
    });
    // Pitfall 4: the flip is visible at /auth/me on the next fetch.
    await invalidateAuthCache(userId);
    return workspace;
  } catch (err: unknown) {
    // (3) P2002 race/tombstone tolerance (ensureDefaultOrgMembership idiom):
    // a concurrent first-use winner means a personal workspace NOW exists —
    // take it (lost race is the desired outcome). No personal workspace ⇒
    // the collision is a tombstoned/foreign workspace name under the plain
    // unique (Pitfall 8) → route renders 409.
    if ((err as { code?: string }).code !== "P2002") throw err;
    const resurrected = await prisma.workspace.findFirst(personalWorkspaceFindFirst(userId));
    if (resurrected) {
      await invalidateAuthCache(userId);
      return resurrected;
    }
    throw new PersonalWorkspaceConflictError();
  }
}
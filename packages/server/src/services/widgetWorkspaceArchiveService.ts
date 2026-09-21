// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import type { WidgetWorkspaceArchiveFilterInput } from "@simmetric-chat/shared";

/**
 * Widget Workspace Archive (WGTA-01) — read-only projection over the
 * existing WidgetWorkspace whitelist join.
 *
 * D-01: three GET endpoints (grouped / flat / stats), all requireAdmin via
 * the widgets router chain. D-02 soft-delete semantics: the `where` on every
 * fetch carries `widget: { deletedAt: null }` and `workspace: { deletedAt: null }`
 * — soft-deleted widgets and workspaces never appear, and a widget whose
 * whitelist rows ALL point at soft-deleted workspaces is an EFFECTIVE ORPHAN.
 * D-03: this service is read-only (no writes, no cache coupling).
 * D-04: no bulk-assign endpoint (deferred to v1.5).
 *
 * The prisma singleton carries `withSoftDelete()` + the `tenantScope`
 * extension (Pitfall 3) — WidgetWorkspace/Widget/Workspace/Project reads
 * AND-merge organizationId automatically. Always import the singleton —
 * never construct a fresh client here. Prisma's groupBy cannot `include`
 * relations, so the archive shape is findMany + nested select + in-memory
 * Map grouping.
 */

/** One row of the flat archive: the join row itself (one per widgetId × workspaceId). */
export interface ArchiveFlatRow {
  widgetId: string;
  widgetName: string;
  widgetIsActive: boolean;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
}

/** A widget inside a project group, with only THAT project's workspaces. */
interface ArchiveGroupWidget {
  id: string;
  name: string;
  isActive: boolean;
  workspaces: { id: string; name: string }[];
}

/** One project group of the grouped archive view. */
export interface ArchiveProjectGroup {
  project: { id: string; name: string };
  widgets: ArchiveGroupWidget[];
}

/** Four-field stats object (spec §3.1): totals + effective orphans (D-02). */
export interface ArchiveStats {
  totalWidgets: number;
  totalWorkspacesLinked: number;
  totalProjects: number;
  orphans: number;
}

/** Shape of the shared fetch used by both archive views (rows carry the nested selects). */
interface ArchiveJoinRow {
  widgetId: string;
  workspaceId: string;
  widget: { id: string; name: string; isActive: boolean };
  workspace: { id: string; name: string; project: { id: string; name: string } | null };
}

/**
 * Fetch the soft-delete-filtered join rows (D-02) with the optional filter
 * passthrough (projectId / workspaceId / widgetId). Single source for the
 * grouped + flat projections — the same row set, two different projections.
 */
async function fetchArchiveRows(filters: WidgetWorkspaceArchiveFilterInput): Promise<ArchiveJoinRow[]> {
  const rows = await prisma.widgetWorkspace.findMany({
    where: {
      ...(filters.widgetId ? { widgetId: filters.widgetId } : {}),
      ...(filters.workspaceId ? { workspaceId: filters.workspaceId } : {}),
      widget: { deletedAt: null },
      workspace: {
        deletedAt: null, // D-02: effective-orphan source
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
      },
    },
    include: {
      widget: { select: { id: true, name: true, isActive: true } },
      workspace: {
        select: {
          id: true,
          name: true,
          project: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ workspace: { projectId: "asc" } }, { widgetId: "asc" }],
  });

  // The composite PK (widgetId × workspaceId) guarantees exactly one row per
  // widgetId × workspaceId — the flat view needs no dedupe (spec §5.1).
  return rows as unknown as ArchiveJoinRow[];
}

/**
 * Grouped archive: rows grouped by workspace.projectId → within each group
 * grouped by widgetId, collecting only that project's workspaces. A widget
 * linked to workspaces of DIFFERENT projects appears under EACH project
 * group (M:N is correct — spec §5.1, Pitfall 8). Prisma groupBy cannot
 * include relations, so this is an in-memory Map group.
 */
export async function getWorkspaceArchive(
  filters: WidgetWorkspaceArchiveFilterInput,
): Promise<ArchiveProjectGroup[]> {
  const rows = await fetchArchiveRows(filters);

  // Group rows by projectId first (Pitfall 8: the grouping unit is
  // (project, widget, workspace-list) — never a global widget dedupe).
  const projectMap = new Map<string, {
    project: { id: string; name: string };
    widgetMap: Map<string, { widget: { id: string; name: string; isActive: boolean }; workspaces: { id: string; name: string }[] }>;
  }>();

  for (const row of rows) {
    const project = row.workspace.project;
    // A workspace without a project (project soft-deleted) has no group to
    // belong to — skip it from the grouped view (it stays in the flat view).
    if (!project) {
      logger.debug("[widgetWorkspaceArchive] join row without project skipped from grouped view", {
        workspaceId: row.workspace.id,
      });
      continue;
    }
    let group = projectMap.get(project.id);
    if (!group) {
      group = { project, widgetMap: new Map() };
      projectMap.set(project.id, group);
    }
    let widgetEntry = group.widgetMap.get(row.widgetId);
    if (!widgetEntry) {
      widgetEntry = { widget: row.widget, workspaces: [] };
      group.widgetMap.set(row.widgetId, widgetEntry);
    }
    widgetEntry.workspaces.push({ id: row.workspace.id, name: row.workspace.name });
  }

  return Array.from(projectMap.values()).map((group) => ({
    project: group.project,
    widgets: Array.from(group.widgetMap.values()).map((entry) => ({
      id: entry.widget.id,
      name: entry.widget.name,
      isActive: entry.widget.isActive,
      workspaces: entry.workspaces,
    })),
  }));
}

/**
 * Flat archive: the join rows themselves — exactly one row per
 * widgetId × workspaceId (composite PK guarantees it; spec §5.1). Used by
 * the flat-table toggle + client-side CSV export (D-07).
 */
export async function getFlatArchive(
  filters: WidgetWorkspaceArchiveFilterInput,
): Promise<ArchiveFlatRow[]> {
  const rows = await fetchArchiveRows(filters);
  return rows.map((row) => ({
    widgetId: row.widgetId,
    widgetName: row.widget.name,
    widgetIsActive: row.widget.isActive,
    workspaceId: row.workspaceId,
    workspaceName: row.workspace.name,
    projectId: row.workspace.project?.id ?? "",
    projectName: row.workspace.project?.name ?? "",
  }));
}

/**
 * Archive stats (spec §3.1): totalWidgets, totalWorkspacesLinked,
 * totalProjects, orphans. TWO fetches only; BOTH filters derived from the
 * SAME filtered row set (single source of truth — Pitfall 2: never count
 * orphans from raw join rows).
 *
 * D-02 EFFECTIVE ORPHANS: orphans = live widgets with 0 NON-deleted linked
 * workspaces. A widget with 5 rows, all pointing at soft-deleted workspaces,
 * IS an orphan — computed from the filtered row map, NOT from raw join counts.
 */
export async function getArchiveStats(): Promise<ArchiveStats> {
  // (a) one fetch: live widget × live workspace links only (D-02 filters).
  const rows = await prisma.widgetWorkspace.findMany({
    where: { widget: { deletedAt: null }, workspace: { deletedAt: null } },
    select: { widgetId: true, workspace: { select: { project: { select: { id: true } } } } },
  });

  // (b) live widgets — soft-deleted widgets never appear anywhere in the archive.
  const widgets = await prisma.widget.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  // Rows are already deduped by the composite PK → totalWorkspacesLinked is
  // the row count; totalProjects is the distinct workspace.projectId over the
  // SAME row set (derived in the same pass).
  const liveWithLinks = new Set<string>();
  const projectIds = new Set<string>();
  for (const row of rows) {
    liveWithLinks.add(row.widgetId);
    const projectId = (row.workspace as { project?: { id?: string } } | null)?.project?.id;
    if (projectId) {
      projectIds.add(projectId);
    }
  }

  return {
    totalWidgets: widgets.length,
    totalWorkspacesLinked: rows.length,
    totalProjects: projectIds.size,
    orphans: widgets.filter((w) => !liveWithLinks.has(w.id)).length,
  };
}
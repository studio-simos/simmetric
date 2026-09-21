// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Widget Workspace Archive (WGTA-01, 188-02) — the read-only "dashboard di
 * monitoraggio" over the WidgetWorkspace join (spec §5.6: monitoring dashboard
 * vs edit point).
 *
 * D-03 READ-ONLY POSTURE: no remove/assign/delete affordances exist anywhere
 * in this component. A row-level affordance navigates to /widgets/:id (the
 * WidgetDetailPage edit point); the archive never becomes a second editor.
 *
 * D-06: grouped-by-project is the DEFAULT view (collapsible per project →
 * widget rows with active/inactive badge → linked-workspace chips); the
 * flat-table toggle lazily fetches /flat and carries the client-side CSV
 * export (D-07, EventLogPanel escape idiom).
 *
 * D-13b attribution row: BOTH product URLs are hardcoded component constants
 * (REQUIREMENTS.md WGTA-03 canonical spellings) — never admin- or
 * API-supplied (D-13/T-188-08).
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Download } from "lucide-react";
import { useProjects } from "../queries/useProjects";
import { useWidgets } from "../queries/useWidgets";
import {
  useArchiveStats,
  useFlatArchive,
  useWidgetWorkspaceArchive,
  type ArchiveProjectGroup,
  type ArchiveGroupWidget,
  type ArchiveFlatRow,
} from "../queries/useWidgetWorkspaceArchive";
import type { WidgetWorkspaceArchiveFilterInput } from "@simmetric-chat/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { showError } from "../lib/toast";
import { cn } from "@/lib/utils";

// D-13/D-13b: canonical product URLs — component constants, never config-derived.
const STUDIO_SIMMOS_URL = "https://www.studiosimos.it";
const SIMMETRIC_CHAT_URL = "https://www.simmetricchat.com";

type ArchiveView = "grouped" | "flat";

/* ------------------------------------------------------------------ */
/*  Grouped view pieces                                                */
/* ------------------------------------------------------------------ */

/** One widget row inside a project group: badge + workspace chips. Display-only. */
function ArchiveWidgetRow({ widget }: { widget: ArchiveGroupWidget }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/widgets/${widget.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/widgets/${widget.id}`);
        }
      }}
      className="flex min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent"
      data-testid={`archive-widget-row-${widget.id}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{widget.name}</span>
        <Badge
          variant={widget.isActive ? "default" : "outline"}
          className="text-xs"
        >
          {widget.isActive ? t("widgets.archive.activeBadge") : t("widgets.archive.inactiveBadge")}
        </Badge>
        {widget.workspaces.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {widget.workspaces.map((ws) => (
              <span
                key={ws.id}
                className="inline-flex max-w-[220px] items-center truncate rounded-md border border-border bg-muted px-2 py-0.5 text-xs text-secondary-foreground"
                title={ws.name}
              >
                {ws.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One collapsible project group. */
function ArchiveProjectSection({ group }: { group: ArchiveProjectGroup }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <CollapsibleTrigger
          className="flex min-h-[44px] flex-1 items-center gap-2 rounded-md text-left text-sm font-semibold text-foreground transition-colors hover:bg-accent"
          aria-expanded={expanded}
          data-testid={`archive-project-${group.project.id}`}
        >
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          {group.project.name}
          <span className="text-xs font-normal text-muted-foreground">
            ({group.widgets.length})
          </span>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="space-y-1 px-3 pb-3">
          {group.widgets.map((widget) => (
            <ArchiveWidgetRow key={`${group.project.id}-${widget.id}`} widget={widget} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/* ------------------------------------------------------------------ */
/*  Flat view + CSV (D-07)                                             */
/* ------------------------------------------------------------------ */

/**
 * Client-side CSV from the already-fetched flat rows (D-07 — no server CSV
 * endpoint). EventLogPanel idiom verbatim: escape = `"` → `""` wrapping,
 * Blob + URL.createObjectURL + temp anchor + revokeObjectURL.
 */
export function buildArchiveCsv(rows: ArchiveFlatRow[]): string {
  const escape = (val: string) => `"${val.replace(/"/g, '""')}"`;
  const headers = ["projectName", "widgetName", "widgetIsActive", "workspaceName"];
  const csvRows = rows.map((r) => [
    r.projectName,
    r.widgetName,
    r.widgetIsActive ? "true" : "false",
    r.workspaceName,
  ]);
  return [
    headers.map(escape).join(","),
    ...csvRows.map((r: string[]) => r.map(escape).join(",")),
  ].join("\n");
}

function downloadArchiveCsv(rows: ArchiveFlatRow[], fileNameBase: string): void {
  const csv = buildArchiveCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileNameBase}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function ArchiveFlatTable({ rows }: { rows: ArchiveFlatRow[] }) {
  const { t } = useTranslation();
  const handleExportCsv = () => {
    try {
      downloadArchiveCsv(rows, "widget-workspace-archive");
    } catch {
      // EventLogPanel export posture: surface failures via toast instead of
      // swallowing them (Rule 2 — missing error handling).
      showError(t("widgets.archive.exportError"));
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={handleExportCsv} data-testid="archive-export-csv">
          <Download className="mr-1.5 size-4" />
          {t("widgets.archive.exportCsv")}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted text-left">
              <th className="px-3 py-2 font-medium text-foreground">{t("widgets.archive.colProject")}</th>
              <th className="px-3 py-2 font-medium text-foreground">{t("widgets.archive.colWidget")}</th>
              <th className="px-3 py-2 font-medium text-foreground">{t("widgets.archive.colStatus")}</th>
              <th className="px-3 py-2 font-medium text-foreground">{t("widgets.archive.colWorkspace")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={`${row.widgetId}-${row.workspaceId}`}
                className="border-b border-border last:border-b-0"
                data-testid={`archive-flat-row-${row.widgetId}-${row.workspaceId}`}
              >
                <td className="px-3 py-2 text-foreground">{row.projectName}</td>
                <td className="px-3 py-2 text-foreground">{row.widgetName}</td>
                <td className="px-3 py-2">
                  <Badge variant={row.widgetIsActive ? "default" : "outline"} className="text-xs">
                    {row.widgetIsActive
                      ? t("widgets.archive.activeBadge")
                      : t("widgets.archive.inactiveBadge")}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-foreground">{row.workspaceName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function WidgetWorkspaceArchive() {
  const { t } = useTranslation();

  // D-07 filters: project select + widget select (from the existing list hooks).
  const { data: projects = [] } = useProjects();
  const { data: widgets = [] } = useWidgets();

  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [widgetFilter, setWidgetFilter] = useState<string>("all");
  const [view, setView] = useState<ArchiveView>("grouped");

  const filters = useMemo<WidgetWorkspaceArchiveFilterInput>(
    () => ({
      ...(projectFilter !== "all" ? { projectId: projectFilter } : {}),
      ...(widgetFilter !== "all" ? { widgetId: widgetFilter } : {}),
    }),
    [projectFilter, widgetFilter]
  );

  const { data: stats } = useArchiveStats();
  const { data: groups = [], isLoading: groupedLoading } = useWidgetWorkspaceArchive(filters);
  // Lazy fetch: the flat endpoint is queried ONLY while the flat view is
  // active (D-07 — useWidgetLeads enabled idiom).
  const { data: flatRows = [], isLoading: flatLoading } = useFlatArchive(filters, view === "flat");

  return (
    <div className="space-y-4">
      {/* Stats header — numeric totals + orphans (D-07, ROADMAP SC-1) */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="archive-stats">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-lg font-semibold text-foreground" data-testid="stat-total-widgets">
            {stats?.totalWidgets ?? 0}
          </div>
          <div className="text-xs text-muted-foreground">{t("widgets.archive.statTotalWidgets")}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-lg font-semibold text-foreground" data-testid="stat-total-workspaces">
            {stats?.totalWorkspacesLinked ?? 0}
          </div>
          <div className="text-xs text-muted-foreground">{t("widgets.archive.statTotalWorkspaces")}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="text-lg font-semibold text-foreground" data-testid="stat-total-projects">
            {stats?.totalProjects ?? 0}
          </div>
          <div className="text-xs text-muted-foreground">{t("widgets.archive.statTotalProjects")}</div>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className={`text-lg font-semibold ${stats?.orphans ? "text-destructive" : "text-foreground"}`} data-testid="stat-orphans">
            {stats?.orphans ?? 0}
          </div>
          <div className="text-xs text-muted-foreground">{t("widgets.archive.statOrphans")}</div>
        </div>
      </div>

      {/* Filter row — project select + widget select (D-07) */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger size="sm" aria-label={t("widgets.archive.filterProject")} data-testid="archive-filter-project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("widgets.archive.filterAllProjects")}</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={widgetFilter} onValueChange={setWidgetFilter}>
          <SelectTrigger size="sm" aria-label={t("widgets.archive.filterWidget")} data-testid="archive-filter-widget">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("widgets.archive.filterAllWidgets")}</SelectItem>
            {widgets.map((w) => (
              <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant={view === "grouped" ? "default" : "outline"}
            onClick={() => setView("grouped")}
            aria-pressed={view === "grouped"}
          >
            {t("widgets.archive.viewGrouped")}
          </Button>
          <Button
            size="sm"
            variant={view === "flat" ? "default" : "outline"}
            onClick={() => setView("flat")}
            aria-pressed={view === "flat"}
          >
            {t("widgets.archive.viewFlat")}
          </Button>
        </div>
      </div>

      {/* Content — grouped is the DEFAULT view (D-06) */}
      {view === "grouped" ? (
        <div className="space-y-3" data-testid="archive-grouped-view">
          {groupedLoading && <div className="text-sm text-muted-foreground">{t("common.loading")}</div>}
          {!groupedLoading && groups.length === 0 && (
            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              {t("widgets.archive.emptyState")}
            </div>
          )}
          {!groupedLoading &&
            groups.map((group) => <ArchiveProjectSection key={group.project.id} group={group} />)}
        </div>
      ) : (
        <div data-testid="archive-flat-view">
          {flatLoading && <div className="text-sm text-muted-foreground">{t("common.loading")}</div>}
          {!flatLoading && flatRows.length === 0 && (
            <div className="rounded-lg border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              {t("widgets.archive.emptyState")}
            </div>
          )}
          {!flatLoading && flatRows.length > 0 && <ArchiveFlatTable rows={flatRows} />}
        </div>
      )}

      {/* D-13b attribution row — compact, both hardcoded product links. */}
      <div
        className={cn("flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground")}
        data-testid="archive-attribution"
      >
        <span>{t("widgets.archive.attribution")}</span>
        <span className="flex items-center gap-3">
          <a href={STUDIO_SIMMOS_URL} className="underline underline-offset-2 hover:text-foreground">
            {STUDIO_SIMMOS_URL}
          </a>
          <a href={SIMMETRIC_CHAT_URL} className="underline underline-offset-2 hover:text-foreground">
            {SIMMETRIC_CHAT_URL}
          </a>
        </span>
      </div>
    </div>
  );
}
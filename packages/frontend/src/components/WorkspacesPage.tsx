// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import { ApiError } from "../utils/api";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useMe } from "../queries/useAuth";
import RecentlyDeleted from "./RecentlyDeleted";
import WorkspaceRow from "./WorkspaceRow";
import WorkspaceCreatePanel from "./WorkspaceCreatePanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
} from "@/components/ui/table";
import {
  useWorkspaces,
  useUpdateWorkspace,
  useDeleteWorkspace,
  useBulkDeleteWorkspaces,
} from "../queries/useWorkspaces";
import { apiGet } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface ProjectOption {
  id: string;
  name: string;
}

export default function WorkspacesPage() {
  const { t } = useTranslation();
  usePageMeta(t("workspaces.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.workspaces") }]);
  const { data: workspaces = [], isLoading: loading } = useWorkspaces();
  const updateWorkspaceMut = useUpdateWorkspace();
  const deleteWorkspaceMut = useDeleteWorkspace();
  const bulkDeleteMut = useBulkDeleteWorkspaces();
  const { data: user } = useMe();
  const isAdmin = user?.roles.some((r) => r.name === "admin") ?? false;
  const [filter, setFilter] = useState<"all" | "owned" | "shared">("all");
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<ProjectOption[]>("/projects");
        if (!cancelled) setProjects(data);
      } catch {
        // projects not available — leave list empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredWorkspaces = (() => {
    let result = [...workspaces];
    if (selectedProjectId !== "all") {
      result = result.filter((w) => w.projectId === selectedProjectId);
    }
    if (filter === "owned") {
      result = result.filter((w) => w.project?.createdBy === user?.id);
    } else if (filter === "shared") {
      result = result.filter((w) => w.project?.createdBy !== user?.id);
    }
    result.sort((a, b) => {
      const aDate = new Date(a.createdAt).getTime();
      const bDate = new Date(b.createdAt).getTime();
      return bDate - aDate;
    });
    return result;
  })();

  // UX-04 selection is derived from the project-filtered list ONLY (Pitfall 2):
  // rows hidden by a filter change are never bulk-deleted or counted. Selection
  // clears whenever the filter value changes.
  const visibleIds = filteredWorkspaces.map((w) => w.id);
  const visibleSelectedIds = visibleIds.filter((id) => selectedIds.has(id));
  const isAllSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const isIndeterminate = visibleSelectedIds.length > 0 && !isAllSelected;

  const handleBindViewChange = (value: string) => {
    setFilter(value as "all" | "owned" | "shared");
    setSelectedIds(new Set());
  };

  const handleProjectChange = (value: string) => {
    setSelectedProjectId(value);
    setSelectedIds(new Set());
  };

  const handleSelectAll = () => {
    // Select-all over an empty filtered list is a no-op — the bar never appears.
    if (visibleIds.length === 0) return;
    setSelectedIds((prev) => {
      if (visibleIds.every((id) => prev.has(id))) {
        return new Set();
      }
      return new Set(visibleIds);
    });
  };

  const handleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleBulkDeleteConfirm = async () => {
    if (visibleSelectedIds.length === 0 || bulkDeleteMut.isPending) return;
    setBulkDeleting(true);
    try {
      const results = await bulkDeleteMut.mutateAsync(visibleSelectedIds);
      const deleted = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult[];
      // Only 403 is a permission skip; any other rejection (5xx/network) is a
      // real failure and must not be reported as "skipped (no permission)".
      const skipped = rejected.filter(
        (r) => (r.reason as ApiError | undefined)?.status === 403,
      ).length;
      const failed = rejected.length - skipped;
      if (deleted > 0) {
        showSuccess(t("workspace.bulk.deleteResult", { deleted, skipped }));
      }
      if (failed > 0 || deleted === 0) {
        showError(getErrorMessage(null, t("workspace.bulk.deleteError")));
      }
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("workspace.bulk.deleteError")));
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold text-foreground">
        {t("workspace.title")}
      </h2>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs font-medium text-muted-foreground uppercase">
          {t("workspaces.filterByProject")}
        </label>
        <Select
          value={selectedProjectId}
          onValueChange={handleProjectChange}
        >
          <SelectTrigger className="border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto min-w-[200px]">
            <SelectValue placeholder={t("workspaces.allProjects")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("workspaces.allProjects")}</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <div className="px-5 py-3 border-b border-input flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            {t("workspace.title")}
          </h3>
          <div className="flex items-center gap-3">
            <Button
              variant="default"
              size="sm"
              onClick={() => setShowCreatePanel((prev) => !prev)}
            >
              <Plus className="w-4 h-4 mr-1" />
              {t("workspace.newWorkspace")}
            </Button>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">
                {t("workspace.filterLabel")}
              </label>
              <Select value={filter} onValueChange={handleBindViewChange}>
                <SelectTrigger className="border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("workspace.all")}</SelectItem>
                  <SelectItem value="owned">{t("workspace.owned")}</SelectItem>
                  <SelectItem value="shared">{t("workspace.shared")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {showCreatePanel && (
          <WorkspaceCreatePanel
            inline
            onCreated={() => {
              setShowCreatePanel(false);
            }}
            onCancel={() => setShowCreatePanel(false)}
          />
        )}

        {/* Bulk actions bar — only when ≥1 VISIBLE row is selected (UX-04) */}
        {visibleSelectedIds.length > 0 && (
          <div className="flex items-center gap-3 px-5 py-2 border-b border-input bg-muted/30">
            <span className="text-sm text-muted-foreground">
              {t("workspace.bulk.selected", { count: visibleSelectedIds.length })}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
              disabled={bulkDeleting}
              className="ml-auto text-destructive hover:text-destructive"
              aria-label={t("workspace.bulk.deleteButton")}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              {t("workspace.bulk.deleteButton")}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-secondary-foreground">
            {t("common.loading")}
          </div>
        ) : filteredWorkspaces.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <h4 className="text-lg font-semibold text-foreground mb-2">
              {t("workspace.emptyTitle")}
            </h4>
            <p className="text-sm text-muted-foreground">
              {t("workspace.emptyBody")}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-b border-input text-left text-muted-foreground">
                <TableHead className="w-10 px-3 py-2">
                  <Checkbox
                    checked={isAllSelected}
                    data-state={isIndeterminate ? "indeterminate" : isAllSelected ? "checked" : "unchecked"}
                    onCheckedChange={handleSelectAll}
                    aria-label={t("workspace.bulk.selectAll")}
                    data-testid="select-all"
                  />
                </TableHead>
                <TableHead className="px-5 py-2 text-xs uppercase tracking-wide">
                  {t("workspace.name")}
                </TableHead>
                {isAdmin && (
                  <TableHead className="px-5 py-2 text-xs uppercase tracking-wide">
                    {t("workspace.owner")}
                  </TableHead>
                )}
                <TableHead className="px-5 py-2 text-xs uppercase tracking-wide">
                  {t("workspaces.allowMemberUploads")}
                </TableHead>
                <TableHead className="px-5 py-2 text-xs uppercase tracking-wide">
                  {t("workspace.created")}
                </TableHead>
                <TableHead className="px-5 py-2 text-xs uppercase tracking-wide">
                  {t("workspace.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredWorkspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  isAdmin={isAdmin}
                  currentUserId={user?.id}
                  onUpdate={(id, data) => updateWorkspaceMut.mutateAsync({ id, data })}
                  onDelete={(id) => deleteWorkspaceMut.mutateAsync(id)}
                  selected={selectedIds.has(workspace.id)}
                  onToggleSelect={handleSelectOne}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Bulk delete confirmation dialog (UX-04, D-04) */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspace.bulk.deleteButton")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspace.bulk.confirmBody", { count: visibleSelectedIds.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting} onClick={() => setBulkDeleteOpen(false)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDeleteConfirm}
              disabled={bulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RecentlyDeleted />
    </div>
  );
}

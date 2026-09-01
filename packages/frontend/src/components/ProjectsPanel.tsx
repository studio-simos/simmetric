// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Pencil, Trash2 } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ProjectRenameModal from "./ProjectRenameModal";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import {
  useProjects,
  useCreateProject,
  useDeleteProject,
  useBulkDeleteProjects,
  useProjectUsage,
  useProjectExport,
  type ProjectUsage,
} from "../queries/useProjects";

export default function ProjectsPanel() {
  const { t } = useTranslation();
  usePageMeta(t("projects.pageTitle"), [
    { label: t("breadcrumb.home"), path: "/" },
    { label: t("breadcrumb.projects") },
  ]);

  const { data: projects = [], isLoading, error } = useProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const bulkDeleteProjects = useBulkDeleteProjects();
  const exportProject = useProjectExport();

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  // Rename modal
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const usage = useProjectUsage(deleteTarget?.id ?? null);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  const allIds = projects.map((p) => p.id);
  const isAllSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const isIndeterminate = selectedIds.size > 0 && !isAllSelected;

  const handleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allIds.every((id) => prev.has(id))) {
        return new Set();
      }
      return new Set(allIds);
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

  const handleBulkDeleteClick = () => {
    setShowBulkDeleteConfirm(true);
  };

  const confirmBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    try {
      await bulkDeleteProjects.mutateAsync(ids);
      showSuccess(
        t("projects.deleteSuccess") + ` (${ids.length})`
      );
      setSelectedIds(new Set());
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("common.error")));
    } finally {
      setShowBulkDeleteConfirm(false);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await createProject.mutateAsync({
        name: newName,
        description: newDesc || undefined,
      });
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("common.error")));
    }
  };

  const handleRenameClick = (project: { id: string; name: string }) => {
    setRenameTarget({ id: project.id, name: project.name });
    setRenameOpen(true);
  };

  const handleDeleteClick = (project: { id: string; name: string }) => {
    setDeleteTarget({ id: project.id, name: project.name });
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteProject.mutateAsync(deleteTarget.id);
      showSuccess(t("projects.deleteSuccess"));
      setDeleteTarget(null);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("projects.deleteError")));
    }
  };

  const handleExport = async () => {
    if (!deleteTarget) return;
    try {
      await exportProject.mutateAsync({
        projectId: deleteTarget.id,
        name: deleteTarget.name,
      });
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("projects.deleteError")));
    }
  };

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <p className="text-secondary-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  const usageCounts: { key: keyof ProjectUsage; label: string }[] = [
    { key: "workspaces", label: t("projects.usageWorkspaces") },
    { key: "chats", label: t("projects.usageChats") },
    { key: "documents", label: t("projects.usageDocuments") },
    { key: "mcpConnections", label: t("projects.usageMcpConnections") },
    { key: "accessGrants", label: t("projects.usageAccessGrants") },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-foreground">{t("projects.title")}</h2>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? t("common.cancel") : t("projects.create")}
        </Button>
      </div>

      {error && (
        <div className="text-sm text-destructive-foreground bg-destructive rounded p-3">
          {getErrorMessage(error, t("common.error"))}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="p-4 border border-border rounded-lg bg-card space-y-3">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("projects.name")}
          />
          <Textarea
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder={t("projects.description")}
            rows={2}
          />
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={createProject.isPending || !newName.trim()}
          >
            {createProject.isPending ? t("common.loading") : t("projects.create")}
          </Button>
        </div>
      )}

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 border border-border rounded-lg bg-card">
          <span className="text-sm text-muted-foreground">
            {t("projects.bulk.selected", { count: selectedIds.size })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkDeleteClick}
            className="ml-auto text-destructive hover:text-destructive"
          >
            {t("projects.bulk.delete")}
          </Button>
        </div>
      )}

      {/* Project list */}
      {projects.length === 0 ? (
        <p className="text-sm text-secondary-foreground">{t("projects.noProjects")}</p>
      ) : (
        <div className="space-y-1">
          {/* Select-all row */}
          <div className="flex items-center gap-3 px-4 py-1.5 border border-transparent" role="row">
            <Checkbox
              checked={isAllSelected || isIndeterminate}
              data-state={isIndeterminate ? "indeterminate" : isAllSelected ? "checked" : "unchecked"}
              onCheckedChange={handleSelectAll}
              aria-label={t("common.selectAll")}
              className="shrink-0"
            />
            <span className="text-xs text-muted-foreground">
              {selectedIds.size > 0
                ? t("projects.bulk.selected", { count: selectedIds.size })
                : `${projects.length} projects`}
            </span>
          </div>

          {projects.map((project) => (
            <div key={project.id} className="p-4 border border-border rounded-lg bg-card">
              <div className="flex items-start gap-3">
                <Checkbox
                  checked={selectedIds.has(project.id)}
                  onCheckedChange={() => handleSelectOne(project.id)}
                  aria-label={`Select ${project.name}`}
                  className="mt-1 shrink-0"
                />
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 flex-1 min-w-0">
                  <div>
                    <h3 className="font-medium text-foreground">{project.name}</h3>
                    {project.description && (
                      <p className="text-sm text-muted-foreground mt-1">{project.description}</p>
                    )}
                    <p className="text-xs text-secondary-foreground mt-2">
                      ID: {project.id.substring(0, 8)}...
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("projects.rename")}
                      title={t("projects.rename")}
                      onClick={() => handleRenameClick(project)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("projects.delete")}
                      title={t("projects.delete")}
                      onClick={() => handleDeleteClick(project)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Rename modal */}
      <ProjectRenameModal
        open={renameOpen}
        onOpenChange={setRenameOpen}
        project={renameTarget}
      />

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono">{t("projects.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("projects.deleteWarning")}</DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-2">
            {usage.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : (
              <ul className="text-sm space-y-1">
                {usageCounts.map(({ key, label }) => (
                  <li key={key} className="flex justify-between">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono">{usage.data?.[key] ?? 0}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-destructive-foreground pt-2">
              {t("projects.confirmDelete")}
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleExport}
              disabled={exportProject.isPending}
            >
              {exportProject.isPending ? t("projects.exporting") : t("projects.exportHistory")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleteProject.isPending || usage.isLoading}
            >
              {deleteProject.isPending ? t("common.loading") : t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirmation dialog */}
      <AlertDialog open={showBulkDeleteConfirm} onOpenChange={setShowBulkDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("projects.bulk.delete")} ({selectedIds.size})
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.bulk.confirmDelete", { count: selectedIds.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("chat.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmBulkDelete}
              disabled={bulkDeleteProjects.isPending}
            >
              {bulkDeleteProjects.isPending ? t("common.loading") : t("projects.bulk.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
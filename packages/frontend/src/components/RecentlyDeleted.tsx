// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useDeletedWorkspaces,
  useBulkRestoreWorkspaces,
  usePermanentDeleteWorkspaces,
} from "../queries/useWorkspaces";
import { showError, showSuccess } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

export default function RecentlyDeleted() {
  const { t } = useTranslation();
  const { data: deletedWorkspaces = [] } = useDeletedWorkspaces();
  const bulkRestoreMut = useBulkRestoreWorkspaces();
  const permanentDeleteMut = usePermanentDeleteWorkspaces();
  const [expanded, setExpanded] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const allIds = deletedWorkspaces.map((w) => w.id);
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

  const handleBulkRestore = () => {
    bulkRestoreMut.mutate(Array.from(selectedIds));
  };

  const handlePermanentDelete = () => {
    setShowDeleteConfirm(true);
  };

  const confirmPermanentDelete = async () => {
    if (permanentDeleteMut.isPending) return;
    try {
      await permanentDeleteMut.mutateAsync(Array.from(selectedIds));
      showSuccess(
        t("workspace.bulk.deleteSuccess", {
          count: selectedIds.size,
          defaultValue: "Workspaces permanently deleted",
        }),
      );
      setSelectedIds(new Set());
      setShowDeleteConfirm(false);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("workspace.bulk.deleteError", { defaultValue: "Permanent delete failed" })));
    }
  };

  return (
    <div className="mt-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
        <span>{t("workspace.recentlyDeleted")}</span>
        {deletedWorkspaces.length > 0 && (
          <Badge variant="outline" className="text-xs">
            {deletedWorkspaces.length}
          </Badge>
        )}
      </Button>

      {expanded && (
        <div className="mt-3 bg-card rounded-lg border border-input overflow-hidden">
          {deletedWorkspaces.length === 0 ? (
            <div className="px-5 py-4 text-sm text-muted-foreground">
              {t("workspace.noDeleted")}
            </div>
          ) : (
            <>
              {/* Bulk actions bar */}
              {selectedIds.size > 0 && (
                <div className="flex items-center gap-3 px-5 py-2 border-b border-input bg-muted/30">
                  <span className="text-sm text-muted-foreground">
                    {t("workspace.bulk.selected", { count: selectedIds.size })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBulkRestore}
                    className="ml-auto"
                  >
                    {t("workspace.bulk.restore")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handlePermanentDelete}
                    className="text-destructive hover:text-destructive"
                  >
                    {t("workspace.bulk.deletePermanent")}
                  </Button>
                </div>
              )}

              <Table className="w-full text-sm">
                <TableHeader>
                  <TableRow className="border-b border-input text-left text-muted-foreground">
                    <TableHead className="w-10 px-3 py-2">
                      <Checkbox
                        checked={isAllSelected}
                        data-state={isIndeterminate ? "indeterminate" : isAllSelected ? "checked" : "unchecked"}
                        onCheckedChange={handleSelectAll}
                        aria-label="Select all"
                      />
                    </TableHead>
                    <TableHead className="px-5 py-2 text-xs font-medium uppercase tracking-wide">{t("workspace.name")}</TableHead>
                    <TableHead className="px-5 py-2 text-xs font-medium uppercase tracking-wide">{t("workspace.description")}</TableHead>
                    <TableHead className="px-5 py-2 text-xs font-medium uppercase tracking-wide">{t("workspace.created")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deletedWorkspaces.map((workspace) => (
                    <TableRow
                      key={workspace.id}
                      className="border-b border-input hover:bg-muted"
                    >
                      <TableCell className="px-3 py-3">
                        <Checkbox
                          checked={selectedIds.has(workspace.id)}
                          onCheckedChange={() => handleSelectOne(workspace.id)}
                          aria-label={`Select ${workspace.name}`}
                        />
                      </TableCell>
                      <TableCell className="px-5 py-3 text-foreground">{workspace.name}</TableCell>
                      <TableCell className="px-5 py-3 text-muted-foreground">{workspace.instructions || "—"}</TableCell>
                      <TableCell className="px-5 py-3 text-xs text-muted-foreground">
                        {new Date(workspace.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspace.bulk.deletePermanent")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspace.bulk.confirmDelete")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("chat.cancel")}</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={confirmPermanentDelete}
              disabled={permanentDeleteMut.isPending}
            >
              {permanentDeleteMut.isPending
                ? t("common.deleting", { defaultValue: "Deleting..." })
                : t("workspace.bulk.deletePermanent")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

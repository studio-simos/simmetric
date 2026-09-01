// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, RotateCcw, Eye } from "lucide-react";
import { apiGet, apiPost } from "../utils/api";
import { WikiDiffViewer } from "./WikiDiffViewer";
import { showSuccess, showError } from "../lib/toast";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils"
import { getErrorMessage } from "../utils/errorUtils";
interface WikiEditRun {
  id: string;
  pageSlug: string;
  action: string;
  status: string;
  previewJson: {
    diff?: {
      old?: string;
      new?: string;
    };
  } | null;
  createdAt: string;
}

interface WikiHistoryModalProps {
  archiveId: string;
  onClose: () => void;
}

export function WikiHistoryModal({ archiveId, onClose }: WikiHistoryModalProps) {
  const { t } = useTranslation();
    const [runs, setRuns] = useState<WikiEditRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRun, setSelectedRun] = useState<WikiEditRun | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  useEffect(() => {
    apiGet<WikiEditRun[]>(`/wiki-edits/${archiveId}`)
      .then((data) => setRuns(data || []))
      .catch((err: unknown) => {
        showError(getErrorMessage(err, t("common.error", "An error occurred")));
        setRuns([]);
      })
      .finally(() => setLoading(false));
  }, [archiveId, t]);

  const handleUndo = async (runId: string) => {
    setUndoingId(runId);
    try {
      await apiPost(`/wiki-write/${runId}/undo`, {});
      setRuns((prev) =>
        prev.map((r) => (r.id === runId ? { ...r, status: "REVERTED" } : r))
      );
      showSuccess(t("wiki.undoSuccess", "Change reverted successfully"));
    } catch (err: unknown) {
      showError(
        getErrorMessage(err, t("wiki.undoFailed", "Failed to revert change"))
      );
    } finally {
      setUndoingId(null);
    }
  };

  const statusBadge = (status: string) => {
    const isReverted = status === "REVERTED";
    const isApplied = status === "APPLIED";
    return (
      <span
        className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", isReverted
            ? "bg-accent text-accent-foreground border-accent-foreground/20"
            : isApplied
            ? "bg-secondary text-secondary-foreground border-secondary-foreground/20"
            : "bg-accent text-muted-foreground border-border")}
      >
        {status}
      </span>
    );
  };

  return (
    <Dialog open={true} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
          <DialogTitle className="text-lg font-semibold text-foreground m-0">
            {t("wiki.historyTitle", "Edit History")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("wiki.historyDescription", "List of edits made to this archive")}
          </DialogDescription>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t("common.close", "Close")}
          >
            <X size={20} />
          </Button>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="space-y-3 py-4">
              <Skeleton className="h-12 w-full rounded-md" />
              <Skeleton className="h-12 w-full rounded-md" />
              <Skeleton className="h-12 w-full rounded-md" />
            </div>
          )}
          {!loading && runs.length === 0 && (
            <div className="text-muted-foreground text-center py-8">
              {t("wiki.noHistory", "No edit history found")}
            </div>
          )}
          <div className="space-y-3">
            {runs.map((run) => (
              <div
                key={run.id}
                className="border border-border rounded-lg p-3 bg-card"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-foreground truncate">
                      {run.pageSlug}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {run.action} — {statusBadge(run.status)} —{" "}
                      {new Date(run.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {run.status === "APPLIED" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUndo(run.id)}
                        disabled={undoingId === run.id}
                        title={t("wiki.undo", "Undo")}
                      >
                        <RotateCcw size={14} />
                        {undoingId === run.id
                          ? t("common.saving", "Saving...")
                          : t("wiki.undo", "Undo")}
                      </Button>
                    )}
                    {run.previewJson?.diff && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedRun(run)}
                        title={t("wiki.viewDiff", "View Diff")}
                      >
                        <Eye size={14} />
                        {t("wiki.viewDiff", "View Diff")}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>

      {selectedRun && selectedRun.previewJson?.diff && (
        <WikiDiffViewer
          oldContent={selectedRun.previewJson.diff.old || ""}
          newContent={selectedRun.previewJson.diff.new || ""}
          onClose={() => setSelectedRun(null)}
        />
      )}
    </Dialog>
  );
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Trash2, Pencil } from "lucide-react";
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type { SynthesisRunData } from "../queries/useSynthesis";
import { useRenameSynthesisRun } from "../queries/useSynthesis";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import { renderReasonLine } from "../lib/synthesisReason";

interface SynthesisRunCardProps {
  run: SynthesisRunData;
  onClick: () => void;
  onDelete?: () => void;
}

function statusBadgeProps(status: SynthesisRunData["status"]): {
  variant: "default" | "secondary" | "destructive";
  className: string;
} {
  switch (status) {
    case "COMPLETED":
      return { variant: "default", className: "" };
    case "APPROVED":
      return {
        variant: "default",
        className: "bg-secondary text-secondary-foreground",
      };
    case "REJECTED":
      return { variant: "destructive", className: "" };
    case "FAILED":
      return { variant: "destructive", className: "" };
    case "PROCESSING":
      return { variant: "secondary", className: "animate-pulse" };
    case "PENDING":
    case "PARTIAL":
    default:
      return { variant: "secondary", className: "" };
  }
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString();
  } catch {
    return dateStr;
  }
}

export default function SynthesisRunCard({ run, onClick, onDelete }: SynthesisRunCardProps) {
  const { t } = useTranslation();
  const [showDelete, setShowDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const renameMutation = useRenameSynthesisRun();
  const statusStyle = statusBadgeProps(run.status);
  const displayTitle = run.name
    || (run.archive?.name
      ? `${run.archive.name} — ${formatDate(run.createdAt)}`
      : `${t("synthesis.runCard.archiveId", { id: run.archiveId.slice(0, 8) })} — ${formatDate(run.createdAt)}`);
  const statusLabel = t(`synthesis.detail.status.${run.status}`);

  const handleRename = async () => {
    const name = renameInput.trim();
    if (!name) { setRenaming(null); return; }
    if (name === run.name) { setRenaming(null); return; }
    try {
      await renameMutation.mutateAsync({ runId: run.id, name });
      showSuccess(t("synthesis.rename.success"));
    } catch (err: unknown) {
      showError(t("synthesis.rename.error") + ": " + getErrorMessage(err));
    } finally {
      setRenaming(null);
    }
  };

  return (
    <>
      <Card
        className="group cursor-pointer hover:ring-2 hover:ring-foreground/10 transition-all relative"
        onClick={onClick}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            {renaming === run.id ? (
              <form
                onSubmit={(e) => { e.preventDefault(); handleRename(); }}
                className="flex gap-1"
              >
                <Input
                  type="text"
                  value={renameInput}
                  onChange={(e) => setRenameInput(e.target.value)}
                  className="flex-1 min-w-0 px-1 py-0.5 h-auto text-[20px] font-semibold leading-[1.2]"
                  autoFocus
                  aria-label={t("synthesis.rename.ariaLabel")}
                  placeholder={run.name}
                  disabled={renameMutation.isPending}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                  }}
                  onBlur={() => handleRename()}
                />
              </form>
            ) : (
              <CardTitle
                style={{ fontSize: "20px", fontWeight: 600, lineHeight: 1.2 }}
                onDoubleClick={() => { setRenaming(run.id); setRenameInput(run.name); }}
              >
                {displayTitle}
              </CardTitle>
            )}
            <div className="flex items-center gap-1 flex-shrink-0">
              <Badge variant={statusStyle.variant} className={statusStyle.className}>
                {statusLabel}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary"
                aria-label={t("synthesis.rename.ariaLabel")}
                disabled={renameMutation.isPending || renaming === run.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming(run.id);
                  setRenameInput(run.name);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowDelete(true);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {run.status === "FAILED" && run.error && (
            <p className="text-sm text-destructive mb-2">{renderReasonLine(run.error, t)}</p>
          )}
          <div className="flex flex-col gap-1 text-sm text-muted-foreground" style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}>
            <div className="flex items-center gap-4">
              <span>
                {t("synthesis.budget.pagesWritten")}: {run.pagesWritten}
              </span>
              <span>
                {t("synthesis.contradictions.title")}: {run.contradictionsFound}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <span>
                {t("synthesis.budget.tokensUsed")}: {run.tokensUsed.toLocaleString()}
              </span>
              <span>
                {t("synthesis.budget.llmCallsUsed")}: {run.llmCallsUsed}
              </span>
            </div>
            <span className="text-xs text-secondary-foreground">
              {formatDate(run.createdAt)}
            </span>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("synthesis.deleteRun")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("synthesis.deleteRunConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDelete?.();
                setShowDelete(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

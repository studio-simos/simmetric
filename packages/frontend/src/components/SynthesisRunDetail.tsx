// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import {
  useSynthesisRunDetail,
  useApproveSynthesisRun,
  useRejectSynthesisRun,
  useRenameSynthesisRun,
} from "../queries/useSynthesis";
import { showSuccess, showError } from "../lib/toast";
import { ApiError } from "../utils/api";
import { getErrorMessage } from "../utils/errorUtils";
import SynthesisBudgetBar from "./SynthesisBudgetBar";
import SynthesisDiffView from "./SynthesisDiffView";
import SynthesisContradictionCard from "./SynthesisContradictionCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
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
import { ArrowLeft, AlertTriangle, Pencil } from "lucide-react";
import { renderReasonLine } from "../lib/synthesisReason";

type RunStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "APPROVED" | "REJECTED" | "PARTIAL" | "FAILED";

function statusBadgeProps(status: RunStatus): {
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

export default function SynthesisRunDetail() {
  const { t } = useTranslation();
  usePageMeta(t("synthesis.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.synthesis"), path: "/synthesis" }, { label: t("synthesis.detail") }]);
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();

  const {
    data: selectedRun,
    isLoading,
    error,
    refetch,
  } = useSynthesisRunDetail(runId);
  const approveMutation = useApproveSynthesisRun();
  const rejectMutation = useRejectSynthesisRun();
  const renameMutation = useRenameSynthesisRun();

  const [approvedSlugs, setApprovedSlugs] = useState<Set<string>>(new Set());
  const [isApproving, setIsApproving] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectingAll, setRejectingAll] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");

  const isActionable =
    (selectedRun?.status === "COMPLETED" || selectedRun?.status === "PARTIAL") &&
    (selectedRun?.previewJson?.changes?.length ?? 0) > 0;

  // UX-03 (D-03): non-actionable runs keep an always-rendered action bar with
  // a disabled approve control + a status-driven reason message instead of
  // hiding the bar. Map status (+ zero changes) to the reason key.
  const notActionableReasonKey = (() => {
    if (isActionable || !selectedRun) return null;
    switch (selectedRun.status) {
      case "PENDING":
        return "synthesis.detail.notActionable.pending";
      case "PROCESSING":
        return "synthesis.detail.notActionable.processing";
      case "FAILED":
        return "synthesis.detail.notActionable.failed";
      case "APPROVED":
        return "synthesis.detail.notActionable.approved";
      case "REJECTED":
        return "synthesis.detail.notActionable.rejected";
      case "COMPLETED":
      case "PARTIAL":
        // Zero changes on a finished run — no approve possible
        return "synthesis.detail.notActionable.noChanges";
      default:
        return "synthesis.detail.notActionable.pending";
    }
  })();

  const handleApproveAll = async () => {
    if (!runId || !selectedRun?.previewJson?.changes?.length) return;
    setIsApproving(true);
    try {
      await approveMutation.mutateAsync({ runId });
      showSuccess(t("synthesis.detail.approveAllSuccess"));
      if (runId) await refetch();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : t("synthesis.detail.approveFailed"));
    } finally {
      setIsApproving(false);
    }
  };

  const handleApproveSelected = async () => {
    if (!runId || approvedSlugs.size === 0) return;
    setIsApproving(true);
    try {
      await approveMutation.mutateAsync({ runId, pageSlugs: Array.from(approvedSlugs) });
      showSuccess(t("synthesis.detail.approveSelectedSuccess"));
      setApprovedSlugs(new Set());
      if (runId) await refetch();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : t("synthesis.detail.approveSelectedFailed"));
    } finally {
      setIsApproving(false);
    }
  };

  const handleRejectAll = async () => {
    if (!runId) return;
    setIsRejecting(true);
    try {
      await rejectMutation.mutateAsync({ runId });
      showSuccess(t("synthesis.detail.rejectAllSuccess"));
      setRejectDialogOpen(false);
      if (runId) await refetch();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : t("synthesis.detail.rejectFailed"));
    } finally {
      setIsRejecting(false);
    }
  };

  const handleRejectSelected = async () => {
    if (!runId || approvedSlugs.size === 0) return;
    setIsRejecting(true);
    try {
      await rejectMutation.mutateAsync({ runId, pageSlugs: Array.from(approvedSlugs) });
      showSuccess(t("synthesis.detail.rejectSelectedSuccess"));
      setApprovedSlugs(new Set());
      setRejectDialogOpen(false);
      if (runId) await refetch();
    } catch (err) {
      showError(err instanceof ApiError ? err.message : t("synthesis.detail.rejectSelectedFailed"));
    } finally {
      setIsRejecting(false);
    }
  };

  const toggleApproval = (slug: string, approved: boolean) => {
    setApprovedSlugs((prev) => {
      const next = new Set(prev);
      if (approved) {
        next.add(slug);
      } else {
        next.delete(slug);
      }
      return next;
    });
  };

  const handleRename = async () => {
    if (!selectedRun) return;
    const name = renameInput.trim();
    if (!name) { setRenaming(null); return; }
    if (name === selectedRun.name) { setRenaming(null); return; }
    try {
      await renameMutation.mutateAsync({ runId: selectedRun.id, name });
      showSuccess(t("synthesis.rename.success"));
    } catch (err: unknown) {
      showError(t("synthesis.rename.error") + ": " + getErrorMessage(err));
    } finally {
      setRenaming(null);
    }
  };

  // Loading state
  if (isLoading && !selectedRun) {
    return (
      <div className="h-full overflow-auto p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-accent rounded w-1/3" />
          <div className="h-4 bg-accent rounded w-1/2" />
          <div className="h-32 bg-accent rounded" />
          <div className="h-32 bg-accent rounded" />
        </div>
      </div>
    );
  }

  // Error state
  if (error && !selectedRun) {
    return (
      <div className="h-full overflow-auto p-6 flex items-center justify-center">
        <div className="text-center max-w-md">
          <h2 style={{ fontSize: "28px", fontWeight: 600, lineHeight: 1.1 }}>
            {t("synthesis.dashboard.error.heading")}
          </h2>
          <p
            className="mt-2 text-muted-foreground"
            style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}
          >
            {error.message}
          </p>
          <Button
            variant="outline"
            className="mt-4 gap-2"
            onClick={() => runId && refetch()}
          >
            {t("synthesis.dashboard.retry")}
          </Button>
        </div>
      </div>
    );
  }

  // Not found
  if (!isLoading && !selectedRun && !error) {
    return (
      <div className="h-full overflow-auto p-6 flex items-center justify-center">
        <div className="text-center max-w-md">
          <h2 style={{ fontSize: "28px", fontWeight: 600, lineHeight: 1.1 }}>
            Synthesis run not found
          </h2>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => navigate("/synthesis")}
          >
            {t("synthesis.dashboard.title")}
          </Button>
        </div>
      </div>
    );
  }

  if (!selectedRun) return null;

  const archiveName = selectedRun.archive?.name || selectedRun.archiveId;
  const status = selectedRun.status as RunStatus;
  const statusStyle = statusBadgeProps(status);
  const statusLabel = t(`synthesis.detail.status.${status}`);
  const preview = selectedRun.previewJson;
  const anyApproved = approvedSlugs.size > 0;

  return (
    <div className="h-full overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/synthesis")}
          className="min-h-[44px] min-w-[44px]"
        >
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            {renaming === selectedRun.id ? (
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
                  placeholder={selectedRun.name}
                  disabled={renameMutation.isPending}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
                  }}
                  onBlur={() => handleRename()}
                />
              </form>
            ) : (
              <h1
                style={{ fontSize: "20px", fontWeight: 600, lineHeight: 1.2 }}
                onDoubleClick={() => { setRenaming(selectedRun.id); setRenameInput(selectedRun.name); }}
              >
                {selectedRun.name || t("synthesis.detail.title", { archiveName })}
              </h1>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-primary"
              aria-label={t("synthesis.rename.ariaLabel")}
              disabled={renameMutation.isPending || renaming === selectedRun.id}
              onClick={() => { setRenaming(selectedRun.id); setRenameInput(selectedRun.name); }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Badge variant={statusStyle.variant} className={statusStyle.className}>
              {statusLabel}
            </Badge>
          </div>
        </div>
      </div>

      {/* KB-04: localized FAILED reason line */}
      {status === "FAILED" && selectedRun.error && (
        <p className="text-sm text-destructive mb-6">{renderReasonLine(selectedRun.error, t)}</p>
      )}

      {/* Budget section */}
      {selectedRun.tokensUsed !== undefined && (
        <div className="mb-6">
          <SynthesisBudgetBar
            pagesRead={selectedRun.pagesRead}
            maxPagesRead={selectedRun.pagesRead} // no explicit max from server
            pagesWritten={selectedRun.pagesWritten}
            maxPagesWritten={100}
            tokensUsed={selectedRun.tokensUsed}
            maxTokens={100000}
            llmCallsUsed={selectedRun.llmCallsUsed}
            maxLlmCalls={50}
            isInProgress={status === "PROCESSING"}
            currentPage={selectedRun.pagesRead}
            totalPages={100}
          />
        </div>
      )}

      <Separator className="my-6" />

      {/* Action buttons */}
      {isActionable ? (
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <Button
            variant="default"
            onClick={handleApproveAll}
            disabled={isApproving || isRejecting}
          >
            {isApproving ? t("synthesis.detail.approving") : t("synthesis.detail.approveAll")}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              setRejectingAll(true);
              setRejectDialogOpen(true);
            }}
            disabled={isApproving || isRejecting}
          >
            {isRejecting ? t("synthesis.detail.rejecting") : t("synthesis.detail.rejectAll")}
          </Button>
          {anyApproved && (
            <Button
              variant="default"
              onClick={handleApproveSelected}
              disabled={isApproving || isRejecting}
            >
              {t("synthesis.detail.approveSelected")}
            </Button>
          )}
          {anyApproved && (
            <Button
              variant="destructive"
              onClick={() => {
                setRejectingAll(false);
                setRejectDialogOpen(true);
              }}
              disabled={isApproving || isRejecting}
            >
              {t("synthesis.detail.rejectSelected")}
            </Button>
          )}
        </div>
      ) : (
        notActionableReasonKey && (
          // UX-03 (D-03): disabled approve with explicit status reason; Reject
          // stays hidden in non-actionable states (OQ2).
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="default" disabled aria-label={t("synthesis.detail.approveAll")}>
                  {t("synthesis.detail.approveAll")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t(notActionableReasonKey)}</TooltipContent>
            </Tooltip>
            <span className="text-sm text-muted-foreground">{t(notActionableReasonKey)}</span>
          </div>
        )
      )}

      {/* Reject confirmation dialog */}
      <AlertDialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {rejectingAll ? t("synthesis.detail.rejectAll") : t("synthesis.detail.rejectSelected")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {rejectingAll
                ? t("synthesis.detail.confirmRejectAll")
                : t("synthesis.detail.confirmRejectSelected", { count: approvedSlugs.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={rejectingAll ? handleRejectAll : handleRejectSelected}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Conflicts warning */}
      {(preview?.contradictions?.length ?? 0) > 0 && (
        <div className="flex items-center gap-2 p-3 mb-6 rounded bg-accent text-accent-foreground text-sm">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <span>
            {t("synthesis.detail.conflictsFound", {
              count: preview?.contradictions?.length ?? 0,
            })}
          </span>
        </div>
      )}

      {/* Changes section */}
      {preview?.changes && preview.changes.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-4" style={{ fontSize: "20px", fontWeight: 600, lineHeight: 1.2 }}>
            Changes
          </h2>
          <div className="flex flex-col gap-6">
            {preview.changes.map((change) => (
              <SynthesisDiffView
                key={change.pageSlug}
                change={change}
                isApproved={change.approved}
                isPending={isActionable && !change.approved}
                hasConflict={false}
                onToggleApproval={(approved) => toggleApproval(change.pageSlug, approved)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Contradictions section */}
      {preview?.contradictions !== undefined && (
        <div className="mb-8">
          <h2 className="mb-4" style={{ fontSize: "20px", fontWeight: 600, lineHeight: 1.2 }}>
            {t("synthesis.contradictions.title")}
          </h2>
          {preview.contradictions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("synthesis.contradictions.none")}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {preview.contradictions.map((contradiction) => (
                <SynthesisContradictionCard
                  key={contradiction.pageSlug + contradiction.claimA.text}
                  contradiction={contradiction}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

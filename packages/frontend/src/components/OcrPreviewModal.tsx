// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Image, FileText, AlertTriangle, X, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Alert, AlertDescription } from "./ui/alert";
import { useApproveOcrJob, useRejectOcrJob } from "../queries/useOcrJobs";
import { queryKeys } from "../queries/keys";
import { showSuccess, showError } from "../lib/toast";
import { renderMarkdown } from "../utils/markdown";
import type { OcrJob } from "../queries/useOcrJobs";

interface Props {
  job: OcrJob;
  archiveId: string;
  open: boolean;
  onClose: () => void;
}

export default function OcrPreviewModal({ job, archiveId, open, onClose }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const approveMutation = useApproveOcrJob();
  const rejectMutation = useRejectOcrJob();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);

  useEffect(() => {
    setCurrentPageIndex(0);
  }, [job.id]);

  if (!open) return null;

  const hasUnverified = job.result?.hasUnverified ?? false;
  const sourceFileName = job.sourceFileName || "unknown.pdf";
  const pageResults = job.result?.pageResults ?? [];
  const hasPageResults = pageResults.length > 0;
  const currentPage = hasPageResults && currentPageIndex < pageResults.length
    ? pageResults[currentPageIndex]
    : null;

  const handleApprove = async () => {
    setApproving(true);
    try {
      await approveMutation.mutateAsync({ archiveId, jobId: job.id });
      queryClient.invalidateQueries({ queryKey: queryKeys.archive.pages(archiveId) });
      showSuccess(t("ocr.preview.approved"));
      onClose();
    } catch {
      showError(t("ocr.error.approveFailed"));
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async () => {
    setRejecting(true);
    try {
      await rejectMutation.mutateAsync({ archiveId, jobId: job.id });
      showSuccess(t("ocr.preview.rejected"));
      onClose();
    } catch {
      showError(t("ocr.error.rejectFailed"));
    } finally {
      setRejecting(false);
    }
  };

  // Per-page Markdown content — BOTH panes bind to the same slice the left
  // pane paginates (D-02): the selected page's markdown, rendered through the
  // dompurify-sanitized renderMarkdown pipeline (T-179-03 — do not bypass).
  const sanitizedHtml = currentPage ? renderMarkdown(currentPage.markdown) : null;

  const token = encodeURIComponent(localStorage.getItem("token") ?? "");

  const goPrevPage = () => setCurrentPageIndex((i) => Math.max(0, i - 1));
  const goNextPage = () => setCurrentPageIndex((i) => Math.min(pageResults.length - 1, i + 1));

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-[20px] font-semibold leading-[1.2] text-foreground truncate">
            {t("ocr.preview.title", { filename: sourceFileName })}
          </h2>
          {job.result && (
            <div className="flex gap-2 flex-shrink-0">
              {job.result.qualityScore !== undefined && (
                <Badge variant="secondary">
                  {t("ocr.preview.qualityScore", { score: job.result.qualityScore })}
                </Badge>
              )}
              {job.result.totalTokens !== undefined && (
                <Badge variant="outline">
                  {t("ocr.preview.tokensUsed", { count: job.result.totalTokens })}
                </Badge>
              )}
              {job.result.totalDurationMs !== undefined && (
                <Badge variant="outline">
                  {t("ocr.preview.duration", {
                    seconds: (job.result.totalDurationMs / 1000).toFixed(1),
                  })}
                </Badge>
              )}
            </div>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} title={t("common.close")}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* UNVERIFIED Warning */}
      {hasUnverified && (
        <div className="px-6 pt-4 flex-shrink-0">
          <Alert className="border-amber-300 dark:border-amber-700 bg-accent text-accent-foreground">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{t("ocr.preview.unverifiedWarning")}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Body: Side-by-side panes on desktop */}
      <div className="hidden md:flex flex-1 overflow-hidden min-h-0">
        {/* Left pane: Source Image */}
        <div className="flex-1 flex flex-col border-r border-border min-w-0 min-h-0">
          <div className="px-4 py-2 border-b border-border flex-shrink-0 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <Image className="h-4 w-4 text-muted-foreground" />
              {t("ocr.preview.sourceImage")}
            </span>
            {hasPageResults && pageResults.length > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={goPrevPage}
                  disabled={currentPageIndex === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t("ocr.preview.pageOf", { current: currentPageIndex + 1, total: pageResults.length })}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={goNextPage}
                  disabled={currentPageIndex >= pageResults.length - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
            <div className="p-4">
              {currentPage?.imagePath ? (
                <img
                  src={`/api/archives/${archiveId}/jobs/${job.id}/pages/${currentPage.pageNumber}/image?token=${token}`}
                  alt={`Source page ${currentPage.pageNumber} for ${sourceFileName}`}
                  className="w-full h-auto rounded-md border border-border"
                />
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  <p>{t("ocr.preview.noSourceImage")}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right pane: Extracted Markdown */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="px-4 py-2 border-b border-border flex-shrink-0">
            <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-muted-foreground" />
              {t("ocr.preview.extractedMarkdown")}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
            <div className="p-4">
              {sanitizedHtml ? (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  <p>{t("ocr.preview.noMarkdownExtracted")}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: vertical stack */}
      <div className="md:hidden flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 py-2 border-b border-border flex-shrink-0 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
              <FileText className="h-4 w-4 text-muted-foreground" />
              {t("ocr.preview.extractedMarkdown")}
            </span>
            {hasPageResults && pageResults.length > 1 && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goPrevPage} disabled={currentPageIndex === 0}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t("ocr.preview.pageOf", { current: currentPageIndex + 1, total: pageResults.length })}
                </span>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goNextPage} disabled={currentPageIndex >= pageResults.length - 1}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
            <div className="p-4">
              {sanitizedHtml ? (
                <div
                  className="prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
              ) : (
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  <p>{t("ocr.preview.noMarkdownExtracted")}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer: Actions */}
      <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border flex-shrink-0">
        <Button
          variant="outline"
          onClick={handleReject}
          disabled={rejecting || approving}
        >
          {rejecting ? (
            <>
              <X className="h-4 w-4 mr-1.5 animate-pulse" />
              {t("ocr.preview.reject")}
            </>
          ) : (
            t("ocr.preview.reject")
          )}
        </Button>
        <Button onClick={handleApprove} disabled={approving || rejecting}>
          {approving ? (
            <>
              <CheckCircle2 className="h-4 w-4 mr-1.5 animate-pulse" />
              {t("ocr.preview.approve")}
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
              {t("ocr.preview.approve")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

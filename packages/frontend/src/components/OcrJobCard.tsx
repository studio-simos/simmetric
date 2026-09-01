// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Clock, Loader2, CheckCircle2, XCircle, ScanLine, Globe, Eye, Trash2 } from "lucide-react";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { useState } from "react";
import { useDeleteOcrJob } from "../queries/useOcrJobs";
import { showSuccess, showError } from "../lib/toast";
import type { OcrJob } from "../queries/useOcrJobs";

import { cn } from "@/lib/utils"
import { getErrorMessage } from "../utils/errorUtils";
interface Props {
  job: OcrJob;
  archiveId: string;
  onPreview: (job: OcrJob) => void;
}

export default function OcrJobCard({ job, archiveId, onPreview }: Props) {
  const { t } = useTranslation();
  const [showDelete, setShowDelete] = useState(false);
  const deleteMutation = useDeleteOcrJob();

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync({ archiveId, jobId: job.id });
      showSuccess(t("ocr.deleteJobSuccess"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("ocr.deleteJobError")));
    } finally {
      setShowDelete(false);
    }
  };

  const isOcr = job.type === "OCR";
  const isUrl = job.type === "URL";

  const statusBadgeConfig = {
    PENDING: {
      variant: "outline" as const,
      icon: Clock,
      label: t("ocr.status.PENDING"),
      className: "",
    },
    PROCESSING: {
      variant: "secondary" as const,
      icon: Loader2,
      label: isOcr
        ? t("ocr.status.PROCESSING", {
            currentPage: job.currentPage ?? "?",
            totalPages: job.totalPages ?? "?",
          })
        : t("urlIngestion.status.PROCESSING"),
      className: "animate-spin",
    },
    COMPLETED: {
      variant: "default" as const,
      icon: CheckCircle2,
      label: isOcr ? t("ocr.status.COMPLETED") : t("urlIngestion.status.COMPLETED"),
      className: "",
    },
    FAILED: {
      variant: "destructive" as const,
      icon: XCircle,
      label: t("ocr.status.FAILED"),
      className: "",
    },
    CANCELLED: {
      variant: "outline" as const,
      icon: XCircle,
      label: t("ocr.status.CANCELLED"),
      className: "",
    },
  };

  const config = statusBadgeConfig[job.status] || statusBadgeConfig.PENDING;
  const StatusIcon = config.icon;

  // Review outcome — only meaningful once the job is COMPLETED. Approving a
  // job on the server also saves its content as an archive page, so "approved"
  // implies "saved". A COMPLETED job that is neither approved nor rejected is
  // still awaiting user review.
  const isApproved = job.status === "COMPLETED" && job.result?.approved === true;
  const isRejected = job.status === "COMPLETED" && job.result?.rejected === true;
  const isPendingReview =
    job.status === "COMPLETED" && !isApproved && !isRejected;

  const sourceName = isOcr
    ? job.sourceFileName || t("ocr.jobType")
    : job.result?.sourceUrl || job.sourceFileName || t("urlIngestion.jobType");

  const truncatedSource =
    sourceName.length > 40 ? sourceName.substring(0, 37) + "..." : sourceName;

  return (
    <Card className="hover:bg-accent/30 transition-colors">
      <CardContent className="space-y-3">
        {/* Top row: Type icon + source name + status badge */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {isOcr ? (
              <ScanLine className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            ) : (
              <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
            <span className="text-sm font-medium text-foreground truncate" title={sourceName}>
              {truncatedSource}
            </span>
          </div>
          <Badge variant={config.variant} className="flex-shrink-0">
            <StatusIcon className={cn("h-3 w-3", config.className)} />
            <span className="ml-1">{config.label}</span>
          </Badge>
        </div>

        {/* Status-specific content */}
        {job.status === "PROCESSING" && (
          <div className="space-y-1">
            <Progress value={job.progress} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {job.progress}%{" "}
              {isOcr && job.currentPage && job.totalPages
                ? t("ocr.status.PROCESSING", {
                    currentPage: job.currentPage,
                    totalPages: job.totalPages,
                  })
                : isUrl
                  ? t("urlIngestion.jobProgress.extracting") || t("urlIngestion.status.PROCESSING")
                  : ""}
            </p>
            {job.modelName && (
              <p className="text-xs text-muted-foreground">
                {t("ocr.modelLabel")}: {job.modelName}
              </p>
            )}
          </div>
        )}

        {job.status === "COMPLETED" && (
          <div className="space-y-2">
            {/* Outcome badge: approved (saved) / rejected / awaiting review */}
            {isApproved && (
              <Badge className="flex-shrink-0 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                <CheckCircle2 className="h-3 w-3" />
                <span className="ml-1">{t("ocr.outcome.approved")}</span>
              </Badge>
            )}
            {isRejected && (
              <Badge variant="destructive" className="flex-shrink-0">
                <XCircle className="h-3 w-3" />
                <span className="ml-1">{t("ocr.outcome.rejected")}</span>
              </Badge>
            )}
            {isPendingReview && (
              <Badge variant="outline" className="flex-shrink-0">
                <Clock className="h-3 w-3" />
                <span className="ml-1">{t("ocr.outcome.pendingReview")}</span>
              </Badge>
            )}
            {job.result && (
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                {job.result.totalTokens !== undefined && (
                  <span>
                    {t("ocr.preview.tokensUsed", { count: job.result.totalTokens })}
                  </span>
                )}
                {job.result.totalDurationMs !== undefined && (
                  <span>
                    {t("ocr.preview.duration", {
                      seconds: (job.result.totalDurationMs / 1000).toFixed(1),
                    })}
                  </span>
                )}
                {job.result.qualityScore !== undefined && (
                  <span>
                    {t("ocr.preview.qualityScore", {
                      score: job.result.qualityScore,
                    })}
                  </span>
                )}
              </div>
            )}
            {!isRejected && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPreview(job)}
              >
                <Eye className="h-3 w-3 mr-1" />
                {isOcr ? t("ocr.preview.title", { filename: sourceName }) : t("urlIngestion.result.viewRaw")}
              </Button>
            )}
          </div>
        )}

        {job.status === "FAILED" && job.error && (
          <div className="space-y-1">
            <p className="text-sm text-destructive">{job.error}</p>
            {isOcr && (
              <p className="text-xs text-muted-foreground">
                {t("ocr.jobStatus.retryHint") ||
                  "The job can be retried by re-uploading the file."}
              </p>
            )}
          </div>
        )}

        {job.status === "CANCELLED" && (
          <p className="text-xs text-muted-foreground">
            {t("ocr.jobStatus.cancelledDesc") ||
              "This job was cancelled. Upload again to retry."}
          </p>
        )}

        {job.status === "PENDING" && (
          <p className="text-xs text-muted-foreground">
            {t("ocr.jobStatus.pendingDesc") ||
              "Waiting to start processing..."}
          </p>
        )}

        {/* Timestamp */}
        <p className="text-xs text-muted-foreground">
          {new Date(job.createdAt).toLocaleString()}
        </p>

        {/* Delete button */}
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              setShowDelete(true);
            }}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ocr.deleteJob")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ocr.deleteJobConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { FileText, RefreshCw } from "lucide-react";
import { useOcrJobs } from "../queries/useOcrJobs";
import type { OcrJob } from "../queries/useOcrJobs";
import OcrJobCard from "./OcrJobCard";
import { Card } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

interface Props {
  archiveId: string;
  onPreview: (job: OcrJob) => void;
}

function SkeletonCard() {
  return (
    <Card className="animate-pulse">
      <div className="px-4 py-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-4 w-4 rounded bg-secondary" />
            <div className="h-4 w-32 rounded bg-secondary" />
          </div>
          <div className="h-5 w-16 rounded bg-secondary" />
        </div>
        <div className="h-2 w-full rounded bg-secondary" />
        <div className="h-3 w-24 rounded bg-secondary" />
      </div>
    </Card>
  );
}

export default function OcrJobList({ archiveId, onPreview }: Props) {
  const { t } = useTranslation();
  const { data: jobs = [], isLoading, error, refetch } = useOcrJobs(archiveId);

  // Loading state
  if (isLoading && jobs.length === 0) {
    return (
      <div className="space-y-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  // Error state
  if (error && jobs.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between">
          <span>{error.message}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            {t("common.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // Empty state
  if (jobs.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <FileText className="h-10 w-10 text-muted-foreground/50 mb-3" />
        <p className="text-[20px] font-semibold leading-[1.2] text-foreground">
          {t("ocr.jobList.emptyTitle") || "No ingestion jobs yet"}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {t("ocr.jobList.emptyDescription") ||
            "Upload a PDF or submit a URL to start ingesting content."}
        </p>
      </div>
    );
  }

  // Has jobs
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {jobs.map((job) => (
        <OcrJobCard
          key={job.id}
          job={job}
          archiveId={archiveId}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}

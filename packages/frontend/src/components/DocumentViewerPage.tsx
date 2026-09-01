// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Copy, FileText, FileWarning, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "./ui/card";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { useDocumentText } from "../queries/useDocuments";
import { renderMarkdown } from "../utils/markdown";
import { showSuccess, showError } from "../lib/toast";

/**
 * Status → Badge variant + accent class. Uses CSS custom properties so the
 * colors stay consistent across light/dark themes.
 */
function statusBadge(status: string) {
  if (status === "completed") {
    return (
      <Badge
        variant="secondary"
        className="text-[var(--success-text)] bg-[var(--success-bg)]"
      >
        {status}
      </Badge>
    );
  }
  if (status === "processing" || status === "pending") {
    return (
      <Badge
        variant="secondary"
        className="text-[var(--warning-text)] bg-[var(--warning-bg)]"
      >
        {status}
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="text-[var(--error-text)] bg-[var(--error-bg)]"
    >
      {status}
    </Badge>
  );
}

export default function DocumentViewerPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDocumentText(id);

  const back = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/documents");
    }
  };

  async function copyText() {
    try {
      await navigator.clipboard.writeText(data?.text ?? "");
      showSuccess(t("documents.copySuccess"));
    } catch {
      showError(t("documents.copyError"));
    }
  }

  // 1. Loading — skeleton placeholder (mirrors ArchivePageFullView).
  if (isLoading) {
    return (
      <Card className="h-full flex flex-col overflow-hidden">
        <CardHeader className="pb-4">
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent className="flex-1">
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-3/4 mb-2" />
          <Skeleton className="h-4 w-5/6" />
        </CardContent>
      </Card>
    );
  }

  // 2. Error / not found — centered Card with FileWarning + back button.
  if (error || !data) {
    return (
      <Card className="flex flex-col items-center justify-center h-64 gap-4">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <FileWarning className="h-10 w-10 text-[var(--text-muted)]" />
          <p className="text-[var(--text-muted)]">{t("documents.notFound")}</p>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={back}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("documents.backToList")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 3. Processing — status !== "completed" → spinner + processing copy.
  if (data.status !== "completed") {
    return (
      <Card className="flex flex-col items-center justify-center h-64 gap-4">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-10 w-10 animate-spin text-[var(--text-muted)]" />
          <p className="text-[var(--text-muted)]">{t("documents.processing")}</p>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={back}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("documents.backToList")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 4. Empty text — no extracted text yet.
  if (!data.text) {
    return (
      <Card className="flex flex-col items-center justify-center h-64 gap-4">
        <CardContent className="flex flex-col items-center gap-4 text-center">
          <FileText className="h-10 w-10 text-[var(--text-muted)]" />
          <div className="space-y-1">
            <p className="font-semibold text-[var(--text)]">
              {t("documents.emptyTextTitle")}
            </p>
            <p className="text-sm text-[var(--text-muted)]">
              {t("documents.emptyTextBody")}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={back}
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("documents.backToList")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // 5. Success — read-only markdown body in a single vertical scroll.
  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-2 pb-4">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-[44px]"
          onClick={back}
          aria-label={t("documents.backToList")}
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          {t("documents.backToList")}
        </Button>
        <CardTitle className="flex-1 truncate text-xl font-semibold">
          {data.name}
        </CardTitle>
        <Badge variant="secondary" className="capitalize">
          {data.type}
        </Badge>
        {statusBadge(data.status)}
        <Button
          variant="outline"
          size="sm"
          className="min-h-[44px]"
          onClick={copyText}
        >
          <Copy className="mr-1 h-4 w-4 text-[var(--primary)]" />
          {t("documents.copyText")}
        </Button>
      </CardHeader>
      <CardContent
        className="flex-1 min-h-0 overflow-y-auto"
        style={{
          scrollbarColor: "var(--scrollbar-thumb) var(--scrollbar-track)",
        }}
      >
        <div
          className="prose prose-sm dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(data.text) }}
        />
      </CardContent>
    </Card>
  );
}
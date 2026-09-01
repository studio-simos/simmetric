// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2, Pencil, Eye, Code, Save, X } from "lucide-react";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "./ui/card";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import { useArchivePage, useUpdatePage } from "../queries/useArchives";
import { queryKeys } from "../queries/keys";
import { renderMarkdown } from "../utils/markdown";
import { ApiError } from "../utils/api";
import { getErrorMessage } from "../utils/errorUtils";
import { showInfo, showError } from "../lib/toast";

interface Props {
  archiveId: string;
  slug: string;
  onBack?: () => void;
  onDeletePage?: () => void;
}

export default function ArchivePageFullView({ archiveId, slug, onBack, onDeletePage }: Props) {
  const { t } = useTranslation();
  const { data: page, isLoading, error } = useArchivePage(archiveId, slug);
  const updatePageMutation = useUpdatePage();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [violations, setViolations] = useState<string[]>([]);

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

  if (error || !page) {
    return (
      <Card className="flex items-center justify-center h-64">
        <CardContent>
          <p className="text-muted-foreground">{t("archives.notFound")}</p>
        </CardContent>
      </Card>
    );
  }

  function startEdit() {
    setDraftBody(page?.bodyText ?? "");
    setShowPreview(false);
    setViolations([]);
    setIsEditing(true);
  }

  async function handleSave() {
    try {
      const result = await updatePageMutation.mutateAsync({
        archiveId,
        slug,
        data: { body: draftBody },
      });
      if ((result as { warnings?: string[] }).warnings?.length) {
        showInfo(t("archives.page.warnings"));
      }
      setIsEditing(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setViolations(
          (err.details as { violations?: string[] })?.violations ?? [],
        );
        // Edit stays open — banner is persistent until corrected.
      } else if (err instanceof ApiError && err.status === 409) {
        showError(t("archives.page.concurrentConflict"));
        queryClient.invalidateQueries({
          queryKey: queryKeys.archive.page(archiveId, slug),
        });
        setIsEditing(false);
      } else {
        showError(getErrorMessage(err, t("common.error")));
      }
    }
  }

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-2 pb-4">
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <CardTitle className="flex-1">{page.title}</CardTitle>
        {page.category && (
          <Badge variant="secondary" className="capitalize">
            {page.category}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
          onClick={startEdit}
          aria-label={t("archives.page.edit")}
          data-testid="archive-page-edit-btn"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        {onDeletePage && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDeletePage}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-1 min-h-0 overflow-y-auto">
        {isEditing ? (
          <div className="flex flex-col gap-3 h-full">
            {violations.length > 0 && (
              <div
                role="alert"
                className="bg-destructive/10 border border-destructive/30 text-destructive rounded-md p-3 text-sm"
              >
                <p className="font-medium mb-1">
                  {t("archives.page.editBanner.heading")}
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  {violations.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="min-h-[44px] md:min-h-0"
                onClick={() => setShowPreview((p) => !p)}
                data-testid="archive-page-preview-btn"
              >
                {showPreview ? (
                  <>
                    <Code className="h-4 w-4" />
                    {t("archives.page.source")}
                  </>
                ) : (
                  <>
                    <Eye className="h-4 w-4" />
                    {t("archives.page.preview")}
                  </>
                )}
              </Button>
              <div className="flex-1" />
              <Button
                variant="default"
                size="sm"
                className="min-h-[44px] md:min-h-0"
                onClick={handleSave}
                disabled={updatePageMutation.isPending}
                data-testid="archive-page-save-btn"
              >
                <Save className="h-4 w-4" />
                {t("archives.page.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-[44px] md:min-h-0"
                onClick={() => setIsEditing(false)}
                data-testid="archive-page-cancel-btn"
              >
                <X className="h-4 w-4" />
                {t("archives.page.cancel")}
              </Button>
            </div>
            {showPreview ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none flex-1"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(draftBody) }}
              />
            ) : (
              <Textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                className="flex-1 min-h-[40vh] font-mono text-sm leading-6 resize-none"
                data-testid="archive-page-edit-textarea"
              />
            )}
          </div>
        ) : page.bodyText ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(page.bodyText) }}
          />
        ) : (
          <p className="text-muted-foreground">{t("archives.page.emptyBody")}</p>
        )}
      </CardContent>
    </Card>
  );
}
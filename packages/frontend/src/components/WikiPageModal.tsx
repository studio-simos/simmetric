// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { X, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useArchivePage } from "../queries/useArchives";
import { renderMarkdown } from "../utils/markdown";

interface WikiPageModalProps {
  archiveId: string;
  slug: string;
  onClose: () => void;
}

export function WikiPageModal({ archiveId, slug, onClose }: WikiPageModalProps) {
  const { t } = useTranslation();
  const { data: currentPage, isLoading: loading } = useArchivePage(archiveId, slug);

  // renderMarkdown already applies DOMPurify sanitization before returning HTML
  const sanitizedHtml = currentPage?.bodyText
    ? renderMarkdown(currentPage.bodyText)
    : "";

  return (
    <Dialog open={true} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0 overflow-hidden">
        <DialogHeader className="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <DialogTitle className="text-lg font-semibold text-foreground truncate m-0">
              {currentPage?.title || slug}
            </DialogTitle>
            {currentPage?.category && (
              <Badge variant="outline" className="text-xs capitalize flex-shrink-0">
                {currentPage.category}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="flex-shrink-0"
            aria-label={t("common.close", "Close")}
          >
            <X size={20} />
          </Button>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && (
            <div className="space-y-3 py-6">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          )}
          {!loading && !currentPage && (
            <div className="text-muted-foreground text-center py-12">
              {t("wiki.pageNotFound", "Page not found")}
            </div>
          )}
          {currentPage && (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              {/* Safe: renderMarkdown runs DOMPurify before returning HTML */}
              <div
                className="text-foreground"
                dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

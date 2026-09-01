// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useCreatePage } from "../queries/useArchives";
import { showSuccess, showError } from "../lib/toast";
import { Button } from "@/components/ui/button";
import { SelectItem } from "@/components/ui/select";
import { AppInput, AppSelect, AppTextarea } from "@/components/ui/app";
import { getErrorMessage } from "../utils/errorUtils";

interface WikiBrokenLinkDialogProps {
  archiveId: string;
  slug: string;
  onClose: () => void;
  onCreated?: () => void;
}

export function WikiBrokenLinkDialog({
  archiveId,
  slug,
  onClose,
  onCreated,
}: WikiBrokenLinkDialogProps) {
  const { t } = useTranslation();
    const createPage = useCreatePage();
  const [title, setTitle] = useState(slug);
  const [category, setCategory] = useState<"entities" | "concepts" | "decisions">("entities");
  const [content, setContent] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!title.trim() || !content.trim()) return;
    setCreating(true);
    try {
      await createPage.mutateAsync({ archiveId, title: title.trim(), content, category });
      showSuccess(t("wiki.pageCreated", "Page created successfully"));
      onCreated?.();
      onClose();
    } catch (err: unknown) {
      showError(
        getErrorMessage(err, t("wiki.createFailed", "Failed to create page"))
      );
    } finally {
      setCreating(false);
    }
  };

  const isValid = title.trim() && content.trim() && !creating;

  return (
    <div
      className="fixed inset-0 z-[50] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-background shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border flex-shrink-0">
          <h3 className="text-lg font-semibold text-foreground">
            {t("wiki.createPageTitle", "Create Page")}
          </h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t("common.close", "Close")}
          >
            <X size={20} />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("wiki.createPageDescription", "The page \"{{slug}}\" does not exist yet. Create it below.", { slug })}
          </p>

          <AppInput
            label={t("archives.pageTitleLabel", "Title")}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full border border-input rounded-lg px-3 py-2 bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />

          <AppSelect
            label={t("archives.pageCategory", "Category")}
            value={category}
            onValueChange={(value) => setCategory(value as "entities" | "concepts" | "decisions")}
            className="w-full border border-input rounded-lg px-3 py-2 bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <SelectItem value="entities">{t("archives.categoryEntities", "Entities")}</SelectItem>
            <SelectItem value="concepts">{t("archives.categoryConcepts", "Concepts")}</SelectItem>
            <SelectItem value="decisions">{t("archives.categoryDecisions", "Decisions")}</SelectItem>
          </AppSelect>

          <AppTextarea
            label={t("archives.pageContent", "Content")}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            className="w-full border border-input rounded-lg px-3 py-2 bg-card text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono text-sm"
            placeholder={t("archives.pageContentPlaceholder", "Enter page content in Markdown...")}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-4 border-t border-border flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!isValid}
          >
            {creating
              ? t("common.saving", "Saving...")
              : t("wiki.create", "Create")}
          </Button>
        </div>
      </div>
    </div>
  );
}

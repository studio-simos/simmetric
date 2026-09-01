// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AppSelect, AppTextarea } from "@/components/ui/app";
import { SelectItem } from "@/components/ui/select";
import { Label } from "./ui/label";
import { Alert, AlertDescription } from "./ui/alert";
import { useCreatePage } from "../queries/useArchives";
import { showSuccess } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface PageCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archiveId: string;
  onSuccess: () => void;
}

export default function PageCreateDialog({
  open,
  onOpenChange,
  archiveId,
  onSuccess,
}: PageCreateDialogProps) {
  const { t } = useTranslation();
    const createPage = useCreatePage();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("entities");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      await createPage.mutateAsync({ archiveId, title: title.trim(), content, category });
      showSuccess(t("archives.pageCreated"));
      onOpenChange(false);
      onSuccess();
      resetForm();
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("archives.pageCreateError")));
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setTitle("");
    setContent("");
    setCategory("entities");
    setError(null);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  const isValid = title.trim() && content.trim() && !submitting;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto min-w-0">
        <DialogHeader>
          <DialogTitle className="text-[20px] font-semibold">
            {t("archives.createPageTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          <div className="space-y-2">
            <Label htmlFor="page-title">{t("archives.pageTitleLabel")}</Label>
            <Input
              id="page-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("archives.pageTitlePlaceholder")}
            />
          </div>

          <AppSelect
            id="page-category"
            label={t("archives.pageCategory")}
            value={category}
            onValueChange={(value) => setCategory(value)}
          >
            <SelectItem value="entities">{t("archives.categoryEntities")}</SelectItem>
            <SelectItem value="concepts">{t("archives.categoryConcepts")}</SelectItem>
            <SelectItem value="decisions">{t("archives.categoryDecisions")}</SelectItem>
          </AppSelect>

          <AppTextarea
            id="page-content"
            label={t("archives.pageContent")}
            className="font-mono max-h-[50vh] overflow-y-auto break-all"
            style={{ wordBreak: 'break-all' }}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t("archives.pageContentPlaceholder")}
            rows={12}
          />

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid}>
            <Plus className="mr-2 h-4 w-4" />
            {submitting ? t("common.saving") : t("archives.createPageButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

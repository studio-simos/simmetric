// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
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
import { useDeletePage } from "../queries/useArchives";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface PageDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageSlug: string;
  archiveId: string;
  onSuccess: () => void;
}

export default function PageDeleteDialog({
  open,
  onOpenChange,
  pageSlug,
  archiveId,
  onSuccess,
}: PageDeleteDialogProps) {
  const { t } = useTranslation();
    const deletePage = useDeletePage();

  const handleDelete = async () => {
    try {
      await deletePage.mutateAsync({ archiveId, slug: pageSlug });
      showSuccess(t("archives.pageDeleteConfirm.title"));
      onSuccess();
      onOpenChange(false);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("common.error")));
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("archives.pageDeleteConfirm.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("archives.pageDeleteConfirm.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("archives.pageDeleteConfirm.keepButton")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Save } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AppTextarea } from "@/components/ui/app";
import { Label } from "./ui/label";
import { Alert, AlertDescription } from "./ui/alert";
import { useUpdateArchive } from "../queries/useArchives";
import { showSuccess } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface ArchiveRenameDialogProps {
  archive: { id: string; name: string; description: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ArchiveRenameDialog({
  archive,
  open,
  onOpenChange,
}: ArchiveRenameDialogProps) {
  const { t } = useTranslation();
  const updateArchive = useUpdateArchive();

  const [name, setName] = useState(archive.name);
  const [description, setDescription] = useState(archive.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      await updateArchive.mutateAsync({
        id: archive.id,
        data: {
          name: name.trim(),
          description: description.trim() || null,
        },
      });
      showSuccess(t("archives.renamedToast"));
      onOpenChange(false);
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("archives.renameError")));
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Reset to current archive values on close (mirror ArchiveCreateDialog)
      setName(archive.name);
      setDescription(archive.description ?? "");
      setError(null);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // Radix portals the content to <body>, but React synthetic events
        // still bubble through the React tree. When this dialog is opened
        // from inside a clickable Card (ArchiveCard), stopPropagation prevents
        // Save/Cancel clicks from triggering the Card's onClick(navigate).
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle className="text-[20px] font-semibold">
            {t("archives.renameDialog.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="archive-rename-name">
              {t("archives.renameDialog.nameLabel")}
            </Label>
            <Input
              id="archive-rename-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("archives.renameDialog.nameLabel")}
            />
          </div>

          <AppTextarea
            id="archive-rename-description"
            label={t("common.description")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("common.description")}
            rows={3}
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
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
          >
            <Save className="mr-2 h-4 w-4" />
            {submitting ? t("common.saving") : t("archives.renameDialog.saveButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
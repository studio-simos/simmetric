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
import { AppTextarea } from "@/components/ui/app";
import { Label } from "./ui/label";
import { Alert, AlertDescription } from "./ui/alert";
import { useCreateArchive } from "../queries/useArchives";
import { showSuccess } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface ArchiveCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ArchiveCreateDialog({ open, onOpenChange }: ArchiveCreateDialogProps) {
  const { t } = useTranslation();
    const createArchive = useCreateArchive();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      await createArchive.mutateAsync({ name: name.trim(), description: description.trim() || undefined });
      showSuccess(t("archives.createDialog.createButton"));
      onOpenChange(false);
      setName("");
      setDescription("");
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("archives.createError")));
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setName("");
      setDescription("");
      setError(null);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-[20px] font-semibold">
            {t("archives.createDialog.title")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="archive-name">{t("archives.newArchive")}</Label>
            <Input
              id="archive-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("archives.newArchive")}
            />
          </div>

          <AppTextarea
            id="archive-description"
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
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            {t("archives.createDialog.discardButton")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || submitting}
          >
            <Plus className="mr-2 h-4 w-4" />
            {submitting ? t("common.saving") : t("archives.createDialog.createButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRenameProject } from "../queries/useProjects";
import { showSuccess, showError } from "../lib/toast";

export interface ProjectRenameModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project being renamed. Null when closed/no selection. */
  project: { id: string; name: string } | null;
}

/**
 * ProjectRenameModal — inline rename dialog for the active project (Feature 1 / 3.5).
 *
 * Prefills the input with the current project name and commits via
 * `useRenameProject` (PUT /api/projects/:id). On success it closes, toasts,
 * and lets the mutation invalidate the projects cache + dispatch
 * `projects-changed` so the sidebar selector and TopBar label refresh.
 *
 * Validation mirrors the shared Zod schema (1–200 chars); the server is the
 * source of truth, so we only guard the empty/over-length client edge cases.
 */
export default function ProjectRenameModal({
  open,
  onOpenChange,
  project,
}: ProjectRenameModalProps) {
  const { t } = useTranslation();
  const rename = useRenameProject();
  const [name, setName] = useState("");

  // Sync the input to the current project whenever the dialog opens.
  useEffect(() => {
    if (open && project) setName(project.name);
  }, [open, project]);

  const trimmed = name.trim();
  const canSave = !!project && trimmed.length >= 1 && trimmed.length <= 200 && !rename.isPending;

  const handleSave = async () => {
    if (!project || !canSave) return;
    try {
      await rename.mutateAsync({ projectId: project.id, name: trimmed });
      showSuccess(t("projectRename.success"));
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("projectRename.error");
      showError(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">{t("projectRename.title")}</DialogTitle>
          <DialogDescription>{t("projectRename.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <label className="text-xs font-medium text-muted-foreground uppercase">
            {t("projectRename.field")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) handleSave();
            }}
            placeholder={t("projectRename.placeholder")}
          />
          <p className="text-[10px] text-muted-foreground font-mono">
            {trimmed.length}/200
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={rename.isPending}>
            {t("projectRename.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {rename.isPending ? t("projectRename.saving") : t("projectRename.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
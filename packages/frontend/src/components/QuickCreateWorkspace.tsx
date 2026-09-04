// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { showSuccess, showError } from "../lib/toast";
import { useWorkspaces, useCreateWorkspace } from "../queries/useWorkspaces";
import { useProjects } from "../queries/useProjects";
import { useFeatureLimit } from "../hooks/useFeature";
import { Button } from "@/components/ui/button";
import { AppInput } from "@/components/ui/app";
import UpgradePrompt from "./UpgradePrompt";
import WorkspaceCreatePanel from "./WorkspaceCreatePanel";
import { getErrorMessage } from "../utils/errorUtils";

interface QuickCreateWorkspaceProps {
  onCreated?: () => void;
}

export default function QuickCreateWorkspace({ onCreated }: QuickCreateWorkspaceProps) {
  const { t } = useTranslation();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: projects = [] } = useProjects();
  const createWorkspace = useCreateWorkspace();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [creating, setCreating] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const selectedProjectId = projects[0]?.id ?? "";

  const maxWorkspaces = useFeatureLimit("max_workspaces");
  const atLimit = maxWorkspaces > 0 && workspaces.length >= maxWorkspaces;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !selectedProjectId) return;

    if (atLimit) return;

    setCreating(true);
    try {
      await createWorkspace.mutateAsync({
        name: name.trim(),
        instructions: instructions.trim() || null,
        projectId: selectedProjectId,
      });
      showSuccess(t("workspace.createSuccess"));
      setName("");
      setInstructions("");
      onCreated?.();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("workspace.createFailed")));
    } finally {
      setCreating(false);
    }
  };

  if (showAdvanced) {
    return (
      <WorkspaceCreatePanel />
    );
  }

  return (
    <div className="bg-card rounded-lg border border-border p-5">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <AppInput
          className="flex-1 min-w-[200px]"
          label={t("workspace.nameLabel")}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("workspaceCreate.namePlaceholder") || "My Workspace"}
          required
          maxLength={100}
        />
        <AppInput
          className="flex-1 min-w-[240px]"
          label={t("workspace.descLabel")}
          type="text"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t("workspaceCreate.instructionsPlaceholder")}
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={creating || !name.trim() || atLimit}
          >
            {creating ? t("common.loading") : t("workspace.create")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowAdvanced(true)}
          >
            {t("workspace.advanced")}
          </Button>
        </div>
      </form>

      {atLimit && (
        <div className="mt-3">
          <UpgradePrompt
            feature="max_workspaces"
            message={t("workspace.limitReached")}
          />
        </div>
      )}
    </div>
  );
}

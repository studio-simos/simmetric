// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import type { WorkspaceWithMeta } from "../queries/useWorkspaces";
import { useMe } from "../queries/useAuth";
import { useProviders } from "../queries/useProviders";
import { apiGet } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AppTextarea } from "@/components/ui/app";
import { IconPicker } from "./IconPicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getErrorMessage } from "../utils/errorUtils";

interface SkillItem {
  name: string;
  displayName: string;
  description: string;
  type: string;
}

interface TemplateItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  systemPrompt: string;
  skills: string[];
  parsingConfig: { ocrRequired?: boolean; [key: string]: unknown };
  constraints: {
    localLLMOnly?: boolean;
    hybridSearchForced?: boolean;
    citationRequired?: boolean;
    [key: string]: unknown;
  };
  embeddingModel: string | null;
  isBuiltIn: boolean;
}

interface WorkspaceRowProps {
  workspace: WorkspaceWithMeta;
  isAdmin?: boolean;
  currentUserId?: string;
  onUpdate?: (id: string, data: {
    name?: string;
    instructions?: string | null;
    allowMemberUploads?: boolean;
    icon?: string | null;
    systemPrompt?: string;
    skills?: string[];
    constraints?: { localLLMOnly?: boolean; hybridSearchForced?: boolean; citationRequired?: boolean };
    parsingConfig?: { ocrRequired?: boolean };
    embeddingModel?: string;
    templateId?: string | null;
  }) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export default function WorkspaceRow({
  workspace,
  isAdmin = false,
  currentUserId,
  onUpdate,
  onDelete,
  selected = false,
  onToggleSelect,
}: WorkspaceRowProps) {
  const { t } = useTranslation();
  const { data: user } = useMe();
  const userPermissions = user?.permissions ?? [];

  const { data: providers = [] } = useProviders();
  const embeddingModels = (() => {
    const allModels = providers.flatMap((p) =>
      p.models?.filter((m) => m.isEmbedding && m.isEnabled && m.isAvailable).map((m) => ({
        id: m.id,
        name: m.name,
        displayName: m.displayName || m.name,
      })) || []
    );
    return allModels;
  })();

  const [isExpanded, setIsExpanded] = useState(false);
  const [draft, setDraft] = useState({
    name: workspace.name,
    instructions: workspace.instructions || "",
    systemPrompt: workspace.agentConfig?.systemPrompt || "",
    icon: workspace.icon || "",
    skills: [] as string[],
    constraints: {} as { localLLMOnly?: boolean; hybridSearchForced?: boolean; citationRequired?: boolean },
    parsingConfig: {} as { ocrRequired?: boolean },
    embeddingModel: workspace.embeddingModel || "",
    templateId: workspace.templateId || "",
  });
  const [skillsList, setSkillsList] = useState<SkillItem[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMiniConfirm, setShowMiniConfirm] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);

  const hasPermission =
    isAdmin ||
    workspace.project?.createdBy === currentUserId ||
    userPermissions.includes("workspace:write");
  const canEdit = hasPermission && !!onUpdate && !!onDelete;

  const original = useMemo(() => ({
    name: workspace.name,
    instructions: workspace.instructions || "",
    systemPrompt: workspace.agentConfig?.systemPrompt || "",
    icon: workspace.icon || "",
    skills: (() => {
      try {
        return JSON.parse(workspace.agentConfig?.enabledSkills || "[]");
      } catch {
        return [];
      }
    })(),
    constraints: (() => {
      try {
        return JSON.parse(workspace.agentConfig?.constraints || "{}");
      } catch {
        return {};
      }
    })(),
    parsingConfig: (() => {
      try {
        return JSON.parse(workspace.agentConfig?.parsingConfig || "{}");
      } catch {
        return {};
      }
    })(),
    embeddingModel: workspace.embeddingModel || "",
    templateId: workspace.templateId || "",
  }), [workspace.name, workspace.instructions, workspace.icon, workspace.embeddingModel, workspace.templateId, workspace.agentConfig?.systemPrompt, workspace.agentConfig?.enabledSkills, workspace.agentConfig?.constraints, workspace.agentConfig?.parsingConfig]);

  const hasChanges = (() => {
    if (draft.name !== original.name) return true;
    if (draft.instructions !== original.instructions) return true;
    if (draft.systemPrompt !== original.systemPrompt) return true;
    if (draft.icon !== original.icon) return true;
    if (JSON.stringify(draft.skills) !== JSON.stringify(original.skills)) return true;
    if (JSON.stringify(draft.constraints) !== JSON.stringify(original.constraints)) return true;
    if (JSON.stringify(draft.parsingConfig) !== JSON.stringify(original.parsingConfig)) return true;
    if (draft.embeddingModel !== original.embeddingModel) return true;
    if (draft.templateId !== original.templateId) return true;
    return false;
  })();

  useEffect(() => {
    if (!isExpanded) return;
    setDraft({
      name: workspace.name,
      instructions: workspace.instructions || "",
      systemPrompt: workspace.agentConfig?.systemPrompt || "",
      icon: workspace.icon || "",
      skills: original.skills,
      constraints: original.constraints,
      parsingConfig: original.parsingConfig,
      embeddingModel: workspace.embeddingModel || "",
      templateId: workspace.templateId || "",
    });
    setError(null);
    setShowMiniConfirm(false);

    // Fetch skills list when expanded
    setLoadingSkills(true);
    apiGet<SkillItem[]>("/agent/skills")
      .then((data) => setSkillsList(data))
      .catch(() => setSkillsList([]))
      .finally(() => setLoadingSkills(false));

    // Fetch templates when expanded
    setLoadingTemplates(true);
    apiGet<TemplateItem[]>("/templates")
      .then((data) => setTemplates(data))
      .catch(() => setTemplates([]))
      .finally(() => setLoadingTemplates(false));
  }, [isExpanded, workspace, original]);

  const handleExpand = () => {
    if (!canEdit) return;
    setIsExpanded(true);
    setError(null);
  };

  const handleCancel = () => {
    if (!hasChanges) {
      setIsExpanded(false);
      setShowMiniConfirm(false);
      setError(null);
    } else {
      setShowMiniConfirm(true);
    }
  };

  const handleDiscard = () => {
    setIsExpanded(false);
    setShowMiniConfirm(false);
    setError(null);
  };

  const handleKeepEditing = () => {
    setShowMiniConfirm(false);
  };

  const handleSave = async () => {
    if (!onUpdate || !hasChanges) return;
    setSaving(true);
    setError(null);
    try {
      await onUpdate(workspace.id, {
        name: draft.name,
        instructions: draft.instructions || null,
        systemPrompt: draft.systemPrompt,
        icon: draft.icon || null,
        skills: draft.skills,
        constraints: draft.constraints,
        parsingConfig: draft.parsingConfig,
        embeddingModel: draft.embeddingModel,
        templateId: draft.templateId || null,
      });
      showSuccess(t("workspace.saveChanges"));
      // Keep the row expanded after a successful save (260809-dhn): the edit
      // form stays visible showing the just-saved values. The workspace prop
      // updates asynchronously via the TanStack Query invalidation, so reset
      // the draft from the saved payload here; the useEffect on
      // [isExpanded, workspace, original] re-syncs from the server truth when
      // the refetched prop lands (flipping hasChanges to false).
      setDraft({
        name: draft.name,
        instructions: draft.instructions || "",
        systemPrompt: draft.systemPrompt,
        icon: draft.icon || "",
        skills: draft.skills,
        constraints: draft.constraints,
        parsingConfig: draft.parsingConfig,
        embeddingModel: draft.embeddingModel,
        templateId: draft.templateId || "",
      });
      setShowMiniConfirm(false);
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("common.error")));
      showError(getErrorMessage(err, t("common.error")));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  };

  const handleDeleteConfirm = async () => {
    if (!onDelete) return;
    setDeleting(true);
    setFadingOut(true);
    await new Promise((r) => setTimeout(r, 300));
    try {
      await onDelete(workspace.id);
      showSuccess(t("workspace.deletedToast", { name: workspace.name }));
      setDeleteOpen(false);
    } catch (err: unknown) {
      setFadingOut(false);
      showError(getErrorMessage(err, t("common.error")));
    } finally {
      setDeleting(false);
    }
  };

  const toggleSkill = (skillName: string) => {
    setDraft((prev) => ({
      ...prev,
      skills: prev.skills.includes(skillName)
        ? prev.skills.filter((s) => s !== skillName)
        : [...prev.skills, skillName],
    }));
  };

  const setConstraint = (key: keyof typeof draft.constraints, value: boolean) => {
    setDraft((prev) => ({
      ...prev,
      constraints: { ...prev.constraints, [key]: value },
    }));
  };

  const setParsingConfig = (key: keyof typeof draft.parsingConfig, value: boolean) => {
    setDraft((prev) => ({
      ...prev,
      parsingConfig: { ...prev.parsingConfig, [key]: value },
    }));
  };

  const handleTemplateSelect = (templateId: string | null) => {
    if (templateId) {
      const tmpl = templates.find((t) => t.id === templateId);
      if (tmpl) {
        setDraft((prev) => ({
          ...prev,
          templateId,
          systemPrompt: tmpl.systemPrompt,
          skills: tmpl.skills,
          constraints: {
            localLLMOnly: tmpl.constraints.localLLMOnly ?? false,
            hybridSearchForced: tmpl.constraints.hybridSearchForced ?? false,
            citationRequired: tmpl.constraints.citationRequired ?? false,
          },
          parsingConfig: {
            ocrRequired: tmpl.parsingConfig.ocrRequired ?? false,
          },
          embeddingModel: tmpl.embeddingModel ?? "",
        }));
      }
    } else {
      setDraft((prev) => ({
        ...prev,
        templateId: "",
      }));
    }
  };

  const rowClass = cn(
    "border-b border-border transition-all duration-300",
    fadingOut && "opacity-0 max-h-0",
    !fadingOut && "opacity-100 max-h-20",
    isExpanded && "bg-muted",
    canEdit && !isExpanded && "hover:bg-muted",
    !canEdit && "opacity-60"
  );

  const colSpan = isAdmin ? 6 : 5;

  return (
    <>
      <tr className={rowClass} aria-readonly={!canEdit || undefined}>
        {/* Selection checkbox (UX-04; rendered unconditionally per OQ1) */}
        <TableCell className="px-3 py-3 w-10">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect?.(workspace.id)}
            aria-label={t("workspace.selectRow", { name: workspace.name })}
            data-testid={`select-${workspace.id}`}
          />
        </TableCell>

        {/* Name cell */}
        <TableCell className="px-5 py-3">
          <div className={canEdit ? "cursor-pointer" : undefined} onClick={canEdit ? handleExpand : undefined}>
            <span className="text-foreground">{workspace.name}</span>
            {!canEdit && (
              <Badge variant="outline" className="ml-2 text-xs">
                {t("workspace.readOnly")}
              </Badge>
            )}
          </div>
        </TableCell>

        {/* Owner column (admin only) */}
        {isAdmin && (
          <TableCell className="px-5 py-3 text-xs text-muted-foreground">
            {(() => {
              const c = workspace.project?.creator;
              const display = c
                ? (`${c.firstName || ""} ${c.lastName || ""}`.trim() || c.username)
                : null;
              return display || workspace.project?.createdBy || "—";
            })()}
          </TableCell>
        )}

        {/* Uploads column */}
        <TableCell className="px-5 py-3">
          {isAdmin ? (
            <Switch
              checked={workspace.allowMemberUploads ?? false}
              aria-label={t("workspaces.allowMemberUploads")}
              onCheckedChange={(checked) => onUpdate?.(workspace.id, { allowMemberUploads: checked })}
            />
          ) : (
            <span className="text-xs text-secondary-foreground">
              {workspace.allowMemberUploads ? t("workspaces.allowMemberUploads") : "—"}
            </span>
          )}
        </TableCell>

        {/* Created column */}
        <TableCell className="px-5 py-3 text-xs text-secondary-foreground">
          {new Date(workspace.createdAt).toLocaleDateString()}
        </TableCell>

        {/* Actions column */}
        <TableCell className="px-5 py-3 w-[200px] max-w-[320px] whitespace-normal">
          <>
            {canEdit && !isExpanded && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleExpand}
                className="text-foreground hover:text-primary"
                aria-label={t("workspace.edit")}
              >
                <Pencil className="w-4 h-4 mr-1" />
                {t("workspace.edit")}
              </Button>
            )}
            {canEdit && (
              <Button
                variant="link"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                className="text-destructive"
                aria-label={t("workspace.deleteWorkspace")}
              >
                {t("common.delete")}
              </Button>
            )}
          </>
        </TableCell>
      </tr>

      {/* Delete confirmation dialog (D-01: standard AlertDialog contract) */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspace.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspace.deleteBody", {
                chatCount: workspace._count?.chats ?? 0,
                docCount: workspace._count?.documents ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} onClick={() => setDeleteOpen(false)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isExpanded && (
        <tr>
          <td colSpan={colSpan} className="p-0">
            <div
              className="p-6 bg-muted border-t border-border space-y-4"
              onKeyDown={handleKeyDown}
              tabIndex={-1}
            >
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">
                  {t("workspaceCreate.name")}
                </label>
                <Input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
                  aria-label={t("workspace.name")}
                  className="w-full border border-input rounded px-2 py-1 text-sm bg-card text-foreground focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                />
              </div>

              {/* Instructions */}
              <AppTextarea
                label={t("workspaceCreate.instructions")}
                value={draft.instructions}
                onChange={(e) => setDraft((prev) => ({ ...prev, instructions: e.target.value }))}
                placeholder={t("workspaceCreate.instructionsPlaceholder")}
                className="w-full min-h-[200px] resize-y"
              />

              {/* Icon */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">
                  {t("workspaceCreate.icon")}
                </label>
                <IconPicker
                  value={draft.icon}
                  onChange={(name) => setDraft((prev) => ({ ...prev, icon: name }))}
                />
              </div>

              {/* System Prompt */}
              <AppTextarea
                label={t("workspaceCreate.systemPrompt")}
                value={draft.systemPrompt}
                onChange={(e) => setDraft((prev) => ({ ...prev, systemPrompt: e.target.value }))}
                placeholder={t("workspaceCreate.systemPromptPlaceholder")}
                className="w-full min-h-[200px] resize-y"
              />

              {/* Skills */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">
                  {t("workspaceCreate.skills")}
                </label>
                {loadingSkills ? (
                  <p className="text-sm text-secondary-foreground">{t("common.loading")}</p>
                ) : (
                  <div className="space-y-2">
                    {skillsList.map((skill) => (
                      <label key={skill.name} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={draft.skills.includes(skill.name)}
                          onChange={() => toggleSkill(skill.name)}
                          className="rounded border-input"
                        />
                        <div>
                          <span className="text-sm font-medium text-foreground">{t(`skills.${skill.name}.displayName`, skill.displayName)}</span>
                          <span className="text-xs text-muted-foreground ml-2">{t(`skills.${skill.name}.description`, skill.description)}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Constraints */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-2">
                  {t("workspaceCreate.constraints")}
                </label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!draft.constraints.localLLMOnly}
                      onChange={(e) => setConstraint("localLLMOnly", e.target.checked)}
                      className="rounded border-input"
                    />
                    <span className="text-sm text-foreground">{t("workspaceCreate.localOnly")}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!draft.constraints.hybridSearchForced}
                      onChange={(e) => setConstraint("hybridSearchForced", e.target.checked)}
                      className="rounded border-input"
                    />
                    <span className="text-sm text-foreground">{t("workspaceCreate.hybridSearch")}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!draft.constraints.citationRequired}
                      onChange={(e) => setConstraint("citationRequired", e.target.checked)}
                      className="rounded border-input"
                    />
                    <span className="text-sm text-foreground">{t("workspaceCreate.citationRequired")}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!draft.parsingConfig.ocrRequired}
                      onChange={(e) => setParsingConfig("ocrRequired", e.target.checked)}
                      className="rounded border-input"
                    />
                    <span className="text-sm text-foreground">{t("workspaceCreate.ocrRequired")}</span>
                  </label>
                </div>
              </div>

              {/* Embedding Model */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">
                  {t("workspaceCreate.embeddingModel")}
                </label>
                <Select
                  value={draft.embeddingModel || "none"}
                  onValueChange={(value) => setDraft((prev) => ({ ...prev, embeddingModel: value === "none" ? "" : value }))}
                >
                  <SelectTrigger className="w-full border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                    <SelectValue placeholder={t("settings.llm.selectModel", "Select model...")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("workspaceCreate.defaultEmbedding", "Use system default")}</SelectItem>
                    {embeddingModels.map((m) => (
                      <SelectItem key={m.id} value={m.name}>{m.displayName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Template Selection */}
              <div>
                <label className="block text-sm font-medium text-muted-foreground mb-1">
                  {t("workspaceCreate.templateSection")}
                </label>
                {loadingTemplates ? (
                  <p className="text-sm text-secondary-foreground">{t("common.loading")}</p>
                ) : (
                  <Select
                    value={draft.templateId || "none"}
                    onValueChange={(value) => handleTemplateSelect(value === "none" ? null : value)}
                  >
                    <SelectTrigger className="w-full border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                      <SelectValue placeholder={t("workspaceCreate.noTemplate")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("workspaceCreate.noTemplate")}</SelectItem>
                      {templates.map((tmpl) => (
                        <SelectItem key={tmpl.id} value={tmpl.id}>
                          {tmpl.icon || "📋"} {tmpl.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {/* Show selected template info */}
                {draft.templateId && (() => {
                  const sel = templates.find((t) => t.id === draft.templateId);
                  if (!sel) return null;
                  return (
                    <div className="mt-2 bg-primary/10 border border-primary rounded-lg p-3">
                      <h4 className="text-sm font-semibold text-primary">
                        {sel.icon} {sel.name}
                      </h4>
                      <p className="text-xs text-primary mt-1">{sel.description}</p>
                      {sel.embeddingModel && (
                        <p className="text-xs text-primary mt-2">
                          {t("workspaceCreate.recommendedModel")}: {sel.embeddingModel}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Error */}
              {error && (
                <span className="text-xs text-destructive mt-1 block">{error}</span>
              )}

              {/* Mini confirm */}
              {showMiniConfirm && (
                <div className="mt-3 p-3 bg-destructive/10 rounded-lg border border-destructive/20 flex items-center gap-3 flex-wrap">
                  <span className="text-sm text-foreground flex-1">{t("workspace.unsavedChangesBody")}</span>
                  <Button variant="ghost" size="sm" onClick={handleKeepEditing}>
                    {t("workspace.keepEditing")}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={handleDiscard}>
                    {t("workspace.discard")}
                  </Button>
                </div>
              )}

              {/* Action bar */}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                >
                  {saving ? t("common.loading") : t("workspace.saveChanges")}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

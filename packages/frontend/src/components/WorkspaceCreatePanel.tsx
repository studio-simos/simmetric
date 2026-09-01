// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useProviders } from "../queries/useProviders";
import { useCreateWorkspace } from "../queries/useWorkspaces";
import { useCreateProject, useProjects } from "../queries/useProjects";
import { apiGet, apiPost } from "../utils/api";
import { showSuccess } from "../lib/toast";

interface WorkspaceCreatePanelProps {
  inline?: boolean;
  onCreated?: () => void;
  onCancel?: () => void;
}

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AppInput, AppTextarea } from "@/components/ui/app";
import { IconPicker } from "./IconPicker";
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
import { getErrorMessage } from "../utils/errorUtils";
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

interface SkillItem {
  name: string;
  displayName: string;
  description: string;
  type: string;
}

export default function WorkspaceCreatePanel({
  inline,
  onCreated,
  onCancel,
}: WorkspaceCreatePanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  usePageMeta(
    inline ? "" : t("createWorkspace.pageTitle"),
    inline
      ? []
      : [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.createWorkspace") }],
  );

  // Data
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const { data: projects = [] } = useProjects();

  // Loading states
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Template selection
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // Inline project creation
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");

  // Workspace form fields
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [icon, setIcon] = useState("📋");
  const [selectedSkills, setSelectedSkills] = useState<string[]>(["rag_search", "workspace_memory"]);
  const [localLLMOnly, setLocalLLMOnly] = useState(false);
  const [hybridSearchForced, setHybridSearchForced] = useState(false);
  const [citationRequired, setCitationRequired] = useState(false);
  const [ocrRequired, setOcrRequired] = useState(false);
  const [embeddingModel, setEmbeddingModel] = useState("");

  // Save as template
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateSlug, setTemplateSlug] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");

  // Dirty state + discard dialog
  const { data: providers = [] } = useProviders();
  const createWorkspace = useCreateWorkspace();
  const createProject = useCreateProject();
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

  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  const isDirty = (() => {
    if (projectId !== "") return true;
    if (name !== "") return true;
    if (instructions !== "") return true;
    if (systemPrompt !== "") return true;
    if (icon !== "📋") return true;
    if (selectedTemplateId !== null) return true;
    if (selectedSkills.length !== 2 || selectedSkills[0] !== "rag_search" || selectedSkills[1] !== "workspace_memory") return true;
    if (localLLMOnly !== false) return true;
    if (hybridSearchForced !== false) return true;
    if (citationRequired !== false) return true;
    if (ocrRequired !== false) return true;
    if (embeddingModel !== "") return true;
    if (saveAsTemplate !== false) return true;
    if (templateSlug !== "") return true;
    if (templateDescription !== "") return true;
    return false;
  })();

  useEffect(() => {
    fetchTemplates();
    fetchSkills();
  }, []);

  const fetchTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const data = await apiGet<TemplateItem[]>("/templates");
      setTemplates(data);
    } catch {
      // Templates not available yet
    } finally {
      setLoadingTemplates(false);
    }
  };

  const fetchSkills = async () => {
    setLoadingSkills(true);
    try {
      const data = await apiGet<SkillItem[]>("/agent/skills");
      setSkills(data);
    } catch {
      // Skills not available
    } finally {
      setLoadingSkills(false);
    }
  };

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  // When template selection changes, populate form fields
  const handleTemplateSelect = (id: string | null) => {
    setSelectedTemplateId(id);
    if (id) {
      const tmpl = templates.find((t) => t.id === id);
      if (tmpl) {
        setSystemPrompt(tmpl.systemPrompt);
        setSelectedSkills(tmpl.skills);
        setLocalLLMOnly(tmpl.constraints.localLLMOnly ?? false);
        setHybridSearchForced(tmpl.constraints.hybridSearchForced ?? false);
        setCitationRequired(tmpl.constraints.citationRequired ?? false);
        setOcrRequired(tmpl.parsingConfig.ocrRequired ?? false);
        setEmbeddingModel(tmpl.embeddingModel ?? "");
        setIcon(tmpl.icon ?? "📋");
      }
    } else {
      // Reset to defaults
      setSystemPrompt("");
      setSelectedSkills(["rag_search", "workspace_memory"]);
      setLocalLLMOnly(false);
      setHybridSearchForced(false);
      setCitationRequired(false);
      setOcrRequired(false);
      setEmbeddingModel("");
      setIcon("📋");
    }
  };

  const toggleSkill = (skillName: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillName) ? prev.filter((s) => s !== skillName) : [...prev, skillName]
    );
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    setCreatingProject(true);
    setError(null);
    try {
      const project = await createProject.mutateAsync({
        name: newProjectName,
        description: newProjectDesc || undefined,
      });
      setProjectId(project.id);
      setShowProjectForm(false);
      setNewProjectName("");
      setNewProjectDesc("");
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("workspaceCreate.errorCreate")));
    } finally {
      setCreatingProject(false);
    }
  };

  const handleCreate = async () => {
    if (!projectId || !name.trim()) {
      setError(t("workspaceCreate.errorRequired"));
      return;
    }

    setCreating(true);
    setError(null);
    setSuccess(null);

    try {
      const body: Record<string, unknown> = {
        projectId,
        name,
        instructions: instructions || undefined,
        templateId: selectedTemplateId || undefined,
        embeddingModel,
        systemPrompt: systemPrompt || undefined,
        icon: icon || undefined,
        skills: selectedSkills,
        constraints: {
          localLLMOnly,
          hybridSearchForced,
          citationRequired,
        },
        parsingConfig: {
          ocrRequired,
        },
      };

      await createWorkspace.mutateAsync(body);

      // If save as template is checked, also create a template
      if (saveAsTemplate && templateSlug.trim()) {
        try {
          await apiPost("/templates", {
            slug: templateSlug.trim(),
            name: name.trim(),
            description: templateDescription || undefined,
            icon,
            systemPrompt: systemPrompt || `You are a helpful AI assistant with access to workspace documents and tools.`,
            skills: selectedSkills,
            parsingConfig: { ocrRequired },
            constraints: { localLLMOnly, hybridSearchForced, citationRequired },
            embeddingModel,
            persistToDisk: true,
          });
        } catch {
          // Template creation failed, but workspace was created — don't block
        }
      }

      showSuccess(t("workspace.createSuccess"));
      if (inline) {
        onCreated?.();
      } else {
        navigate("/workspaces");
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, t("workspaceCreate.errorCreate")));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={inline ? "p-6 bg-muted border-t border-border space-y-4" : "w-full h-full overflow-y-auto p-6 space-y-6"}>
      {!inline && (
        <h2 className="text-xl font-bold text-foreground">{t("workspaceCreate.title")}</h2>
      )}

      {/* Project Selection */}
      <div>
        <label className="block text-sm font-medium text-muted-foreground mb-1">
          {t("workspaceCreate.projectId")} *
        </label>
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : (
          <div className="flex gap-2">
            <Select value={projectId || "none"} onValueChange={(value) => setProjectId(value === "none" ? "" : value)}>
              <SelectTrigger className="flex-1 border border-input rounded px-3 py-2 text-sm bg-card text-foreground h-auto">
                <SelectValue placeholder={t("workspaceCreate.selectProject")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("workspaceCreate.selectProject")}</SelectItem>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowProjectForm(!showProjectForm)}
              title={t("workspaceCreate.newProject")}
            >
              +
            </Button>
          </div>
        )}

        {/* Inline project creation form */}
        {showProjectForm && (
          <div className="mt-3 p-4 border border-border rounded-lg bg-muted space-y-3">
            <h4 className="text-sm font-semibold text-foreground">{t("workspaceCreate.newProject")}</h4>
            <Input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder={t("workspaceCreate.projectNamePlaceholder")}
              className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground"
            />
            <AppTextarea
              value={newProjectDesc}
              onChange={(e) => setNewProjectDesc(e.target.value)}
              placeholder={t("workspaceCreate.projectDesc")}
              className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground"
              rows={2}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleCreateProject}
                disabled={creatingProject || !newProjectName.trim()}
              >
                {creatingProject ? t("common.loading") : t("workspaceCreate.createProject")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowProjectForm(false)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Workspace Name */}
      <AppInput
        label={t("workspaceCreate.name") + " *"}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("workspaceCreate.namePlaceholder")}
        className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground"
      />

      {/* Instructions */}
      <AppTextarea
        label={t("workspaceCreate.instructions")}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder={t("workspaceCreate.instructionsPlaceholder")}
        className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground min-h-[200px] resize-y"
      />

      {/* Template Selection */}
      <div>
        <label className="block text-sm font-medium text-muted-foreground mb-2">
          {t("workspaceCreate.templateSection")}
        </label>

        {loadingTemplates ? (
          <p className="text-sm text-secondary-foreground">{t("common.loading")}</p>
        ) : (
          <Select
            value={selectedTemplateId || "none"}
            onValueChange={(value) => handleTemplateSelect(value === "none" ? null : value)}
          >
            <SelectTrigger className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground h-auto">
              <SelectValue placeholder={t("workspaceCreate.noTemplate")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("workspaceCreate.noTemplate")} — {t("workspaceCreate.noTemplateDesc")}</SelectItem>
              {templates.map((tmpl) => (
                <SelectItem key={tmpl.id} value={tmpl.id}>
                  {tmpl.icon || "📋"} {tmpl.name}
                  {tmpl.constraints.localLLMOnly ? ` — ${t("workspaceCreate.localOnly")}` : ""}
                  {tmpl.constraints.citationRequired ? ` — ${t("workspaceCreate.citationRequired")}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Selected template info */}
        {selectedTemplate && (
          <div className="mt-3 bg-primary/10 border border-primary rounded-lg p-4">
            <h4 className="text-sm font-semibold text-primary">
              {selectedTemplate.icon} {selectedTemplate.name}
            </h4>
            <p className="text-xs text-primary mt-1">{selectedTemplate.description}</p>
            {selectedTemplate.embeddingModel && (
              <p className="text-xs text-primary mt-2">
                {t("workspaceCreate.recommendedModel")}: {selectedTemplate.embeddingModel}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Template Configuration Section */}
      <div className="border-t pt-6 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">{t("workspaceCreate.configSection")}</h3>

        {/* Icon */}
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-1">
            {t("workspaceCreate.icon")}
          </label>
          <IconPicker value={icon} onChange={setIcon} />
        </div>

        {/* System Prompt */}
        <AppTextarea
          label={t("workspaceCreate.systemPrompt")}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder={t("workspaceCreate.systemPromptPlaceholder")}
          className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground min-h-[200px] resize-y"
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
              {skills.map((skill) => (
                <label key={skill.name} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedSkills.includes(skill.name)}
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
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={localLLMOnly}
                onChange={(e) => setLocalLLMOnly(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-sm text-foreground">{t("workspaceCreate.localOnly")}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={hybridSearchForced}
                onChange={(e) => setHybridSearchForced(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-sm text-foreground">{t("workspaceCreate.hybridSearch")}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={citationRequired}
                onChange={(e) => setCitationRequired(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-sm text-foreground">{t("workspaceCreate.citationRequired")}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ocrRequired}
                onChange={(e) => setOcrRequired(e.target.checked)}
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
          <Select value={embeddingModel || "none"} onValueChange={(value) => setEmbeddingModel(value === "none" ? "" : value)}>
            <SelectTrigger className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground h-auto">
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
      </div>

      {/* Save as Template */}
      <div className="border-t pt-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={saveAsTemplate}
            onChange={(e) => setSaveAsTemplate(e.target.checked)}
            className="rounded border-input"
          />
          <span className="text-sm font-medium text-foreground">{t("workspaceCreate.saveAsTemplate")}</span>
        </label>

        {saveAsTemplate && (
          <div className="mt-3 space-y-3 p-4 border border-border rounded-lg bg-muted">
            <AppInput
              label={t("workspaceCreate.templateSlug") + " *"}
              value={templateSlug}
              onChange={(e) => setTemplateSlug(e.target.value.replace(/[^a-z0-9-]/g, "-"))}
              placeholder={t("workspaceCreate.templateSlugPlaceholder")}
              className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground"
            />
            <AppTextarea
              label={t("workspaceCreate.templateDesc")}
              value={templateDescription}
              onChange={(e) => setTemplateDescription(e.target.value)}
              placeholder={t("workspaceCreate.templateDescPlaceholder")}
              className="w-full border border-input rounded px-3 py-2 text-sm bg-card text-foreground"
              rows={2}
            />
          </div>
        )}
      </div>

      {/* Error / Success */}
      {error && (
        <div className="text-sm text-destructive-foreground bg-destructive rounded p-3">{error}</div>
      )}
      {success && (
        <div className="text-sm text-secondary-foreground bg-secondary rounded p-3">{success}</div>
      )}

      {/* Create / Cancel buttons */}
      <div className="flex gap-3">
        <Button
          onClick={handleCreate}
          disabled={creating || !projectId || !name.trim()}
        >
          {creating ? t("common.loading") : t("workspaceCreate.create")}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            if (!isDirty) {
              if (inline) {
                onCancel?.();
              } else {
                navigate("/workspaces");
              }
            } else {
              setShowDiscardDialog(true);
            }
          }}
        >
          {t("common.cancel")}
        </Button>
      </div>

      <AlertDialog open={showDiscardDialog} onOpenChange={setShowDiscardDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspace.unsavedNavigateTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("workspace.unsavedNavigateBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowDiscardDialog(false)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (inline) {
                  onCancel?.();
                } else {
                  navigate("/workspaces");
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("workspace.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
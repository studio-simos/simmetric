// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { AppTextarea } from "@/components/ui/app";
import { Alert, AlertDescription } from "./ui/alert";
import { Checkbox } from "./ui/checkbox";
import { DialogFooter } from "./ui/dialog";
import type { WorkspaceTemplate } from "../queries/useTemplates";

export interface TemplateFormValues {
  slug: string;
  name: string;
  description: string;
  icon: string;
  systemPrompt: string;
  skills: string[];
  embeddingModel: string;
  persistToDisk: boolean;
}

interface TemplateFormProps {
  initial?: WorkspaceTemplate | null;
  submitting: boolean;
  error?: string | null;
  onSubmit: (values: TemplateFormValues) => void;
  onCancel: () => void;
}

export function TemplateForm({
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: TemplateFormProps) {
  const { t } = useTranslation();
  const isEdit = !!initial;

  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [skillsText, setSkillsText] = useState(
    (initial?.skills ?? ["rag_search", "workspace_memory"]).join(", "),
  );
  const [embeddingModel, setEmbeddingModel] = useState(
    initial?.embeddingModel ?? "",
  );
  const [persistToDisk, setPersistToDisk] = useState(false);

  const canSubmit =
    name.trim().length > 0 &&
    systemPrompt.trim().length > 0 &&
    (isEdit || slug.trim().length > 0) &&
    !submitting;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const skills = skillsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    onSubmit({
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim(),
      icon: icon.trim(),
      systemPrompt: systemPrompt.trim(),
      skills,
      embeddingModel: embeddingModel.trim(),
      persistToDisk,
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="template-name">{t("settings.templates.form.nameLabel")}</Label>
          <Input
            id="template-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.templates.form.namePlaceholder")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="template-slug">{t("settings.templates.form.slugLabel")}</Label>
          <Input
            id="template-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={t("settings.templates.form.slugPlaceholder")}
            disabled={isEdit}
          />
          {!isEdit && (
            <p className="text-xs text-[var(--text-muted)]">
              {t("settings.templates.form.slugHint")}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="template-icon">{t("settings.templates.form.iconLabel")}</Label>
          <Input
            id="template-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder={t("settings.templates.form.iconPlaceholder")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="template-embedding">{t("settings.templates.form.embeddingModelLabel")}</Label>
          <Input
            id="template-embedding"
            value={embeddingModel}
            onChange={(e) => setEmbeddingModel(e.target.value)}
            placeholder={t("settings.templates.form.embeddingModelPlaceholder")}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="template-description">{t("settings.templates.form.descriptionLabel")}</Label>
        <Input
          id="template-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("settings.templates.form.descriptionPlaceholder")}
        />
      </div>

      <AppTextarea
        id="template-system-prompt"
        label={t("settings.templates.form.systemPromptLabel")}
        value={systemPrompt}
        onChange={(e) => setSystemPrompt(e.target.value)}
        placeholder={t("settings.templates.form.systemPromptPlaceholder")}
        rows={6}
      />

      <div className="space-y-2">
        <Label htmlFor="template-skills">{t("settings.templates.form.skillsLabel")}</Label>
        <Input
          id="template-skills"
          value={skillsText}
          onChange={(e) => setSkillsText(e.target.value)}
          placeholder={t("settings.templates.form.skillsPlaceholder")}
        />
        <p className="text-xs text-[var(--text-muted)]">
          {t("settings.templates.form.skillsHint")}
        </p>
      </div>

      {!isEdit && (
        <div className="flex items-start gap-2">
          <Checkbox
            id="template-persist"
            checked={persistToDisk}
            onCheckedChange={(checked) => setPersistToDisk(checked === true)}
          />
          <div className="grid gap-1 leading-none">
            <Label htmlFor="template-persist" className="cursor-pointer">
              {t("settings.templates.form.persistToDiskLabel")}
            </Label>
            <p className="text-xs text-[var(--text-muted)]">
              {t("settings.templates.form.persistToDiskHint")}
            </p>
          </div>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          {t("common.cancel")}
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          {submitting
            ? t("common.saving")
            : isEdit
              ? t("common.save")
              : t("settings.templates.createButton")}
        </Button>
      </DialogFooter>
    </div>
  );
}

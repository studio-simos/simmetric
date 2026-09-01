// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  type WorkspaceTemplate,
} from "../queries/useTemplates";
import { TemplateForm, type TemplateFormValues } from "./TemplateForm";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

/**
 * SettingsTemplates — admin CRUD UI for industry templates
 * (WorkspaceTemplate), Phase 112-01.
 *
 * Rendered as a sub-section of Settings → Avanzate. Lists all templates with
 * icon, name, slug, system prompt preview, skills, and type badge. Built-in
 * templates (isBuiltIn) are read-only — badge shown, edit/delete disabled.
 * Custom templates expose Edit (Dialog + TemplateForm) and Delete
 * (AlertDialog confirmation). Permission gate is in SettingsPage
 * (admin:settings), NOT here.
 */
export function SettingsTemplates() {
  const { t } = useTranslation();
  const { data: templates, isLoading, error } = useTemplates();
  const createTemplate = useCreateTemplate();
  const updateTemplate = useUpdateTemplate();
  const deleteTemplate = useDeleteTemplate();

  const [creating, setCreating] = useState(false);
  const [editingTemplate, setEditingTemplate] =
    useState<WorkspaceTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<WorkspaceTemplate | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const closeDialog = () => {
    setCreating(false);
    setEditingTemplate(null);
    setFormError(null);
  };

  const handleSubmit = async (values: TemplateFormValues) => {
    setSubmitting(true);
    setFormError(null);
    try {
      if (editingTemplate) {
        await updateTemplate.mutateAsync({
          id: editingTemplate.id,
          data: {
            name: values.name,
            description: values.description || null,
            icon: values.icon || null,
            systemPrompt: values.systemPrompt,
            skills: values.skills,
            embeddingModel: values.embeddingModel || null,
          },
        });
        showSuccess(t("settings.templates.updateSuccess"));
      } else {
        await createTemplate.mutateAsync({
          slug: values.slug,
          name: values.name,
          description: values.description || undefined,
          icon: values.icon || undefined,
          systemPrompt: values.systemPrompt,
          skills: values.skills,
          embeddingModel: values.embeddingModel || undefined,
          persistToDisk: values.persistToDisk,
        });
        showSuccess(t("settings.templates.createSuccess"));
      }
      closeDialog();
    } catch (err: unknown) {
      setFormError(getErrorMessage(err, t("settings.templates.saveError")));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteTemplate.mutateAsync(deleteTarget.id);
      showSuccess(t("settings.templates.deleteSuccess"));
      setDeleteTarget(null);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.templates.deleteError")));
    }
  };

  const truncate = (text: string, max = 80) =>
    text.length > max ? `${text.slice(0, max)}…` : text;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-[var(--text-muted)]">
          {t("settings.templates.description")}
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("settings.templates.createButton")}
        </Button>
      </div>

      {error && (
        <div className="py-4 text-sm text-[var(--error-text)]">
          {t("settings.templates.loadError")}
        </div>
      )}

      {!error && (
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-input text-left text-muted-foreground">
                <TableHead className="px-4 py-2 w-12">
                  {t("settings.templates.columns.icon")}
                </TableHead>
                <TableHead className="px-4 py-2">
                  {t("settings.templates.columns.name")}
                </TableHead>
                <TableHead className="px-4 py-2">
                  {t("settings.templates.columns.slug")}
                </TableHead>
                <TableHead className="px-4 py-2">
                  {t("settings.templates.columns.systemPrompt")}
                </TableHead>
                <TableHead className="px-4 py-2">
                  {t("settings.templates.columns.skills")}
                </TableHead>
                <TableHead className="px-4 py-2">
                  {t("settings.templates.columns.type")}
                </TableHead>
                <TableHead className="px-4 py-2 text-right">
                  {t("settings.templates.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(templates ?? []).map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="px-4 py-2 text-lg">
                    {template.icon || "📋"}
                  </TableCell>
                  <TableCell className="px-4 py-2 font-medium text-[var(--text)]">
                    {template.name}
                  </TableCell>
                  <TableCell className="px-4 py-2">
                    <code className="text-xs bg-[var(--surface-alt)] px-1.5 py-0.5 rounded">
                      {template.slug}
                    </code>
                  </TableCell>
                  <TableCell
                    className="px-4 py-2 max-w-[280px] text-[var(--text-muted)]"
                    title={template.systemPrompt}
                  >
                    <span className="text-xs">{truncate(template.systemPrompt)}</span>
                  </TableCell>
                  <TableCell className="px-4 py-2 max-w-[180px]">
                    <div className="flex flex-wrap gap-1">
                      {template.skills.slice(0, 3).map((skill) => (
                        <Badge key={skill} variant="secondary" className="text-xs">
                          {skill}
                        </Badge>
                      ))}
                      {template.skills.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{template.skills.length - 3}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-2">
                    {template.isBuiltIn ? (
                      <Badge variant="secondary">
                        {t("settings.templates.builtIn")}
                      </Badge>
                    ) : (
                      <Badge variant="outline">
                        {t("settings.templates.custom")}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-2">
                    {template.isBuiltIn ? (
                      <span
                        className="block text-right text-xs text-[var(--text-muted)]"
                        title={t("settings.templates.readOnlyHint")}
                      >
                        {t("settings.templates.readOnly")}
                      </span>
                    ) : (
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("common.edit")}
                          onClick={() => {
                            setFormError(null);
                            setEditingTemplate(template);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("common.delete")}
                          onClick={() => setDeleteTarget(template)}
                        >
                          <Trash2 className="h-4 w-4 text-[var(--error-text)]" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!isLoading && (templates ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8">
                    <p className="text-sm text-[var(--text-muted)]">
                      {t("settings.templates.noTemplates")}
                    </p>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {isLoading && (
            <div className="text-center py-8 text-[var(--text-muted)] text-sm border-t border-[var(--border)]">
              {t("common.loading")}
            </div>
          )}
        </div>
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.templates.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.templates.deleteConfirm", {
                name: deleteTarget?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={creating || !!editingTemplate}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className="max-w-[720px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate
                ? t("settings.templates.editTitle")
                : t("settings.templates.createTitle")}
            </DialogTitle>
          </DialogHeader>
          <TemplateForm
            key={editingTemplate?.id ?? "create"}
            initial={editingTemplate}
            submitting={submitting}
            error={formError}
            onSubmit={handleSubmit}
            onCancel={closeDialog}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsDlpPatterns — admin panel for DLP pattern configuration
 * (quick 260829-ony — DLP_FEATURES_SPEC §2.3/Fase 4).
 *
 * Mounted in Settings → Advanced next to the DLP audit panel.
 * - List: displayName, name (mono), enabled switch, Built-in badge; edit +
 *   delete (custom only — built-ins can only be toggled/renamed/disabled).
 * - Add/Edit dialog: name (snake_case), displayName, regex source with INLINE
 *   compile validation, flags, replacement, and a live test preview showing
 *   matched segments + the redacted text.
 * - Danger-zone note documents the v1 limitation (spec §4.1): DB-backed
 *   patterns apply on the plugin inlet/outlet + the end-of-stream final
 *   flush; the per-token progressive streaming flush stays on the built-in
 *   pattern set.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useDlpPatterns,
  useCreateDlpPattern,
  useUpdateDlpPattern,
  useDeleteDlpPattern,
} from "../queries/useDlpPatterns";
import type { DlpPattern } from "../queries/useDlpPatterns";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";
import { showSuccess, showError } from "../lib/toast";
import { Plus, Pencil, Trash2, ShieldAlert, Loader2 } from "lucide-react";

/** Client mirror of the server's compileRegex validation (invalid → inline error). */
function compileCheck(pattern: string, flags: string): string | null {
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Local (unpersisted) test preview — same shape as the server test endpoint. */
function localTest(
  pattern: string,
  flags: string,
  sample: string,
): { matches: Array<{ index: number; length: number; matchedText: string }>; redactedText: string } | null {
  try {
    const regex = new RegExp(pattern, flags);
    const matches: Array<{ index: number; length: number; matchedText: string }> = [];
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = regex.exec(sample)) !== null) {
      matches.push({ index: m.index, length: m[0].length, matchedText: m[0] });
      if (m[0].length === 0) {
        regex.lastIndex += 1;
        if (regex.lastIndex > sample.length) break;
      }
      if (++guard > 10_000) break;
    }
    const redactedText = sample.replace(regex, "[REDACTED]");
    regex.lastIndex = 0;
    return { matches, redactedText };
  } catch {
    return null;
  }
}

interface EditingState {
  /** null = creating a new custom pattern */
  pattern: DlpPattern | null;
  name: string;
  displayName: string;
  patternSource: string;
  patternFlags: string;
  replacement: string;
  isEnabled: boolean;
  sample: string;
}

const EMPTY_EDIT: EditingState = {
  pattern: null,
  name: "",
  displayName: "",
  patternSource: "",
  patternFlags: "gu",
  replacement: "[REDACTED]",
  isEnabled: true,
  sample: "",
};

export function SettingsDlpPatterns() {
  const { t } = useTranslation();
  const { data: patterns = [], isLoading, error } = useDlpPatterns();
  const createMutation = useCreateDlpPattern();
  const updateMutation = useUpdateDlpPattern();
  const deleteMutation = useDeleteDlpPattern();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [edit, setEdit] = useState<EditingState>(EMPTY_EDIT);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DlpPattern | null>(null);

  const regexError = useMemo(() => {
    if (!edit.patternSource.trim()) return null;
    return compileCheck(edit.patternSource, edit.patternFlags || "gu");
  }, [edit.patternSource, edit.patternFlags]);

  const preview = useMemo(() => {
    if (regexError || !edit.patternSource.trim() || !edit.sample) return null;
    return localTest(edit.patternSource, edit.patternFlags || "gu", edit.sample);
  }, [edit.patternSource, edit.patternFlags, edit.sample, regexError]);

  const openCreate = () => {
    setEdit(EMPTY_EDIT);
    setDialogOpen(true);
  };

  const openEdit = (p: DlpPattern) => {
    setEdit({
      pattern: p,
      name: p.name,
      displayName: p.displayName,
      patternSource: p.pattern,
      patternFlags: p.patternFlags,
      replacement: p.replacement,
      isEnabled: p.isEnabled,
      sample: "",
    });
    setDialogOpen(true);
  };

  const canSave =
    edit.displayName.trim().length > 0 &&
    (!regexError) &&
    (edit.pattern !== null || (edit.name.trim().length > 0 && edit.patternSource.trim().length > 0));

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (edit.pattern === null) {
        await createMutation.mutateAsync({
          name: edit.name.trim(),
          displayName: edit.displayName.trim(),
          pattern: edit.patternSource,
          patternFlags: edit.patternFlags || "gu",
          replacement: edit.replacement,
          isEnabled: edit.isEnabled,
        });
        showSuccess(t("dlpPatterns.toast.created"));
      } else {
        const isBuiltIn = edit.pattern.isBuiltIn;
        await updateMutation.mutateAsync({
          id: edit.pattern.id,
          data: isBuiltIn
            ? { displayName: edit.displayName.trim(), isEnabled: edit.isEnabled }
            : {
                displayName: edit.displayName.trim(),
                pattern: edit.patternSource,
                patternFlags: edit.patternFlags || "gu",
                replacement: edit.replacement,
                isEnabled: edit.isEnabled,
              },
        });
        showSuccess(t("dlpPatterns.toast.updated"));
      }
      setDialogOpen(false);
      setEdit(EMPTY_EDIT);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message || t("dlpPatterns.toast.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (p: DlpPattern, checked: boolean) => {
    try {
      await updateMutation.mutateAsync({ id: p.id, data: { isEnabled: checked } });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t("dlpPatterns.toast.saveError"));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      showSuccess(t("dlpPatterns.toast.deleted"));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : t("dlpPatterns.toast.deleteError"));
    } finally {
      setDeleteTarget(null);
    }
  };

  const isBuiltInEdit = edit.pattern?.isBuiltIn ?? false;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-foreground">
            {t("dlpPatterns.title")}
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            {t("dlpPatterns.description")}
          </p>
        </div>
        <Button size="sm" onClick={openCreate} data-testid="dlp-add-pattern">
          <Plus className="h-4 w-4 mr-1" />
          {t("dlpPatterns.add")}
        </Button>
      </div>

      {/* v1 limitation documented in the danger zone (spec §4.1) */}
      <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2.5">
        <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
        <p className="text-xs text-foreground">{t("dlpPatterns.dangerZone")}</p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground mt-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("dlpPatterns.loading")}
        </div>
      ) : error ? (
        <p className="text-sm text-destructive mt-4">{t("dlpPatterns.loadError")}</p>
      ) : (
        <div className="mt-4 space-y-2">
          {patterns.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dlpPatterns.empty")}</p>
          ) : (
            patterns.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center gap-2 border border-border rounded-md px-3 py-2"
                data-testid={`dlp-pattern-row-${p.name}`}
              >
                <Switch
                  checked={p.isEnabled}
                  onCheckedChange={(v) => handleToggle(p, v)}
                  aria-label={`${t("dlpPatterns.toggle")} ${p.displayName}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">
                      {p.displayName}
                    </span>
                    {p.isBuiltIn && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("dlpPatterns.builtIn")}
                      </Badge>
                    )}
                    {!p.isEnabled && (
                      <Badge variant="outline" className="text-[10px]">
                        {t("dlpPatterns.disabled")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <code className="text-[11px] text-muted-foreground">{p.name}</code>
                    <code className="text-[11px] text-muted-foreground truncate max-w-[60%] opacity-70">
                      /{p.pattern}/{p.patternFlags}
                    </code>
                  </div>
                </div>
                <button
                  className="p-1.5 rounded hover:bg-accent"
                  aria-label={`${t("dlpPatterns.edit")} ${p.displayName}`}
                  onClick={() => openEdit(p)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {!p.isBuiltIn && (
                  <button
                    className="p-1.5 rounded hover:bg-accent text-destructive"
                    aria-label={`${t("dlpPatterns.delete")} ${p.displayName}`}
                    onClick={() => setDeleteTarget(p)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Add/Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              {edit.pattern === null ? t("dlpPatterns.dialog.addTitle") : t("dlpPatterns.dialog.editTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="dlp-pattern-name">{t("dlpPatterns.dialog.name")}</Label>
              <Input
                id="dlp-pattern-name"
                value={edit.name}
                disabled={edit.pattern !== null} // name immutable after create
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                placeholder="italian_fiscal_code"
                data-testid="dlp-pattern-name"
              />
            </div>
            <div>
              <Label htmlFor="dlp-pattern-display">{t("dlpPatterns.dialog.displayName")}</Label>
              <Input
                id="dlp-pattern-display"
                value={edit.displayName}
                onChange={(e) => setEdit({ ...edit, displayName: e.target.value })}
                data-testid="dlp-pattern-display"
              />
            </div>
            <div>
              <Label htmlFor="dlp-pattern-regex">{t("dlpPatterns.dialog.pattern")}</Label>
              <Textarea
                id="dlp-pattern-regex"
                value={edit.patternSource}
                disabled={isBuiltInEdit}
                onChange={(e) => setEdit({ ...edit, patternSource: e.target.value })}
                className="font-mono text-xs"
                rows={2}
                data-testid="dlp-pattern-regex"
              />
              {regexError && (
                <p className="text-xs text-destructive mt-1" data-testid="dlp-pattern-regex-error">
                  {t("dlpPatterns.dialog.invalidRegex", { error: regexError })}
                </p>
              )}
              {isBuiltInEdit && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t("dlpPatterns.dialog.frozenHint")}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="dlp-pattern-flags">{t("dlpPatterns.dialog.flags")}</Label>
                <Input
                  id="dlp-pattern-flags"
                  value={edit.patternFlags}
                  disabled={isBuiltInEdit}
                  onChange={(e) => setEdit({ ...edit, patternFlags: e.target.value })}
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <Label htmlFor="dlp-pattern-replacement">{t("dlpPatterns.dialog.replacement")}</Label>
                <Input
                  id="dlp-pattern-replacement"
                  value={edit.replacement}
                  disabled={isBuiltInEdit}
                  onChange={(e) => setEdit({ ...edit, replacement: e.target.value })}
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div className="border-t border-border pt-3">
              <Label htmlFor="dlp-pattern-sample">{t("dlpPatterns.dialog.testLabel")}</Label>
              <Textarea
                id="dlp-pattern-sample"
                value={edit.sample}
                onChange={(e) => setEdit({ ...edit, sample: e.target.value })}
                placeholder={t("dlpPatterns.dialog.testPlaceholder")}
                rows={3}
                className="text-xs"
                data-testid="dlp-pattern-sample"
              />
              {preview && (
                <div className="mt-2 space-y-1.5" data-testid="dlp-pattern-preview">
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t("dlpPatterns.dialog.matches", { count: preview.matches.length })}:
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {preview.matches.map((m, i) => (
                        <code
                          key={`${m.index}-${i}`}
                          className="text-[11px] bg-destructive/10 text-destructive px-1.5 py-0.5 rounded"
                        >
                          {m.matchedText || "∅"}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t("dlpPatterns.dialog.redactedPreview")}:
                    </p>
                    <code className="block text-[11px] bg-muted px-2 py-1 rounded mt-1 whitespace-pre-wrap break-all">
                      {preview.redactedText}
                    </code>
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="dlp-pattern-enabled" className="text-sm">
                {t("dlpPatterns.dialog.enabled")}
              </Label>
              <Switch
                id="dlp-pattern-enabled"
                checked={edit.isEnabled}
                onCheckedChange={(v) => setEdit({ ...edit, isEnabled: v })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={!canSave || saving} data-testid="dlp-pattern-save">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation (custom only) */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dlpPatterns.deleteTitle")}</AlertDialogTitle>
            <p className="text-sm text-muted-foreground">
              {t("dlpPatterns.deleteConfirm", { name: deleteTarget?.displayName ?? "" })}
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} data-testid="dlp-pattern-delete-confirm">
              {t("dlpPatterns.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SettingsDlpPatterns;
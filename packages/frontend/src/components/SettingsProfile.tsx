// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { AuthUser } from "../queries/useAuth";
import { useMe, useUpdateProfile, useUploadAvatar, useRemoveAvatar } from "../queries/useAuth";
import { useChatNav } from "../contexts/ChatContext";
import { showSuccess, showError } from "../lib/toast";
import { apiUpload } from "../utils/api";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import type { ChatImportPreview } from "@simmetric-chat/shared";
import { getErrorMessage } from "../utils/errorUtils";

/**
 * SettingsProfile — split into three independently-rendered sub-sections so
 * SettingsPage can place each under a different menu voice:
 *
 *   <SettingsProfilePersonal />       → Profilo · Informazioni personali
 *   <SettingsProfileInstructions />    → Profilo · Istruzioni personalizzate
 *   <SettingsProfileChatData />        → Avanzate · Dati chat
 *
 * `getInitials` remains a named export (used by ComparisonPane / ChatMessage).
 */

function getInitials(user: AuthUser | null): string {
  if (!user) return "?";
  if (user.firstName && user.lastName) {
    return ((user.firstName[0] ?? "") + (user.lastName[0] ?? "")).toUpperCase();
  }
  return (user.username[0] ?? "").toUpperCase();
}

interface ProfileFormValues {
  firstName: string;
  lastName: string;
  textSize: string;
}

function applyTextSizeClass(size: string) {
  document.documentElement.classList.remove("text-size-sm", "text-size-md", "text-size-lg");
  if (size === "sm" || size === "md" || size === "lg") {
    document.documentElement.classList.add(`text-size-${size}`);
  }
}

/** Profilo · Informazioni personali — avatar + nome/cognome + text size. */
export function SettingsProfilePersonal() {
  const { t } = useTranslation();
  const { data: user } = useMe();
  const updateProfileMutation = useUpdateProfile();
  const uploadAvatarMutation = useUploadAvatar();
  const removeAvatarMutation = useRemoveAvatar();

  const profileForm = useForm<ProfileFormValues>({
    defaultValues: {
      firstName: user?.firstName || "",
      lastName: user?.lastName || "",
      textSize: user?.textSize || "md",
    },
  });

  const [saving, setSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) {
      const size = user.textSize || "md";
      profileForm.reset({
        firstName: user.firstName || "",
        lastName: user.lastName || "",
        textSize: size,
      });
      applyTextSizeClass(size);
    }
    // `profileForm` (react-hook-form) and `applyTextSizeClass` (module-level
    // pure import) are intentionally excluded from the deps array — both are
    // stable references that do not need to gate re-runs. Only the user
    // fields we mirror into the form drive the reset. (D-05 pattern 3 —
    // intentional, documented.)
  }, [user?.firstName, user?.lastName, user?.textSize]);

  const isProfileDirty =
    profileForm.watch("firstName") !== (user?.firstName || "") ||
    profileForm.watch("lastName") !== (user?.lastName || "") ||
    profileForm.watch("textSize") !== (user?.textSize || "md");

  const handleSaveProfile = async (data: ProfileFormValues) => {
    setSaving(true);
    setProfileError(null);
    try {
      await updateProfileMutation.mutateAsync({ firstName: data.firstName, lastName: data.lastName, textSize: data.textSize });
      showSuccess(t("settings.profile.profileUpdated"));
    } catch (err: unknown) {
      const msg = getErrorMessage(err, t("settings.profile.profileError"));
      setProfileError(msg);
      showError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!validTypes.includes(file.type)) {
      showError(t("settings.profile.avatarError"));
      return;
    }
    if (file.size > 512 * 1024) {
      showError(t("settings.profile.avatarError"));
      return;
    }

    setUploading(true);
    try {
      await uploadAvatarMutation.mutateAsync(file);
      showSuccess(t("settings.profile.avatarUploaded"));
    } catch {
      showError(t("settings.profile.avatarError"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRemoveAvatar = async () => {
    setShowRemoveConfirm(false);
    try {
      await removeAvatarMutation.mutateAsync();
      showSuccess(t("settings.profile.avatarRemoved"));
    } catch {
      showError(t("settings.profile.avatarError"));
    }
  };

  const displayName = user?.firstName || user?.username || "";

  return (
    <div className="w-full">
      {/* Avatar */}
      <div className="flex items-center gap-4 mb-4">
        <div className="relative">
          <Button
            variant="ghost"
            onClick={() => fileInputRef.current?.click()}
            className="w-16 h-16 rounded-full overflow-hidden cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary p-0"
            aria-label={t("settings.profile.avatarUpload")}
            disabled={uploading}
          >
            <Avatar className="w-16 h-16">
              <AvatarImage
                src={user?.avatar || undefined}
                alt="Avatar"
                className="object-cover"
              />
              <AvatarFallback className="bg-primary text-white text-lg font-medium">
                {getInitials(user ?? null)}
              </AvatarFallback>
            </Avatar>
            {uploading && (
              <div className="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center">
                <div className="animate-spin h-5 w-5 border-2 border-white border-t-transparent rounded-full" />
              </div>
            )}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleAvatarUpload}
            className="hidden"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="text-xs text-muted-foreground">{user?.email}</span>
          <div className="flex flex-col sm:flex-row gap-1.5 mt-1">
            <Button
              variant="link"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="justify-start"
            >
              {t("settings.profile.avatarUpload")}
            </Button>
            {user?.avatar && !showRemoveConfirm && (
              <Button
                variant="link"
                size="sm"
                onClick={() => setShowRemoveConfirm(true)}
                className="text-destructive justify-start"
              >
                {t("settings.profile.avatarRemove")}
              </Button>
            )}
          </div>
          {showRemoveConfirm && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                {t("settings.profile.avatarRemoveConfirm")}
              </span>
              <Button
                variant="link"
                size="sm"
                onClick={handleRemoveAvatar}
                className="text-destructive font-medium"
              >
                {t("common.delete")}
              </Button>
              <Button
                variant="link"
                size="sm"
                onClick={() => setShowRemoveConfirm(false)}
                className="text-muted-foreground"
              >
                {t("common.cancel")}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Form fields */}
      <Form {...profileForm}>
        <form
          onSubmit={profileForm.handleSubmit(handleSaveProfile)}
          className="space-y-3"
        >
          <FormField
            control={profileForm.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("settings.profile.firstName")}</FormLabel>
                <FormControl>
                  <Input type="text" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={profileForm.control}
            name="lastName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("settings.profile.lastName")}</FormLabel>
                <FormControl>
                  <Input type="text" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="space-y-2">
            <label className="text-sm font-medium leading-none text-foreground">
              {t("settings.profile.email")}
            </label>
            <Input type="email" value={user?.email || ""} disabled />
          </div>

          {profileError && (
            <p className="text-sm text-destructive mt-2">{profileError}</p>
          )}

          <div className="mt-4">
            <Button
              type="submit"
              disabled={saving || !isProfileDirty}
              size="sm"
            >
              {saving ? t("common.saving") : t("settings.profile.save")}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}

/** Profilo · Istruzioni personalizzate — textarea custom instructions. */
export function SettingsProfileInstructions() {
  const { t } = useTranslation();
  const { data: user } = useMe();
  const updateProfileMutation = useUpdateProfile();

  const [customInstructions, setCustomInstructions] = useState(user?.customInstructions || "");
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setCustomInstructions(user.customInstructions || "");
    }
  }, [user?.customInstructions]);

  const isInstructionsDirty =
    customInstructions !== (user?.customInstructions || "");

  const handleSaveInstructions = async () => {
    setSavingInstructions(true);
    setInstructionsError(null);
    try {
      await updateProfileMutation.mutateAsync({ customInstructions });
      showSuccess(t("settings.profile.instructionsSaved"));
    } catch (err: unknown) {
      const msg = getErrorMessage(err, t("settings.profile.profileError"));
      setInstructionsError(msg);
      showError(msg);
    } finally {
      setSavingInstructions(false);
    }
  };

  const charCount = customInstructions.length;
  const charCounterColor =
    charCount >= 4000
      ? "text-red-500"
      : charCount > 3500
        ? "text-amber-500"
        : "text-muted-foreground";

  return (
    <div className="w-full">
      <p className="text-sm text-muted-foreground mb-3">
        {t("settings.profile.customInstructionsDesc")}
      </p>
      <Textarea
        value={customInstructions}
        onChange={(e) => setCustomInstructions(e.target.value)}
        maxLength={4000}
        aria-label={t("settings.profile.customInstructions")}
        aria-describedby="char-counter"
        placeholder={t("settings.profile.customInstructionsPlaceholder")}
        className="min-h-[200px] resize-y"
      />
      <div className="flex items-center justify-between mt-1">
        <span id="char-counter" className={`text-xs ${charCounterColor}`}>
          {t("settings.profile.characterCount", { count: charCount })}
        </span>
      </div>

      {instructionsError && (
        <p className="text-sm text-destructive mt-2">{instructionsError}</p>
      )}

      <div className="mt-3">
        <Button
          onClick={handleSaveInstructions}
          disabled={savingInstructions || !isInstructionsDirty}
          size="sm"
        >
          {savingInstructions
            ? t("common.saving")
            : t("settings.profile.saveInstructions")}
        </Button>
      </div>
    </div>
  );
}

/** Avanzate · Dati chat — export/import delle chat del workspace corrente. */
export function SettingsProfileChatData() {
  const { t } = useTranslation();
  const { currentWorkspaceId } = useChatNav();
  const [exporting, setExporting] = useState(false);
  const [importPreview, setImportPreview] = useState<ChatImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleExportChats = async () => {
    if (!currentWorkspaceId) return;
    setExporting(true);
    try {
      const token = localStorage.getItem("token");
      const response = await fetch(`/api/workspaces/${currentWorkspaceId}/chats/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const contentDisposition = response.headers.get("Content-Disposition");
      const filename = contentDisposition
        ? contentDisposition.split("filename=")[1]?.replace(/"/g, "") || "chats-export.json"
        : "chats-export.json";
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      showError(t("settings.profile.exportError"));
    } finally {
      setExporting(false);
    }
  };

  const handleImportPreview = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentWorkspaceId) return;
    setSelectedImportFile(file);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const preview = await apiUpload<ChatImportPreview>(
        `/workspaces/${currentWorkspaceId}/chats/import/preview`,
        formData
      );
      setImportPreview(preview);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.profile.importError")));
      setImportPreview(null);
      setSelectedImportFile(null);
    }
    if (importFileRef.current) importFileRef.current.value = "";
  };

  const handleImportConfirm = async () => {
    if (!selectedImportFile || !currentWorkspaceId || !importPreview) return;
    setImporting(true);
    const confirmFormData = new FormData();
    confirmFormData.append("file", selectedImportFile);
    confirmFormData.append("format", importPreview.format);
    try {
      const result = await apiUpload<{ imported: number; skipped: number }>(
        `/workspaces/${currentWorkspaceId}/chats/import/confirm`,
        confirmFormData
      );
      showSuccess(t("settings.profile.importSuccess", { imported: result.imported, skipped: result.skipped }));
      setImportPreview(null);
      setSelectedImportFile(null);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.profile.importError")));
    } finally {
      setImporting(false);
    }
  };

  const handleImportCancel = () => {
    setImportPreview(null);
    setSelectedImportFile(null);
  };

  return (
    <div className="w-full">
      <p className="text-sm text-muted-foreground mb-4">
        {t("settings.profile.exportDesc")}
      </p>

      <div className="flex flex-col gap-4">
        {/* Export */}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportChats}
            disabled={exporting || !currentWorkspaceId}
          >
            {exporting && (
              <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
            )}
            {exporting
              ? t("common.saving")
              : t("settings.profile.exportChats")}
          </Button>
        </div>

        {/* Import */}
        <div>
          <input
            ref={importFileRef}
            type="file"
            accept=".json"
            onChange={handleImportPreview}
            className="hidden"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => importFileRef.current?.click()}
            disabled={!currentWorkspaceId}
          >
            {t("settings.profile.importChats")}
          </Button>
          <p className="text-xs text-muted-foreground mt-1">
            {t("settings.profile.importDesc")}
          </p>
        </div>

        {/* Import Preview Dialog */}
        <Dialog
          open={!!importPreview}
          onOpenChange={(open) => {
            if (!open) handleImportCancel();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("settings.profile.importPreview")}</DialogTitle>
            </DialogHeader>
            {importPreview && (
              <>
                <div className="space-y-2">
                  <Badge variant="outline" className="text-xs">
                    {t("settings.profile.importFormat", {
                      format: importPreview.format,
                    })}
                  </Badge>
                  <p className="text-sm text-foreground">
                    {t("settings.profile.importChatCount", {
                      count: importPreview.chats.length,
                      messages: importPreview.chats.reduce(
                        (sum, c) => sum + c.messageCount,
                        0,
                      ),
                    })}
                  </p>
                  {importPreview.warnings.map((w, i) => (
                    <p key={i} className="text-xs text-amber-500">
                      {w.type === "attachments_skipped"
                        ? t("settings.profile.importWarning", {
                            count: w.count,
                          })
                        : t("settings.profile.importInvalidWarning", {
                            count: w.count,
                          })}
                    </p>
                  ))}
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleImportCancel}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleImportConfirm}
                    disabled={importing}
                    autoFocus
                  >
                    {importing && (
                      <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    )}
                    {importing
                      ? t("common.saving")
                      : t("settings.profile.importConfirm", {
                          count: importPreview.chats.length,
                        })}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

export { getInitials };
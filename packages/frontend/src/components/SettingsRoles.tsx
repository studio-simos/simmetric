// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiPut, apiDelete } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import { MENU_SECTIONS, SETTINGS_TAB_PERMISSIONS } from "@simmetric-chat/shared";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { getErrorMessage } from "../utils/errorUtils";

interface RoleWithSections {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  permissions: string[];
  menuSections: string[];
}

const PERMISSION_CATEGORIES: Record<string, { labelKey: string; perms: string[] }> = {
  Workspace: { labelKey: "settings.roles.permCatWorkspace", perms: ["workspace:read", "workspace:write", "workspace:delete", "workspace:create"] },
  Project: { labelKey: "settings.roles.permCatProject", perms: ["project:read", "project:write", "project:delete", "project:create"] },
  Chat: { labelKey: "settings.roles.permCatChat", perms: ["chat:read", "chat:write", "chat:delete"] },
  Document: { labelKey: "settings.roles.permCatDocument", perms: ["document:read", "document:write", "document:delete"] },
  // Phase 70 D-09: "Archivi" category added so an admin can grant archive:write
  // to non-admins via the UI — required by the KB assign route (D-05 always-both
  // on document:write + archive:write). Without this category the unified
  // upload area's KB leg is unreachable for non-admin users.
  Archive: { labelKey: "settings.roles.permCatArchive", perms: ["archive:read", "archive:write", "archive:delete"] },
  Admin: { labelKey: "settings.roles.permCatAdmin", perms: ["admin:users", "admin:settings", "admin:roles"] },
};

// Phase 206 (VIS-01, D-16): per-role settings/menu section visibility entries
// served by GET /api/roles/:roleId/visibility (override|default tagged).
interface RoleVisibilityEntryLocal {
  sectionKey: string;
  visible: boolean;
  source: "override" | "default";
}

interface RoleWithSections {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  permissions: string[];
  menuSections: string[];
}

interface RoleFormValues {
  name: string;
  description: string;
}

export default function SettingsRoles() {
  const { t } = useTranslation();
  const [roles, setRoles] = useState<RoleWithSections[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingRole, setEditingRole] = useState<RoleWithSections | null>(null);
  const [creating, setCreating] = useState(false);
  const [roleToDelete, setRoleToDelete] = useState<string | null>(null);

  // Edit form state
  const [editPermissions, setEditPermissions] = useState<Set<string>>(new Set());
  const [editMenuSections, setEditMenuSections] = useState<Set<string>>(new Set());

  // Phase 206 (VIS-01, D-16): visibility editor state (dedicated dialog).
  const [visibilityRole, setVisibilityRole] = useState<RoleWithSections | null>(null);
  const [visibilityEntries, setVisibilityEntries] = useState<RoleVisibilityEntryLocal[]>([]);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilityLoading, setVisibilityLoading] = useState(false);

  const openVisibility = async (role: RoleWithSections) => {
    setVisibilityRole(role);
    setVisibilityLoading(true);
    try {
      const data = await apiGet<{ sections: RoleVisibilityEntryLocal[] }>(`/roles/${role.id}/visibility`);
      setVisibilityEntries(data.sections);
    } catch (err: unknown) {
      showError(t("settings.roles.visibility.loadFailed") + ": " + getErrorMessage(err));
      setVisibilityRole(null);
    } finally {
      setVisibilityLoading(false);
    }
  };

  const toggleVisibility = (sectionKey: string) => {
    setVisibilityEntries((prev) =>
      prev.map((entry) =>
        entry.sectionKey === sectionKey ? { ...entry, visible: !entry.visible, source: "override" as const } : entry,
      ),
    );
  };

  const saveVisibility = async () => {
    if (!visibilityRole) return;
    setVisibilitySaving(true);
    try {
      await apiPut(`/roles/${visibilityRole.id}/visibility`, {
        sections: visibilityEntries.map(({ sectionKey, visible }) => ({ sectionKey, visible })),
      });
      showSuccess(t("settings.roles.visibility.saved"));
      setVisibilityRole(null);
    } catch (err: unknown) {
      showError(t("settings.roles.visibility.saveFailed") + ": " + getErrorMessage(err));
    } finally {
      setVisibilitySaving(false);
    }
  };

  const createForm = useForm<RoleFormValues>({
    defaultValues: { name: "", description: "" },
  });

  const editForm = useForm<RoleFormValues>({
    defaultValues: { name: "", description: "" },
  });

  const loadRoles = async () => {
    try {
      const data = await apiGet<RoleWithSections[]>("/roles");
      setRoles(data);
    } catch (err: unknown) {
      showError(t("settings.roles.loadFailed") + ": " + getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRoles();
  }, []);

  // Phase 70 D-10 / SC-3: fetch the single role fresh from the DB (not the
  // in-memory list snapshot) so the edit form sees the effective DB state.
  // The list (`loadRoles`) is still used for the summary grid; this fetch is
  // only triggered when the admin clicks "Edit".
  const startEdit = async (role: RoleWithSections) => {
    try {
      const fresh = await apiGet<RoleWithSections>(`/roles/${role.id}`);
      setEditingRole(fresh);
      editForm.reset({
        name: fresh.name,
        description: fresh.description || "",
      });
      setEditPermissions(new Set(fresh.permissions));
      setEditMenuSections(new Set(fresh.menuSections));
    } catch (err: unknown) {
      // Fall back to the in-memory snapshot if the single-role fetch fails
      // (e.g. transient network error) so the admin can still edit. Toast
      // informs the admin that the DB version could not be loaded.
      showError(getErrorMessage(err, t("settings.roles.fetchFailed")));
      setEditingRole(role);
      editForm.reset({
        name: role.name,
        description: role.description || "",
      });
      setEditPermissions(new Set(role.permissions));
      setEditMenuSections(new Set(role.menuSections));
    }
  };

  const cancelEdit = () => {
    setEditingRole(null);
    setCreating(false);
    createForm.reset({ name: "", description: "" });
  };

  const togglePermission = (perm: string) => {
    setEditPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  };

  const toggleMenuSection = (section: string) => {
    setEditMenuSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const handleCreate = async (data: RoleFormValues) => {
    if (!data.name.trim()) {
      showError(t("settings.roles.nameRequired"));
      return;
    }
    try {
      await apiPost("/roles", {
        name: data.name.trim(),
        description: data.description.trim() || null,
        permissionNames: [] as string[],
      });
      showSuccess(t("settings.roles.createSuccess"));
      createForm.reset({ name: "", description: "" });
      setCreating(false);
      await loadRoles();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.roles.createFailed")));
    }
  };

  const handleSave = async (data: RoleFormValues) => {
    if (!editingRole) return;
    try {
      // Update role name/description
      await apiPut(`/roles/${editingRole.id}`, {
        name: data.name.trim(),
        description: data.description.trim() || null,
        permissionNames: [...editPermissions],
      });
      // Update menu sections
      await apiPut(`/roles/${editingRole.id}/menu-sections`, {
        menuSections: [...editMenuSections],
      });
      showSuccess(t("settings.roles.updateSuccess"));
      setEditingRole(null);
      await loadRoles();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.roles.updateFailed")));
    }
  };

  const handleDelete = async () => {
    if (!roleToDelete) return;
    try {
      await apiDelete(`/roles/${roleToDelete}`);
      showSuccess(t("settings.roles.deleteSuccess"));
      if (editingRole?.id === roleToDelete) setEditingRole(null);
      setRoleToDelete(null);
      await loadRoles();
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.roles.deleteFailed")));
    }
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm">{t("settings.roles.loading")}</div>;
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">{t("settings.roles.title")}</h3>
        {!creating && !editingRole && (
          <Button
            size="sm"
            onClick={() => setCreating(true)}
          >
            {t("settings.roles.createRoleButton")}
          </Button>
        )}
      </div>

      {/* Create form */}
      <Dialog open={creating} onOpenChange={(open) => { if (!open) cancelEdit(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.roles.createFormTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.roles.createDescription", { defaultValue: "Enter a name and description for the new role." })}
            </DialogDescription>
          </DialogHeader>
          <Form {...createForm}>
            <form onSubmit={createForm.handleSubmit(handleCreate)} className="space-y-4">
              <div className="flex gap-3">
                <FormField
                  control={createForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>{t("settings.roles.nameLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder={t("settings.roles.namePlaceholder")}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={createForm.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem className="flex-[2]">
                      <FormLabel>{t("settings.roles.descriptionLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          placeholder={t("settings.roles.descriptionPlaceholder")}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <DialogFooter>
                <Button size="sm" type="submit">{t("settings.roles.createButton")}</Button>
                <DialogClose asChild>
                  <Button variant="ghost" size="sm" type="button" onClick={cancelEdit}>{t("common.cancel")}</Button>
                </DialogClose>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Edit form */}
      <Dialog open={!!editingRole} onOpenChange={(open) => { if (!open) cancelEdit(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.roles.editingTitle", { name: editingRole?.name || "" })}</DialogTitle>
            <DialogDescription>
              {t("settings.roles.editDescription", { defaultValue: "Modify the role details, permissions, and menu sections." })}
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleSave)} className="space-y-5">
              <div className="flex gap-3">
                <FormField
                  control={editForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>{t("settings.roles.nameLabel")}</FormLabel>
                      <FormControl>
                        <Input
                          type="text"
                          disabled={editingRole?.isDefault}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem className="flex-[2]">
                      <FormLabel>{t("settings.roles.descriptionLabel")}</FormLabel>
                      <FormControl>
                        <Input type="text" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Permissions */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-2">{t("settings.roles.permissionsLabel")}</label>
                <div className="space-y-3">
                  {Object.entries(PERMISSION_CATEGORIES).map(([cat, { labelKey, perms }]) => (
                    <div key={cat}>
                      <p className="text-xs font-semibold text-foreground mb-1">{t(labelKey)}</p>
                      <div className="flex flex-wrap gap-2">
                        {perms.map((perm) => (
                          <label key={perm} className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                            <Checkbox
                              checked={editPermissions.has(perm)}
                              onCheckedChange={() => togglePermission(perm)}
                            />
                            {perm.split(":")[1]}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Menu Sections */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-2">{t("settings.roles.menuSectionsLabel")}</label>
                <div className="flex flex-wrap gap-3">
                  {MENU_SECTIONS.map((section) => (
                    <label key={section} className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                      <Checkbox
                        checked={editMenuSections.has(section)}
                        onCheckedChange={() => toggleMenuSection(section)}
                      />
                      {section}
                    </label>
                  ))}
                </div>
              </div>

              <DialogFooter>
                <Button size="sm" type="submit">{t("common.save")}</Button>
                <DialogClose asChild>
                  <Button variant="ghost" size="sm" type="button" onClick={cancelEdit}>{t("common.cancel")}</Button>
                </DialogClose>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Phase 206 (VIS-01, D-16): per-role visibility dialog — menu + settings
          sections with server-resolved values (override wins; absent rows fall
          back to the permission-OR default). */}
      <Dialog open={!!visibilityRole} onOpenChange={(open) => !open && setVisibilityRole(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("settings.roles.visibility.title")} — {visibilityRole?.name}</DialogTitle>
            <DialogDescription>{t("settings.roles.visibility.description")}</DialogDescription>
          </DialogHeader>
          {visibilityLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2">{t("settings.roles.visibility.menuSections")}</p>
                <div className="space-y-2">
                  {visibilityEntries
                    .filter((e) => (MENU_SECTIONS as readonly string[]).includes(e.sectionKey))
                    .map((entry) => (
                      <div key={entry.sectionKey} className="flex items-center justify-between">
                        <span className="text-sm">{entry.sectionKey}</span>
                        <Switch
                          checked={entry.visible}
                          onCheckedChange={() => toggleVisibility(entry.sectionKey)}
                          aria-label={`${entry.sectionKey}: ${entry.visible}`}
                        />
                      </div>
                    ))}
                </div>
              </div>
              <div className="space-y-4">
                <p className="text-xs font-semibold text-muted-foreground mb-2">{t("settings.roles.visibility.settingsSections")}</p>
                <div className="space-y-2">
                  {Object.keys(SETTINGS_TAB_PERMISSIONS).map((key) => {
                    const entry = visibilityEntries.find((e) => e.sectionKey === key);
                    const visible = entry?.visible ?? true;
                    return (
                      <div key={key} className="flex items-center justify-between">
                        <span className="text-sm">
                          {key}
                          {entry?.source === "override" && (
                            <Badge variant="outline" className="ml-2 text-[10px]">{t("settings.roles.visibility.override")}</Badge>
                          )}
                        </span>
                        <Switch
                          checked={visible}
                          onCheckedChange={() => toggleVisibility(key)}
                          aria-label={`${key}: ${visible}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" onClick={() => setVisibilityRole(null)}>{t("common.cancel")}</Button>
            </DialogClose>
            <Button size="sm" disabled={visibilitySaving} onClick={saveVisibility}>
              {t("common.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Roles list */}
      <div className="space-y-3">
        {roles.map((role) => (
          <div
            key={role.id}
            className="bg-card rounded-lg border border-border p-4"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-2 gap-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{role.name}</span>
                {role.isDefault && (
                  <Badge variant="outline" className="text-[14px]">{t("settings.roles.defaultBadge")}</Badge>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => startEdit(role)}
                >
                  {t("common.edit")}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => openVisibility(role)}
                >
                  {t("settings.roles.visibility.title")}
                </Button>
                {!role.isDefault && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setRoleToDelete(role.id)}
                    className="text-destructive"
                  >
                    {t("common.delete")}
                  </Button>
                )}
              </div>
            </div>
            {role.description && (
              <p className="text-xs text-muted-foreground mb-2">{t(`roles.${role.name}.description`, role.description)}</p>
            )}
            <div className="flex flex-wrap gap-1 mb-2">
              {role.permissions.map((p) => (
                <Badge key={p} variant="outline" className="text-[14px]">
                  {p}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {role.menuSections.map((s) => (
                <Badge key={s} variant="secondary" className="text-[14px]">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={!!roleToDelete} onOpenChange={(open) => !open && setRoleToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.roles.confirmDelete")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRoleToDelete(null)}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

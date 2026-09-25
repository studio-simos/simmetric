// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 206 (AGENCY-01/02, Plan 05 Task 2): agency team-management surface.
// Mirrors SettingsUsers table idioms; ALL option lists are SERVER-DERIVED
// (D-10 — the client never computes the lattice). Temp passwords display
// EXACTLY ONCE (D-06, UI-SPEC prohibition 2); 404 → empty-state (UI-1/UI-6).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAgencyUsers,
  useAgencyCeiling,
  useDelegatablePermissions,
  useCreateSubUser,
  useDisableSubUser,
  useEnableSubUser,
  useResetSubUserPassword,
  useUpdateSubUserPermissions,
  type AgencySubUser,
} from "../queries/useAgencyUsers";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function SettingsAgencyUsers() {
  const { t } = useTranslation();
  const { data } = useAgencyUsers();
  const { data: ceiling } = useAgencyCeiling();
  const { data: delegatable } = useDelegatablePermissions();

  const createMutation = useCreateSubUser();
  const disableMutation = useDisableSubUser();
  const enableMutation = useEnableSubUser();
  const resetMutation = useResetSubUserPassword();
  const permissionsMutation = useUpdateSubUserPermissions();

  const [createOpen, setCreateOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Temp password displayed EXACTLY ONCE (prohibition 2 — cleared on close).
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [confirmDisableId, setConfirmDisableId] = useState<string | null>(null);
  // Phase 206 (owner UAT): the destructive reset needs an explicit confirm
  // BEFORE the mutation — the temp-password-once dialog is not a confirm.
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null);
  const [permissionsUserId, setPermissionsUserId] = useState<string | null>(null);
  const [pickedPermissions, setPickedPermissions] = useState<Set<string>>(new Set());

  const users = data?.users ?? [];

  const handleCreate = async () => {
    try {
      const created = await createMutation.mutateAsync({ username, email, password: password || undefined });
      showSuccess(t("settings.agency.created"));
      if (created.generatedPassword) {
        // D-06: agency-relayed temp password, shown once.
        setTempPassword(created.generatedPassword);
      } else {
        setCreateOpen(false);
      }
      setUsername("");
      setEmail("");
      setPassword("");
    } catch (err: unknown) {
      showError(t("settings.agency.createFailed") + ": " + getErrorMessage(err));
    }
  };

  // Owner UAT: the picker PRE-SELECTS the user's current grants — the write
  // is full-replace, so reopening with an empty set would wipe them on save.
  const openPermissions = (user: AgencySubUser) => {
    setPickedPermissions(new Set(user.permissions));
    setPermissionsUserId(user.id);
  };

  const handleReset = async (id: string) => {
    try {
      const result = await resetMutation.mutateAsync(id);
      setTempPassword(result.tempPassword);
    } catch (err: unknown) {
      showError(t("settings.agency.resetFailed") + ": " + getErrorMessage(err));
    }
  };

  const handlePermissionsSave = async () => {
    if (!permissionsUserId) return;
    try {
      await permissionsMutation.mutateAsync({ id: permissionsUserId, permissions: [...pickedPermissions] });
      showSuccess(t("settings.agency.permissionsSaved"));
      setPickedPermissions(new Set());
      setPermissionsUserId(null);
    } catch (err: unknown) {
      showError(t("settings.agency.permissionsSaveFailed") + ": " + getErrorMessage(err));
    }
  };

  return (
    <div className="space-y-4 p-4 pt-6 pr-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t("settings.agency.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("settings.agency.subtitle")}</p>
        </div>
        {ceiling && (
          <Badge variant="outline" className="text-xs">
            {t("settings.agency.ceilingLabel", {
              active: ceiling.active,
              max: ceiling.maxSponsoredUsers,
            })}
          </Badge>
        )}
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          {t("settings.agency.createButton")}
        </Button>
      </div>

      {users.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">{t("settings.agency.empty")}</p>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <div key={user.id} className="bg-card rounded-lg border border-border p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{user.username}</span>
                  {user.disabledAt ? (
                    <Badge variant="outline" className="text-[10px]">{t("settings.agency.disabledBadge")}</Badge>
                  ) : user.mustChangePassword ? (
                    <Badge variant="outline" className="text-[10px]">{t("settings.agency.pendingBadge")}</Badge>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  {user.disabledAt ? (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => enableMutation.mutate(user.id)}
                    >
                      {t("settings.agency.enable")}
                    </Button>
                  ) : (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setConfirmDisableId(user.id)}
                    >
                      {t("settings.agency.disable")}
                    </Button>
                  )}
                  <Button variant="link" size="sm" onClick={() => setConfirmResetId(user.id)}>
                    {t("settings.agency.resetPassword")}
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => openPermissions(user)}
                  >
                    {t("settings.agency.permissionsButton")}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{user.email}</p>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.agency.createTitle")}</DialogTitle>
            <DialogDescription>{t("settings.agency.createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t("settings.agency.usernameLabel")}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              type="email"
              placeholder={t("settings.agency.emailLabel")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>{t("common.cancel")}</Button>
            </DialogClose>
            <Button size="sm" disabled={createMutation.isPending || !username || !email} onClick={handleCreate}>
              {t("common.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Temp password — once-only display (UI-SPEC prohibition 2) */}
      <Dialog open={!!tempPassword} onOpenChange={(open) => !open && setTempPassword(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.agency.tempPasswordTitle")}</DialogTitle>
            <DialogDescription>{t("settings.agency.tempPasswordHint")}</DialogDescription>
          </DialogHeader>
          <p className="font-mono text-sm bg-muted rounded px-3 py-2 select-all">{tempPassword}</p>
          <div className="flex justify-end">
            <DialogClose asChild>
              <Button size="sm" onClick={() => setTempPassword(null)}>{t("common.close")}</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reset confirm (owner UAT): the temp password shows only AFTER the
          explicit confirmation — never as a side effect of a stray click. */}
      <AlertDialog
        open={!!confirmResetId}
        onOpenChange={(open) => !open && setConfirmResetId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.agency.resetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.agency.resetDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmResetId(null)}>{t("common.cancel")}</Button>
            <AlertDialogAction
              onClick={() => {
                if (confirmResetId) handleReset(confirmResetId);
                setConfirmResetId(null);
              }}
            >
              {t("settings.agency.resetConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Disable confirm */}
      <AlertDialog
        open={!!confirmDisableId}
        onOpenChange={(open) => !open && setConfirmDisableId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.agency.disableTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.agency.disableDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDisableId(null)}>{t("common.cancel")}</Button>
            <AlertDialogAction
              onClick={() => {
                if (confirmDisableId) disableMutation.mutate(confirmDisableId);
                setConfirmDisableId(null);
              }}
            >
              {t("settings.agency.disableConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Permissions picker — options are SERVER-DERIVED (D-10) */}
      <Dialog
        open={!!permissionsUserId}
        onOpenChange={(open) => !open && setPermissionsUserId(null)}
      >
        <DialogContent className="max-w-md max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("settings.agency.permissionsTitle")}</DialogTitle>
            <DialogDescription>{t("settings.agency.permissionsDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {(delegatable?.permissions ?? []).map((perm) => (
              <div key={perm} className="flex items-center gap-2">
                <Checkbox
                  id={`perm-${perm}`}
                  checked={pickedPermissions.has(perm)}
                  onCheckedChange={() => {
                    setPickedPermissions((prev) => {
                      const next = new Set(prev);
                      if (next.has(perm)) next.delete(perm);
                      else next.add(perm);
                      return next;
                    });
                  }}
                />
                <label htmlFor={`perm-${perm}`} className="text-sm font-mono">{perm}</label>
              </div>
            ))}
            {(delegatable?.permissions ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">{t("settings.agency.noDelegatable")}</p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" onClick={() => setPermissionsUserId(null)}>{t("common.cancel")}</Button>
            </DialogClose>
            <Button
              size="sm"
              disabled={permissionsMutation.isPending || !permissionsUserId}
              onClick={handlePermissionsSave}
            >
              {t("common.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
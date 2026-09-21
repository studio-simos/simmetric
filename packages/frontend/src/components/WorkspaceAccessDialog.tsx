// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { UserPlus, Users, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { apiGet } from "../utils/api";
import {
  useWorkspaceAccess,
  useGrantWorkspaceAccess,
  useRevokeWorkspaceAccess,
  useBulkGrantWorkspaceAccess,
} from "../queries/useWorkspaces";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface AccessUser {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

// Phase 189 (D-20): the role Select lives beside the user Select — the
// grant body widens to {userId, role} (Plan-02-upgraded endpoint).
const ROLES = ["owner", "editor", "viewer"] as const;

interface WorkspaceAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
}

export function displayName(u: { username: string; firstName: string | null; lastName: string | null }): string {
  const name = `${u.firstName || ""} ${u.lastName || ""}`.trim();
  return name || u.username;
}

export default function WorkspaceAccessDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
}: WorkspaceAccessDialogProps) {
  const { t } = useTranslation();
  const { data: grants = [], isLoading } = useWorkspaceAccess(open ? workspaceId : null);
  const grantMut = useGrantWorkspaceAccess(workspaceId);
  const revokeMut = useRevokeWorkspaceAccess(workspaceId);
  // Phase 189 (D-20): bulk multi-select grant via the D-17 endpoint.
  const bulkMut = useBulkGrantWorkspaceAccess(workspaceId);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  // Phase 189 (D-20): role for the single grant (owner/editor/viewer).
  const [selectedRole, setSelectedRole] = useState<string>("viewer");
  const [bulkUserIds, setBulkUserIds] = useState<string[]>([]);
  const [bulkRole, setBulkRole] = useState<string>("viewer");
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [usersLoaded, setUsersLoaded] = useState(false);
  // 189-REVIEW WR-05: a failed /auth/users fetch no longer renders as an
  // empty grantable list — the dialog shows a load-error row with a retry.
  const [usersLoadError, setUsersLoadError] = useState(false);

  const loadUsers = async () => {
    setLoadingUsers(true);
    setUsersLoadError(false);
    try {
      const data = await apiGet<AccessUser[]>("/auth/users");
      setUsers(data);
      setUsersLoaded(true);
    } catch {
      setUsers([]);
      setUsersLoadError(true);
    } finally {
      setLoadingUsers(false);
    }
  };

  // Phase 189 (D-20): loadUsers once when the dialog OPENS — the
  // pre-existing handleOpenChange-only path misses a first mount that
  // already renders with open=true (the dialog is conditionally mounted by
  // every caller, so mount-with-open is the normal case). The guard's
  // `usersLoaded` flag makes a repeat fire a no-op (idempotent by state).
  useEffect(() => {
    if (open && !usersLoaded) {
      void loadUsers();
    }
  }, [open, usersLoaded]);

  const grantableUsers = useMemo(() => {
    const granted = new Set(grants.map((g) => g.userId));
    return users.filter((u) => !granted.has(u.id));
  }, [users, grants]);

  const handleGrant = async () => {
    if (!selectedUserId) return;
    try {
      // D-20: the grant body now carries the selected role.
      await grantMut.mutateAsync({ userId: selectedUserId, role: selectedRole });
      showSuccess(t("workspace.access.granted"));
      setSelectedUserId("");
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("workspace.access.grantError")));
    }
  };

  const handleRevoke = async (userId: string) => {
    try {
      await revokeMut.mutateAsync(userId);
      showSuccess(t("workspace.access.revoked"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("workspace.access.revokeError")));
    }
  };

  // Phase 189 (D-20): bulk multi-select grant — the D-17 endpoint returns
  // { granted, failed[] }; a partial failure lists the failed usernames.
  const handleBulkGrant = async () => {
    if (bulkUserIds.length === 0) return;
    try {
      const result = await bulkMut.mutateAsync({ userIds: bulkUserIds, role: bulkRole });
      if (result.failed.length === 0) {
        showSuccess(t("workspace.access.granted"));
      } else {
        const failedNames = result.failed
          .map((f) => users.find((u) => u.id === f.userId)?.username ?? f.userId)
          .join(", ");
        showError(t("settings.workspaceAccess.bulkPartial", { failed: failedNames }));
      }
      setBulkUserIds([]);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("workspace.access.grantError")));
    }
  };

  const toggleBulkUser = (userId: string) => {
    setBulkUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const handleOpenChange = (next: boolean) => {
    if (next && !usersLoaded) {
      void loadUsers();
    }
    if (!next) {
      setSelectedUserId("");
      setBulkUserIds([]);
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("workspace.access.title", { name: workspaceName })}</DialogTitle>
          <DialogDescription>{t("workspace.access.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 189-REVIEW WR-05: user-list load failure surfaced (never an
              empty grantable list) + retry. */}
          {usersLoadError && (
            <div
              data-testid="workspace-access-users-load-error"
              className="px-4 py-3 rounded-lg flex items-center justify-between bg-destructive text-destructive-foreground"
            >
              <span className="text-sm">{t("workspace.access.usersLoadError")}</span>
              <Button variant="outline" size="sm" onClick={() => void loadUsers()} className="ml-4">
                {t("workspace.access.retryUsers")}
              </Button>
            </div>
          )}

          {/* Grant form: user Select + role Select (D-20) */}
          <div className="flex items-center gap-2">
            <Select
              value={selectedUserId}
              onValueChange={setSelectedUserId}
              disabled={loadingUsers}
              aria-label={t("workspace.access.selectUser")}
            >
              <SelectTrigger className="flex-1 border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                <SelectValue
                  placeholder={loadingUsers ? t("common.loading") : t("workspace.access.selectUser")}
                />
              </SelectTrigger>
              <SelectContent>
                {grantableUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {displayName(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={selectedRole}
              onValueChange={setSelectedRole}
              aria-label={t("workspace.access.role")}
            >
              <SelectTrigger className="w-36 border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                <SelectValue placeholder={t("workspace.access.role")} />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`workspace.access.role${r.charAt(0).toUpperCase()}${r.slice(1)}`, r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleGrant}
              disabled={!selectedUserId || grantMut.isPending}
              aria-label={t("workspace.access.grantButton")}
            >
              <UserPlus className="w-4 h-4 mr-1" />
              {t("workspace.access.grantButton")}
            </Button>
          </div>

          {/* Bulk multi-select grant (D-20 — D-17 endpoint via
              useBulkGrantWorkspaceAccess; partial failure lists names). */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("settings.workspaceAccess.grantBulk")}</p>
            <div className="max-h-32 overflow-y-auto space-y-1 border border-input rounded p-2">
              {grantableUsers.map((u) => (
                <label key={u.id} className="flex items-center gap-2 cursor-pointer text-sm">
                  <Checkbox
                    checked={bulkUserIds.includes(u.id)}
                    onCheckedChange={() => toggleBulkUser(u.id)}
                  />
                  <span>{displayName(u)}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Select value={bulkRole} onValueChange={setBulkRole} aria-label={t("workspace.access.role")}>
                <SelectTrigger className="w-36 border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                  <SelectValue placeholder={t("workspace.access.role")} />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`workspace.access.role${r.charAt(0).toUpperCase()}${r.slice(1)}`, r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={handleBulkGrant}
                disabled={bulkUserIds.length === 0 || bulkMut.isPending}
                aria-label={t("settings.workspaceAccess.grantBulk")}
              >
                <Users className="w-4 h-4 mr-1" />
                {t("settings.workspaceAccess.grantBulk")}
              </Button>
            </div>
          </div>

          {/* Current grants */}
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("workspace.access.empty")}</p>
          ) : (
            <ul className="space-y-2" aria-label={t("workspace.access.listLabel")}>
              {grants.map((grant) => (
                <li
                  key={grant.userId}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-input bg-card"
                >
                  <div className="min-w-0">
                    <span className="text-sm text-foreground truncate block">
                      {grant.user ? displayName(grant.user) : grant.userId}
                    </span>
                    {grant.user?.email && (
                      <span className="text-xs text-muted-foreground truncate block">
                        {grant.user.email}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {grant.role && (
                      <Badge variant="outline" className="text-xs">
                        {t(`workspace.access.role${grant.role.charAt(0).toUpperCase()}${grant.role.slice(1)}`, grant.role)}
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {new Date(grant.grantedAt).toLocaleDateString()}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(grant.userId)}
                      disabled={revokeMut.isPending}
                      aria-label={t("workspace.access.revoke")}
                      className="text-destructive hover:text-destructive"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 189 (WSIS-03, D-19) — admin workspace-access panel.
 *
 * PER-WORKSPACE view (admin thinks "grant workspace W to these users", not
 * per-user): workspace list (GET /workspaces — the admin router surface) →
 * expand a row → per-workspace grants panel (list + revoke) + grant form
 * (user search + role select) + bulk multi-select grant with a role.
 *
 * All access CRUD rides the TanStack hooks from useWorkspaces.ts (D-20 —
 * the golden rule: REST data through TanStack Query; NO direct apiPost to
 * /access outside the hooks). User search reuses the SettingsUsers idiom
 * (apiGet("/auth/users") + local username filter) and the displayName()
 * helper exported from WorkspaceAccessDialog.tsx (single copy, no
 * duplication). i18n via the NEW settings.workspaceAccess.* family
 * (workspace.access.* pre-existing keys stay untouched — D-23).
 *
 * The server re-gates every call (owner-or-admin, Plan 02) — the panel's
 * admin gating is UX-only.
 */

import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, UserPlus } from "lucide-react";
import { apiGet } from "../utils/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import type { WorkspaceWithMeta, WorkspaceAccessGrant } from "../queries/useWorkspaces";
import {
  useWorkspaceAccess,
  useGrantWorkspaceAccess,
  useRevokeWorkspaceAccess,
  useBulkGrantWorkspaceAccess,
} from "../queries/useWorkspaces";
import { displayName } from "./WorkspaceAccessDialog";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";

interface AccessUser {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

const ROLES = ["owner", "editor", "viewer"] as const;

export default function SettingsWorkspaceAccess() {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceWithMeta[]>([]);
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [loading, setLoading] = useState(true);
  // 189-REVIEW WR-05: a swallowed load error rendered an empty grantable
  // list (the admin believes there are no users); the failure is now
  // surfaced with an error banner + retry (SettingsPage idiom).
  const [loadError, setLoadError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [userFilter, setUserFilter] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [bulkRole, setBulkRole] = useState<string>("viewer");
  const [selectedSingleUserId, setSelectedSingleUserId] = useState<string>("");

  // Data through the hooks (TanStack golden rule). The access list for the
  // expanded row lazy-fetches via useWorkspaceAccess(enabled=expanded).
  const { data: grants = [], isLoading: grantsLoading } = useWorkspaceAccess(expandedId, !!expandedId);
  const grantMut = useGrantWorkspaceAccess(expandedId ?? "");
  const revokeMut = useRevokeWorkspaceAccess(expandedId ?? "");
  const bulkMut = useBulkGrantWorkspaceAccess(expandedId ?? "");

  const loadData = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [wsData, usersData] = await Promise.all([
        apiGet<WorkspaceWithMeta[]>("/workspaces"),
        apiGet<AccessUser[]>("/auth/users"),
      ]);
      setWorkspaces(wsData);
      setUsers(usersData);
    } catch {
      // Surface the failure (WR-05) — no longer swallowed into empty state.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleRevoke = async (userId: string) => {
    if (!expandedId) return;
    try {
      await revokeMut.mutateAsync(userId);
      showSuccess(t("settings.workspaceAccess.revokeSuccess"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.workspaceAccess.error")));
    }
  };

  const handleGrant = async (userId: string) => {
    if (!expandedId) return;
    try {
      await grantMut.mutateAsync({ userId, role });
      showSuccess(t("settings.workspaceAccess.success"));
      setSelectedSingleUserId("");
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.workspaceAccess.error")));
    }
  };

  const handleBulkGrant = async () => {
    if (!expandedId || selectedUserIds.length === 0) return;
    try {
      const result = await bulkMut.mutateAsync({ userIds: selectedUserIds, role: bulkRole });
      if (result.failed.length === 0) {
        showSuccess(t("settings.workspaceAccess.success"));
      } else {
        const failedNames = result.failed
          .map((f) => users.find((u) => u.id === f.userId)?.username ?? f.userId)
          .join(", ");
        showError(t("settings.workspaceAccess.bulkPartial", { failed: failedNames }));
      }
      setSelectedUserIds([]);
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.workspaceAccess.error")));
    }
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const grantableUsers = useMemo(() => {
    const granted = new Set(grants.map((g) => g.userId));
    return users
      .filter((u) => !granted.has(u.id))
      .filter((u) =>
        userFilter
          ? `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim().toLowerCase().includes(userFilter.toLowerCase()) ||
            u.username.toLowerCase().includes(userFilter.toLowerCase()) ||
            (u.email ?? "").toLowerCase().includes(userFilter.toLowerCase())
          : true,
      );
  }, [users, grants, userFilter]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }

  // 189-REVIEW WR-05: load-failure banner + retry (SettingsPage idiom) —
  // a transient /auth/users or /workspaces failure must never present as
  // an empty grantable list.
  if (loadError) {
    return (
      <div
        data-testid="workspace-access-load-error"
        className="px-4 py-3 rounded-lg flex items-center justify-between bg-destructive text-destructive-foreground"
      >
        <span className="text-sm">{t("settings.workspaceAccess.loadError")}</span>
        <Button variant="outline" size="sm" onClick={() => void loadData()} className="ml-4">
          {t("settings.workspaceAccess.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>{t("workspace.name")}</TableHead>
            <TableHead>{t("workspace.access.listLabel")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workspaces.map((ws) => (
            <TableRow key={ws.id}>
              <TableCell className="w-10">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setExpandedId(expandedId === ws.id ? null : ws.id);
                    setSelectedSingleUserId("");
                    setSelectedUserIds([]);
                    setUserFilter("");
                  }}
                  aria-label={t("settings.workspaceAccess.grantTitle", { name: ws.name })}
                >
                  {expandedId === ws.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </Button>
              </TableCell>
              <TableCell>{ws.name}</TableCell>
              <TableCell>
                {/* Lazy per-expanded-row access count (D-19) — the hook only
                    fires for the open row; closed rows show a placeholder
                    badge (the count resolves on expand). */}
                {expandedId === ws.id ? <AccessCountBadge workspaceId={ws.id} /> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {expandedId && (
        <div className="space-y-4 border border-input rounded p-4" data-testid="workspace-access-panel">
          <h3 className="text-sm font-semibold">
            {t("settings.workspaceAccess.grantTitle", {
              name: workspaces.find((w) => w.id === expandedId)?.name ?? expandedId,
            })}
          </h3>

          {/* Current grants */}
          {grantsLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : grants.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("workspace.access.empty")}</p>
          ) : (
            <ul className="space-y-2" aria-label={t("workspace.access.listLabel")}>
              {grants.map((grant: WorkspaceAccessGrant) => (
                <li
                  key={grant.userId}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded border border-input bg-card"
                >
                  <div className="min-w-0">
                    <span className="text-sm text-foreground truncate block">
                      {grant.user ? displayName(grant.user) : grant.userId}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("settings.workspaceAccess.grantedAt")}: {new Date(grant.grantedAt).toLocaleDateString()}
                      {grant.grantedBy
                        ? ` · ${t("settings.workspaceAccess.grantedBy")}: ${users.find((u) => u.id === grant.grantedBy)?.username ?? grant.grantedBy}`
                        : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-xs">
                      {t(`settings.workspaceAccess.role${grant.role.charAt(0).toUpperCase()}${grant.role.slice(1)}`, grant.role)}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(grant.userId)}
                      disabled={revokeMut.isPending}
                      aria-label={t("settings.workspaceAccess.revoke")}
                      className="text-destructive hover:text-destructive"
                    >
                      {t("settings.workspaceAccess.revoke")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/* Single grant: user search + role */}
          <div className="space-y-2">
            <Input
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              placeholder={t("settings.workspaceAccess.userSearch")}
              aria-label={t("settings.workspaceAccess.userSearch")}
            />
            <div className="flex items-center gap-2">
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="w-40 border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                  <SelectValue placeholder={t("settings.workspaceAccess.role")} />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`settings.workspaceAccess.role${r.charAt(0).toUpperCase()}${r.slice(1)}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={selectedSingleUserId}
                onValueChange={setSelectedSingleUserId}
                disabled={grantMut.isPending}
                aria-label={t("workspace.access.selectUser")}
              >
                <SelectTrigger
                  className="flex-1 border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto"
                  aria-label={t("workspace.access.selectUser")}
                >
                  <SelectValue placeholder={t("workspace.access.selectUser")} />
                </SelectTrigger>
                <SelectContent>
                  {grantableUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {displayName(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() => selectedSingleUserId && handleGrant(selectedSingleUserId)}
                disabled={!selectedSingleUserId || grantMut.isPending}
                aria-label={t("settings.workspaceAccess.grant")}
              >
                <UserPlus className="w-4 h-4 mr-1" />
                {t("settings.workspaceAccess.grant")}
              </Button>
            </div>
          </div>

          {/* Bulk multi-select grant (D-19) */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("settings.workspaceAccess.grantBulk")}</p>
            <div className="max-h-40 overflow-y-auto space-y-1 border border-input rounded p-2">
              {grantableUsers.map((u) => (
                <label key={u.id} className="flex items-center gap-2 cursor-pointer text-sm">
                  <Checkbox
                    checked={selectedUserIds.includes(u.id)}
                    onCheckedChange={() => toggleUser(u.id)}
                  />
                  <span>{displayName(u)}</span>
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Select value={bulkRole} onValueChange={setBulkRole} aria-label={t("settings.workspaceAccess.grantBulk")}>
                <SelectTrigger className="w-40 border border-input rounded px-2 py-1 text-sm bg-card text-foreground h-auto">
                  <SelectValue placeholder={t("settings.workspaceAccess.role")} />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`settings.workspaceAccess.role${r.charAt(0).toUpperCase()}${r.slice(1)}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={handleBulkGrant}
                disabled={selectedUserIds.length === 0 || bulkMut.isPending}
                aria-label={t("settings.workspaceAccess.grantBulk")}
              >
                {t("settings.workspaceAccess.grantBulk")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Expanded-row access-count badge: subscribes to the (extended) access-list
 * hook for its workspace — enabled only when this row IS the expanded one,
 * so the panel never fans out one GET per row (D-19 lazy-fetch shape).
 */
function AccessCountBadge({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const { data: grants = [], isLoading } = useWorkspaceAccess(workspaceId, true);
  if (isLoading) {
    return <span className="text-xs text-muted-foreground">{t("common.loading")}</span>;
  }
  return (
    <Badge variant="outline" className="text-xs">
      {grants.length}
    </Badge>
  );
}
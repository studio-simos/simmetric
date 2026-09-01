// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  useMcpConnections,
  useDeleteMcpConnection,
  useToggleMcpConnection,
  useTestMcpConnection,
} from "../queries/useMcpConnections";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { showSuccess, showError } from "../lib/toast";
import McpConnectionForm from "./McpConnectionForm";
import type { McpConnection } from "../queries/useMcpConnections";
import { getErrorMessage } from "../utils/errorUtils";

export default function SettingsMcpConnections() {
  const { t } = useTranslation();
  const { data: connections = [], isLoading } = useMcpConnections();
  const deleteMutation = useDeleteMcpConnection();
  const toggleMutation = useToggleMcpConnection();
  const testMutation = useTestMcpConnection();

  const [editingConnection, setEditingConnection] = useState<McpConnection | null>(null);
  const [creating, setCreating] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpConnection | null>(null);
  const [testState, setTestState] = useState<
    Map<string, { status: "testing" | "success" | "error"; toolCount?: number; error?: string }>
  >(new Map());

  const testTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleToggle = async (conn: McpConnection) => {
    setTogglingId(conn.id);
    try {
      await toggleMutation.mutateAsync({ id: conn.id, enabled: !conn.enabled });
      showSuccess(
        t("settings.mcpConnections.toggleSuccess", {
          status: !conn.enabled ? "enabled" : "disabled",
        })
      );
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.mcpConnections.toggleFailed")));
    } finally {
      setTogglingId(null);
    }
  };

  const handleTest = async (conn: McpConnection) => {
    // Clear any existing timeout for this connection
    const existingTimeout = testTimeoutRef.current.get(conn.id);
    if (existingTimeout) clearTimeout(existingTimeout);

    setTestState((prev) => {
      const next = new Map(prev);
      next.set(conn.id, { status: "testing" });
      return next;
    });

    try {
      const result = await testMutation.mutateAsync(conn.id);
      if (!result.success) {
        const rawError = result.error || "";
        const isNetworkError = /ENOTFOUND|ECONNREFUSED|fetch failed/i.test(rawError);
        const friendlyError = isNetworkError
          ? "Server unreachable. Check URL and try again."
          : rawError;
        showError(friendlyError);
        setTestState((prev) => {
          const next = new Map(prev);
          next.set(conn.id, { status: "error", error: friendlyError });
          return next;
        });
      } else {
        setTestState((prev) => {
          const next = new Map(prev);
          next.set(conn.id, {
            status: "success",
            toolCount: result.toolCount,
          });
          return next;
        });
      }
    } catch (err: unknown) {
      const rawMessage = getErrorMessage(err, "");
      const isNetworkError = /ENOTFOUND|ECONNREFUSED|fetch failed/i.test(rawMessage);
      const friendlyError = isNetworkError
        ? "Server unreachable. Check URL and try again."
        : rawMessage;
      showError(friendlyError);
      setTestState((prev) => {
        const next = new Map(prev);
        next.set(conn.id, { status: "error", error: friendlyError });
        return next;
      });
    }

    // Auto-clear after 5 seconds
    const timeout = setTimeout(() => {
      setTestState((prev) => {
        const next = new Map(prev);
        next.delete(conn.id);
        return next;
      });
      testTimeoutRef.current.delete(conn.id);
    }, 5000);
    testTimeoutRef.current.set(conn.id, timeout);
  };

  const handleDelete = (conn: McpConnection) => {
    setDeleteTarget(conn);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      showSuccess(t("settings.mcpConnections.deleteSuccess"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.mcpConnections.deleteFailed")));
    } finally {
      setDeleteTarget(null);
    }
  };

  const StatusDot = ({ status }: { status?: string }) => {
    if (status === "connected") {
      return (
        <span className="flex items-center text-secondary-foreground">
          <span className="w-2 h-2 rounded-full inline-block mr-2 bg-green-500" />
          {t("settings.mcpConnections.statusConnected")}
        </span>
      );
    }
    if (status === "error") {
      return (
        <span className="flex items-center text-destructive-foreground">
          <span className="w-2 h-2 rounded-full inline-block mr-2 bg-red-500" />
          {t("settings.mcpConnections.statusError")}
        </span>
      );
    }
    return (
      <span className="flex items-center text-secondary-foreground">
        <span className="w-2 h-2 rounded-full inline-block mr-2 bg-gray-400" />
        {t("settings.mcpConnections.statusDisconnected")}
      </span>
    );
  };

  const TestBadge = ({ conn }: { conn: McpConnection }) => {
    const state = testState.get(conn.id);
    if (!state) return null;

    if (state.status === "testing") {
      return (
        <span className="text-xs text-muted-foreground ml-2">
          {t("settings.mcpConnections.testing")}
        </span>
      );
    }
    if (state.status === "success") {
      return (
        <span className="text-xs text-secondary-foreground ml-2">
          {t("settings.mcpConnections.testSuccess", { count: state.toolCount || 0 })}
        </span>
      );
    }
    return (
      <span className="text-xs text-destructive-foreground ml-2">
        {t("settings.mcpConnections.testFailed", { error: state.error || "" })}
      </span>
    );
  };

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">
          {t("settings.mcpConnections.title")}
        </h3>
        <Button size="sm" onClick={() => setCreating(true)}>
          {t("settings.mcpConnections.createButton")}
        </Button>
      </div>

      {/* Table */}
      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-input text-left text-muted-foreground">
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colName")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colUrl")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colTransport")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colStatus")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colEnabled")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.mcpConnections.colActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((conn) => (
              <TableRow
                key={conn.id}
                className="border-b border-input hover:bg-accent"
              >
                <TableCell className="px-5 py-3 text-foreground">
                  {conn.name}
                </TableCell>
                <TableCell className="px-5 py-3 text-muted-foreground text-xs max-w-[200px] truncate">
                  {conn.url}
                </TableCell>
                <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                  {conn.transportType}
                </TableCell>
                <TableCell className="px-5 py-3">
                  <StatusDot status={conn.liveStatus} />
                </TableCell>
                <TableCell className="px-5 py-3">
                  {togglingId === conn.id ? (
                    <span className="text-xs text-muted-foreground">...</span>
                  ) : (
                    <Switch
                      checked={conn.enabled}
                      onCheckedChange={() => handleToggle(conn)}
                      disabled={togglingId === conn.id}
                      aria-label={t("settings.mcpConnections.enabledLabel")}
                    />
                  )}
                </TableCell>
                <TableCell className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => handleTest(conn)}
                      disabled={testState.get(conn.id)?.status === "testing"}
                    >
                      {t("settings.mcpConnections.test")}
                    </Button>
                    <TestBadge conn={conn} />
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setEditingConnection(conn)}
                    >
                      {t("common.edit")}
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => handleDelete(conn)}
                      className="text-destructive-foreground"
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {connections.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="px-5 py-8 text-center">
                  <p className="text-lg font-semibold text-foreground mb-2">
                    {t("settings.mcpConnections.noConnections")}
                  </p>
                  <p className="text-sm text-muted-foreground mb-4">
                    {t("settings.mcpConnections.noConnectionsBody")}
                  </p>
                  <Button size="sm" onClick={() => setCreating(true)}>
                    {t("settings.mcpConnections.createButton")}
                  </Button>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {isLoading && connections.length === 0 && (
          <div className="text-center py-8 text-secondary-foreground text-sm">
            {t("common.loading")}
          </div>
        )}
      </div>

      {/* Delete Confirmation AlertDialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.mcpConnections.deleteConfirmTitle", {
                defaultValue: "Delete MCP Connection",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.mcpConnections.deleteConfirm")}
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

      {/* Dialog */}
      <Dialog
        open={creating || !!editingConnection}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditingConnection(null);
          }
        }}
      >
        <DialogContent className="max-w-[640px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingConnection
                ? t("settings.mcpConnections.edit")
                : t("settings.mcpConnections.title")}
            </DialogTitle>
          </DialogHeader>
          <McpConnectionForm
            connection={editingConnection}
            onClose={() => {
              setCreating(false);
              setEditingConnection(null);
            }}
            onSave={() => {
              setCreating(false);
              setEditingConnection(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

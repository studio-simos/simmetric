// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * BackupDestinations — list + create/edit/delete for backup destinations.
 *
 * Pattern follows SettingsMcpConnections: header with title + create button,
 * Table of entities, AlertDialog for delete confirmation, Dialog wrapping the
 * form for create+edit.
 *
 * D-19 RBAC: action buttons are gated by `useBackupPermission(action)` and
 * disabled (not hidden) when the user lacks permission, with a tooltip.
 * D-20 license: when the user picks a remote type on Community, the
 * UpgradePrompt is rendered inside the form (BackupDestinationForm handles
 * this). The "Crea destinazione" button itself is not gated by license so
 * the user can always reach the form to see why they need Enterprise.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  useBackupDestinations,
  useDeleteBackupDestination,
  useTestBackupDestination,
  type BackupDestination,
  type BackupTestResult,
} from "../queries/useBackupDestinations";
import { useBackupPermission } from "../hooks/useBackupPermission";
import { showSuccess, showError } from "../lib/toast";
import { ApiError } from "../utils/api";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
import BackupDestinationForm from "./BackupDestinationForm";
import { getErrorMessage } from "../utils/errorUtils";

export default function BackupDestinations() {
  const { t } = useTranslation();
  const { data: destinations = [], isLoading, error } = useBackupDestinations();
  const deleteMutation = useDeleteBackupDestination();
  const testMutation = useTestBackupDestination();

  const canRead = useBackupPermission("backup:destination:read");
  const canWrite = useBackupPermission("backup:destination:write");

  const [editing, setEditing] = useState<BackupDestination | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupDestination | null>(null);
  const [testState, setTestState] = useState<
    Map<string, { status: "testing" | "success" | "error"; error?: string }>
  >(new Map());

  const testTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // WR-07: clear all pending setTimeouts on unmount so we don't fire
  // setTestState on a torn-down component (the "state update on an
  // unmounted component" warning in dev, an allocated Map in prod).
  useEffect(() => {
    return () => {
      testTimeoutRef.current.forEach((handle) => clearTimeout(handle));
      testTimeoutRef.current.clear();
    };
  }, []);

  const handleTest = async (dest: BackupDestination) => {
    const existing = testTimeoutRef.current.get(dest.id);
    if (existing) clearTimeout(existing);
    setTestState((prev) => {
      const next = new Map(prev);
      next.set(dest.id, { status: "testing" });
      return next;
    });
    let result: BackupTestResult;
    try {
      result = await testMutation.mutateAsync(dest.id);
      if (result.success) {
        setTestState((prev) => {
          const next = new Map(prev);
          next.set(dest.id, { status: "success" });
          return next;
        });
        showSuccess(t("settings.backups.destinations.testSuccess"));
      } else {
        setTestState((prev) => {
          const next = new Map(prev);
          next.set(dest.id, { status: "error", error: result.error || "" });
          return next;
        });
        showError(
          t("settings.backups.destinations.testFailed", { error: result.error || "" }),
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? getErrorMessage(err) : String(err);
      setTestState((prev) => {
        const next = new Map(prev);
        next.set(dest.id, { status: "error", error: msg });
        return next;
      });
      if (err instanceof ApiError && err.status === 404) {
        showError(t("backup.enterpriseRequired"));
      } else {
        showError(t("settings.backups.destinations.testFailed", { error: msg }));
      }
    }
    const timeout = setTimeout(() => {
      setTestState((prev) => {
        const next = new Map(prev);
        next.delete(dest.id);
        return next;
      });
      testTimeoutRef.current.delete(dest.id);
    }, 5000);
    testTimeoutRef.current.set(dest.id, timeout);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      showSuccess(t("settings.backups.destinations.deleteSuccess"));
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        showError(t("backup.enterpriseRequired"));
      } else {
        const msg = err instanceof Error ? getErrorMessage(err) : String(err);
        showError(msg || t("settings.backups.destinations.deleteFailed"));
      }
    } finally {
      setDeleteTarget(null);
    }
  };

  if (!canRead) {
    return (
      <div className="text-sm text-muted-foreground py-8 text-center">
        {t("settings.backups.permissionDenied")}
      </div>
    );
  }

  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="w-full space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">
            {t("settings.backups.destinations.title")}
          </h3>
          <Button size="sm" onClick={() => setCreating(true)} disabled={!canWrite}>
            {t("settings.backups.destinations.createButton")}
          </Button>
        </div>
        <div className="rounded-lg border border-input bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("backup.enterpriseRequired")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">
          {t("settings.backups.destinations.title")}
        </h3>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          disabled={!canWrite}
          title={!canWrite ? t("settings.backups.permissionDenied") : undefined}
        >
          {t("settings.backups.destinations.createButton")}
        </Button>
      </div>

      {/* Table */}
      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-input text-left text-muted-foreground">
              <TableHead className="px-5 py-2">
                {t("settings.backups.destinations.colName")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.destinations.colType")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.destinations.colStatus")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.destinations.colActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {destinations.map((dest) => {
              const ts = testState.get(dest.id);
              return (
                <TableRow
                  key={dest.id}
                  className="border-b border-input hover:bg-accent"
                >
                  <TableCell className="px-5 py-3 text-foreground">{dest.name}</TableCell>
                  <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                    {t(`settings.backups.destinations.type_${dest.type}`)}
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    <Badge
                      variant={
                        dest.status === "online"
                          ? "default"
                          : dest.status === "error"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {t(`settings.backups.destinations.status_${dest.status}`)}
                    </Badge>
                    {ts && (
                      <span className="text-xs text-muted-foreground ml-2">
                        {ts.status === "testing"
                          ? t("settings.backups.destinations.testing")
                          : ts.status === "success"
                            ? t("settings.backups.destinations.testSuccess")
                            : t("settings.backups.destinations.testFailed", {
                                error: ts.error || "",
                              })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => handleTest(dest)}
                        disabled={ts?.status === "testing"}
                      >
                        {t("settings.backups.destinations.test")}
                      </Button>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => setEditing(dest)}
                        disabled={!canWrite}
                        title={!canWrite ? t("settings.backups.permissionDenied") : undefined}
                      >
                        {t("common.edit")}
                      </Button>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => setDeleteTarget(dest)}
                        disabled={!canWrite}
                        className="text-destructive-foreground"
                        title={!canWrite ? t("settings.backups.permissionDenied") : undefined}
                      >
                        {t("common.delete")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {destinations.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="px-5 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t("settings.backups.destinations.empty")}
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {isLoading && destinations.length === 0 && (
          <div className="text-center py-8 text-secondary-foreground text-sm">
            {t("common.loading")}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.backups.destinations.deleteConfirmTitle", {
                defaultValue: "Delete Backup Destination",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.backups.destinations.deleteConfirm")}
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

      {/* Create/Edit dialog */}
      <Dialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent className="max-w-[640px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("settings.backups.destinations.editTitle")
                : t("settings.backups.destinations.title")}
            </DialogTitle>
          </DialogHeader>
          <BackupDestinationForm
            destination={editing}
            onClose={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSave={() => {
              setCreating(false);
              setEditing(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

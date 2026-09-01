// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * BackupJobs sub-tab — list of scheduled backup jobs.
 *
 * Features (per Phase 57 decisions):
 *  - Table with Name / Destination / Frequency / Schedule / Enabled (Switch) /
 *    Actions (Run now / Edit / Delete).
 *  - "Esegui ora" button per row (D-11): opens confirm dialog (D-13) with
 *    "Non chiedere piu per questo job" checkbox persisted in localStorage
 *    under `backup.skipRunConfirm.<jobId>`. On confirm, calls POST /:id/run
 *    and auto-navigates to the Storico sub-tab (D-11 fire-and-navigate).
 *  - Toggle Switch per row: calls POST /:id/toggle.
 *  - Create / Edit dialog wraps `BackupJobForm`.
 *  - All action buttons gated by `useBackupPermission("job:write")` (D-19):
 *    disabled (not hidden) with a tooltip when the user lacks permission.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useBackupJobs,
  useDeleteBackupJob,
  useToggleBackupJob,
  useRunBackupJob,
  type BackupJob,
} from "../queries/useBackupJobs";
import { useBackupDestinations } from "../queries/useBackupDestinations";
import { useBackupPermission } from "../hooks/useBackupPermission";
import { showSuccess, showError } from "../lib/toast";
import { ApiError } from "../utils/api";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import BackupJobForm from "./BackupJobForm";
import { getErrorMessage } from "../utils/errorUtils";

interface BackupJobsProps {
  /** Called after a successful "Esegui ora" to navigate to the Storico sub-tab. */
  onNavigateToLogs: () => void;
}

const SKIP_CONFIRM_KEY_PREFIX = "backup.skipRunConfirm.";

function getSkipConfirm(jobId: string): boolean {
  try {
    return localStorage.getItem(SKIP_CONFIRM_KEY_PREFIX + jobId) === "true";
  } catch {
    return false;
  }
}

function setSkipConfirm(jobId: string, value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(SKIP_CONFIRM_KEY_PREFIX + jobId, "true");
    } else {
      localStorage.removeItem(SKIP_CONFIRM_KEY_PREFIX + jobId);
    }
  } catch {
    /* localStorage may be unavailable in private mode — fail silently */
  }
}

export default function BackupJobs({ onNavigateToLogs }: BackupJobsProps) {
  const { t } = useTranslation();
  const { data: jobs = [], isLoading, error: jobsError } = useBackupJobs();
  const { data: destinations = [] } = useBackupDestinations();

  const deleteMutation = useDeleteBackupJob();
  const toggleMutation = useToggleBackupJob();
  const runMutation = useRunBackupJob();

  const canRead = useBackupPermission("backup:job:read");
  const canWrite = useBackupPermission("backup:job:write");

  const [editing, setEditing] = useState<BackupJob | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupJob | null>(null);
  const [runTarget, setRunTarget] = useState<BackupJob | null>(null);
  const [skipConfirmChecked, setSkipConfirmChecked] = useState(false);

  // CR-04: handleToggle relies on the mutation's optimistic update
  // (see useToggleBackupJob). The Switch flips immediately and a
  // second rapid click sees the new value, so no client-side
  // `togglingId` placeholder is needed. The Switch is still disabled
  // while the mutation is in flight to prevent more than one in-flight
  // request per row.
  const handleToggle = async (job: BackupJob) => {
    if (!canWrite) return;
    if (toggleMutation.isPending) return;
    try {
      await toggleMutation.mutateAsync({ id: job.id, enabled: !job.enabled });
      showSuccess(
        t("settings.backups.jobs.toggleSuccess", {
          status: !job.enabled ? "enabled" : "disabled",
        })
      );
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        showError(t("backup.enterpriseRequired"));
      } else {
        const message =
          err instanceof Error
            ? getErrorMessage(err)
            : typeof err === "string"
              ? err
              : "";
        showError(message || t("settings.backups.jobs.toggleFailed"));
      }
    }
  };

  const handleRunClick = (job: BackupJob) => {
    if (!canWrite) return;
    if (getSkipConfirm(job.id)) {
      // D-13: skip the dialog if the user opted out for this job.
      void handleConfirmRun(job);
      return;
    }
    setSkipConfirmChecked(false);
    setRunTarget(job);
  };

  const handleConfirmRun = async (jobArg?: BackupJob) => {
    const job = jobArg ?? runTarget;
    if (!job) return;
    if (skipConfirmChecked) {
      setSkipConfirm(job.id, true);
    }
    // Close the dialog immediately for snappy UX.
    setRunTarget(null);
    try {
      await runMutation.mutateAsync(job.id);
      showSuccess(t("settings.backups.jobs.runSuccess"));
      // D-11: fire-and-navigate to Storico with active polling.
      onNavigateToLogs();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        showError(t("backup.enterpriseRequired"));
      } else {
        showError(getErrorMessage(err, t("settings.backups.jobs.runFailed")));
      }
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      showSuccess(t("settings.backups.jobs.deleteSuccess"));
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 404) {
        showError(t("backup.enterpriseRequired"));
      } else {
        showError(getErrorMessage(err, t("settings.backups.jobs.deleteFailed")));
      }
    } finally {
      setDeleteTarget(null);
    }
  };

  const permissionDeniedTitle = t("settings.backups.permissionDenied");

  if (jobsError instanceof ApiError && jobsError.status === 404) {
    return (
      <div className="w-full space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">
            {t("settings.backups.jobs.title")}
          </h3>
          <Button size="sm" onClick={() => setCreating(true)} disabled={!canWrite}>
            {t("settings.backups.jobs.createButton")}
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
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">
          {t("settings.backups.jobs.title")}
        </h3>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          disabled={!canWrite || destinations.length === 0}
          title={
            !canWrite
              ? permissionDeniedTitle
              : destinations.length === 0
                ? t("settings.backups.jobs.needDestinationFirst")
                : undefined
          }
        >
          {t("settings.backups.jobs.createButton")}
        </Button>
      </div>

      {/* Table */}
      <div className="bg-card rounded-lg border border-input overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-b border-input text-left text-muted-foreground">
              <TableHead className="px-5 py-2">
                {t("settings.backups.jobs.colName")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.jobs.colDestination")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.jobs.colFrequency")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.jobs.colSchedule")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.jobs.colEnabled")}
              </TableHead>
              <TableHead className="px-5 py-2">
                {t("settings.backups.jobs.colActions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow
                key={job.id}
                className="border-b border-input hover:bg-accent"
              >
                <TableCell className="px-5 py-3 text-foreground">
                  {job.name}
                </TableCell>
                <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                  {job.destinationName || job.destinationId}
                </TableCell>
                <TableCell className="px-5 py-3 text-muted-foreground text-xs">
                  {t(`settings.backups.jobs.frequency_${job.frequency}`)}
                </TableCell>
                <TableCell className="px-5 py-3 text-muted-foreground text-xs font-mono">
                  {job.schedule || "—"}
                </TableCell>
                <TableCell className="px-5 py-3">
                  <Switch
                    checked={job.enabled}
                    onCheckedChange={() => handleToggle(job)}
                    disabled={!canWrite || toggleMutation.isPending}
                    title={!canWrite ? permissionDeniedTitle : undefined}
                    aria-label={t("settings.backups.jobs.colEnabled")}
                  />
                </TableCell>
                <TableCell className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => handleRunClick(job)}
                      disabled={!canWrite || runMutation.isPending}
                      title={!canWrite ? permissionDeniedTitle : undefined}
                    >
                      {t("settings.backups.jobs.runNow")}
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setEditing(job)}
                      disabled={!canWrite}
                      title={!canWrite ? permissionDeniedTitle : undefined}
                    >
                      {t("common.edit")}
                    </Button>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setDeleteTarget(job)}
                      disabled={!canWrite}
                      title={!canWrite ? permissionDeniedTitle : undefined}
                      className="text-destructive-foreground"
                    >
                      {t("common.delete")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {jobs.length === 0 && !isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="px-5 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t("settings.backups.jobs.empty")}
                  </p>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {isLoading && jobs.length === 0 && (
          <div className="text-center py-8 text-secondary-foreground text-sm">
            {t("common.loading")}
          </div>
        )}
      </div>

      {!canRead && (
        <p className="text-sm text-muted-foreground">
          {permissionDeniedTitle}
        </p>
      )}

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
              {t("settings.backups.jobs.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.backups.jobs.deleteConfirm", {
                name: deleteTarget?.name || "",
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

      {/* Run-now confirmation dialog (D-11, D-13) */}
      <AlertDialog
        open={!!runTarget}
        onOpenChange={(open) => {
          if (!open) setRunTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.backups.jobs.runConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.backups.jobs.runConfirmDescription", {
                name: runTarget?.name || "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 py-2">
            <Checkbox
              id="skip-confirm-run"
              checked={skipConfirmChecked}
              onCheckedChange={(checked) =>
                setSkipConfirmChecked(checked === true)
              }
            />
            <label
              htmlFor="skip-confirm-run"
              className="text-sm text-foreground cursor-pointer"
            >
              {t("settings.backups.jobs.skipConfirmLabel")}
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleConfirmRun()}>
              {t("settings.backups.jobs.runNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create / Edit dialog */}
      <Dialog
        open={creating || !!editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
      >
        <DialogContent className="max-w-[560px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("settings.backups.jobs.editTitle")
                : t("settings.backups.jobs.createTitle")}
            </DialogTitle>
          </DialogHeader>
          <BackupJobForm
            job={editing}
            destinations={destinations}
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

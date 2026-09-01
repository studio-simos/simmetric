// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * RestoreConfirmDialog — 2-section modal that confirms a backup restore
 * (Phase 57-04, D-17 / D-18).
 *
 * Layout:
 *   1. Dry-run section: "Esegui anteprima" button that calls
 *      POST /api/backups/restore/:logId/dry-run and shows the file list,
 *      table list, and checksum badge.
 *   2. Restore section: a Select for selective mode (db | files | complete,
 *      default "complete") and an Input where the user must type the
 *      exact literal string "RESTORE" (case-sensitive per Phase 55 D-09).
 *      The "Esegui restore" button is enabled only when:
 *        - the dry-run has succeeded (dryRunResult is set AND isValid)
 *        - the user has typed "RESTORE" exactly
 *        - no restore or polling is in flight
 *
 * Network resilience (D-18): the restore call may take up to 30 minutes
 * server-side. If the browser's network drops during that window, the
 * browser typically times out and the client receives a network error.
 * In that case we start a 10-second polling loop against
 * `useBackupLog(id)` and watch for the log's status to move to "restored"
 * (or a non-running terminal state). When the server confirms completion
 * we fire the success toast + `onComplete` and close the dialog.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { showError, showSuccess } from "@/lib/toast";
import {
  useBackupLog,
  useDryRunRestore,
  useExecuteRestore,
  type BackupDryRunResult,
  type BackupLog,
  type BackupRestoreInput,
} from "../queries/useBackupLogs";
import { getErrorMessage } from "../utils/errorUtils";
import { ApiError } from "../utils/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface RestoreConfirmDialogProps {
  log: BackupLog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete?: () => void;
}

type Selective = BackupRestoreInput["selective"];

/* ------------------------------------------------------------------ */
/*  Polling constants                                                  */
/* ------------------------------------------------------------------ */

// Wall-clock guard for the polling fallback (D-18). The actual fetch
// cadence is driven by TanStack Query's `refetchInterval` below — these
// constants only cap how long we keep polling before giving up.
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_DURATION_MS = 5 * 60_000; // 5 minutes

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function RestoreConfirmDialog({
  log,
  open,
  onOpenChange,
  onComplete,
}: RestoreConfirmDialogProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "en";

  // --- Local state -----------------------------------------------------
  const [confirmation, setConfirmation] = useState("");
  const [selective, setSelective] = useState<Selective>("complete");
  const [dryRunResult, setDryRunResult] = useState<BackupDryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [pollingActive, setPollingActive] = useState(false);

  // --- Mutations + single-log polling query ----------------------------
  const dryRunMutation = useDryRunRestore();
  const executeMutation = useExecuteRestore();
  // Wall-clock start of the polling window. A real useRef (not a useMemo-
  // returned plain object) so react-compiler does not flag .current mutation
  // as "mutating a value returned from a function whose return value should
  // not be mutated". Refs survive re-renders without re-triggering the effect,
  // so the "max duration" check stays monotonic across locale changes and
  // React batches.
  const pollStartRef = useRef<number>(0);
  const { data: polledLog } = useBackupLog(pollingActive ? log.id : undefined, {
    poll: true,
  });

  // Detect polled completion: when pollingActive is true and the polled
  // log's status moves to "restored" (terminal success), clear the
  // polling loop and fire the success toast.
  useEffect(() => {
    if (!pollingActive || !polledLog) return;
    if (polledLog.status === "restored") {
      setPollingActive(false);
      pollStartRef.current = 0;
      showSuccess(t("settings.backups.restore.polledSuccess"));
      onComplete?.();
      onOpenChange(false);
    } else if (
      polledLog.status === "failed" ||
      polledLog.status === "success"
    ) {
      // "success" is the pre-restore terminal state; if we still don't
      // see "restored" after 5 minutes, give up.
      setPollingActive(false);
      pollStartRef.current = 0;
      showError(t("settings.backups.restore.polledTimeout"));
      onOpenChange(false);
    }
  }, [pollingActive, polledLog, onComplete, onOpenChange, t]);

  // Wall-clock guard: if we have been polling for more than the
  // maximum duration, give up. The actual refetch cadence is owned by
  // `useBackupLog` so this effect does not race with the query.
  useEffect(() => {
    if (!pollingActive) return;
    const interval = setInterval(() => {
      if (
        pollStartRef.current > 0 &&
        Date.now() - pollStartRef.current >= POLL_MAX_DURATION_MS
      ) {
        clearInterval(interval);
        setPollingActive(false);
        pollStartRef.current = 0;
        showError(t("settings.backups.restore.polledTimeout"));
        onOpenChange(false);
      }
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [pollingActive, onOpenChange, t, pollStartRef]);

  // Reset local state when the dialog re-opens with a different log.
  useEffect(() => {
    if (open) {
      setConfirmation("");
      setSelective("complete");
      setDryRunResult(null);
      setDryRunError(null);
      setRestoreError(null);
      setPollingActive(false);
      pollStartRef.current = 0;
    }
  }, [open, log.id, pollStartRef]);

  // --- Handlers --------------------------------------------------------
  const handleDryRun = async () => {
    setDryRunError(null);
    try {
      const result = await dryRunMutation.mutateAsync({ logId: log.id });
      setDryRunResult(result);
    } catch (err: unknown) {
      setDryRunResult(null);
      if (err instanceof ApiError && err.status === 404) {
        setDryRunError(t("backup.enterpriseRequired"));
      } else {
        setDryRunError(
          getErrorMessage(err, t("settings.backups.restore.dryRunError")),
        );
      }
    }
  };

  const handleExecute = async () => {
    if (confirmation.trim() !== "RESTORE") return;
    if (!dryRunResult) return;
    setRestoreError(null);
    setPollingActive(false);
    pollStartRef.current = 0;
    try {
      await executeMutation.mutateAsync({
        logId: log.id,
        data: { selective, confirmation: "RESTORE" },
      });
      showSuccess(t("settings.backups.restore.success"));
      onComplete?.();
      onOpenChange(false);
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? getErrorMessage(err)
          : typeof err === "string"
            ? err
            : "";
      if (err instanceof ApiError && err.status === 404) {
        setRestoreError(t("backup.enterpriseRequired"));
        showError(t("backup.enterpriseRequired"));
        return;
      }
      const isNetworkish =
        /timeout|network|fetch|aborted/i.test(message) ||
        // Axios-style network error code with no message:
        (typeof (err as { status?: number })?.status === "number" &&
          (err as { status?: number }).status === 0);
      if (isNetworkish) {
        // D-18 fallback: poll for the server-completion status. The
        // server is still running the restore; the client just lost
        // its connection.
        pollStartRef.current = Date.now();
        setPollingActive(true);
      } else {
        setRestoreError(message || t("settings.backups.restore.failedGeneric"));
        showError(
          t("settings.backups.restore.failed", { error: message }),
        );
      }
    }
  };

  const handleCancel = () => {
    setPollingActive(false);
    pollStartRef.current = 0;
    onOpenChange(false);
  };

  // --- Derived flags ---------------------------------------------------
  const restoreLoading = executeMutation.isPending;
  const restoreBusy = restoreLoading || pollingActive;
  const confirmationTrimmed = confirmation.trim();
  const canExecute =
    confirmationTrimmed === "RESTORE" &&
    !!dryRunResult &&
    dryRunResult.isValid &&
    !restoreBusy;

  // --- Render helpers --------------------------------------------------
  const description = t("settings.backups.restore.description", {
    date: log.startedAt
      ? new Date(log.startedAt).toLocaleString(locale)
      : "—",
    destination: log.destination?.name || "—",
  });

  const dryRunTables = dryRunResult?.contents?.tables ?? [];
  const dryRunFiles = dryRunResult?.contents?.files ?? [];
  const MAX_LIST_ITEMS = 10;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.backups.restore.title")}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Persistent warning while restore / polling is active (D-18) */}
        {restoreBusy && (
          <div
            role="alert"
            className="bg-warning/10 border border-warning/30 rounded-md p-3 flex items-start gap-2"
          >
            <Loader2 className="h-4 w-4 mt-0.5 animate-spin shrink-0" />
            <p className="text-sm text-foreground leading-relaxed">
              {t("settings.backups.restore.timeoutWarning")}
            </p>
          </div>
        )}

        {/* Section 1 — Dry-run */}
        <section className="space-y-3" data-testid="restore-dryrun-section">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {t("settings.backups.restore.dryRunTitle")}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t("settings.backups.restore.dryRunDescription")}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleDryRun}
              disabled={dryRunMutation.isPending || restoreBusy}
            >
              {dryRunMutation.isPending
                ? t("common.loading")
                : t("settings.backups.restore.runDryRun")}
            </Button>
            {dryRunResult && (
              <Badge
                variant={dryRunResult.isValid ? "default" : "destructive"}
              >
                {dryRunResult.isValid
                  ? t("settings.backups.restore.checksumValid")
                  : t("settings.backups.restore.checksumInvalid")}
              </Badge>
            )}
          </div>

          {dryRunError && (
            <p
              role="alert"
              className="text-xs text-destructive flex items-center gap-1"
            >
              <AlertTriangle className="h-3 w-3" />
              {dryRunError}
            </p>
          )}

          {dryRunResult && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-md border border-input p-3 bg-surface-alt">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t("settings.backups.restore.tables")}
                </p>
                {dryRunTables.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    {t("settings.backups.restore.empty")}
                  </p>
                ) : (
                  <ul className="text-xs font-mono space-y-0.5">
                    {dryRunTables.slice(0, MAX_LIST_ITEMS).map((t_) => (
                      <li key={t_} className="truncate">
                        {t_}
                      </li>
                    ))}
                    {dryRunTables.length > MAX_LIST_ITEMS && (
                      <li className="text-muted-foreground italic">
                        +{dryRunTables.length - MAX_LIST_ITEMS}…
                      </li>
                    )}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t("settings.backups.restore.files")}
                </p>
                {dryRunFiles.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    {t("settings.backups.restore.empty")}
                  </p>
                ) : (
                  <ul className="text-xs font-mono space-y-0.5">
                    {dryRunFiles.slice(0, MAX_LIST_ITEMS).map((f) => (
                      <li key={f} className="truncate">
                        {f}
                      </li>
                    ))}
                    {dryRunFiles.length > MAX_LIST_ITEMS && (
                      <li className="text-muted-foreground italic">
                        +{dryRunFiles.length - MAX_LIST_ITEMS}…
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          )}
        </section>

        <Separator className="my-2" />

        {/* Section 2 — Real restore */}
        <section className="space-y-3" data-testid="restore-execute-section">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {t("settings.backups.restore.realTitle")}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {t("settings.backups.restore.realDescription")}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="restore-selective"
              className="text-xs text-muted-foreground"
            >
              {t("settings.backups.restore.selectiveLabel")}
            </label>
            <Select
              value={selective}
              onValueChange={(v) => setSelective(v as Selective)}
              disabled={restoreBusy}
            >
              <SelectTrigger id="restore-selective" className="w-[260px] h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="db">
                  {t("settings.backups.restore.selective_db")}
                </SelectItem>
                <SelectItem value="files">
                  {t("settings.backups.restore.selective_files")}
                </SelectItem>
                <SelectItem value="complete">
                  {t("settings.backups.restore.selective_complete")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor="restore-confirmation"
              className="text-xs text-muted-foreground"
            >
              {t("settings.backups.restore.typeRestorLabel")}
            </label>
            <Input
              id="restore-confirmation"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="RESTORE"
              autoComplete="off"
              spellCheck={false}
              disabled={restoreBusy}
              className="font-mono w-[260px] h-8 text-sm"
            />
            {confirmation.length > 0 && confirmationTrimmed !== "RESTORE" && (
              <p className="text-xs text-muted-foreground italic">
                {t("settings.backups.restore.confirmationHint")}
              </p>
            )}
          </div>

          {restoreError && (
            <p
              role="alert"
              className="text-xs text-destructive flex items-center gap-1"
            >
              <AlertTriangle className="h-3 w-3" />
              {restoreError}
            </p>
          )}

          <div className="pt-1">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleExecute}
              disabled={!canExecute}
            >
              {restoreLoading
                ? t("common.loading")
                : t("settings.backups.restore.executeRestore")}
            </Button>
          </div>
        </section>

        <DialogFooter className="flex items-center justify-between gap-2 sm:flex-row">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleCancel}
          >
            {t("common.cancel")}
          </Button>
          <p className="text-xs text-muted-foreground italic">
            {t("settings.backups.restore.helpText")}
          </p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useBeforeUnload } from "react-router-dom";
import { apiPost } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { RefreshCw } from "lucide-react";
import { getErrorMessage } from "../utils/errorUtils";
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

interface ReindexResult {
  reindexed: number;
  skipped: number;
  errors: string[];
  totalDocuments: number;
  durationSeconds: number;
}

export function SettingsMaintenanceReaper() {
  const { t } = useTranslation();
  const { getValue } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();

  // fail-closed parity with the server: enabled only on literal "true"
  const [checked, setChecked] = useState(getValue("upload_draft_reaper_enabled") === "true");
  const [cron, setCron] = useState(getValue("upload_draft_reaper_cron"));
  const [cronError, setCronError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const currentValue = getValue("upload_draft_reaper_enabled");
  const currentCron = getValue("upload_draft_reaper_cron");

  // Sync local state when the server-side values change (after invalidate + refetch).
  useEffect(() => {
    setChecked(currentValue === "true");
  }, [currentValue]);
  useEffect(() => {
    setCron(currentCron);
  }, [currentCron]);

  // Client-side pre-check only: blocks obviously malformed cron before save.
  // The server warns and falls back to the default cadence on invalid values.
  const isValidCronShape = (v: string) => /^(\S+\s+){4}\S+$/.test(v.trim());

  const handleToggle = async (v: boolean) => {
    setChecked(v);
    try {
      await updateSettings([
        { key: "upload_draft_reaper_enabled", value: String(v) },
      ]);
      showSuccess(t("settings.maintenance.reaperSaveSuccess"));
    } catch {
      // Revert optimistic state on failure.
      setChecked(!v);
      showError(t("settings.maintenance.reaperSaveError"));
    }
  };

  const handleSaveCron = async () => {
    const trimmed = cron.trim();
    if (!isValidCronShape(trimmed)) {
      setCronError(t("settings.maintenance.reaperCronInvalid"));
      return;
    }
    setCronError(null);
    setSaving(true);
    try {
      await updateSettings([{ key: "upload_draft_reaper_cron", value: trimmed }]);
      showSuccess(t("settings.maintenance.reaperSaveSuccess"));
    } catch {
      showError(t("settings.maintenance.reaperSaveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card border border-input rounded-lg p-6 space-y-4">
      <div>
        <h4 className="text-base font-medium text-foreground">
          {t("settings.maintenance.reaperTitle")}
        </h4>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          {t("settings.maintenance.reaperDescription")}
        </p>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t("settings.maintenance.reaperEnabled")}
          </p>
          <p className="text-xs text-[var(--text-subtle)] mt-1">
            {t("settings.maintenance.reaperEnabledHint")}
          </p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={handleToggle}
          aria-label={t("settings.maintenance.reaperEnabled")}
        />
      </div>

      <div>
        <label
          htmlFor="reaper-cron-input"
          className="text-sm font-medium text-foreground"
        >
          {t("settings.maintenance.reaperCron")}
        </label>
        <div className="flex items-center gap-2 mt-1">
          <Input
            id="reaper-cron-input"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 3 * * *"
            className="font-mono"
          />
          <Button variant="default" onClick={handleSaveCron} disabled={saving}>
            {t("settings.maintenance.reaperSaveCron")}
          </Button>
        </div>
        {cronError && (
          <p className="text-sm text-[var(--error-text)] mt-1">{cronError}</p>
        )}
      </div>
    </div>
  );
}

export default function SettingsMaintenance() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [reindexing, setReindexing] = useState(false);
  const [result, setResult] = useState<ReindexResult | null>(null);
  const [reembedding, setReembedding] = useState(false);
  const [reembedResult, setReembedResult] = useState<ReindexResult | null>(null);

  const busy = reindexing || reembedding;

  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const pendingPathRef = useRef<string | null>(null);
  const lastPathnameRef = useRef(location.pathname);
  const isNavigatingRef = useRef(false);

  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (busy) {
          event.preventDefault();
          event.returnValue = "";
          return true;
        }
      },
      [busy]
    )
  );

  useEffect(() => {
    if (location.pathname === lastPathnameRef.current) return;
    lastPathnameRef.current = location.pathname;
    if (isNavigatingRef.current) {
      isNavigatingRef.current = false;
      return;
    }
    if (busy) {
      pendingPathRef.current = location.pathname;
      setShowLeaveDialog(true);
    }
  }, [location.pathname, busy]);

  const handleLeaveConfirm = () => {
    const to = pendingPathRef.current;
    setShowLeaveDialog(false);
    pendingPathRef.current = null;
    if (to) {
      isNavigatingRef.current = true;
      navigate(to, { replace: true });
    }
  };

  const handleLeaveCancel = () => {
    setShowLeaveDialog(false);
    pendingPathRef.current = null;
  };

  const handleReindex = async () => {
    setReindexing(true);
    setResult(null);
    try {
      const data = await apiPost<ReindexResult>("/system/reindex-documents", {});
      setResult(data);
      if (data.errors.length > 0) {
        showError(t("settings.maintenance.reindexErrors", { count: data.errors.length }));
      } else {
        showSuccess(t("settings.maintenance.reindexSuccess", { count: data.reindexed }));
      }
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.maintenance.reindexError")));
    } finally {
      setReindexing(false);
    }
  };

  const handleReembed = async () => {
    setReembedding(true);
    setReembedResult(null);
    try {
      const data = await apiPost<ReindexResult>("/system/reembed-documents", {});
      setReembedResult(data);
      if (data.errors.length > 0) {
        showError(t("settings.maintenance.reembedErrors", { count: data.errors.length }));
      } else {
        showSuccess(t("settings.maintenance.reembedSuccess", { count: data.reindexed }));
      }
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.maintenance.reembedError")));
    } finally {
      setReembedding(false);
    }
  };

  return (
    <div className="w-full space-y-6">
      <h3 className="text-lg font-medium text-foreground">
        {t("settings.maintenance.title")}
      </h3>

      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.maintenance.leaveInProgressTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.maintenance.leaveInProgressBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleLeaveCancel}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLeaveConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.maintenance.leaveAnyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="bg-card border border-input rounded-lg p-6 space-y-4">
        <div>
          <h4 className="text-base font-medium text-foreground">
            {t("settings.maintenance.reindexTitle")}
          </h4>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            {t("settings.maintenance.reindexDesc")}
          </p>
        </div>

        <Button
          variant="default"
          onClick={handleReindex}
          disabled={reindexing}
          className="gap-2"
        >
          <RefreshCw size={16} className={reindexing ? "animate-spin" : ""} />
          {reindexing
            ? t("settings.maintenance.reindexing")
            : t("settings.maintenance.reindexButton")}
        </Button>

        {result && (
          <div className="text-sm space-y-1 bg-[var(--surface-alt)] rounded-md px-3 py-2">
            <p className="text-foreground">
              ✓ {t("settings.maintenance.reindexedCount", { count: result.reindexed })}
            </p>
            <p className="text-[var(--text-muted)]">
              {t("settings.maintenance.skippedCount", { count: result.skipped })}
            </p>
            {result.errors.length > 0 && (
              <p className="text-[var(--error-text)]">
                {t("settings.maintenance.errorCount", { count: result.errors.length })}
              </p>
            )}
            <p className="text-[var(--text-subtle)]">
              {t("settings.maintenance.duration", { seconds: result.durationSeconds })}
            </p>
          </div>
        )}
      </div>

      <div className="bg-card border border-input rounded-lg p-6 space-y-4">
        <div>
          <h4 className="text-base font-medium text-foreground">
            {t("settings.maintenance.reembedTitle")}
          </h4>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            {t("settings.maintenance.reembedDesc")}
          </p>
        </div>

        <Button
          variant="default"
          onClick={handleReembed}
          disabled={reembedding}
          className="gap-2"
        >
          <RefreshCw size={16} className={reembedding ? "animate-spin" : ""} />
          {reembedding
            ? t("settings.maintenance.reembedding")
            : t("settings.maintenance.reembedButton")}
        </Button>

        {reembedResult && (
          <div className="text-sm space-y-1 bg-[var(--surface-alt)] rounded-md px-3 py-2">
            <p className="text-foreground">
              ✓ {t("settings.maintenance.reindexedCount", { count: reembedResult.reindexed })}
            </p>
            <p className="text-[var(--text-muted)]">
              {t("settings.maintenance.skippedCount", { count: reembedResult.skipped })}
            </p>
            {reembedResult.errors.length > 0 && (
              <p className="text-[var(--error-text)]">
                {t("settings.maintenance.errorCount", { count: reembedResult.errors.length })}
              </p>
            )}
            <p className="text-[var(--text-subtle)]">
              {t("settings.maintenance.duration", { seconds: reembedResult.durationSeconds })}
            </p>
          </div>
        )}
      </div>

      <SettingsMaintenanceReaper />
    </div>
  );
}

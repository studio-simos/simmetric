// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-05, 202-04 Task 2) — the /plugins admin page per the
 * approved 202-UI-SPEC §2-§8: header + restart, always-rendered zip dropzone
 * hero, card grid with the three deterministic badge matrices (status /
 * license / restart-pending), platform-only license modal, toggle + uninstall
 * overflow menu, and the supervisor/manual restart split.
 *
 * SECRET DISCIPLINE (A-5/A-6, T-202-19): the license JWT is a bearer
 * credential — type="password" + labelled show/hide toggle + autoComplete
 * off; the modal ALWAYS opens empty and the stored license is NEVER rendered
 * back (the card's license badge is the only persisted license state).
 *
 * Deferred-truth discipline (A-3/A-9): enable/disable lands only at the next
 * restart — the amber "Restart required" chip + toggleSuccess copy say so in
 * the moment of action. Restart state (isRestarting) is component-local
 * useState — UI-session state, never the query cache (UI-SPEC §10).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDropzone } from "react-dropzone";
import { AlertTriangle, ChevronDown, Loader2, MoreHorizontal, Puzzle, RefreshCw } from "lucide-react";
import { usePageMeta } from "@/hooks/usePageMeta";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
  usePlugins,
  useInstallPlugin,
  useTogglePlugin,
  useUninstallPlugin,
  useSavePluginLicense,
  useVerifyPluginLicense,
  useRestartServer,
} from "../queries/usePlugins";
import { useMe } from "../queries/useAuth";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import type { PluginRow } from "@simmetric-chat/shared";

/** Client-side mirror of the multer cap (A-11): reject BEFORE any API call. */
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const ZIP_ACCEPT = {
  "application/zip": [".zip"],
  "application/x-zip-compressed": [".zip"],
} as const;

/** Restart-window safety timeout (A-10): if the supervisor never brings the
 * server back, the normal error path is restored after 90s. */
const RESTART_SAFETY_TIMEOUT_MS = 90_000;

/** Pure dropzone guard (test seam): null = accepted, else the i18n error key. */
function validatePluginFile(file: { name: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith(".zip")) return "plugins.dropzone.invalidType";
  if (file.size > MAX_ZIP_BYTES) return "plugins.dropzone.tooLarge";
  return null;
}

/* ------------------------------------------------------------------ */
/*  Badge matrices (UI-SPEC §4 — deterministic, first match wins)      */
/* ------------------------------------------------------------------ */

type BadgeSpec = { key: string; className: string; tooltip?: string };

function statusBadge(row: PluginRow, t: (k: string, o?: Record<string, unknown>) => string): BadgeSpec {
  // Priority order: disabled > failed > loaded > installed (first match wins).
  if (!row.enabled) {
    return { key: "plugins.statusDisabled", className: "bg-secondary text-secondary-foreground" };
  }
  if (row.status === "failed") {
    return {
      key: "plugins.statusFailed",
      className: "bg-destructive/10 text-destructive dark:bg-destructive/20",
      tooltip: t("plugins.lastErrorTooltip", { error: row.lastError ?? "" }),
    };
  }
  if (row.status === "loaded") {
    return { key: "plugins.statusLoaded", className: "bg-green-500/10 text-green-700 dark:text-green-400" };
  }
  return { key: "plugins.statusInstalled", className: "bg-secondary text-secondary-foreground" };
}

function licenseBadge(row: PluginRow, t: (k: string, o?: Record<string, unknown>) => string): BadgeSpec | null {
  // D6 verbatim: none → NO badge/section/anything (zero license UI, P3).
  if (row.licenseMode === "none") return null;
  if (row.licenseMode === "self") {
    return { key: "plugins.licenseBadgeSelf", className: "" }; // outline variant
  }
  // licenseMode === "platform"
  if (row.licenseStatus === "verified") {
    return { key: "plugins.licenseBadgeVerified", className: "bg-green-500/10 text-green-700 dark:text-green-400" };
  }
  if (row.licenseStatus === "invalid" || row.licenseStatus === "expired" || row.licenseStatus === "plugin_mismatch") {
    return {
      key: "plugins.licenseBadgeInvalid",
      className: "bg-destructive/10 text-destructive dark:bg-destructive/20",
      tooltip: t("plugins.licenseStatusTooltip", { reason: row.licenseStatus }),
    };
  }
  // missing / null (never verified) — a pending state, not an error (A: amber).
  return { key: "plugins.licenseBadgeMissing", className: "bg-amber-500/10 text-amber-700 dark:text-amber-400" };
}

function badgeClasses(spec: BadgeSpec): string {
  return spec.className || "";
}

export default function PluginPage() {
  const { t } = useTranslation();
  usePageMeta(t("plugins.title"));

  const { data, isLoading, isError } = usePlugins();
  const install = useInstallPlugin();
  const toggle = useTogglePlugin();
  const uninstall = useUninstallPlugin();
  const saveLicense = useSavePluginLicense();
  const verifyLicense = useVerifyPluginLicense();
  const restart = useRestartServer();
  const me = useMe();
  const canManage = (me.data?.permissions ?? []).includes("plugins:manage");

  const restartMode = data?.restartMode ?? "manual";
  const plugins = data?.plugins ?? [];

  const installing = install.isPending;

  // Single-flight toggle (199 idiom).
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Uninstall confirmation.
  const [deletingRow, setDeletingRow] = useState<PluginRow | null>(null);

  // License modal session state — ALWAYS opens empty (A-6); Save gated on a
  // passing Verify in THIS modal session (A-7).
  const [licenseRow, setLicenseRow] = useState<PluginRow | null>(null);
  const [licenseInput, setLicenseInput] = useState("");
  const [licenseVisible, setLicenseVisible] = useState(false);
  const [verifyPassed, setVerifyPassed] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  // Restart session state (UI-SPEC §10) — never the query cache.
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false);

  const { getRootProps, getInputProps, isDragActive: dropzoneDragActive } = useDropzone({
    multiple: false,
    accept: ZIP_ACCEPT,
    maxSize: MAX_ZIP_BYTES,
    disabled: installing || isRestarting || !canManage,
    onDrop: (accepted, rejected) => {
      // A-11: client-side guards reject BEFORE any API call (the multer cap
      // mirrored client-side; the server remains authoritative).
      const firstRejected = rejected[0];
      if (firstRejected) {
        const code = (firstRejected as unknown as { errors?: ReadonlyArray<{ code: string }> }).errors?.[0]?.code;
        showError(t(code === "file-too-large" ? "plugins.dropzone.tooLarge" : "plugins.dropzone.invalidType"));
        return;
      }
      const file = accepted[0];
      if (!file) return;
      const invalidKey = validatePluginFile(file);
      if (invalidKey) {
        showError(t(invalidKey));
        return;
      }
      install.mutateAsync(file)
        .then(() => showSuccess(t("plugins.installSuccess")))
        .catch((err: unknown) => showError(t("plugins.installFailed", { error: getErrorMessage(err) })));
    },
  });

  const handleToggle = async (row: PluginRow, enabled: boolean) => {
    setTogglingId(row.id);
    try {
      await toggle.mutateAsync({ id: row.id, enabled });
      // A-9: the deferred effect is stated in the moment of action.
      showSuccess(t("plugins.toggleSuccess", { action: t(enabled ? "plugins.enable" : "plugins.disable") }));
    } catch {
      showError(t("plugins.toggleFailed"));
    } finally {
      setTogglingId(null);
    }
  };

  const handleUninstall = async (row: PluginRow) => {
    setDeletingRow(null);
    try {
      await uninstall.mutateAsync(row.id);
      showSuccess(t("plugins.uninstallSuccess"));
    } catch {
      showError(t("plugins.uninstallFailed"));
    }
  };

  const openLicenseModal = (row: PluginRow) => {
    setLicenseRow(row);
    setLicenseInput(""); // A-6: the modal ALWAYS opens empty
    setLicenseVisible(false);
    setVerifyPassed(false); // A-7: per-session gate
    setVerifyResult(null);
  };

  const handleVerify = async () => {
    if (!licenseRow || !licenseInput) return;
    try {
      await verifyLicense.mutateAsync({ id: licenseRow.id, licenseKey: licenseInput });
      setVerifyPassed(true);
      setVerifyResult({ ok: true });
    } catch (err: unknown) {
      setVerifyPassed(false);
      setVerifyResult({ ok: false, reason: getErrorMessage(err) });
    }
  };

  const handleSaveLicense = async () => {
    if (!licenseRow || !licenseInput || !verifyPassed) return;
    try {
      await saveLicense.mutateAsync({ id: licenseRow.id, licenseKey: licenseInput });
      setLicenseRow(null);
      showSuccess(t("plugins.license.saved"));
    } catch (err: unknown) {
      // Modal stays open, state intact (UI-SPEC §6.5).
      showError(t("plugins.license.saveFailed"));
      void err;
    }
  };

  const handleRestart = async () => {
    setRestartConfirmOpen(false);
    setIsRestarting(true); // A-10: set immediately, before the mutation settles
    try {
      await restart.mutateAsync();
      // 202 is the truth — the banner lives until the list refetches green
      // (TanStack 30s heartbeat) or the 90s safety timeout restores errors.
      window.setTimeout(() => setIsRestarting(false), RESTART_SAFETY_TIMEOUT_MS);
    } catch {
      setIsRestarting(false);
      showError(t("plugins.restart.failed"));
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* §2 — page header: title + description + right-aligned outline restart */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{t("plugins.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("plugins.description")}</p>
        </div>
        {canManage && (
          restartMode === "supervisor" ? (
            <Button variant="outline" onClick={() => setRestartConfirmOpen(true)} disabled={isRestarting}>
              <RefreshCw className="w-4 h-4" />
              {t("plugins.restart.button")}
            </Button>
          ) : (
            <div className="flex items-start gap-2">
              {/* D-06: dev mode — no confirm, no API call, the warning replaces the call */}
              <Button variant="outline" disabled aria-label={t("plugins.restart.button")}>
                <RefreshCw className="w-4 h-4" />
                {t("plugins.restart.button")}
              </Button>
              <div className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400 max-w-xs">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  <strong>{t("plugins.restart.devWarningTitle")}</strong>{" "}
                  {t("plugins.restart.devWarningBody")}
                </span>
              </div>
            </div>
          )
        )}
      </div>

      {/* §8 — persistent restarting banner (local session state, never cache) */}
      {isRestarting && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("plugins.restart.restarting")}
        </div>
      )}

      {/* §2 — dropzone hero: ALWAYS rendered (A-15) */}
      <div
        data-testid="dropzone-root"
        {...getRootProps()}
        className={`mt-6 cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          dropzoneDragActive ? "border-primary bg-primary/5" : "border-border bg-card"
        } ${installing ? "opacity-60" : ""}`}
      >
        <input data-testid="dropzone-input" {...getInputProps()} />
        <div className="flex items-center justify-center gap-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm font-medium">{t("plugins.dropzone.heading")}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("plugins.dropzone.body")}</p>
        {installing && (
          <p className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("plugins.installing")}
          </p>
        )}
      </div>

      {/* §2 — card grid / empty line */}
      {plugins.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t("plugins.empty")}</p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {plugins.map((row) => (
            <PluginCard
              key={row.id}
              row={row}
              t={t}
              canManage={canManage}
              togglingId={togglingId}
              onToggle={handleToggle}
              onUninstall={(r) => setDeletingRow(r)}
              onLicense={openLicenseModal}
            />
          ))}
        </div>
      )}

      {/* Uninstall confirmation (Cancel first in tab order — the 199 idiom) */}
      <AlertDialog open={deletingRow !== null} onOpenChange={(open) => !open && setDeletingRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("plugins.uninstallConfirmTitle", { name: deletingRow?.displayName ?? deletingRow?.packageName ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("plugins.uninstallConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingRow(null)}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deletingRow && void handleUninstall(deletingRow)}
            >
              {t("plugins.uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restart confirmation (supervisor only; Cancel first) */}
      <AlertDialog open={restartConfirmOpen} onOpenChange={setRestartConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("plugins.restart.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("plugins.restart.confirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRestart()}>{t("plugins.restart.confirmAction")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* §6 — license modal (rendered ONLY for platform rows) */}
      <Dialog open={licenseRow !== null} onOpenChange={(open) => !open && setLicenseRow(null)}>
        <DialogContent className="max-w-[560px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("plugins.license.title")}</DialogTitle>
            <DialogDescription>{t("plugins.license.requiredHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="plugin-license-input">{t("plugins.license.inputLabel")}</Label>
              <input
                id="plugin-license-input"
                type={licenseVisible ? "text" : "password"}
                value={licenseInput}
                onChange={(e) => {
                  setLicenseInput(e.target.value);
                  setVerifyPassed(false); // A-7: the gate is per-session input
                  setVerifyResult(null);
                }}
                autoComplete="off"
                className="flex h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {t("plugins.license.inputHint", { packageName: licenseRow?.packageName ?? "" })}
                </p>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setLicenseVisible((v) => !v)}
                >
                  {licenseVisible ? t("plugins.license.hide") : t("plugins.license.show")}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={!licenseInput || verifyLicense.isPending}
                onClick={() => void handleVerify()}
              >
                {verifyLicense.isPending ? t("plugins.license.verifying") : t("plugins.license.verify")}
              </Button>
              <Button
                disabled={!verifyPassed || saveLicense.isPending}
                onClick={() => void handleSaveLicense()}
              >
                {saveLicense.isPending ? t("plugins.license.saving") : t("plugins.license.save")}
              </Button>
            </div>
            {verifyResult?.ok && (
              <p className="text-xs text-green-700 dark:text-green-400">{t("plugins.license.verifyOk")}</p>
            )}
            {verifyResult && !verifyResult.ok && (
              <p className="text-xs text-destructive">
                {t("plugins.license.verifyFailed", { reason: verifyResult.reason ?? "" })}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* List fetch error — the quiet error block (A-10: toasts suppressed in the restart window) */}
      {isError && !isRestarting && (
        <p className="mt-4 text-sm text-destructive">{t("plugins.errorGeneric")}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Card (UI-SPEC §3)                                                  */
/* ------------------------------------------------------------------ */

type TFn = (k: string, o?: Record<string, unknown>) => string;

function PluginCard(props: {
  row: PluginRow;
  t: TFn;
  canManage: boolean;
  togglingId: string | null;
  onToggle: (row: PluginRow, enabled: boolean) => Promise<void>;
  onUninstall: (row: PluginRow) => void;
  onLicense: (row: PluginRow) => void;
}) {
  const { row, t, canManage, togglingId, onToggle, onUninstall, onLicense } = props;
  const isNative = row.source === "native";
  const status = statusBadge(row, t);
  const license = licenseBadge(row, t);
  const restartPending = row.enabled && row.status !== "loaded" && row.status !== "failed";
  const name = row.displayName ?? row.packageName;

  return (
    <Card data-plugin-card className="p-4">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <Puzzle className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm" title={name}>
          {name}
        </span>
        <StatusBadge spec={status} t={t} />
      </div>

      {/* Meta rows */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate" title={row.packageName}>
          {row.packageName}
        </span>
        {row.version && (
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            v{row.version}
          </Badge>
        )}
        <Badge variant="outline" className="h-4 px-1 text-[10px]">
          {t("plugins.apiVersion", { version: row.apiVersion })}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge variant={isNative ? "outline" : "secondary"}>{t(isNative ? "plugins.sourceNative" : "plugins.sourceManaged")}</Badge>
        {license && (
          <BadgeWithTooltip spec={license} t={t} />
        )}
        {restartPending && (
          <Badge className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
            {t("plugins.restartRequired")}
          </Badge>
        )}
      </div>
      {isNative && <p className="mt-1 text-xs text-muted-foreground">{t("plugins.nativeHint")}</p>}

      {/* lastError detail (failed rows only) */}
      {row.status === "failed" && row.lastError && (
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-destructive">
            <ChevronDown className="h-3 w-3 transition-transform duration-150 [[data-state=open]>&]:rotate-180" />
            {t("plugins.lastErrorTrigger")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1 break-words text-xs text-destructive dark:text-red-400">{row.lastError}</p>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Action row — native rows render read-only (A-4) */}
      {!isNative && canManage && (
        <div className="mt-3 flex items-center justify-between">
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-busy={togglingId === row.id}>
                <Switch
                  checked={row.enabled}
                  disabled={togglingId === row.id}
                  aria-label={t(row.enabled ? "plugins.disable" : "plugins.enable")}
                  onCheckedChange={(checked: boolean) => void onToggle(row, checked)}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{t(row.enabled ? "plugins.disable" : "plugins.enable")}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("plugins.cardMenu")}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {row.licenseMode === "platform" && (
                <DropdownMenuItem onSelect={() => onLicense(row)}>
                  {t("plugins.manageLicense")}
                </DropdownMenuItem>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuItem
                    disabled={row.enabled}
                    onSelect={() => onUninstall(row)}
                  >
                    {t("plugins.uninstall")}
                  </DropdownMenuItem>
                </TooltipTrigger>
                {row.enabled && (
                  <TooltipContent className="max-w-[40ch] whitespace-normal">
                    {t("plugins.uninstallDisabledHint")}
                  </TooltipContent>
                )}
              </Tooltip>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ spec, t }: { spec: BadgeSpec; t: TFn }) {
  const badge = (
    <Badge className={badgeClasses(spec) || undefined} aria-label={spec.tooltip ?? t(spec.key)}>
      {t(spec.key)}
    </Badge>
  );
  if (!spec.tooltip) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-[40ch] whitespace-normal">{spec.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function BadgeWithTooltip({ spec, t }: { spec: BadgeSpec; t: TFn }) {
  // A badge without a tint class renders as outline (the "Self-licensed"
  // informational variant); tinted badges keep their explicit classes.
  const badge = (
    <Badge
      variant={spec.className ? undefined : "outline"}
      className={spec.className || undefined}
      aria-label={spec.tooltip ?? t(spec.key)}
    >
      {t(spec.key)}
    </Badge>
  );
  if (!spec.tooltip) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-[40ch] whitespace-normal">{spec.tooltip}</TooltipContent>
    </Tooltip>
  );
}
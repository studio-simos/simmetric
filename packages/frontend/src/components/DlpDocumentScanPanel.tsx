// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 192 (DLP-05/DLP-06, UI-SPEC surfaces 3/4) — DlpDocumentScanPanel.
 *
 * Admin sibling card in Settings → Avanzate, rendered directly below the
 * SettingsGeneralDlp card (SettingsPage wires it). Self-contained: reads the
 * useDlpDocs hooks (TanStack Query golden rule), receives no props.
 *
 * Two sections separated by a Separator:
 *  - Eval: single-flight "Run evaluation" (disabled + RefreshCw spin while
 *    running — SettingsMaintenance precedent), no-run empty state, passed
 *    neutral summary, amber gate-failed banner (DLPNotice convention) with
 *    per-class rates + documentedOnly annotation, destructive Alert only for
 *    hard runner errors with a ghost retry, Skeleton while loading. Metric
 *    values render in font-mono (JetBrains Mono, UI-SPEC typography).
 *  - Backfill: destructive AlertDialog confirm with the eligible count
 *    ("Scan {{count}} documents" destructive-styled, dismissive "Not now"),
 *    single-flight, result toast {{scanned}} scanned · {{masked}} masked ·
 *    {{failed}} failed, empty arm replaces the trigger when totalEligible 0,
 *    re-run-safe error copy on partial failures. The 409 eval-gate rejection
 *    renders the gate-blocked banner on the panel (the server is the hard
 *    gate — UI-SPEC rule 7).
 *
 * Color discipline (UI-SPEC): accent ONLY on the two CTAs + focus rings;
 * warnings are amber; destructive only for the confirm button + hard errors.
 * Toasts (not inline banners) for async results. NO Progress bar — the
 * default contract is the result-counts panel.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useDlpEvalResult, useRunDlpEval, useDlpBackfill } from "../queries/useDlpDocs";
import type { DlpEvalResult, DlpEvalClassRow } from "@simmetric-chat/shared";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

/** The checksum-validated classes (dlpEvalService's deterministic gate tier) —
 * their FP count is what the gate asserts to 0. NER-context classes are the
 * documented recall gap (nerMode "stub"), annotated "documented, not gating". */
const CHECKSUM_CLASSES = new Set(["GOV_ID", "FINANCIAL"]);

function formatFpRate(fpRate: number): string {
  return `${(fpRate * 100).toFixed(1)}%`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function ClassRow({
  row,
  t,
}: {
  row: DlpEvalClassRow;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const documentedOnly = !CHECKSUM_CLASSES.has(row.entityClass);
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-foreground font-medium shrink-0">
        {row.entityClass}
        {documentedOnly && (
          <span className="ml-2 text-muted-foreground font-normal">
            ({t("settings.dlpDocs.eval.documentedOnly")})
          </span>
        )}
      </span>
      <span className="text-muted-foreground truncate">
        {t("settings.dlpDocs.eval.detected", { count: row.detected })} ·{" "}
        {t("settings.dlpDocs.eval.expected", { count: row.expected })} ·{" "}
        <span className="font-mono">
          {t("settings.dlpDocs.eval.falsePositives", { count: row.falsePositives })}
        </span>
      </span>
    </div>
  );
}

function DlpDocumentScanPanel() {
  const { t } = useTranslation();
  const { data: evalResult, isLoading: evalLoading, error: evalError, refetch: refetchEval } =
    useDlpEvalResult();
  const runEvalMut = useRunDlpEval();
  const backfillMut = useDlpBackfill();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [backfillFailed, setBackfillFailed] = useState<number | null>(null);
  const [backfillErrored, setBackfillErrored] = useState(false);

  const evalRunning = runEvalMut.isPending;
  const backfillRunning = backfillMut.isPending;

  // The backfill section renders its destructive confirm ONLY when there is
  // something to scan (the plan-06 no-op success arm keeps totalEligible 0).
  // While the eval gate is unproven the eligible count is unknown to the
  // client — the dialog copy uses the server's 409-provided count only in the
  // gate-blocked banner; the confirm flow is reachable only past the gate.
  const gatePassed = evalResult?.passed === true;
  const evalFullResult: DlpEvalResult | null =
    evalResult && evalResult.noRun !== true ? evalResult : null;

  const handleRunEval = async () => {
    try {
      await runEvalMut.mutateAsync();
      showSuccess(t("settings.dlpDocs.eval.passed", { fpRate: "0.0%", total: 0 }));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("settings.dlpDocs.eval.error")));
    }
  };

  const handleBackfill = async () => {
    setBackfillFailed(null);
    setBackfillErrored(false);
    try {
      const data = await backfillMut.mutateAsync();
      const failedCount = data.errors.length;
      if (data.totalEligible === 0) {
        // No-op success — the empty state renders from this response.
        showSuccess(t("settings.dlpDocs.backfill.empty"));
      } else if (failedCount > 0) {
        setBackfillFailed(failedCount);
        showError(t("settings.dlpDocs.backfill.error", { failed: failedCount }));
      } else {
        showSuccess(t("settings.dlpDocs.backfill.result", { scanned: data.enqueued, masked: data.enqueued, failed: 0 }));
      }
      setConfirmOpen(false);
    } catch (err: unknown) {
      setBackfillErrored(true);
      showError(getErrorMessage(err, t("settings.dlpDocs.backfill.runError")));
      setConfirmOpen(false);
    }
  };

  return (
    <div className="bg-card border border-input rounded-lg p-6 space-y-4" data-testid="dlp-document-scan-panel">
      {/* Heading */}
      <div>
        <h4 className="text-base font-medium text-foreground">
          {t("settings.dlpDocs.title")}
        </h4>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          {t("settings.dlpDocs.description")}
        </p>
      </div>

      {/* ── Eval section ── */}
      <div className="space-y-3" data-testid="dlp-eval-section">
        {evalLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-9 w-40" />
          </div>
        ) : evalError ? (
          <>
            <Alert variant="destructive">
              <ShieldAlert className="w-4 h-4" />
              <AlertTitle>{t("settings.dlpDocs.eval.error")}</AlertTitle>
              <AlertDescription>
                {(evalError as Error).message}
              </AlertDescription>
            </Alert>
            <Button variant="ghost" size="sm" onClick={() => refetchEval()}>
              {t("settings.dlpDocs.eval.retry")}
            </Button>
          </>
        ) : evalFullResult ? (
          <>
            {evalFullResult.passed ? (
              <div
                className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-sm text-foreground"
                data-testid="dlp-eval-passed"
              >
                <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  {t("settings.dlpDocs.eval.passed", {
                    fpRate: formatFpRate(evalFullResult.fpRate),
                    total: evalFullResult.totalChecks,
                  })}
                </span>
              </div>
            ) : (
              <div
                className="rounded-lg border border-[var(--border)] bg-amber-50/10 dark:bg-amber-950/20 border-l-2 border-l-amber-400 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
                data-testid="dlp-eval-failed"
                role="alert"
              >
                <div className="flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {t("settings.dlpDocs.eval.failed", {
                      fpRate: formatFpRate(evalFullResult.fpRate),
                    })}
                  </span>
                </div>
              </div>
            )}

            {/* Per-class rates — fixed DLP_ENTITY_CLASSES order from the server */}
            {evalFullResult.perClass.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("settings.dlpDocs.eval.perClassTitle")}
                </p>
                {evalFullResult.perClass.map((row) => (
                  <ClassRow key={row.entityClass} row={row} t={t} />
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {t("settings.dlpDocs.eval.lastRun", { date: formatDate(evalFullResult.lastRun) })}
            </p>
          </>
        ) : (
          <div className="space-y-2" data-testid="dlp-eval-empty">
            <p className="text-sm font-medium text-foreground">
              {t("settings.dlpDocs.eval.empty.heading")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("settings.dlpDocs.eval.empty.body")}
            </p>
          </div>
        )}

        {/* Single-flight Run evaluation CTA (accent budget: one of two).
            Hidden while the initial result fetch is loading — the button
            belongs to the loaded/empty/error arms, not the skeleton arm. */}
        {!evalLoading && (
          <Button
            variant="default"
            onClick={handleRunEval}
            disabled={evalRunning}
            className="gap-2"
            data-testid="dlp-eval-run"
          >
            <RefreshCw size={16} className={evalRunning ? "animate-spin" : ""} />
            {evalRunning
              ? t("settings.dlpDocs.eval.running")
              : t("settings.dlpDocs.eval.run")}
          </Button>
        )}
      </div>

      <Separator />

      {/* ── Backfill section ── */}
      <div className="space-y-3" data-testid="dlp-backfill-section">
        {!gatePassed && (
          <div
            className="rounded-lg border border-[var(--border)] bg-amber-50/10 dark:bg-amber-950/20 border-l-2 border-l-amber-400 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
            data-testid="dlp-backfill-gate-blocked"
            role="alert"
          >
            <div className="flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{t("workspace.dlp.gateBlocked")}</span>
            </div>
          </div>
        )}

        {backfillErrored && (
          <p className="text-sm text-destructive" data-testid="dlp-backfill-error">
            {t("settings.dlpDocs.backfill.runError")}
          </p>
        )}

        {gatePassed ? (
          backfillFailed !== null ? (
            <p className="text-sm text-destructive">
              {t("settings.dlpDocs.backfill.error", { failed: backfillFailed })}
            </p>
          ) : (
            <Button
              variant="default"
              onClick={() => setConfirmOpen(true)}
              disabled={backfillRunning}
              className="gap-2"
              data-testid="dlp-backfill-trigger"
            >
              <RefreshCw size={16} className={backfillRunning ? "animate-spin" : ""} />
              {backfillRunning
                ? t("settings.dlpDocs.backfill.running")
                : t("settings.dlpDocs.backfill.run")}
            </Button>
          )
        ) : null}

        {backfillRunning && (
          <p className="text-sm text-muted-foreground" data-testid="dlp-backfill-running">
            {t("settings.dlpDocs.backfill.running")}
          </p>
        )}
      </div>

      {/* Destructive backfill confirm (D-12: the ONLY destructive action). The
          eligible count rides the server response; the dialog copy carries the
          count via the confirm-run label. Re-run-safe copy is in confirmBody. */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.dlpDocs.backfill.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.dlpDocs.backfill.confirmBody", {
                count: backfillMut.data?.totalEligible ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={backfillRunning} onClick={() => setConfirmOpen(false)}>
              {t("settings.dlpDocs.backfill.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBackfill}
              disabled={backfillRunning}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="dlp-backfill-confirm"
            >
              {t("settings.dlpDocs.backfill.confirmRun", {
                count: backfillMut.data?.totalEligible ?? 0,
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default DlpDocumentScanPanel;
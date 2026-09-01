// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * PendingDocsPanel — Phase 71-05 Task 3.
 *
 * Lifecycle list (D-04) of unassigned + in-flight + done UploadDrafts with
 * filter chips (To assign / In progress / Completed), multi-select bulk-assign
 * (D-06 per-file MIME validation + toast variants), per-leg RAG+KB badges
 * (D-10 variant per state + className=font-semibold + aria-label), retry-KB
 * per-row (D-08, only when kbStatus=FAILED), skeleton stage feedback (D-11),
 * "Assigned to" live label (D-05), and empty states.
 *
 * D-07 idempotency is server-side — the client never pre-checks draft status
 * before dispatching assign; it just calls useAssignDraft per valid draft and
 * lets the pending query refetch.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DraftDestination, AssignDraftInput } from "@simmetric-chat/shared";
import {
  useUploadDrafts,
  useAssignDraft,
  useRetryKb,
  useRetryRag,
  useRetryBoth,
  useDeleteDraft,
  useRenameDraft,
  type UploadDraft,
  type RetryLegsResponse,
} from "../queries/useUploadDrafts";
import { useArchives } from "../queries/useArchives";
import { showSuccess, showError } from "../lib/toast";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Label } from "./ui/label";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./ui/dialog";
import { Clock, Loader2, Check, AlertTriangle, Minus, RotateCw, Pencil } from "lucide-react";
import {
  isValidForDestination,
  destinationToAssignBody,
} from "./UploadDestinationChooser";

/* ------------------------------------------------------------------ */
/*  Per-leg badge helpers (D-10, UI-SPEC §Color)                       */
/* ------------------------------------------------------------------ */

function ragBadgeProps(status: string | null) {
  if (status === null) {
    return {
      variant: "outline" as const,
      icon: <Minus className="h-3 w-3" />,
      label: "RAG unassigned",
      extra: "text-muted-foreground",
    };
  }
  switch (status) {
    case "completed":
      return { variant: "default" as const, icon: <Check className="h-3 w-3" />, label: "RAG done", extra: "" };
    case "failed":
      return { variant: "destructive" as const, icon: <AlertTriangle className="h-3 w-3" />, label: "RAG failed", extra: "" };
    case "processing":
      return {
        variant: "secondary" as const,
        icon: <Loader2 className="h-3 w-3 animate-spin" />,
        label: "RAG in-flight",
        extra: "text-primary",
      };
    case "pending":
    default:
      return {
        variant: "secondary" as const,
        icon: <Clock className="h-3 w-3" />,
        label: "RAG pending",
        extra: "",
      };
  }
}

function kbBadgeProps(status: string | null) {
  if (status === null) {
    return {
      variant: "outline" as const,
      icon: <Minus className="h-3 w-3" />,
      label: "KB unassigned",
      extra: "text-muted-foreground",
    };
  }
  switch (status) {
    case "COMPLETED":
      return { variant: "default" as const, icon: <Check className="h-3 w-3" />, label: "KB done", extra: "" };
    case "FAILED":
      return { variant: "destructive" as const, icon: <AlertTriangle className="h-3 w-3" />, label: "KB failed", extra: "" };
    case "CANCELLED":
      // 71-06 WR-02: CANCELLED is a terminal state (KB_TERMINAL set in
      // PendingDocsPanel.tsx:139). Render it as a neutral secondary badge
      // so the user can distinguish it from FAILED (red) and COMPLETED (green).
      return {
        variant: "secondary" as const,
        icon: <Minus className="h-3 w-3" />,
        label: "KB cancelled",
        extra: "text-muted-foreground",
      };
    case "PROCESSING":
      return {
        variant: "secondary" as const,
        icon: <Loader2 className="h-3 w-3 animate-spin" />,
        label: "KB in-flight",
        extra: "text-primary",
      };
    case "PENDING":
    default:
      return {
        variant: "secondary" as const,
        icon: <Clock className="h-3 w-3" />,
        label: "KB pending",
        extra: "",
      };
  }
}

/* ------------------------------------------------------------------ */
/*  D-05 destination label                                             */
/* ------------------------------------------------------------------ */

/**
 * 71-06 WR-03: assignedToLabel is module-scope and has no `t` in scope,
 * so the caller passes the translation function. For the unassigned case
 * we return the LOCALIZED string (not the raw i18n key) so the row shows
 * the translated label instead of the literal "uploads.destination.*".
 * The RAG/KB/Both labels stay as literal English (they are destination
 * names, not translatable strings — consistent with `destinationToAssignBody`
 * which maps them to assign-body fields).
 */
function assignedToLabel(d: UploadDraft, t: (key: string) => string): string {
  if (d.ragEnabled && d.kbEnabled) return "Both";
  if (d.ragEnabled) return "RAG";
  if (d.kbEnabled) return "KB";
  return t("uploads.destination.unassigned.label");
}

/* ------------------------------------------------------------------ */
/*  Filter logic (D-04)                                                */
/* ------------------------------------------------------------------ */

const RAG_TERMINAL = new Set(["completed", "failed"]);
const KB_TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function isDone(d: UploadDraft): boolean {
  if (d.parseStatus === "done") return true;
  const ragTerminal = d.ragStatus === null || RAG_TERMINAL.has(d.ragStatus);
  const kbTerminal = d.kbStatus === null || KB_TERMINAL.has(d.kbStatus);
  return d.parseStatus === "assigned" && ragTerminal && kbTerminal;
}

function isInFlight(d: UploadDraft): boolean {
  return d.parseStatus === "assigned" && !isDone(d);
}

/**
 * 260829-h0n — delete eligibility. A draft is deletable iff it is NOT
 * in-flight, i.e. the SAME predicate the filter chips use (isDone via
 * isInFlight). Failed-terminal drafts (parseStatus "assigned" with every
 * enabled leg completed/failed and disabled legs ignored) are deletable —
 * delete is the user's explicit choice over retry. The server's DELETE /:id
 * gate derives in-flight with the identical formula (mirroring
 * enrichDraftWithLegStatus's ragDone/kbDone), so what this predicate allows
 * through bulk delete is exactly what the server accepts; the server 409
 * remains authoritative for the poll-vs-click race.
 */
export function isDeletable(d: UploadDraft): boolean {
  return !isInFlight(d);
}

function isUnassigned(d: UploadDraft): boolean {
  return d.parseStatus === "unassigned" || d.parseStatus === "uploaded";
}

type FilterKey = "all" | "unassigned" | "inFlight" | "done";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export interface PendingDocsPanelProps {
  workspaceId: string;
  /** True while a stage mutation is in-flight — shows the skeleton row (D-11). */
  stagePending?: boolean;
}

export default function PendingDocsPanel({ workspaceId, stagePending }: PendingDocsPanelProps) {
  const { t } = useTranslation();
  const { data: drafts = [] } = useUploadDrafts(workspaceId);
  const assign = useAssignDraft(workspaceId);
  const retryKb = useRetryKb(workspaceId);
  const retryRag = useRetryRag(workspaceId);
  const retryBoth = useRetryBoth(workspaceId);
  const deleteDraft = useDeleteDraft(workspaceId);
  const renameDraft = useRenameDraft(workspaceId);
  const { data: archives = [] } = useArchives();

  const [filter, setFilter] = useState<FilterKey>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDest, setBulkDest] = useState<DraftDestination>("kb");
  const [bulkArchiveId, setBulkArchiveId] = useState<string | undefined>(undefined);
  // Phase 76-03 — bulk delete + inline rename state (D-03, D-04, D-06).
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkAssigning, setIsBulkAssigning] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  // quick 260826-fan — bulk retry state (D-03). RadioGroup picks rag/kb/both;
  // archive Select shown when kb or both. Sequential dispatch mirrors
  // handleBulkConfirm.
  const [bulkRetryOpen, setBulkRetryOpen] = useState(false);
  const [retryDest, setRetryDest] = useState<"rag" | "kb" | "both">("rag");
  const [retryArchiveId, setRetryArchiveId] = useState<string | undefined>(undefined);
  const [isBulkRetrying, setIsBulkRetrying] = useState(false);

  const filtered = (() => {
    if (filter === "all") return drafts;
    if (filter === "unassigned") return drafts.filter(isUnassigned);
    if (filter === "inFlight") return drafts.filter(isInFlight);
    return drafts.filter(isDone);
  })();

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkConfirm() {
    setIsBulkAssigning(true);
    const selectedDrafts = drafts.filter((d) => selected.has(d.id));
    const valid: UploadDraft[] = [];
    const skippedMime: UploadDraft[] = [];
    for (const d of selectedDrafts) {
      if (isValidForDestination(d.mimeType, bulkDest)) {
        valid.push(d);
      } else {
        skippedMime.push(d);
      }
    }

    // 71-06 WR-04: wrap the per-draft dispatch loop in a try/catch so a
    // partial failure (e.g. one assign.mutateAsync rejects mid-loop) still
    // surfaces a toast to the user instead of silently swallowing the
    // error. The success/skip toasts below only run when the loop completes
    // without throwing. The `finally` block resets the selection + dialog
    // state regardless of outcome so the UI does not get stuck open.
    try {
      // D-07: client never pre-checks status — dispatch per valid draft.
      // Skip drafts that are already finalized (parseStatus "done") instead
      // of failing the whole batch on a 409. This lets the user select a mix
      // of completed + in-progress drafts and bulk-assign: the finalized ones
      // are silently skipped, the rest are dispatched.
      let assigned = 0;
      let skippedFinalized = 0;
      for (const d of valid) {
        if (d.parseStatus === "done") {
          skippedFinalized++;
          continue;
        }
        const body: AssignDraftInput = destinationToAssignBody(bulkDest, bulkArchiveId);
        await assign.mutateAsync({ id: d.id, body });
        assigned++;
      }

      // 260829-xxx: honest per-reason toasts. The old single "skipped (MIME
      // non valido)" message conflated two distinct skip reasons — a MIME
      // matrix rejection AND a finalized (parseStatus "done") draft, which
      // has a perfectly valid MIME but would 409 ("Draft already finalized")
      // — a misleading diagnosis for valid-MIME files. The retry flow
      // (POST /:id/retry, no done-gate) is the correct recovery path for
      // finalized drafts. noneValid keeps its original guard (assigned=0
      // AND no finalized skips) — "everything was MIME-invalid" stays an
      // ERROR toast, not a success-with-skips.
      if (assigned === 0 && skippedFinalized === 0) {
        showError(t("uploads.bulkAssign.noneValid"));
      } else if (skippedMime.length > 0 && skippedFinalized > 0) {
        showSuccess(
          t("uploads.bulkAssign.skippedBoth", {
            assigned,
            skippedMime: skippedMime.length,
            skippedFinalized,
          }),
        );
      } else if (skippedMime.length > 0) {
        showSuccess(
          t("uploads.bulkAssign.skipped", {
            assigned,
            skipped: skippedMime.length,
          }),
        );
      } else if (skippedFinalized > 0) {
        showSuccess(
          t("uploads.bulkAssign.skippedFinalized", {
            assigned,
            skipped: skippedFinalized,
          }),
        );
      } else {
        showSuccess(t("uploads.bulkAssign.success", { count: assigned }));
      }
    } catch (err: unknown) {
      showError(
        t("uploads.bulkAssign.partialError", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setIsBulkAssigning(false);
      setSelected(new Set());
      setBulkOpen(false);
    }
  }

  async function handleRetryKb(d: UploadDraft) {
    // 71-06 WR-05 belt-and-suspenders: bail early with a toast if no archive
    // is assigned. The server Task A fix populates assignedArchiveId in the
    // pending response, but if a future regression omits it the client
    // must NOT POST with archiveId:"" (the assign schema rejects empty
    // archiveId when kb=true). This guard prevents a confusing 400 toast.
    if (!d.assignedArchiveId) {
      showError(t("uploads.retryKb.noArchive", { filename: d.originalName }));
      return;
    }
    try {
      // 260829-fty: a 200 can still carry kbResult "rejected" (Promise
      // .allSettled per-leg isolation) — honest toast from the leg's
      // settled status, not from the HTTP status.
      const result = await retryKb.mutateAsync({
        id: d.id,
        archiveId: d.assignedArchiveId,
      });
      if (result.kbResult === "rejected") {
        showError(t("uploads.retry.legFailed", { filename: d.originalName, leg: "KB" }));
        return;
      }
      showSuccess(t("uploads.retryKb.success", { filename: d.originalName }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(t("uploads.retryKb.error", { message: msg }));
    }
  }

  /**
   * quick 260826-fan — per-row RAG retry (D-02). Dispatches useRetryRag,
   * which posts {rag:true, kb:false} to /retry. The server soft-deletes the
   * old Document (if any) and re-dispatches the RAG leg.
   *
   * 260829-fty: a 200 can still report the RAG leg as "rejected" via
   * Promise.allSettled per-leg isolation — show the legFailed error toast
   * instead of the success toast in that case.
   */
  async function handleRetryRag(d: UploadDraft) {
    try {
      const result = await retryRag.mutateAsync({ id: d.id });
      if (result.ragResult === "rejected") {
        showError(t("uploads.retry.legFailed", { filename: d.originalName, leg: "RAG" }));
        return;
      }
      showSuccess(t("uploads.retryRag.success", { filename: d.originalName }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(t("uploads.retryRag.error", { message: msg }));
    }
  }

  /**
   * quick 260826-fan — bulk retry confirm (D-03). Sequential dispatch per
   * selected draft based on retryDest (rag/kb/both). Mirrors handleBulkConfirm:
   * per-draft try/catch accumulating ok/failed counts, success/partial-error
   * toasts, reset selection + close dialog in finally. Reuses
   * isValidForDestination for the MIME matrix (rag rejects images).
   */
  async function handleBulkRetryConfirm() {
    setIsBulkRetrying(true);
    const selectedDrafts = drafts.filter((d) => selected.has(d.id));
    let ok = 0;
    const failed: string[] = [];

    try {
      for (const d of selectedDrafts) {
        // MIME matrix: rag rejects images. Skip silently for invalid combos.
        if (retryDest === "rag" && !isValidForDestination(d.mimeType, "rag")) {
          failed.push(d.originalName);
          continue;
        }
        if ((retryDest === "kb" || retryDest === "both") && !isValidForDestination(d.mimeType, "kb")) {
          failed.push(d.originalName);
          continue;
        }
        try {
          // 260829-fty: capture the settled per-leg status. A 200 whose
          // requested leg reports "rejected" counts as FAILED (feeds the
          // bulkRetry.partialError toast), not ok.
          let result: RetryLegsResponse | undefined;
          if (retryDest === "rag") {
            result = await retryRag.mutateAsync({ id: d.id });
          } else if (retryDest === "kb") {
            if (!retryArchiveId) {
              failed.push(d.originalName);
              continue;
            }
            result = await retryKb.mutateAsync({ id: d.id, archiveId: retryArchiveId });
          } else {
            if (!retryArchiveId) {
              failed.push(d.originalName);
              continue;
            }
            result = await retryBoth.mutateAsync({ id: d.id, archiveId: retryArchiveId });
          }
          // ok ONLY when every requested leg settled "fulfilled" (null =
          // leg not requested — never blocks).
          const ragOk = result.ragResult !== "rejected";
          const kbOk = result.kbResult !== "rejected";
          if (ragOk && kbOk) {
            ok++;
          } else {
            failed.push(d.originalName);
          }
        } catch {
          failed.push(d.originalName);
        }
      }

      if (failed.length === 0) {
        showSuccess(t("uploads.bulkRetry.success", { count: ok }));
      } else {
        showError(
          t("uploads.bulkRetry.partialError", {
            message: `${ok} ok, ${failed.length} failed: ${failed.join(", ")}`,
          }),
        );
      }
    } finally {
      setIsBulkRetrying(false);
      setSelected(new Set());
      setBulkRetryOpen(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Phase 76-03 — single + bulk delete + inline rename handlers      */
  /* ---------------------------------------------------------------- */

  /**
   * D-06 inline rename save. Enter / blur submits, Escape cancels. Empty
   * name exits edit mode silently (D-07). Length > 500 shows a toast and
   * stays in edit mode. The hook invalidates the pending list on success
   * so the new name persists across reloads (no manual cache mutation — the
   * hook owns invalidation, matching handleBulkConfirm's convention).
   */
  async function handleRename(id: string) {
    const name = draftName.trim();
    if (!name) {
      // D-07 — empty silent cancel.
      setEditingId(null);
      return;
    }
    if (name.length > 500) {
      showError(t("uploads.rename.tooLong"));
      return;
    }
    try {
      await renameDraft.mutateAsync({ id, originalName: name });
      showSuccess(t("uploads.rename.success"));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(t("uploads.rename.error", { message: msg }));
    } finally {
      setEditingId(null);
    }
  }

  /**
   * D-05 in-flight gate at confirm time. Drafts with `parseStatus === "assigned"`
   * (in-flight) are SKIPPED, not blocking — the user can delete a mix of
   * completed + in-flight drafts and only the deletable ones are removed.
   * The server-side 409 (Plan 01) is the authoritative backstop for the
   * poll-vs-click race. Mirrors handleBulkConfirm — clear all selection +
   * close regardless of outcome.
   */
  async function handleBulkDeleteConfirm() {
    const selectedDrafts = drafts.filter((d) => selected.has(d.id));
    // 260829-h0n: use the SAME predicate the filter chips use (isDeletable →
    // isInFlight → isDone) instead of the raw parseStatus !== "assigned"
    // field — the failed-terminal draft that renders under the "done"-ish
    // categories is the same one the server's failure-aware gate accepts.
    const deletable = selectedDrafts.filter(isDeletable);
    const skippedInFlight = selectedDrafts.length - deletable.length;

    if (deletable.length === 0) {
      showError(t("uploads.bulkDelete.inFlightBlocked"));
      return;
    }

    let ok = 0;
    const failed: string[] = [];
    try {
      for (const d of deletable) {
        try {
          await deleteDraft.mutateAsync({ id: d.id });
          ok++;
        } catch {
          failed.push(d.originalName);
        }
      }
      if (failed.length === 0 && skippedInFlight === 0) {
        showSuccess(t("uploads.bulkDelete.success", { count: ok }));
      } else {
        showError(
          t("uploads.bulkDelete.partialError", {
            ok,
            failed: failed.length + skippedInFlight,
            message: [...failed, ...Array(skippedInFlight).fill("in-flight")].join(", "),
          }),
        );
      }
    } finally {
      setSelected(new Set());
      setBulkDeleteOpen(false);
    }
  }

  const filterChips: Array<{ key: FilterKey; labelKey: string }> = [
    { key: "unassigned", labelKey: "uploads.pending.filter.unassigned" },
    { key: "inFlight", labelKey: "uploads.pending.filter.inFlight" },
    { key: "done", labelKey: "uploads.pending.filter.done" },
  ];

  const selectedCount = selected.size;
  const validCount = drafts.filter(
    (d) => selected.has(d.id) && isValidForDestination(d.mimeType, bulkDest),
  ).length;
  // quick 260723-xxx — KB/Both destinations require an archive. The server
  // assign schema rejects empty archiveId when kb=true (see handleRetryKb
  // guard, line ~277), so the confirm button must be disabled until one is
  // picked instead of letting the user dispatch a guaranteed 400.
  const needsArchive = bulkDest === "kb" || bulkDest === "both";
  const archiveMissing = needsArchive && !bulkArchiveId;

  // quick 260826-fan — bulk retry derived values (mirror the bulk-assign
  // needsArchive/archiveMissing pattern).
  const retryNeedsArchive = retryDest === "kb" || retryDest === "both";
  const retryArchiveMissing = retryNeedsArchive && !retryArchiveId;
  const retryValidCount = drafts.filter((d) => {
    if (!selected.has(d.id)) return false;
    if (retryDest === "rag") return isValidForDestination(d.mimeType, "rag");
    return isValidForDestination(d.mimeType, "kb");
  }).length;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t("uploads.pending.heading")}</CardTitle>
        <div className="flex gap-2">
          {filterChips.map((chip) => (
            <Button
              key={chip.key}
              variant={filter === chip.key ? "default" : "ghost"}
              size="sm"
              aria-pressed={filter === chip.key}
              onClick={() => setFilter(chip.key)}
            >
              {t(chip.labelKey)}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-3 sm:px-4">
        {/* D-11 skeleton stage row */}
        {stagePending && (
          <div className="flex items-center gap-4 p-2 sm:p-3 border-b border-border" aria-busy="true">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
            <div className="flex-1" />
            <Badge variant="secondary" className="font-semibold">
              {t("uploads.stage.uploading")}
            </Badge>
          </div>
        )}

        {/* Empty states */}
        {!stagePending && drafts.length === 0 && (
          <div className="py-12 text-center">
            <p className="text-sm font-medium">
              {t("uploads.pending.empty.heading")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("uploads.pending.empty.body")}
            </p>
          </div>
        )}
        {!stagePending && drafts.length > 0 && filtered.length === 0 && (
          <div className="py-12 text-center">
            <p className="text-sm font-medium">
              {t("uploads.pending.empty.filteredHeading")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("uploads.pending.empty.bodyFiltered")}
            </p>
          </div>
        )}

        {/* Draft list */}
        {filtered.length > 0 && (
          <>
            {/* Select-all + bulk-assign + bulk-delete toolbar (D-03 — Assign left, Delete right) */}
            <div className="flex items-center justify-end gap-2 mb-3">
              <div className="flex items-center gap-2 mr-auto">
                <Checkbox
                  checked={filtered.length > 0 && selected.size === filtered.length}
                  onCheckedChange={(checked) => {
                    setSelected(() => {
                      if (checked) return new Set(filtered.map((d) => d.id));
                      return new Set();
                    });
                  }}
                  aria-label={t("uploads.source.fromDoc.selectAll")}
                />
                <span className="text-sm font-medium text-muted-foreground">
                  {t("uploads.source.fromDoc.selectAll")}
                </span>
              </div>
              <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
                <DialogTrigger asChild>
                  <Button
                    className="min-h-[44px] sm:min-h-0"
                    disabled={selectedCount === 0}
                  >
                    {t("uploads.bulkAssign.confirm")}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t("uploads.bulkAssign.confirm")}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <RadioGroup
                      value={bulkDest}
                      onValueChange={(v) => setBulkDest(v as DraftDestination)}
                      className="gap-3"
                    >
                      {(["rag", "kb", "both"] as DraftDestination[]).map((d) => (
                        <div key={d} className="flex items-center gap-2">
                          <RadioGroupItem value={d} id={`bulk-${d}`} />
                          <Label htmlFor={`bulk-${d}`}>
                            {t(`uploads.destination.${d === "unassigned" ? "unassigned" : d}.label`)}
                          </Label>
                        </div>
                      ))}
                    </RadioGroup>
                    {(bulkDest === "kb" || bulkDest === "both") && (
                      <Select
                        value={bulkArchiveId}
                        onValueChange={setBulkArchiveId}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue
                            placeholder={t("uploads.destination.archive.placeholder")}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {archives.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <p className="text-sm text-muted-foreground">
                      {validCount} / {selectedCount}
                    </p>
                  </div>
                  <DialogFooter>
                    <Button
                      data-testid="bulk-assign-submit"
                      disabled={archiveMissing || isBulkAssigning}
                      title={archiveMissing ? t("uploads.bulkAssign.archiveRequired") : undefined}
                      onClick={handleBulkConfirm}
                    >
                      {isBulkAssigning && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {isBulkAssigning
                        ? t("uploads.bulkAssign.processing")
                        : t("uploads.bulkAssign.confirm")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              {/* quick 260826-fan — Retry Selected (D-03). Mirror the bulk-assign
                  Dialog structure: RadioGroup (rag/kb/both) + archive Select
                  when kb/both + valid/selected count + sequential dispatch. */}
              <Dialog open={bulkRetryOpen} onOpenChange={setBulkRetryOpen}>
                <DialogTrigger asChild>
                  <Button
                    className="min-h-[44px] sm:min-h-0"
                    disabled={selectedCount === 0}
                  >
                    {t("uploads.bulkRetry.confirm")}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t("uploads.bulkRetry.confirm")}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-2">
                    <RadioGroup
                      value={retryDest}
                      onValueChange={(v) => setRetryDest(v as "rag" | "kb" | "both")}
                      className="gap-3"
                    >
                      {(["rag", "kb", "both"] as const).map((d) => (
                        <div key={d} className="flex items-center gap-2">
                          <RadioGroupItem value={d} id={`bulk-retry-${d}`} />
                          <Label htmlFor={`bulk-retry-${d}`}>
                            {t(`uploads.retry.${d}`)}
                          </Label>
                        </div>
                      ))}
                    </RadioGroup>
                    {(retryDest === "kb" || retryDest === "both") && (
                      <Select
                        value={retryArchiveId}
                        onValueChange={setRetryArchiveId}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue
                            placeholder={t("uploads.destination.archive.placeholder")}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {archives.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <p className="text-sm text-muted-foreground">
                      {retryValidCount} / {selectedCount}
                    </p>
                  </div>
                  <DialogFooter>
                    <Button
                      data-testid="bulk-retry-submit"
                      disabled={retryArchiveMissing || isBulkRetrying}
                      title={retryArchiveMissing ? t("uploads.bulkRetry.archiveRequired") : undefined}
                      onClick={handleBulkRetryConfirm}
                    >
                      {isBulkRetrying && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {isBulkRetrying
                        ? t("uploads.bulkRetry.processing")
                        : t("uploads.bulkRetry.confirm")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              {/* D-03 — Delete Selected (destructive, disabled at 0 selected) */}
              <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="min-h-[44px] sm:min-h-0"
                    disabled={selectedCount === 0}
                  >
                    {t("uploads.bulkDelete.deleteSelected")}
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {t("uploads.bulkDelete.confirmTitle", { count: selected.size })}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="space-y-2 py-2">
                    <p className="text-sm">
                      {t("uploads.bulkDelete.confirmBody")}
                    </p>
                    {/* UI-SPEC typography reconciliation — 12px muted caption */}
                    <p className="text-xs text-muted-foreground">
                      {t("uploads.bulkDelete.doneNote")}
                    </p>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="ghost"
                      autoFocus
                      onClick={() => setBulkDeleteOpen(false)}
                    >
                      {t("uploads.bulkDelete.cancel")}
                    </Button>
                    <Button
                      variant="destructive"
                      data-testid="bulk-delete-submit"
                      onClick={handleBulkDeleteConfirm}
                    >
                      {t("uploads.bulkDelete.confirm", { count: selected.size })}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            <ul className="divide-y divide-border">
              {filtered.map((d) => {
                const rag = ragBadgeProps(d.ragStatus);
                const kb = kbBadgeProps(d.kbStatus);
                const destLabel = assignedToLabel(d, t);
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 p-2 sm:gap-4 sm:p-3">
                    <Checkbox
                      checked={selected.has(d.id)}
                      onCheckedChange={() => toggleSelect(d.id)}
                      aria-label={`select ${d.originalName}`}
                    />
                    <div className="flex-1 min-w-0">
                      {editingId === d.id ? (
                        /* D-06 inline rename — Enter/blur save, Esc cancel */
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleRename(d.id);
                          }}
                          className="flex gap-1 min-w-0"
                        >
                          <Input
                            type="text"
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingId(null);
                              }
                            }}
                            className="flex-1 min-w-0 px-1 py-0.5 h-auto text-sm"
                            autoFocus
                            onBlur={() => handleRename(d.id)}
                          />
                        </form>
                      ) : (
                        <>
                          {/* Title wraps (break-words) so long names stay visible
                             and the row height adapts to content instead of being
                             clipped by truncate — fixes 375px hidden-title crowding. */}
                          <p className="break-words text-sm font-medium">
                            {d.originalName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {d.mimeType} · {t("uploads.row.assignedTo", { destination: destLabel })}
                          </p>
                        </>
                      )}
                    </div>
                    {/* Right-side cluster: RAG/KB badges + retry + row actions.
                        w-full on narrow → wraps below the title (mandare a capo);
                        sm:w-auto → stays inline beside the title on wider screens. */}
                    <div className="flex items-center justify-end gap-2 w-full sm:w-auto">
                      <Badge
                        variant={rag.variant}
                        aria-label={rag.label}
                        className={`font-semibold ${rag.extra}`}
                      >
                        {rag.icon}
                        RAG
                      </Badge>
                      <Badge
                        variant={kb.variant}
                        aria-label={kb.label}
                        className={`font-semibold ${kb.extra}`}
                      >
                        {kb.icon}
                        KB
                      </Badge>
                      {d.ragEnabled !== false && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] sm:min-h-0"
                          onClick={() => handleRetryRag(d)}
                        >
                          <RotateCw className="h-3 w-3" />
                          {t("uploads.row.retryRag")}
                        </Button>
                      )}
                      {d.kbEnabled !== false && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] sm:min-h-0"
                          onClick={() => handleRetryKb(d)}
                        >
                          <RotateCw className="h-3 w-3" />
                          {t("uploads.row.retryKb")}
                        </Button>
                      )}
                      {/* 76-03 per-row action: pencil (rename). Single-delete is
                          handled by the top-bar "Delete Selected" bulk flow. */}
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] sm:min-h-0"
                          aria-label={t("uploads.row.rename")}
                          /* D-07 — rename allowed in every state, never disabled */
                          onClick={() => {
                            setEditingId(d.id);
                            setDraftName(d.originalName);
                          }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
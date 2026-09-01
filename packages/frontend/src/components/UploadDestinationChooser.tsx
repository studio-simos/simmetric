// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UploadDestinationChooser — Phase 71-05 Task 2.
 *
 * RadioGroup RAG / KB / Both / Decide-later (DST-01, D-02) — always visible
 * below the dropzone. KB selection reveals an archive Select populated from
 * useArchives. KB + PDF/image reveals OcrModeSelector (D-16). Invalid-MIME
 * options are disabled with an explanatory Tooltip (D-12). Image MIME rows
 * show a warning badge "Not assignable to RAG in v0.12" (D-12).
 *
 * Exports `destinationToAssignBody` — the UI→assignDraftSchema mapping
 * (RESEARCH Pattern 2): both → {rag,kb,archiveId?}, unassigned →
 * {rag:false,kb:false}, rag → {rag:true,kb:false}, kb →
 * {rag:false,kb:true,archiveId} (archiveId required).
 */

import { useTranslation } from "react-i18next";
import type { AssignDraftInput, DraftDestination } from "@simmetric-chat/shared";
import { useArchives } from "../queries/useArchives";
import OcrModeSelector from "./OcrModeSelector";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Label } from "./ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Badge } from "./ui/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
import { AlertTriangle } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  MIME validation matrix (RESEARCH Pattern 3, mirrors server-side)   */
/* ------------------------------------------------------------------ */

/** Image MIME — RAG leg not available in v0.12. */
// Intentionally not exported — internal MIME gates (Phase 180 sweep).
const RAG_BLOCKED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
]);

/** Archive MIME — KB leg dispatches via dispatchUploadToArchive (parse-only).
 * quick 260829-xxx: text/plain + text/csv added (txt/csv→KB gap closed ahead
 * of v0.13) — the collector's parse-only endpoint already parses both; this
 * set mirrors the server-side ALLOWED_ARCHIVE_MIME in routes/uploads.ts.
 * (The legacy xls MIME "application/vnd.ms-excel" was removed — the server
 * whitelist never had it; stage still accepts it, KB destination does not.) */
// Intentionally not exported — internal MIME gates (Phase 180 sweep).
const KB_ARCHIVE_MIME = new Set([
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/** OCR MIME — KB leg dispatches via createOcrJob (PDF + 4 image MIME). */
// Intentionally not exported — internal MIME gates (Phase 180 sweep).
const KB_OCR_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/tiff",
]);

/** KB leg eligible = archive MIME ∪ OCR MIME. */
const KB_ELIGIBLE_MIME = new Set<string>([...KB_ARCHIVE_MIME, ...KB_OCR_MIME]);

/**
 * isValidForDestination — D-12 + D-06 per-file MIME validation. Mirrors the
 * server-side matrix (uploads.ts assign route KB restriction, 71-02 amended
 * to ALLOWED_ARCHIVE_MIME ∪ KB_OCR_MIME — txt/csv KB-eligible since quick
 * 260829-xxx). UX-only — server re-validates.
 */
export function isValidForDestination(
  draftMimeType: string | undefined,
  dest: DraftDestination,
): boolean {
  if (!draftMimeType) return true; // no MIME context (pre-drop default) → allow
  if (dest === "rag") return !RAG_BLOCKED_MIME.has(draftMimeType);
  if (dest === "kb") return KB_ELIGIBLE_MIME.has(draftMimeType);
  if (dest === "both") {
    // both → must be valid for BOTH legs
    return !RAG_BLOCKED_MIME.has(draftMimeType) && KB_ELIGIBLE_MIME.has(draftMimeType);
  }
  return true; // unassigned always valid (stage-only)
}

/* ------------------------------------------------------------------ */
/*  destination → assignDraftSchema mapping (RESEARCH Pattern 2)       */
/* ------------------------------------------------------------------ */

export function destinationToAssignBody(
  dest: DraftDestination,
  archiveId?: string,
): AssignDraftInput {
  switch (dest) {
    case "rag":
      return { rag: true, kb: false };
    case "kb":
      if (!archiveId) {
        throw new Error("destinationToAssignBody: archiveId is required when dest=kb");
      }
      return { rag: false, kb: true, archiveId };
    case "both":
      // archiveId optional for "both" — RAG leg does not need it, KB leg does.
      // Server requires archiveId when kb=true; we pass it through when present.
      return archiveId
        ? { rag: true, kb: true, archiveId }
        : { rag: true, kb: true };
    case "unassigned":
    default:
      return { rag: false, kb: false };
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export interface UploadDestinationChooserProps {
  destination: DraftDestination;
  onDestinationChange: (d: DraftDestination) => void;
  archiveId?: string;
  onArchiveIdChange?: (id: string) => void;
  ocrMode?: string;
  onOcrModeChange?: (m: string) => void;
  /** MIME of the draft being assigned — used for D-12 disabling. Undefined = pre-drop default. */
  draftMimeType?: string;
}

const DEST_OPTIONS: Array<{
  value: DraftDestination;
  labelKey: string;
  helperKey: string;
  tooltipId: string;
}> = [
  { value: "rag", labelKey: "uploads.destination.rag.label", helperKey: "uploads.destination.rag.helper", tooltipId: "tooltip-rag" },
  { value: "kb", labelKey: "uploads.destination.kb.label", helperKey: "uploads.destination.kb.helper", tooltipId: "tooltip-kb" },
  { value: "both", labelKey: "uploads.destination.both.label", helperKey: "uploads.destination.both.helper", tooltipId: "tooltip-both" },
  { value: "unassigned", labelKey: "uploads.destination.unassigned.label", helperKey: "uploads.destination.unassigned.helper", tooltipId: "tooltip-unassigned" },
];

export default function UploadDestinationChooser({
  destination,
  onDestinationChange,
  archiveId,
  onArchiveIdChange,
  ocrMode,
  onOcrModeChange,
  draftMimeType,
}: UploadDestinationChooserProps) {
  const { t } = useTranslation();
  const { data: archives = [] } = useArchives();

  const showArchivePicker = destination === "kb" || destination === "both";
  const showOcrMode =
    (destination === "kb" || destination === "both") &&
    !!draftMimeType &&
    KB_OCR_MIME.has(draftMimeType);
  const isImage = !!draftMimeType && RAG_BLOCKED_MIME.has(draftMimeType);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("uploads.destination.heading")}</CardTitle>
        <CardDescription>{t("uploads.destination.helper")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <TooltipProvider>
          <RadioGroup
            value={destination}
            onValueChange={(v) => onDestinationChange(v as DraftDestination)}
            className="gap-3"
          >
            {DEST_OPTIONS.map((opt) => {
              const valid = isValidForDestination(draftMimeType, opt.value);
              const tooltipText =
                opt.value === "rag" && !valid
                  ? t("uploads.tooltip.imagesRag")
                  : opt.value === "kb" && !valid
                  ? t("uploads.tooltip.kbMime")
                  : null;
              return (
                <div key={opt.value} className="flex items-start gap-3">
                  <div className="flex items-center gap-2 pt-1">
                    <RadioGroupItem
                      value={opt.value}
                      id={`dest-${opt.value}`}
                      disabled={!valid}
                      aria-describedby={!valid ? opt.tooltipId : undefined}
                    />
                    <Label htmlFor={`dest-${opt.value}`} className="font-medium">
                      {t(opt.labelKey)}
                    </Label>
                  </div>
                  <div className="flex-1 text-sm text-muted-foreground">
                    {t(opt.helperKey)}
                  </div>
                  {!valid && tooltipText && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          id={opt.tooltipId}
                          role="tooltip"
                          className="sr-only"
                          data-testid={opt.tooltipId}
                        >
                          {tooltipText}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {tooltipText}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </RadioGroup>
        </TooltipProvider>

        {isImage && (
          <Badge
            variant="outline"
            className="font-semibold text-muted-foreground"
          >
            <AlertTriangle className="h-3 w-3" />
            {t("uploads.row.imageRagGap")}
          </Badge>
        )}

        {showArchivePicker && (
          <div className="space-y-2">
            <Select
              value={archiveId}
              onValueChange={(v) => onArchiveIdChange?.(v)}
            >
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue placeholder={t("uploads.destination.archive.placeholder")} />
              </SelectTrigger>
              <SelectContent>
                {archives.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {archives.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t("uploads.destination.archive.empty")}
              </p>
            )}
          </div>
        )}

        {showOcrMode && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("uploads.ocrMode.heading")}</p>
            <OcrModeSelector
              value={ocrMode ?? "text"}
              onChange={(m) => onOcrModeChange?.(m)}
              supportedModes={["text", "vision", "custom"]}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
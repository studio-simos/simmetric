// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CircleCheck } from "lucide-react";
import { renderMarkdown } from "../utils/markdown";
import type { SynthesisChange } from "../queries/useSynthesis";

import { cn } from "@/lib/utils"
interface SynthesisDiffViewProps {
  change: SynthesisChange;
  isApproved: boolean;
  isPending: boolean;
  hasConflict: boolean;
  onToggleApproval: (approved: boolean) => void;
}

function hasContradictions(text: string): boolean {
  return /\[CONTRADICTION/i.test(text);
}

function highlightContradictions(html: string): string {
  return html.replace(
    /(\[CONTRADICTION[^\]]*\])/gi,
    '<mark class="bg-accent text-accent-foreground px-1 rounded">$1</mark>'
  );
}

export default function SynthesisDiffView({
  change,
  isApproved,
  isPending,
  hasConflict,
  onToggleApproval,
}: SynthesisDiffViewProps) {
  const { t } = useTranslation();
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const syncInProgress = useRef(false);

  const conflictInProposed = hasContradictions(change.proposedContent);
  const conflictInCurrent = change.currentContent
    ? hasContradictions(change.currentContent)
    : false;
  const showContradictionBanner = conflictInProposed || conflictInCurrent;

  const currentHtml = change.currentContent
    ? highlightContradictions(renderMarkdown(change.currentContent))
    : "";

  const proposedHtml = highlightContradictions(renderMarkdown(change.proposedContent));

  const handleLeftScroll = () => {
    if (syncInProgress.current || !rightScrollRef.current || !leftScrollRef.current)
      return;
    syncInProgress.current = true;
    const leftEl = leftScrollRef.current;
    const rightEl = rightScrollRef.current;
    const maxScrollLeft = leftEl.scrollHeight - leftEl.clientHeight;
    if (maxScrollLeft <= 0) {
      syncInProgress.current = false;
      return;
    }
    const scrollRatio = leftEl.scrollTop / maxScrollLeft;
    rightEl.scrollTop = scrollRatio * (rightEl.scrollHeight - rightEl.clientHeight);
    requestAnimationFrame(() => {
      syncInProgress.current = false;
    });
  };

  const handleRightScroll = () => {
    if (syncInProgress.current || !leftScrollRef.current || !rightScrollRef.current)
      return;
    syncInProgress.current = true;
    const leftEl = leftScrollRef.current;
    const rightEl = rightScrollRef.current;
    const maxScrollRight = rightEl.scrollHeight - rightEl.clientHeight;
    if (maxScrollRight <= 0) {
      syncInProgress.current = false;
      return;
    }
    const scrollRatio = rightEl.scrollTop / maxScrollRight;
    leftEl.scrollTop = scrollRatio * (leftEl.scrollHeight - leftEl.clientHeight);
    requestAnimationFrame(() => {
      syncInProgress.current = false;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Page title and metadata */}
      <div className="flex items-center gap-2">
        <h3 style={{ fontSize: "20px", fontWeight: 600, lineHeight: 1.2 }}>
          {t("synthesis.diff.title", { pageTitle: change.title })}
        </h3>
        {isApproved && (
          <Badge className="bg-secondary text-secondary-foreground gap-1">
            <CircleCheck className="w-3 h-3" />
            Approved
          </Badge>
        )}
      </div>

      {/* Contradiction banner */}
      {showContradictionBanner && (
        <div className="flex items-center gap-2 p-2 rounded bg-accent text-accent-foreground text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{t("synthesis.diff.contradictionBanner")}</span>
        </div>
      )}

      {/* Diff panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left panel: Current */}
        <div className="flex flex-col">
          <p
            className="text-xs font-semibold text-muted-foreground mb-2"
            style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {t("synthesis.diff.current")}
          </p>
          <div className="rounded-lg border border-border overflow-hidden">
            {change.action === "create" ? (
              <div className="p-4 text-sm text-muted-foreground bg-card">
                {t("synthesis.diff.newPage")}
              </div>
            ) : (
              <ScrollArea className="h-[400px]">
                <div
                  ref={leftScrollRef}
                  onScroll={handleLeftScroll}
                  className="p-4 prose prose-sm dark:prose-invert max-w-none text-sm"
                  style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}
                  dangerouslySetInnerHTML={{ __html: currentHtml }}
                />
              </ScrollArea>
            )}
          </div>
        </div>

        {/* Right panel: Proposed */}
        <div className="flex flex-col">
          <p
            className="text-xs font-semibold text-muted-foreground mb-2"
            style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}
          >
            {t("synthesis.diff.proposed")}
          </p>
          <div
            className={cn("rounded-lg border border-border overflow-hidden", change.action === "create"
                ? "bg-secondary dark:bg-green-950"
                : "")}
          >
            <ScrollArea className="h-[400px]">
              <div
                ref={rightScrollRef}
                onScroll={handleRightScroll}
                className="p-4 prose prose-sm dark:prose-invert max-w-none text-sm"
                style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}
                dangerouslySetInnerHTML={{ __html: proposedHtml }}
              />
            </ScrollArea>
          </div>
        </div>
      </div>

      <Separator />

      {/* Approval controls */}
      {isApproved && (
        <div className="flex items-center gap-2 text-sm text-secondary-foreground">
          <CircleCheck className="w-4 h-4" />
          Approved
        </div>
      )}

      {hasConflict && isPending && (
        <div className="flex items-center gap-2 p-2 rounded bg-accent text-accent-foreground text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {t("synthesis.detail.conflictWarning")}
        </div>
      )}

      {isPending && !hasConflict && (
        <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            checked={false}
            onChange={(e) => onToggleApproval(e.target.checked)}
            className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
          />
          <span className="text-sm" style={{ fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }}>
            {t("synthesis.diff.approveCheckbox", {
              pageTitle: change.title,
              confidence: change.confidence,
            })}
          </span>
        </label>
      )}
    </div>
  );
}

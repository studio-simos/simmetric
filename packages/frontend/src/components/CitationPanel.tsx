// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { SourceCitation } from "../hooks/useChat";

interface CitationPanelProps {
  sources: SourceCitation[];
  onClose: () => void;
}

export default function CitationPanel({ sources, onClose }: CitationPanelProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  // Auto-expand the first citation on open so chunkText is immediately visible.
  // The user can still collapse/expand individual citations via click.
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);

  const citationList = (
    <>
      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">{t("chat.noSourcesAvailable")}</p>
      ) : (
        sources.map((source, i) => (
          <div
            key={`${source.documentId}-${i}`}
            className="bg-muted border border-border rounded-lg overflow-hidden"
          >
            <Button
              variant="ghost"
              onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
              className="w-full text-left px-4 py-3 justify-start h-auto hover:bg-muted transition-colors"
            >
              <div className="flex items-start gap-2">
                <Avatar className="w-6 h-6 shrink-0">
                  <AvatarFallback className="text-xs font-medium text-primary-foreground bg-primary">{i + 1}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{source.documentName}</p>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {source.pageNumber && (
                      <span className="text-xs text-muted-foreground">
                        {t("chat.citations.page", { n: source.pageNumber, defaultValue: "Page {{n}}" })}
                      </span>
                    )}
                    {source.lineStart !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        {source.lineEnd !== undefined && source.lineEnd !== source.lineStart
                          ? t("chat.citations.lines", { start: source.lineStart, end: source.lineEnd, defaultValue: "Lines {{start}}–{{end}}" })
                          : t("chat.citations.line", { n: source.lineStart, defaultValue: "Line {{n}}" })}
                      </span>
                    )}
                    {source.paragraph && (
                      <span className="text-xs text-muted-foreground">¶{source.paragraph}</span>
                    )}
                    {source.score !== undefined && (
                      <span className="text-xs text-muted-foreground">
                        {(source.score * 100).toFixed(1)}% match
                      </span>
                    )}
                    {source.source === "archive" && (
                      <span className="inline-flex items-center rounded text-[10px] font-semibold uppercase tracking-wider bg-primary/15 text-primary px-1.5 py-0.5">
                        {t("chat.archive.badge")}
                      </span>
                    )}
                  </div>
                </div>
                <svg
                  className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expandedIndex === i ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </Button>

            {expandedIndex === i && source.chunkText && (
              <div className="px-4 pb-3">
                <div className="text-xs text-muted-foreground bg-card border border-border rounded p-3 leading-relaxed whitespace-pre-wrap">
                  {source.chunkText}
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </>
  );

  if (isMobile) {
    return (
      <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
        <SheetContent side="bottom" className="max-h-[80vh] flex flex-col">
          <SheetHeader>
            <SheetTitle>{t("chat.sources")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {citationList}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-card border-l border-border shadow-xl z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-lg font-semibold text-foreground">{t("chat.sources")}</h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="text-muted-foreground hover:text-muted-foreground transition-colors"
          title={t("common.close")}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {citationList}
      </div>
    </div>
  );
}

/**
 * CitationBadge — inline citation number rendered below assistant messages.
 * Clicking opens the CitationPanel.
 */
export function CitationBadge({ index, onClick }: { index: number; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-primary text-primary-foreground hover:opacity-80 transition-opacity"
      title={`Source ${index + 1}`}
    >
      {index + 1}
    </Button>
  );
}
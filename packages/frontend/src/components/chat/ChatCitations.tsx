// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useId } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourceCitation } from "../../hooks/useChat";

/**
 * ChatCitations — inline, expandable citation list below an assistant message.
 *
 * Feature 4.2.4: each citation shows document name + page + score + a 2-line
 * snippet (`chunkText`, line-clamped). Feature 4.7.2: expand AND collapse
 * animate — the list stays mounted and the `.chat-citation-list` / `.is-open`
 * classes (chat-theme.css) drive a max-height + opacity transition in both
 * directions (the old one-shot animation only handled expand).
 * Feature 4.9.1: role="region" aria-label="Sources"; the chevron rotates
 * ▸ → ▾ and carries aria-expanded/aria-controls.
 *
 * Clicking a row opens the full CitationPanel overlay via `onOpenPanel`.
 */
export interface ChatCitationsProps {
  sources: SourceCitation[];
  onOpenPanel?: (sources: SourceCitation[]) => void;
}

export function ChatCitations({ sources, onOpenPanel }: ChatCitationsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();

  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-2" role="region" aria-label={t("chat.citations.label", "Sources")}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={regionId}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform duration-200", expanded && "rotate-90")}
          aria-hidden="true"
        />
        <span className="chat-citation-count">
          {t("chat.citations.toggle", { count: sources.length, defaultValue: "Sources ({{count}})" })}
        </span>
      </button>

      <ul id={regionId} className={cn("chat-citation-list mt-1.5 space-y-1.5", expanded && "is-open")}>
        {sources.map((source, i) => (
          <li key={`${source.documentId}-${i}`}>
            <button
              type="button"
              onClick={() => onOpenPanel?.(sources)}
              className="w-full text-left flex items-start gap-2 rounded border border-border bg-card px-2 py-1.5 hover:border-primary/40 hover:bg-accent/30 transition-theme focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("chat.citations.openSource", { name: source.documentName, defaultValue: "Open source: {{name}}" })}
            >
              <span className="inline-flex items-center justify-center size-4 shrink-0 rounded-full text-[10px] font-bold bg-primary text-primary-foreground mt-0.5">
                {i + 1}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium text-foreground truncate">
                  {source.documentName}
                </span>
                <span className="flex items-center gap-2 mt-0.5">
                  {source.pageNumber && (
                    <span className="text-[10px] text-muted-foreground">
                      {t("chat.citations.page", { n: source.pageNumber, defaultValue: "Page {{n}}" })}
                    </span>
                  )}
                  {source.score !== undefined && (
                    <span className="text-[10px] text-muted-foreground">
                      {(source.score * 100).toFixed(1)}%
                    </span>
                  )}
                </span>
                {source.chunkText && (
                  <span className="block text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
                    {source.chunkText}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}


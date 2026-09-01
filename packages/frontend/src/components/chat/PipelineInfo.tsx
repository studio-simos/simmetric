// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Search, FileText, Database, Brain } from "lucide-react";

interface PipelineInfoProps {
  toolsCalled: string[];
  sourcesFound: number;
  ragSearched: boolean;
  ragResults: number;
}

export function PipelineInfo({ toolsCalled, sourcesFound, ragSearched, ragResults }: PipelineInfoProps) {
  const { t } = useTranslation();

  // Determine the primary source of information
  const hasSources = sourcesFound > 0;
  const hasRag = ragSearched && ragResults > 0;
  const hasWiki = toolsCalled.includes("wiki_query");
  const hasMemory = toolsCalled.includes("workspace_memory") || toolsCalled.includes("memory_search");
  const hasWebSearch = toolsCalled.includes("web_search");
  const usedTools = toolsCalled.length > 0;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/60">
      {/* Source indicator */}
      {hasSources ? (
        <span className="inline-flex items-center gap-1 rounded bg-primary/10 text-primary/70 px-1.5 py-0.5">
          <FileText className="size-2.5" />
          {t("chat.pipeline.fromDocuments", "Da documenti")}
        </span>
      ) : usedTools ? (
        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-600/70 dark:text-amber-400/70 px-1.5 py-0.5">
          <Brain className="size-2.5" />
          {t("chat.pipeline.fromModel", "Da conoscenza del modello")}
        </span>
      ) : null}

      {/* Tool badges */}
      {hasRag && (
        <span className="inline-flex items-center gap-1">
          <Search className="size-2.5" />
          RAG
        </span>
      )}
      {hasWiki && <span>Wiki</span>}
      {hasMemory && (
        <span className="inline-flex items-center gap-1">
          <Database className="size-2.5" />
          Memoria
        </span>
      )}
      {hasWebSearch && <span>Web</span>}

      {/* Sources count */}
      {hasSources && (
        <span>
          {t("chat.pipeline.sourcesCount", { count: sourcesFound, defaultValue: "{{count}} fonti" })}
        </span>
      )}

      {/* No tools used */}
      {!usedTools && !hasSources && (
        <span className="inline-flex items-center gap-1">
          <Brain className="size-2.5" />
          {t("chat.pipeline.directResponse", "Risposta diretta")}
        </span>
      )}
    </div>
  );
}

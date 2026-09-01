// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { FileText, BrainCircuit, Wrench, Gauge } from "lucide-react";
import { GlitchText } from "../GlitchText";
import { ChatModelBadge } from "./ChatModelBadge";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useArchives } from "../../queries/useArchives";
import { useSessionTokens } from "../../queries/useChatTokens";
import { formatTokens } from "../../utils/tokens";

/**
 * ChatEmptyState — "Simmetric Native" terminal status board (Feature 4.4.1).
 *
 * Replaces the generic suggested-prompt grid (which the spec explicitly
 * forbade) with a context-aware status board: a 2×2 grid of cards that report
 * real workspace state — indexed documents, knowledge-base archives, the
 * built-in skill set, and today's token usage — plus a header "SIMMETRIC CHAT //
 * READY" and a footer carrying the active model + air-gap status.
 *
 * The two actionable cards ("Ask about your documents", "Search the knowledge
 * base") emit a context-aware prompt via `onQuickAction`; the skills + token
 * cards are status display only. Counts come from TanStack hooks (dedup'd with
 * the rest of the app) or optional props; missing values fall back to "—".
 */
export interface ChatEmptyStateProps {
  /** Active workspace — drives the session-token + archives queries. */
  workspaceId?: string;
  /** Override for indexed-document count (otherwise "—"). */
  documentCount?: number;
  /** Active model shown in the footer badge. */
  activeModel?: { providerId?: string; model?: string; modelProvider?: string };
  /** When true, an "AIR-GAPPED" status badge is shown in the footer. */
  airGapped?: boolean;
  onQuickAction?: (prompt: string) => void;
}

/** Built-in agent skills (CLAUDE_NEW.md) — static, air-gap available. */
const BUILTIN_SKILLS = ["rag_search", "workspace_memory", "document_temp_process", "wiki_query", "wiki_write"];

function orDash(n: number | undefined): string {
  return typeof n === "number" ? String(n) : "—";
}

export function ChatEmptyState({
  workspaceId,
  documentCount,
  activeModel,
  airGapped,
  onQuickAction,
}: ChatEmptyStateProps) {
  const { t } = useTranslation();
  const { data: archives = [] } = useArchives(!!workspaceId);
  const { data: sessionTokens } = useSessionTokens(workspaceId);

  const kbCount = archives.length;
  const tokensToday = sessionTokens?.total;

  return (
    <div
      className="flex flex-col items-center justify-center h-full text-center px-4 py-8 gap-6"
      role="status"
      aria-live="polite"
    >
      {/* Header — terminal status board title. */}
      <div className="flex flex-col items-center gap-1">
        <GlitchText
          as="h2"
          text={t("chat.emptyState.ready", "SIMMETRIC CHAT // READY")}
          className="text-lg tracking-wider text-primary"
        />
        <p className="text-xs font-mono text-muted-foreground">
          {t("chat.emptyState.subtitle", "Ask anything, or pick a quick start below.")}
        </p>
      </div>

      {/* 2×2 status board. */}
      <div
        className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg"
        role="list"
        aria-label={t("chat.emptyState.actionsLabel", "Quick start actions")}
      >
        {/* Card 1 — indexed documents (actionable). */}
        <button
          type="button"
          role="listitem"
          onClick={() => onQuickAction?.(t("chat.emptyState.action.docs.prompt", "Summarize the key points of my indexed documents"))}
          className="chat-quick-card group flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("chat.emptyState.action.docs.label", "Ask about your documents")}
        >
          <FileText className="size-5 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-foreground leading-snug">
              {t("chat.emptyState.action.docs.label", "Ask about your documents")}
            </span>
            <span className="block text-[11px] font-mono text-muted-foreground mt-0.5">
              {t("chat.emptyState.docs", "{{count}} indexed").replace("{{count}}", orDash(documentCount))}
            </span>
          </span>
        </button>

        {/* Card 2 — knowledge base (actionable). */}
        <button
          type="button"
          role="listitem"
          onClick={() => onQuickAction?.(t("chat.emptyState.action.kb.prompt", "Search the knowledge base for: "))}
          className="chat-quick-card group flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("chat.emptyState.action.kb.label", "Search knowledge base")}
        >
          <BrainCircuit className="size-5 shrink-0 text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-foreground leading-snug">
              {t("chat.emptyState.action.kb.label", "Search knowledge base")}
            </span>
            <span className="block text-[11px] font-mono text-muted-foreground mt-0.5">
              {t("chat.emptyState.kb", "{{count}} archives").replace("{{count}}", String(kbCount))}
            </span>
          </span>
        </button>

        {/* Card 3 — available skills (status only). */}
        <div
          role="listitem"
          className="chat-quick-card group flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left"
          aria-label={t("chat.emptyState.skills", "Available skills")}
        >
          <Wrench className="size-5 shrink-0 text-muted-foreground" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-foreground leading-snug">
              {t("chat.emptyState.skills", "Available skills")}
            </span>
            <span className="block text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
              {BUILTIN_SKILLS.join(" · ")}
            </span>
          </span>
        </div>

        {/* Card 4 — token usage today (status only). */}
        <div
          role="listitem"
          className="chat-quick-card group flex items-start gap-3 rounded-lg border border-border bg-card p-3 text-left"
          aria-label={t("chat.emptyState.tokensToday", "Token usage today")}
        >
          <Gauge className="size-5 shrink-0 text-muted-foreground" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm text-foreground leading-snug">
              {t("chat.emptyState.tokensToday", "Token usage today")}
            </span>
            <span className="block text-[11px] font-mono text-muted-foreground mt-0.5">
              {tokensToday !== undefined ? formatTokens(tokensToday) : "—"}
            </span>
          </span>
        </div>
      </div>

      {/* Footer — active model + air-gap status. */}
      <div className="flex items-center gap-2 flex-wrap justify-center">
        <ChatModelBadge
          providerId={activeModel?.providerId}
          model={activeModel?.model}
          modelProvider={activeModel?.modelProvider}
          size="sm"
          className={cn(!activeModel?.model && "opacity-70")}
        />
        {airGapped && (
          <Badge variant="outline" className="text-[10px] font-mono border-[var(--chat-accent)] text-[var(--chat-accent)]">
            {t("chat.emptyState.airgapped", "AIR-GAPPED")}
          </Badge>
        )}
      </div>
    </div>
  );
}


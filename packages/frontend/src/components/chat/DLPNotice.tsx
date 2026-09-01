// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert, ChevronDown, ChevronRight, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DLPNoticeProps {
  matches: Array<{ type: string; text: string }>;
  isAdmin: boolean;
  /**
   * Quick 260829-spj: global "Show DLP texts" preference (ChatPanel →
   * ChatMessage). Seeds the per-notice reveal state; when the global toggle
   * flips, the effect below syncs ALL notices uniformly. A user can still
   * override per-notice with the eye button between global toggles.
   */
  showTextDefault?: boolean;
}

/** Count matches per type */
function groupByType(matches: Array<{ type: string; text: string }>): Array<{ type: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const m of matches) {
    counts[m.type] = (counts[m.type] || 0) + 1;
  }
  return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

export function DLPNotice({ matches, isAdmin, showTextDefault = false }: DLPNoticeProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(isAdmin);
  const [showText, setShowText] = useState(showTextDefault);

  // Quick 260829-spj: follow the global "Show DLP texts" toggle whenever it
  // changes. Placed before the early returns so hook order stays stable.
  useEffect(() => {
    setShowText(showTextDefault);
  }, [showTextDefault]);

  if (!matches || matches.length === 0) return null;

  const grouped = groupByType(matches);
  const totalCount = matches.length;

  // Non-admin: collapsed badge only, no expand
  if (!isAdmin) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-amber-50/10 dark:bg-amber-950/20 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
      >
        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
        <span>{t("dlp.notice.badge")}</span>
      </div>
    );
  }

  // Admin: expandable
  return (
    <div
      className={cn(
        "mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] border-l-2 border-l-amber-400",
      )}
    >
      {/* Collapsed header — always visible */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls="dlp-notice-body"
        className={cn(
          "flex w-full items-center gap-1.5 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300 hover:bg-[var(--surface-hover)] transition-colors rounded-t-lg",
          isExpanded && "rounded-b-none border-b border-[var(--border)]",
        )}
      >
        <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
        <span>{t("dlp.notice.badgeWithCount", { count: totalCount })}</span>
        {isExpanded ? (
          <ChevronDown className="w-3 h-3 ml-auto shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 ml-auto shrink-0" />
        )}
      </button>

      {/* Expanded body */}
      {isExpanded && (
        <div id="dlp-notice-body" className="px-3 py-2 space-y-2">
          {/* Match type pills */}
          <div className="flex items-center gap-1.5 flex-wrap" role="list">
            {grouped.map(({ type, count }) => (
              <span
                key={type}
                role="listitem"
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--surface-alt)] text-[var(--text-muted)]"
              >
                {t("dlp.notice.matchType", { type, count })}
              </span>
            ))}
          </div>

          {/* Show text toggle */}
          <button
            type="button"
            onClick={() => setShowText(!showText)}
            aria-expanded={showText}
            className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
          >
            {showText ? (
              <>
                <EyeOff className="w-3 h-3" />
                {t("dlp.notice.hideText")}
              </>
            ) : (
              <>
                <Eye className="w-3 h-3" />
                {t("dlp.notice.showText")}
              </>
            )}
          </button>

          {/* Matched text snippets */}
          {showText && (
            <div className="space-y-1">
              {matches.map((match, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <span className="text-xs font-medium text-[var(--text-muted)] shrink-0 mt-0.5 w-16">
                    {match.type}
                  </span>
                  <code className="text-xs font-mono bg-[var(--surface-alt)] rounded p-1.5 overflow-x-auto break-all text-[var(--text-muted)] flex-1">
                    {match.text}
                  </code>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


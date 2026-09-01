// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

import { cn } from "@/lib/utils"
interface SynthesisBudgetBarProps {
  pagesRead: number;
  maxPagesRead: number;
  pagesWritten: number;
  maxPagesWritten: number;
  tokensUsed: number;
  maxTokens: number;
  llmCallsUsed: number;
  maxLlmCalls: number;
  isInProgress?: boolean;
  currentPage?: number;
  totalPages?: number;
}

function budgetColor(used: number, max: number): string {
  if (max <= 0) return "text-muted-foreground";
  const pct = (used / max) * 100;
  if (pct >= 100) return "text-destructive-foreground";
  if (pct >= 80) return "text-accent-foreground";
  return "text-secondary-foreground";
}

function progressIndicatorClass(used: number, max: number): string {
  if (max <= 0) return "";
  const pct = (used / max) * 100;
  if (pct >= 100) return "[&>span]:bg-destructive-foreground";
  if (pct >= 80) return "[&>span]:bg-accent-foreground";
  return "[&>span]:bg-secondary-foreground";
}

export default function SynthesisBudgetBar({
  pagesRead,
  maxPagesRead,
  pagesWritten,
  maxPagesWritten,
  tokensUsed,
  maxTokens,
  llmCallsUsed,
  maxLlmCalls,
  isInProgress,
  currentPage,
  totalPages,
}: SynthesisBudgetBarProps) {
  const { t } = useTranslation();

  const rows = [
    { label: t("synthesis.budget.pagesRead"), used: pagesRead, max: maxPagesRead },
    { label: t("synthesis.budget.pagesWritten"), used: pagesWritten, max: maxPagesWritten },
    { label: t("synthesis.budget.tokensUsed"), used: tokensUsed, max: maxTokens },
    { label: t("synthesis.budget.llmCallsUsed"), used: llmCallsUsed, max: maxLlmCalls },
  ];

  const anyExhausted = rows.some((r) => r.max > 0 && r.used >= r.max);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}>
          {t("synthesis.budget.title")}
        </h3>
        <Separator className="flex-1" />
      </div>

      {isInProgress && currentPage !== undefined && totalPages !== undefined && (
        <p className="text-xs text-accent-foreground" style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}>
          {t("synthesis.budget.inProgress", { current: currentPage, total: totalPages })}
        </p>
      )}

      {anyExhausted && (
        <p className="text-xs text-destructive-foreground" style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}>
          {t("synthesis.budget.exhausted", {
            pagesWritten,
            maxPages: maxPagesWritten,
            tokensUsed,
            maxTokens,
          })}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const pct = row.max > 0 ? Math.min((row.used / row.max) * 100, 100) : 0;
          return (
            <div key={row.label} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-muted-foreground" style={{ fontSize: "12px", fontWeight: 600, lineHeight: 1.2 }}>
                  {row.label}
                </span>
                <Badge variant="secondary" className={budgetColor(row.used, row.max)}>
                  {row.used} / {row.max}
                </Badge>
              </div>
              <Progress
                value={pct}
                className={cn("h-1.5", progressIndicatorClass(row.used, row.max))}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

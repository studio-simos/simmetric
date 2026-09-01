// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardList, Search, MessageSquare, ChevronDown } from "lucide-react";
import type { AgentPlan } from "@simmetric-chat/shared";
import { cn } from "@/lib/utils";

/**
 * PlanBanner — collapsible banner that renders the structured plan emitted
 * during the planning phase (plan mode). Shown above the in-flight streaming
 * response, and above persisted assistant messages that carry a plan in
 * their metadata.
 *
 * Behavior (see design spec §4):
 *  - Enters with a slide-down + fade-in (200ms) animation.
 *  - Expanded by default while streaming.
 *  - Auto-collapse to a one-line summary 3s after `done` flips true.
 *  - Click the collapsed bar to re-expand; click again to collapse.
 *  - Persisted banners (reloaded chats) start collapsed (`defaultExpanded=false`).
 *  - Accessible: `aria-expanded`, `aria-controls`, keyboard-activatable button.
 */
export interface PlanBannerProps {
  plan: AgentPlan;
  /** True once the final response has arrived — triggers the 3s auto-collapse. */
  done?: boolean;
  /** Initial expansion state. Defaults to true (streaming-time banners). */
  defaultExpanded?: boolean;
  className?: string;
}

export function PlanBanner({ plan, done = false, defaultExpanded = true, className }: PlanBannerProps) {
  const { t } = useTranslation();
  const panelId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [mounted, setMounted] = useState(false);

  // Slide-down + fade-in on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Auto-collapse 3s after the final response arrives.
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setExpanded(false), 3000);
    return () => clearTimeout(id);
  }, [done]);

  const stepCount = plan.steps.length;
  const firstToolStep = plan.steps.find((s) => s.tool);

  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--border)] bg-[var(--surface-alt)] transition-all duration-200",
        mounted ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1",
        className,
      )}
      role="region"
      aria-label={t("planBanner.title", "Plan")}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          "focus:outline-none focus:ring-2 focus:ring-primary rounded-lg",
        )}
      >
        <ClipboardList className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-medium text-[var(--text)] truncate">
          {t("planBanner.title", "Plan")}
          {firstToolStep ? (
            <span className="text-[var(--text-muted)] font-normal"> · {firstToolStep.action}</span>
          ) : null}
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs text-[var(--text-muted)]">
          <span>{t("planBanner.stepCount", { count: stepCount, defaultValue: `{{count}} step${stepCount === 1 ? "" : "s"}` })}</span>
          <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </span>
      </button>

      {expanded && (
        <div id={panelId} className="border-t border-[var(--border)] px-3 pb-2 pt-1">
          <p className="text-sm font-semibold text-[var(--text)] py-1">{plan.goal}</p>
          <ol className="space-y-1">
            {plan.steps.map((s, i) => {
              const isTool = !!s.tool;
              const Icon = isTool ? Search : MessageSquare;
              return (
                <li key={i} className="flex items-start gap-2 text-sm text-[var(--text-muted)]">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-mono text-primary">
                    {i + 1}
                  </span>
                  <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                  <span className="min-w-0">
                    {s.action}
                    {isTool && <span className="ml-1 text-[10px] font-mono text-[var(--text-subtle)]">[{s.tool}]</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}


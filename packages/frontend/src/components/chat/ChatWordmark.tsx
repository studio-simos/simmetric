// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ChatWordmark — the elegant, monochrome wordmark shown at the center of the
 * chat when it is empty (UI revision R-2, replacing the former glitch
 * tri-color "SIMMETRIC CHAT // READY" title).
 *
 * Rules (REVISIONE_UI.md §4):
 * - Monochrome ONLY: `--foreground` / `--foreground/90` / `--muted-foreground`.
 *   No `--primary`, no neon, no glitch layers — reads elegantly in every
 *   theme (light Pearl, dark, hacker, system-resolved).
 * - White-label aware: renders `appName` (BRANDING_APP_NAME) — falls back to
 *   the i18n `app.name`.
 * - The optional micro status badge (e.g. "READY") stays mono 10px
 *   muted-foreground; under the hacker theme it may pick up the chat accent.
 */

import { useTranslation } from "react-i18next";
import Monogram from "../Monogram";
import { cn } from "@/lib/utils";

export interface ChatWordmarkProps {
  /** White-label app name (BRANDING_APP_NAME); empty → i18n app.name. */
  appName?: string;
  /** Optional micro status line (e.g. "READY") rendered under the subtitle. */
  statusLine?: string;
  className?: string;
}

export default function ChatWordmark({ appName, statusLine, className }: ChatWordmarkProps) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex flex-col items-center gap-3 select-none", className)}>
      <Monogram size={56} color="var(--foreground)" className="opacity-90" />
      <h2 className="text-2xl font-medium tracking-wide text-foreground/90">
        {appName || t("app.name")}
      </h2>
      <p className="text-xs text-muted-foreground tracking-wide">
        {t("chat.emptyState.subtitle", "Ask anything, or pick a quick start below.")}
      </p>
      {statusLine && (
        <p
          className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/80"
          aria-hidden="true"
        >
          {statusLine}
        </p>
      )}
    </div>
  );
}
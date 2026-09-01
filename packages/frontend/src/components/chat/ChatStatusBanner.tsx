// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * ChatStatusBanner — mono status line above the input (Feature 4.1.1 + 4.2.3).
 *
 * Renders the SSE `status` message (e.g. "Searching documents…") in a terminal
 * style with a leading block cursor `▌`. Fades in/out between states via the
 * `.chat-status-banner` class. aria-live="polite" announces the phase once,
 * not per token (coherent with Feature 4.9.2 — the per-stream announcement is
 * owned by ChatMessageList, this banner is purely visual).
 *
 * Renders nothing when `statusMessage` is null.
 */
export interface ChatStatusBannerProps {
  statusMessage: string | null;
  className?: string;
}

export function ChatStatusBanner({ statusMessage, className }: ChatStatusBannerProps) {
  const { t } = useTranslation();
  if (!statusMessage) return null;

  return (
    <div
      className={cn(
        "chat-status-banner flex items-center gap-2 px-3 py-1.5 text-xs font-mono",
        "bg-[var(--chat-status-banner-bg)] text-muted-foreground border-t border-[var(--chat-border)]",
        className,
      )}
      role="status"
      aria-live="polite"
      aria-label={t("chat.status.bannerLabel", "Assistant status")}
    >
      <span className="text-[var(--chat-accent)]" aria-hidden="true">▌</span>
      <span className="truncate">{statusMessage}</span>
    </div>
  );
}


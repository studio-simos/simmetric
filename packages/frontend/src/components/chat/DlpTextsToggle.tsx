// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DlpTextsToggleProps {
  /**
   * Render gate — the item only exists for admins (same `admin:settings`
   * gate as DLPNotice in ChatMessage.tsx: non-admins can never reveal
   * DLP-redacted text, so the toggle would be dead UI for them).
   */
  visible: boolean;
  /** Current global preference: true = matched texts revealed across all notices. */
  checked: boolean;
  onToggle: (next: boolean) => void;
}

/**
 * DlpTextsToggle — "Show DLP texts" / "Hide DLP texts" item for the chat
 * "+" more-actions Popover (quick 260829-spj). Rendered in the `dlpToggle`
 * slot of ChatInputArea, alongside the parent-owned compare-models action.
 *
 * Presentational only: visibility, checked state, and the handler are owned
 * by ChatPanel (same convention as the compare-models button in the actions
 * slot — quick 260723-nnr keeps state + permission gating in the parent).
 *
 * a11y: `role="menuitemcheckbox"` + `aria-checked` — a checkable menu item,
 * not a pressed toggle button.
 */
export function DlpTextsToggle({ visible, checked, onToggle }: DlpTextsToggleProps) {
  const { t } = useTranslation();

  if (!visible) return null;

  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onToggle(!checked)}
      aria-label={checked ? t("chat.dlp.hideTexts") : t("chat.dlp.showTexts")}
      className={cn(
        "flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm transition-colors hover:bg-accent/40",
      )}
    >
      {checked ? (
        <EyeOff className="w-4 h-4 shrink-0 text-muted-foreground" />
      ) : (
        <Eye className="w-4 h-4 shrink-0 text-muted-foreground" />
      )}
      <span>{checked ? t("chat.dlp.hideTexts") : t("chat.dlp.showTexts")}</span>
    </button>
  );
}


// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SidebarItem — Feature 7.2 Slice B (quick task 260714-n3q).
 *
 * Nav item with icon + label + active state. Click navigates and closes the
 * mobile sheet (caller wires the navigate + mobile-close via `onClick`).
 *
 * Active state mirrors the inline Sidebar in App.tsx: inline `style` with
 * `primaryColor + "15"` background and `primaryColor` text (color). When
 * `isActive` is not provided, no active styling is applied (caller decides).
 *
 * Rail mode (`collapsed`): shows only the icon centered, label hidden, with a
 * `title` attribute for tooltip accessibility. The item is still clickable.
 */

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SidebarItemProps {
  /** Route path (used for active detection by caller; passed for reference). */
  path: string;
  /** Display label (i18n key resolved by caller). */
  label: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Optional trailing badge node. */
  badge?: ReactNode;
  /** Primary accent color for active state (hex). */
  primaryColor?: string;
  /** Whether this item matches the current route. */
  isActive?: boolean;
  /** Rail mode: when true, show icon only with title tooltip. */
  collapsed?: boolean;
  /** Click handler (caller navigates + closes mobile sheet). */
  onClick?: () => void;
}

export default function SidebarItem({
  path,
  label,
  icon,
  badge,
  primaryColor,
  isActive = false,
  collapsed = false,
  onClick,
}: SidebarItemProps) {
  const activeStyle =
    isActive && primaryColor
      ? { backgroundColor: primaryColor + "15", color: primaryColor }
      : isActive
        ? { fontWeight: 500 }
        : undefined;

  if (collapsed) {
    return (
      <Button
        variant="ghost"
        onClick={onClick}
        title={label}
        aria-label={label}
        className="w-full flex items-center justify-center px-1 py-2 rounded text-sm justify-center h-auto text-muted-foreground hover:bg-muted"
        style={activeStyle}
      >
        {icon ?? <span className="w-4 h-4" />}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "w-full text-left px-3 py-2 rounded text-sm justify-start h-auto flex items-center gap-2",
        isActive ? "font-medium" : "text-muted-foreground hover:bg-muted",
      )}
      style={activeStyle}
      data-path={path}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {badge}
    </Button>
  );
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SidebarLink — Feature 7.2 Slice B (quick task 260714-n3q).
 *
 * Non-collapsible direct-link nav variant (for Settings/Admin at the bottom
 * of the sidebar). Same active-state logic as SidebarItem but the icon is
 * optional and the layout is flat (no badge slot). Used for direct links
 * that don't belong to a collapsible group.
 */

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SidebarLinkProps {
  /** Route path. */
  path: string;
  /** Display label (i18n key resolved by caller). */
  label: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Primary accent color for active state (hex). */
  primaryColor?: string;
  /** Whether this item matches the current route. */
  isActive?: boolean;
  /** Rail mode: when true, show icon only with title tooltip. */
  collapsed?: boolean;
  /** Click handler (caller navigates + closes mobile sheet). */
  onClick?: () => void;
}

export default function SidebarLink({
  path,
  label,
  icon,
  primaryColor,
  isActive = false,
  collapsed = false,
  onClick,
}: SidebarLinkProps) {
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
    </Button>
  );
}
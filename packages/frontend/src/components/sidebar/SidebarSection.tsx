// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SidebarSection — Feature 7.2 Slice B (quick task 260714-n3q).
 *
 * Collapsible group wrapper for the console sidebar. Renders an uppercase
 * mono label + a chevron trigger that toggles open/close. State persists to
 * localStorage under `storageKey` (matching the orphaned AppSidebar pattern).
 *
 * Rail mode (`collapsed`): the group label is hidden and children render
 * directly (the sidebar collapses to a 60px icon-only rail; groups don't
 * collapse in rail mode — items show as icon-only). A thin separator is
 * still drawn so the visual grouping is preserved.
 *
 * Primitives use `@/components/ui/collapsible` (Radix). Theme via ThemeContext
 * (class-based `.theme-hacker`) — NOT next-themes (LOCKED F5).
 */

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SidebarSectionProps {
  /** Uppercase monospace group label (i18n key resolved by caller). */
  label: string;
  /** Optional group icon shown in rail mode (collapsed). */
  icon?: ReactNode;
  /** Initial open state when no persisted state exists (default: true). */
  defaultOpen?: boolean;
  /** localStorage key for persisting open/close state. */
  storageKey?: string;
  /** Rail mode: when true, hide the label and render children directly. */
  collapsed?: boolean;
  children: ReactNode;
}

export default function SidebarSection({
  label,
  icon,
  defaultOpen = true,
  storageKey,
  collapsed = false,
  children,
}: SidebarSectionProps) {
  const [open, setOpen] = useState<boolean>(() => {
    if (!storageKey) return defaultOpen;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) return JSON.parse(raw);
    } catch {
      // ignore parse errors
    }
    return defaultOpen;
  });

  useEffect(() => {
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(open));
      } catch {
        // ignore quota errors
      }
    }
  }, [open, storageKey]);

  // Rail mode: label hidden, children always visible (icon-only items).
  if (collapsed) {
    return (
      <div className="pt-3 first:pt-0 border-t border-input/60 first:border-t-0">
        {icon ? (
          <div className="flex justify-center py-1 text-muted-foreground/70">
            {icon}
          </div>
        ) : null}
        <div className="space-y-0.5">{children}</div>
      </div>
    );
  }

  return (
    <div className="pt-3 first:pt-0 border-t border-input/60 first:border-t-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            className="w-full flex items-center justify-between px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 hover:text-muted-foreground rounded-sm h-auto select-none"
          >
            <span>{label}</span>
            <ChevronDown
              className={cn(
                "w-3 h-3 transition-transform duration-200",
                open ? "rotate-180" : "",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-0.5">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
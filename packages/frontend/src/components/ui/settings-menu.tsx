// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

"use client";

import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * SettingsMenu — master-detail settings menu (UI revision R-6).
 *
 * Plain-button vertical nav reused by BOTH the desktop settings rail (240px
 * left column) and the mobile left drawer (Sheet). It is intentionally NOT a
 * Radix TabsTrigger because the mobile Sheet is a portal rendered outside
 * the `<Tabs>` tree, so a TabsTrigger context cannot reach it.
 *
 * The menu is a two-level tree: each top-level **group** is one settings
 * "page" (tab) and exposes its **sub-sections** as an always-expanded sub-list
 * of indented items. The user request (2026-07-15): every sub-section of every
 * settings page must be a selectable voice in a sub-menu of the current menu,
 * all expanded; clicking a voice opens it as a full detail page (master-detail
 * — the rail slides away, the page slides in from the right).
 *
 * The active item carries the `settings-menu-item` class plus a
 * `data-active="true"` attribute — the hooks the `.theme-hacker` CSS override
 * in `index.css` targets. The component itself is theme-agnostic: it never
 * imports any theme library or `useTheme` and never hardcodes hacker colors.
 *
 * Active state (2026-09 polish): tinted fill + primary text via the inline
 * color-mix style — NO accent border in light/dark. The `border-l-2` is kept
 * only as the carrier for the documented `.theme-hacker` neon-green left edge
 * (see SidebarSettingsThemeInvariants.test.tsx); it stays transparent
 * otherwise.
 *
 * The active voice is passed as `activeVoice` ({ tab, labelKey, sectionId } |
 * null) rather than a bare tab key, so both group voices and sub-section
 * voices highlight correctly while a page is open.
 */
export interface SettingsSubMenuEntry {
  /** Stable anchor id — matched against `settings-section-<id>` in the page. */
  id: string;
  /** i18n key for the sub-section label. */
  labelKey: string;
}

export interface SettingsMenuGroup {
  /** Tab key (general | llm | appearance | security | advanced). */
  key: string;
  /** i18n key for the group (tab) label. */
  labelKey: string;
  /** Sub-sections rendered as an always-expanded indented sub-list. */
  sections: SettingsSubMenuEntry[];
}

export interface SettingsMenuProps {
  groups: SettingsMenuGroup[];
  /**
   * The menu voice currently open as a detail page (master-detail mode):
   * `{ tab, labelKey, sectionId }` — a group voice when `sectionId` is
   * null, a sub-section voice otherwise. `null` = the full menu overview
   * (no voice focused).
   */
  activeVoice?: { tab: string; labelKey: string; sectionId: string | null } | null;
  /** Called when a group header is clicked (opens the group page). */
  onSelectTab: (tabKey: string) => void;
  /** Called when a sub-section is clicked (opens the section page). */
  onSelectSection: (tabKey: string, sectionId: string) => void;
  className?: string;
}

export function SettingsMenu({
  groups,
  activeVoice = null,
  onSelectTab,
  onSelectSection,
  className,
}: SettingsMenuProps) {
  const { t } = useTranslation();

  if (groups.length === 0) return null;

  return (
    <nav
      className={cn("flex flex-col py-2", className)}
      aria-label={t("settings.menuLabel", "Settings sections")}
    >
      {groups.map((group) => {
        const isGroupActive =
          activeVoice !== null &&
          activeVoice.tab === group.key &&
          activeVoice.sectionId === null;
        return (
          <div key={group.key}>
            {/* Group header = the settings "page" (tab). Clicking opens the
                group page (all its sub-sections) in the detail area. */}
            <Button
              type="button"
              variant="ghost"
              data-active={isGroupActive ? "true" : "false"}
              aria-current={isGroupActive ? "page" : undefined}
              aria-label={t(group.labelKey)}
              onClick={() => onSelectTab(group.key)}
              className={cn(
                "settings-menu-item justify-start rounded-none px-4 py-3 text-sm font-medium border-l-2 border-transparent transition-colors text-foreground hover:bg-accent/50",
              )}
              style={
                isGroupActive
                  ? {
                      backgroundColor:
                        "color-mix(in oklab, var(--primary) 8%, var(--background))",
                      color: "var(--primary)",
                    }
                  : undefined
              }
            >
              {t(group.labelKey)}
            </Button>

            {/* Always-expanded sub-section voices. */}
            {group.sections.length > 0 && (
              <div className="flex flex-col" role="list">
                {group.sections.map((section) => {
                  const isSectionActive =
                    activeVoice !== null &&
                    activeVoice.tab === group.key &&
                    activeVoice.sectionId === section.id;
                  return (
                        <Button
                          key={section.id}
                          type="button"
                          variant="ghost"
                          data-active={isSectionActive ? "true" : "false"}
                          aria-current={isSectionActive ? "true" : undefined}
                          aria-label={t(section.labelKey)}
                          onClick={() => onSelectSection(group.key, section.id)}
                          className={cn(
                            "settings-menu-item justify-start rounded-none pl-7 pr-4 py-2 text-[13px] font-normal border-l-2 border-transparent transition-colors text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                          )}
                          style={
                            isSectionActive
                              ? {
                                  backgroundColor:
                                    "color-mix(in oklab, var(--primary) 8%, var(--background))",
                                  color: "var(--primary)",
                                }
                              : undefined
                          }
                        >
                          {t(section.labelKey)}
                        </Button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export default SettingsMenu;
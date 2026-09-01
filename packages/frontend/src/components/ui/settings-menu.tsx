// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

"use client";

import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * SettingsMenu — Feature 7.5 Slice C (extended: sub-section sub-menu).
 *
 * Plain-button vertical nav reused by BOTH the desktop settings rail (240px
 * left column) and the mobile Sheet. It is intentionally NOT a Radix
 * TabsTrigger because the mobile Sheet is a portal rendered outside the
 * `<Tabs>` tree, so a TabsTrigger context cannot reach it.
 *
 * The menu is a two-level tree: each top-level **group** is one settings
 * "page" (tab) and exposes its **sub-sections** as an always-expanded sub-list
 * of indented items. The user request (2026-07-15): every sub-section of every
 * settings page must be a selectable voice in a sub-menu of the current menu,
 * all expanded; clicking a sub-voice navigates to the page and scrolls to the
 * matching section. Groups therefore never collapse — their sub-sections are
 * always visible.
 *
 * The active item carries the `settings-menu-item` class plus a
 * `data-active="true"` attribute — the hooks the `.theme-hacker` CSS override
 * in `index.css` targets. The component itself is theme-agnostic: it never
 * imports any theme library or `useTheme` and never hardcodes hacker colors.
 *
 * Keys are typed as plain `string` (not the SettingsPage `Tab` union) to avoid
 * a circular dependency; SettingsPage passes its `Tab`-typed values which are
 * assignable to `string`.
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
  activeTab: string;
  /** Currently-focused sub-section id (highlights the matching sub-voice). */
  activeSection?: string | null;
  /** Called when a group header is clicked (switch tab, scroll to top). */
  onSelectTab: (tabKey: string) => void;
  /** Called when a sub-section is clicked (switch tab + scroll to section). */
  onSelectSection: (tabKey: string, sectionId: string) => void;
  className?: string;
}

export function SettingsMenu({
  groups,
  activeTab,
  activeSection = null,
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
        const isGroupActive = group.key === activeTab;
        return (
          <div key={group.key}>
            {/* Group header = the settings "page" (tab). Clicking switches the
                page without targeting a specific section (scrolls to top). */}
            <Button
              type="button"
              variant="ghost"
              data-active={isGroupActive ? "true" : "false"}
              aria-current={isGroupActive ? "page" : undefined}
              aria-label={t(group.labelKey)}
              onClick={() => onSelectTab(group.key)}
              className={cn(
                "settings-menu-item justify-start rounded-none px-4 py-3 text-sm font-medium border-l-2 transition-colors",
                isGroupActive
                  ? "border-primary"
                  : "border-transparent text-foreground hover:bg-accent/50",
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
                    isGroupActive && activeSection === section.id;
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
                            "settings-menu-item justify-start rounded-none pl-7 pr-4 py-2 text-[13px] font-normal border-l-2 transition-colors",
                            isSectionActive
                              ? "border-primary"
                              : "border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground",
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
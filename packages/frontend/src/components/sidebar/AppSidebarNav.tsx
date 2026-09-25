// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppSidebarNav — the inline menu content inside the AppSidebar (UI revision
 * R-7): the project/workspace selectors + the RBAC-filtered nav groups.
 * Rendered ONLY while the footer Menu button holds the menu open (hidden
 * completely otherwise); presentational, byte-identical RBAC semantics with
 * the AppNavOverlay dialog via `sidebar/navModel.tsx`. Rendering reuses the
 * Feature 7.2 sidebar primitives.
 *
 * Layout contract (shape brief):
 *  - flex-none block with its own `overflow-y-auto`, capped at ~45% height,
 *    `border-t` separator (ChatSidebar above scrolls independently);
 *  - persist keys `sidebar-nav:<groupId>` via SidebarSection;
 *  - the workspace selector rides on top of the nav groups — it is the
 *    former sidebar dropdown (R-5 moved it into the dialog; R-7 brings it
 *    back inline) and only renders when a project is selected (workspaces
 *    are project-scoped; without a project there is nothing to switch);
 *  - rail mode (`collapsed`): icon-only SidebarItems with `title` tooltips
 *    and a tiny corner lock for license-gated entries (no group icons —
 *    each entry already renders its own, so a group icon would double it);
 *  - active state = `primaryColor + "15"` background + colored text (inline
 *    style, matching the App.tsx sidebar convention the primitives encode);
 *  - locked entries keep their LockBadge in the expanded rows and clicking
 *    navigates to the route so its UpgradePrompt renders (widgets /
 *    analytics / eventLog / SSO all render their own upgrade state);
 *  - mobile: the same inline nav at every breakpoint (no isMobile prop) —
 *    collapsed by default below 768px (the App-level `sidebar-open`
 *    default), expanded nav rows carry a ≥44px touch target below `lg`.
 */

import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SidebarSection from "./SidebarSection";
import SidebarItem from "./SidebarItem";
import SidebarDropdown from "./SidebarDropdown";
import { preloadRoute } from "../routePreload";
import { buildNavGroups, isActiveNavPath, LockBadge } from "./navModel";
import type { NavEntry } from "./navModel";
import type { SidebarDropdownItem } from "./SidebarDropdown";
import { cn } from "@/lib/utils";

export interface AppSidebarNavProps {
  menuSections: string[];
  isAdmin: boolean;
  isEnterprise: boolean;
  /** Primary accent color (hex) for the active-state styling. */
  primaryColor: string;
  /** i18n `t` passed from App (same pattern as AppSidebar). */
  t: (key: string) => string;
  /** Rail mode: icon-only items with title tooltips + corner lock. */
  collapsed?: boolean;
  /** R-7: project selector (rendered only when projects exist). */
  projects?: SidebarDropdownItem[];
  /** R-7: selected project id (empty = none selected). */
  selectedProjectId?: string;
  /** R-7: project selection handler. */
  onProjectSelect?: (id: string) => void;
  /** R-7: workspaces of the selected project (selector hidden without a project). */
  workspaces?: SidebarDropdownItem[];
  /** R-7: selected workspace id (empty = none selected). */
  selectedWorkspaceId?: string;
  /** R-7: workspace selection handler. */
  onWorkspaceSelect?: (id: string) => void;
  /**
   * R-7: fired after any entry navigation so the caller can close the
   * inline menu (the destination is the primary surface; the menu hides
   * completely after use).
   */
  onNavigate?: () => void;
}

export default function AppSidebarNav({
  menuSections,
  isAdmin,
  isEnterprise,
  primaryColor,
  t,
  collapsed = false,
  projects,
  selectedProjectId = "",
  onProjectSelect,
  workspaces,
  selectedWorkspaceId = "",
  onWorkspaceSelect,
  onNavigate,
}: AppSidebarNavProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const groups = useMemo(
    () => buildNavGroups({ menuSections, isAdmin, isEnterprise }),
    [menuSections, isAdmin, isEnterprise],
  );

  const isActive = (path: string) => isActiveNavPath(location.pathname, path);

  const handleSelect = (entry: NavEntry) => {
    navigate(entry.path);
    onNavigate?.();
  };

  return (
    <nav
      aria-label={t("nav.menu")}
      className="flex-none max-h-[45%] overflow-y-auto overflow-x-hidden border-t border-input/60"
    >
      {/*
        R-7: workspace selector — project-scoped, so it only makes sense
        once a project is chosen. With no project there is nothing to list
        (App filters `sidebarWorkspaces` by `selectedProjectId`); rendering
        a dead control would be a disabled row with no path forward.
      */}
      {projects && projects.length > 0 && (
        <SidebarDropdown
          label={t("sidebar.project")}
          value={selectedProjectId}
          onValueChange={onProjectSelect ?? (() => {})}
          items={projects}
          placeholder={t("sidebar.selectProject")}
        />
      )}
      {workspaces && workspaces.length > 0 && selectedProjectId && (
        <SidebarDropdown
          label={t("sidebar.workspace")}
          value={selectedWorkspaceId}
          onValueChange={onWorkspaceSelect ?? (() => {})}
          items={workspaces}
          placeholder={t("sidebar.selectWorkspace")}
        />
      )}
      {groups.map((group) => (
        <SidebarSection
          key={group.id}
          label={t(group.labelKey)}
          storageKey={`sidebar-nav:${group.id}`}
          collapsed={collapsed}
        >
          {group.entries.map((entry) => (
            <SidebarItem
              key={entry.id}
              path={entry.path}
              label={t(entry.labelKey)}
              icon={entry.icon}
              primaryColor={primaryColor}
              isActive={isActive(entry.path)}
              collapsed={collapsed}
              onClick={() => handleSelect(entry)}
              onHover={() => preloadRoute(entry.path)}
              className="max-lg:min-h-[44px]"
              badge={
                entry.locked ? (
                  <span
                    className={cn(
                      // Rail: a tiny corner lock pinned to the bottom-right
                      // of the icon-only tile (absolute; the rail SidebarItem
                      // is `relative`). Expanded: the trailing lock badge.
                      collapsed &&
                        "absolute bottom-0.5 right-0.5 text-muted-foreground/70 [&_svg]:w-2 [&_svg]:h-2",
                    )}
                  >
                    <LockBadge />
                  </span>
                ) : null
              }
            />
          ))}
        </SidebarSection>
      ))}
    </nav>
  );
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppNavOverlay — the large navigation dialog (UI revision R-5), opened from
 * the AppSidebar footer "Menu" button (or the Cmd/Ctrl+/ shortcut).
 *
 * Claude-style two-pane layout: the left rail lists the project + workspace
 * selectors and the nav groups; the wide right pane shows the selected
 * group's items (default: the first visible group). Items keep the exact
 * RBAC gating the sidebar had — same `menuSections` filter, same `isAdmin`
 * gates, same enterprise lock indicators — only the surface changed.
 *
 * R-6: the group model lives in `sidebar/navModel.tsx` (shared with the
 * persistent AppSidebarNav) and the lock indicator is the shared `LockBadge`.
 *
 * The dialog covers most of the viewport (the CommandDialog className
 * override) so every entry is visible without scrolling.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import { Sheet, SheetPortal, SheetOverlay, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { useIsMobile } from "../hooks/use-mobile";
import type { SidebarDropdownItem } from "./sidebar";
import SidebarDropdown from "./sidebar/SidebarDropdown";
import { buildNavGroups, LockBadge, isActiveNavPath } from "./sidebar/navModel";
import type { NavGroup } from "./sidebar/navModel";
import { cn } from "@/lib/utils";

export interface AppNavOverlayProps {
  open: boolean;
  onClose: () => void;
  isEnterprise: boolean;
  isAdmin: boolean;
  menuSections: string[];
  /** i18n `t` passed from App (same pattern as AppSidebar). */
  t: (key: string) => string;
  // Project / workspace selector state (same props as the former sidebar dropdowns).
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: (id: string) => void;
  setWorkspaceId: (id: string) => void;
  projects: SidebarDropdownItem[];
  workspaces: SidebarDropdownItem[];
}

export default function AppNavOverlay({
  open,
  onClose,
  isEnterprise,
  isAdmin,
  menuSections,
  t,
  selectedProjectId,
  setSelectedProjectId,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  setWorkspaceId,
  projects,
  workspaces,
}: AppNavOverlayProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  // Native cmdk filtering is ON: each nav item's `value` is the localized
  // label (+ English keywords), so typing filters across all groups. The two
  // interactive dropdown rows are force-mounted so they never get filtered.
  const { i18n } = useTranslation();

  const navigateTo = (path: string) => {
    onClose();
    navigate(path);
  };

  const isActivePath = (path: string) => isActiveNavPath(location.pathname, path);

  const handleWorkspaceSelect = (workspaceId: string) => {
    if (workspaceId === "__add__") {
      onClose();
      navigate("/create-workspace");
      return;
    }
    setSelectedWorkspaceId(workspaceId);
    if (workspaceId) {
      setWorkspaceId(workspaceId);
      localStorage.setItem("lastWorkspaceId", workspaceId);
    }
  };

  const handleProjectSelect = (value: string) => {
    setSelectedProjectId(value);
    setSelectedWorkspaceId("");
    setWorkspaceId("");
    if (value) localStorage.setItem("lastProjectId", value);
    else localStorage.removeItem("lastProjectId");
  };

  /** Localized searchable value: current-language label + English keywords. */
  const navValue = (labelKey: string, keywords: string) =>
    `${i18n.t(labelKey)} ${keywords}`.toLowerCase();

  // ── Group model (desktop pane layout + mobile command groups) ─────
  // R-6: extracted to sidebar/navModel.tsx — byte-identical RBAC semantics,
  // shared with the persistent AppSidebarNav so the surfaces cannot drift.
  const groups: NavGroup[] = useMemo(
    () => buildNavGroups({ menuSections, isAdmin, isEnterprise }),
    [menuSections, isAdmin, isEnterprise],
  );

  // Default pane = the group containing the active path, else the first group.
  // `isActivePath` reads `location` only, so this recomputes on navigation.
  const activeGroup = groups.find((g) =>
    g.entries.some((e) => isActivePath(e.path)),
  );
  const defaultPane = activeGroup?.id ?? groups[0]?.id ?? null;
  const paneGroup = groups.find((g) => g.id === defaultPane) ?? groups[0] ?? null;

  // ── Shared overlay content (Command palette body) ─────────────────
  // Rendered inside CommandDialog on desktop and inside a bottom Sheet on
  // mobile — same content, non-intrusive surface per breakpoint.
  const commandBody = (
    <Command>
      <CommandInput
        placeholder={t("nav.searchPlaceholder")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <CommandList>
        <CommandEmpty>{t("nav.noResults")}</CommandEmpty>

        {/* ── Project + workspace selectors (former sidebar dropdowns) ──
            Interactive rows: force-mounted so native filtering never hides
            them; pointer interaction reaches the Radix Selects. */}
        <CommandGroup forceMount heading={t("sidebar.project")}>
          <CommandItem
            value="__project-select__"
            forceMount
            className="p-0 hover:bg-inherit aria-selected:bg-inherit"
            onSelect={() => {}}
          >
            <div className="w-full px-2 py-1">
              <SidebarDropdown
                label=""
                value={selectedProjectId}
                onValueChange={handleProjectSelect}
                items={projects}
                placeholder={t("sidebar.selectProject")}
              />
            </div>
          </CommandItem>
        </CommandGroup>

        <CommandGroup forceMount heading={t("sidebar.workspace")}>
          <CommandItem
            value="__workspace-select__"
            forceMount
            className="p-0 hover:bg-inherit aria-selected:bg-inherit"
            onSelect={() => {}}
          >
            <div className="w-full px-2 py-1">
              <SidebarDropdown
                label=""
                value={selectedWorkspaceId}
                onValueChange={handleWorkspaceSelect}
                items={workspaces}
                placeholder={t("sidebar.selectWorkspace")}
                disabled={!selectedProjectId}
                addOption={{ value: "__add__", label: t("sidebar.addWorkspace") }}
              />
            </div>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {groups.map((group) => (
          <CommandGroup key={group.id} heading={t(group.labelKey)}>
            {group.entries.map((entry) => (
              <CommandItem
                key={entry.id}
                value={navValue(entry.labelKey, entry.keywords)}
                onSelect={() => navigateTo(entry.path)}
              >
                {entry.icon}
                <span className={cn(isActivePath(entry.path) && "text-primary font-medium")}>
                  {t(entry.labelKey)}
                </span>
                {entry.locked && <LockBadge />}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );

  // ── Desktop two-pane body ─────────────────────────────────────────
  // Everything sits inside ONE <Command> root (cmdk items/list require the
  // store context). The left rail carries the search + grouped items; the
  // wide pane shows the effective group's entries as large rows. Selecting
  // an entry closes and navigates (the settings entry is handled by its path
  // like everything else).
  const desktopBody = (
    <Command className="flex flex-col">
      <CommandInput
        placeholder={t("nav.searchPlaceholder")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="flex flex-1 min-h-0 h-[min(56vh,500px)]">
        {/* Left rail */}
        <div className="w-64 flex-none border-r border-border/70 flex flex-col min-h-0">
          <div className="p-2 flex flex-col gap-2 flex-none">
            <SidebarDropdown
              label={t("sidebar.project")}
              value={selectedProjectId}
              onValueChange={handleProjectSelect}
              items={projects}
              placeholder={t("sidebar.selectProject")}
            />
            <SidebarDropdown
              label={t("sidebar.workspace")}
              value={selectedWorkspaceId}
              onValueChange={handleWorkspaceSelect}
              items={workspaces}
              placeholder={t("sidebar.selectWorkspace")}
              disabled={!selectedProjectId}
              addOption={{ value: "__add__", label: t("sidebar.addWorkspace") }}
            />
          </div>
          <div className="mx-2 h-px bg-border flex-none" />
          <CommandList className="flex-1 min-h-0">
            <CommandEmpty>{t("nav.noResults")}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group.id} heading={t(group.labelKey)}>
                {group.entries.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={navValue(entry.labelKey, entry.keywords)}
                    onSelect={() => navigateTo(entry.path)}
                  >
                    {entry.icon}
                    <span className={cn(isActivePath(entry.path) && "text-primary font-medium")}>
                      {t(entry.labelKey)}
                    </span>
                    {entry.locked && <LockBadge />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </div>

        {/* Wide pane — the active group's entries as large rows (Claude-style
            flyout; clicking a row navigates and closes the dialog). */}
        <div className="flex-1 min-w-0 p-2 flex flex-col overflow-y-auto">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground flex-none">
            {paneGroup ? t(paneGroup.labelKey) : ""}
          </div>
          <div className="flex-1 min-h-0 flex flex-col gap-0.5">
            {(paneGroup?.entries ?? []).map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => navigateTo(entry.path)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-left transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActivePath(entry.path) && "bg-accent text-accent-foreground",
                )}
              >
                <span className="flex-none text-muted-foreground">{entry.icon}</span>
                <span className="flex-1 text-left truncate">{t(entry.labelKey)}</span>
                {entry.locked && <LockBadge />}
                <ChevronRight className="w-3.5 h-3.5 opacity-40" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </Command>
  );

  if (isMobile) {
    // Mobile/tablet (<768px): the nav overlay surfaces as a bottom Sheet —
    // same content, pattern already used by ChatPanel (chat-list Sheet).
    return (
      <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <SheetPortal>
          <SheetOverlay className="bg-black/50 backdrop-blur-sm" />
          <SheetPrimitive.Content
            className={cn(
              "fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-lg",
              "inset-x-0 bottom-0 max-h-[80dvh] rounded-t-xl border-t",
              "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-10 data-[state=open]:fade-in-0",
              "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom-10 data-[state=closed]:fade-out-0",
            )}
          >
            <SheetTitle className="sr-only">{t("nav.overlayTitle")}</SheetTitle>
            <SheetDescription className="sr-only">
              {t("nav.overlayDescription")}
            </SheetDescription>
            <div className="flex justify-center pt-2 pb-1" aria-hidden="true">
              <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
            </div>
            <div className="overflow-y-auto min-h-0 pb-[env(safe-area-inset-bottom)]">
              {commandBody}
            </div>
          </SheetPrimitive.Content>
        </SheetPortal>
      </Sheet>
    );
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={t("nav.overlayTitle")}
      description={t("nav.overlayDescription")}
      className="w-[min(880px,calc(100%-2rem))] sm:max-w-[880px] top-1/4"
    >
      {desktopBody}
    </CommandDialog>
  );
}
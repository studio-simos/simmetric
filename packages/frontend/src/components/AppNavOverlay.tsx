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
 * The dialog covers most of the viewport (the CommandDialog className
 * override) so every entry is visible without scrolling.
 */

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutGrid,
  MessageSquare,
  FileText,
  BookOpen,
  Layers,
  FolderKanban,
  Store,
  BarChart3,
  ScrollText,
  Shield,
  Upload,
  Settings,
  Lock,
  ChevronRight,
} from "lucide-react";
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

/** Small monochrome lock indicator (replaces the 🔒 emoji in labels). */
function LockBadge() {
  return <Lock className="w-3 h-3 text-muted-foreground flex-none" aria-hidden="true" />;
}

interface NavEntry {
  id: string;
  labelKey: string;
  keywords: string;
  icon: React.ReactNode;
  path: string;
  locked?: boolean;
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

  const isActivePath = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

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
  type NavGroup = {
    id: string;
    labelKey: string;
    entries: NavEntry[];
  };

  const groups: NavGroup[] = useMemo(() => {
    const list: NavGroup[] = [];
    if (menuSections.includes("dashboard")) {
      list.push({
        id: "overview",
        labelKey: "sidebar.group.overview",
        entries: [
          {
            id: "dashboard",
            labelKey: "sidebar.dashboard",
            keywords: "dashboard home overview",
            icon: <LayoutGrid className="w-4 h-4" />,
            path: "/dashboard",
          },
        ],
      });
    }
    const chatEntries: NavEntry[] = [
      {
        id: "chat",
        labelKey: "sidebar.chat",
        keywords: "chat conversations messages",
        icon: <MessageSquare className="w-4 h-4" />,
        path: "/",
      },
    ];
    if (menuSections.includes("projects")) {
      chatEntries.push({
        id: "projects",
        labelKey: "sidebar.projects",
        keywords: "projects management",
        icon: <FolderKanban className="w-4 h-4" />,
        path: "/projects",
      });
    }
    if (menuSections.includes("workspaces")) {
      chatEntries.push({
        id: "workspaces",
        labelKey: "sidebar.workspaces",
        keywords: "workspaces management",
        icon: <Layers className="w-4 h-4" />,
        path: "/workspaces",
      });
    }
    list.push({ id: "chatTools", labelKey: "sidebar.group.chatTools", entries: chatEntries });

    const knowledgeEntries: NavEntry[] = [];
    if (menuSections.includes("documents")) {
      knowledgeEntries.push({
        id: "documents",
        labelKey: "sidebar.documents",
        keywords: "documents files viewer",
        icon: <FileText className="w-4 h-4" />,
        path: "/documents",
      });
    }
    if (menuSections.includes("knowledgeBase")) {
      knowledgeEntries.push({
        id: "knowledgeBase",
        labelKey: "sidebar.knowledgeBase",
        keywords: "knowledge base wiki archives",
        icon: <BookOpen className="w-4 h-4" />,
        path: "/knowledge-base",
      });
    }
    if (menuSections.includes("uploads")) {
      knowledgeEntries.push({
        id: "uploads",
        labelKey: "sidebar.uploads",
        keywords: "uploads files ocr",
        icon: <Upload className="w-4 h-4" />,
        path: "/uploads",
      });
    }
    if (knowledgeEntries.length > 0) {
      list.push({ id: "knowledge", labelKey: "sidebar.group.knowledge", entries: knowledgeEntries });
    }

    const platformEntries: NavEntry[] = [];
    if (menuSections.includes("widget")) {
      platformEntries.push({
        id: "widget",
        labelKey: "sidebar.widget",
        keywords: "widgets embed chat",
        icon: <LayoutGrid className="w-4 h-4" />,
        path: "/widgets",
        locked: !isEnterprise,
      });
    }
    if (menuSections.includes("marketplace")) {
      platformEntries.push({
        id: "marketplace",
        labelKey: "sidebar.marketplace",
        keywords: "marketplace mcp servers catalog",
        icon: <Store className="w-4 h-4" />,
        path: "/mcp-marketplace",
      });
    }
    if (menuSections.includes("analytics")) {
      platformEntries.push({
        id: "analytics",
        labelKey: "sidebar.analytics",
        keywords: "analytics stats usage charts",
        icon: <BarChart3 className="w-4 h-4" />,
        path: "/analytics",
        locked: !isEnterprise,
      });
    }
    if (platformEntries.length > 0) {
      list.push({ id: "platform", labelKey: "sidebar.group.platform", entries: platformEntries });
    }

    const systemEntries: NavEntry[] = [];
    if (menuSections.includes("eventLog")) {
      systemEntries.push({
        id: "eventLog",
        labelKey: "sidebar.eventLog",
        keywords: "event log audit logs",
        icon: <ScrollText className="w-4 h-4" />,
        path: "/logs",
        locked: !isEnterprise,
      });
    }
    if (isAdmin) {
      systemEntries.push({
        id: "sso",
        labelKey: "sidebar.sso",
        keywords: "sso saml oidc authentication",
        icon: <Shield className="w-4 h-4" />,
        path: "/sso",
        locked: !isEnterprise,
      });
    }
    if (menuSections.includes("settings")) {
      systemEntries.push({
        id: "settings",
        labelKey: "sidebar.settings",
        keywords: "settings preferences configuration",
        icon: <Settings className="w-4 h-4" />,
        path: "/settings",
      });
    }
    if (systemEntries.length > 0) {
      list.push({ id: "system", labelKey: "sidebar.group.system", entries: systemEntries });
    }
    return list;
  }, [menuSections, isAdmin, isEnterprise, i18n]);

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
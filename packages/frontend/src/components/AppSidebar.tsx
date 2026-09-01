// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppSidebar — Feature 7.2 Slice B (quick task 260714-n3q).
 *
 * Console-style sidebar rendered from primitive components
 * (SidebarSection / SidebarItem / SidebarLink / SidebarDropdown). Adopts the
 * orphaned AppSidebar file as the new home for the sidebar, reconciled against
 * the real inline Sidebar that lived in App.tsx (lines 634-978).
 *
 * Reconciliation (LOCKED constraints honored):
 * - Groups use the REAL App.tsx keys (overview/chatTools/knowledge/workspace/
 *   platform/system) mapped to the 11 MENU_SECTIONS — NOT the orphaned
 *   core/knowledge/management/admin keys.
 * - Collapse: `sidebarOpen=false` → 60px icon-only RAIL (`w-15`), NOT `w-0`
 *   opacity-0 hide. `sidebarOpen=true` → `w-64`. Mobile stays `w-full` in the
 *   Sheet (App.tsx wraps mobile in its own Sheet).
 * - Bottom section: license badge + workspace id ONLY. Theme toggle, language
 *   selector, and user block live in the TopBar UserDropdown (Feature 7.4
 *   Slice A) — NOT reintroduced here.
 * - `useTheme` comes from `@/contexts/ThemeContext` (custom, class-based
 *   `.theme-hacker`). The Next.js theming dep is DEAD and is NOT imported.
 * - `data-slot` in `form.tsx` is untouched (LOCKED F5.3).
 *
 * Props mirror the former inline Sidebar in App.tsx so the App.tsx swap is a
 * 1:1 prop pass-through. `isAdmin`/`isEnterprise` arrive as props (caller
 * derives them from useMe/useLicenseInfo). Projects/workspaces lists arrive as
 * props (caller reads useProjects/useWorkspaces) — this component stays free
 * of TanStack Query hooks + useMe/useLogout (no user block to render).
 */

import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  PanelLeftClose,
  PanelLeftOpen,
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SidebarSection,
  SidebarItem,
  SidebarDropdown,
  type SidebarDropdownItem,
} from "./sidebar";
import { cn } from "@/lib/utils";

/**
 * Monogram — the Simmetric Chat "S" letter-mark (Phase 149 BRAND-01 / D-06).
 *
 * Single source of truth for the "S" geometry shared between the favicon
 * (`packages/frontend/public/favicon.svg`) and the AppSidebar rail-mode
 * fallback. A future brand-asset swap changes this one component (and the
 * favicon file) to update both sites in sync. Inline SVG — no remote URL,
 * no SSRF surface (T-149-03 accept).
 */
function Monogram({ size, color }: { size: number; color: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label="Simmetric Chat"
      className="rounded-md"
    >
      {/* Warm off-white rounded-square background — matches the favicon's
          hardcoded fill so the rail icon reads in both light/dark sidebars
          without depending on currentColor / CSS context. */}
      <rect width="32" height="32" rx="8" ry="8" fill="#FDFAF4" />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontSize="20"
        fontWeight="700"
        fill={color}
      >
        S
      </text>
    </svg>
  );
}

export interface AppSidebarProps {
  appName: string;
  primaryColor: string;
  /** White-label subtitle (BRANDING_APP_SUBTITLE); empty → fallback to t("app.subtitle"). */
  appSubtitle?: string;
  /** White-label icon URL (BRANDING_APP_ICON_URL); empty → fallback to appName initial. */
  appIconUrl?: string;
  isEnterprise: boolean;
  isAdmin: boolean;
  menuSections: string[];
  currentWorkspaceId: string | null;
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: (id: string) => void;
  setWorkspaceId: (id: string) => void;
  t: (key: string) => string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  isMobile?: boolean;
  onMobileNav?: (path: string) => void;
  /** Projects from useProjects() (caller-supplied). */
  projects: SidebarDropdownItem[];
  /** Workspaces for the selected project (caller-supplied, filtered by project). */
  workspaces: SidebarDropdownItem[];
}

export default function AppSidebar({
  appName,
  primaryColor,
  appSubtitle,
  appIconUrl,
  isEnterprise,
  isAdmin,
  menuSections,
  currentWorkspaceId,
  selectedProjectId,
  setSelectedProjectId,
  selectedWorkspaceId,
  setSelectedWorkspaceId,
  setWorkspaceId,
  t,
  sidebarOpen,
  setSidebarOpen,
  isMobile = false,
  onMobileNav,
  projects,
  workspaces,
}: AppSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Cache-busting token for the white-label app icon. The server stores the
  // icon at a stable path (BRANDING_APP_ICON_URL), so when it is replaced the
  // browser would keep serving the stale cached <img> at the same URL. We
  // append `?t=<bust>` to the src and bump the bust on every upload via the
  // `branding-changed` event (Feature 8 Slice C). The token is persisted to
  // localStorage so a reload after an upload still requests the fresh URL.
  const [iconBust, setIconBust] = useState(
    () => Number(localStorage.getItem("branding-icon-bust")) || 0,
  );
  useEffect(() => {
    const onBranding = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.iconBust) {
        setIconBust(detail.iconBust);
        localStorage.setItem("branding-icon-bust", String(detail.iconBust));
      }
    };
    window.addEventListener("branding-changed", onBranding);
    return () => window.removeEventListener("branding-changed", onBranding);
  }, []);

  // Busted src for the header icon (expanded + rail modes). Empty when no
  // icon; raw URL when no bust token yet (first ever render); `?t=<bust>`
  // appended after the first upload so a replacement at the same path busts
  // the browser cache.
  const iconSrc = appIconUrl
    ? iconBust > 0
      ? appIconUrl.includes("?")
        ? `${appIconUrl}&t=${iconBust}`
        : `${appIconUrl}?t=${iconBust}`
      : appIconUrl
    : "";

  // Rail mode = desktop sidebar collapsed to 60px icon-only. Mobile is always
  // full-width (rendered inside App.tsx's Sheet).
  const collapsed = !isMobile && !sidebarOpen;

  const handleNav = (path: string) => {
    if (isMobile && onMobileNav) onMobileNav(path);
    else navigate(path);
  };

  const isActivePath = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + "/");

  const handleWorkspaceSelect = (workspaceId: string) => {
    if (workspaceId === "__add__") {
      if (isMobile && onMobileNav) onMobileNav("/create-workspace");
      else navigate("/create-workspace");
      return;
    }
    setSelectedWorkspaceId(workspaceId);
    if (workspaceId) {
      setWorkspaceId(workspaceId);
      localStorage.setItem("lastWorkspaceId", workspaceId);
    }
  };

  const documentsPath = currentWorkspaceId
    ? `/workspace/${currentWorkspaceId}/documents`
    : "/documents";

  return (
    <div
      className={cn(
        "relative z-10 flex flex-col bg-card overflow-hidden whitespace-nowrap",
        isMobile
          ? "w-full h-full border-r-0"
          : "border-r border-input transition-all duration-300 ease-in-out",
        isMobile ? "" : (sidebarOpen ? "w-64" : "w-15"),
      )}
      data-collapsed={collapsed ? "true" : "false"}
    >
      {/* Header block: appName (primary color) + subtitle + collapse toggle */}
      <div
        className={cn(
          "p-4 border-b border-input flex items-center justify-between",
          collapsed && "flex-col gap-2 px-1 py-3",
        )}
      >
        <div className={cn(collapsed && "hidden")}>
          <div className="flex items-center gap-2">
            {appIconUrl ? (
              <img
                src={iconSrc}
                alt={appName}
                className="app-icon h-7 w-7 rounded-md object-cover"
              />
            ) : null}
            <h1 className="text-xl font-bold" style={{ color: primaryColor }}>
              {appName}
            </h1>
          </div>
          <p className="app-subtitle text-xs text-muted-foreground mt-1 truncate">
            {appSubtitle || t("app.subtitle")}
          </p>
        </div>
        {collapsed && (
          appIconUrl ? (
            <img
              src={iconSrc}
              alt={appName}
              className="app-icon h-7 w-7 rounded-md object-cover"
            />
          ) : (
            // Phase 149 BRAND-01: rail-mode monogram fallback (D-02). Replaces
            // the former text-initial span with the same SVG "S" mark used by
            // the favicon. The appIconUrl truthy branch above is the
            // white-label enterprise icon path — untouched (out of scope).
            <Monogram size={28} color={primaryColor} />
          )
        )}
        {isMobile ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? t("sidebar.toggleClose") : t("sidebar.toggleOpen")}
            title={sidebarOpen ? t("sidebar.toggleClose") : t("sidebar.toggleOpen")}
            className="text-muted-foreground hover:text-foreground flex-shrink-0"
          >
            {sidebarOpen ? (
              <PanelLeftClose className="w-4 h-4" />
            ) : (
              <PanelLeftOpen className="w-4 h-4" />
            )}
          </Button>
        )}
      </div>

      {/* Project + workspace selectors (hidden in rail mode — no room) */}
      {!collapsed && (
        <>
          <SidebarDropdown
            label={t("sidebar.project")}
            value={selectedProjectId}
            onValueChange={(value) => {
              setSelectedProjectId(value);
              setSelectedWorkspaceId("");
              setWorkspaceId("");
              if (value) localStorage.setItem("lastProjectId", value);
              else localStorage.removeItem("lastProjectId");
            }}
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
        </>
      )}

      {/* Navigation — grouped, mapped to 11 MENU_SECTIONS */}
      <nav className="flex flex-col justify-start flex-1 px-3 py-2 overflow-y-auto min-h-0">
        {/* Overview */}
        {menuSections.includes("dashboard") && (
          <SidebarSection
            label={t("sidebar.group.overview")}
            storageKey="app-sidebar-overview"
            collapsed={collapsed}
          >
            <SidebarItem
              path="/dashboard"
              label={t("sidebar.dashboard")}
              icon={<LayoutGrid className="w-4 h-4" />}
              isActive={isActivePath("/dashboard")}
              primaryColor={primaryColor}
              collapsed={collapsed}
              onClick={() => handleNav("/dashboard")}
            />
          </SidebarSection>
        )}

        {/* Chat tools */}
        <SidebarSection
          label={t("sidebar.group.chatTools")}
          storageKey="app-sidebar-chatTools"
          collapsed={collapsed}
        >
          <SidebarItem
            path="/"
            label={t("sidebar.chat")}
            icon={<MessageSquare className="w-4 h-4" />}
            isActive={isActivePath("/")}
            primaryColor={primaryColor}
            collapsed={collapsed}
            onClick={() => handleNav("/")}
          />
          {/* Projects management page (260723-oqs) — between chat and workspaces.
              Gated by the "projects" menu section (admin/superuser); rename/delete
              are admin ops. Regular users still pick projects via the top dropdown. */}
          {menuSections.includes("projects") && (
            <SidebarItem
              path="/projects"
              label={t("sidebar.projects")}
              icon={<FolderKanban className="w-4 h-4" />}
              isActive={isActivePath("/projects")}
              primaryColor={primaryColor}
              collapsed={collapsed}
              onClick={() => handleNav("/projects")}
            />
          )}
          {/* Workspaces moved under Chat Tools (260723-jzf) — was its own group. */}
          {menuSections.includes("workspaces") && (
            <SidebarItem
              path="/workspaces"
              label={t("sidebar.workspaces")}
              icon={<Layers className="w-4 h-4" />}
              isActive={isActivePath("/workspaces")}
              primaryColor={primaryColor}
              collapsed={collapsed}
              onClick={() => handleNav("/workspaces")}
            />
          )}
        </SidebarSection>

        {/* Knowledge — documents moved here from Chat Tools (260723-jzf).
            Group shows if any of its items is visible; each item gated individually.
            Order: Documents, Wiki (was Knowledge Base), Uploads. */}
        {(menuSections.includes("documents") ||
          menuSections.includes("knowledgeBase") ||
          menuSections.includes("uploads")) && (
          <SidebarSection
            label={t("sidebar.group.knowledge")}
            storageKey="app-sidebar-knowledge"
            collapsed={collapsed}
          >
            {menuSections.includes("documents") && (
              <SidebarItem
                path={documentsPath}
                label={t("sidebar.documents")}
                icon={<FileText className="w-4 h-4" />}
                isActive={isActivePath(documentsPath)}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav(documentsPath)}
              />
            )}
            {menuSections.includes("knowledgeBase") && (
              <SidebarItem
                path="/knowledge-base"
                label={t("sidebar.knowledgeBase")}
                icon={<BookOpen className="w-4 h-4" />}
                isActive={isActivePath("/knowledge-base")}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav("/knowledge-base")}
              />
            )}
            {/* Phase 71-03: unified uploads page — placed after knowledgeBase per CONTEXT discretion */}
            {menuSections.includes("uploads") && (
              <SidebarItem
                path="/uploads"
                label={t("sidebar.uploads")}
                icon={<Upload className="w-4 h-4" />}
                isActive={isActivePath("/uploads")}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav("/uploads")}
              />
            )}
          </SidebarSection>
        )}

        {/* Platform */}
        {(menuSections.includes("widget") ||
          menuSections.includes("marketplace") ||
          menuSections.includes("analytics")) && (
          <SidebarSection
            label={t("sidebar.group.platform")}
            storageKey="app-sidebar-platform"
            collapsed={collapsed}
          >
            {menuSections.includes("widget") && (
              <SidebarItem
                path="/widgets"
                label={
                  isEnterprise
                    ? t("sidebar.widget")
                    : `${t("sidebar.widget")} \u{1F512}`
                }
                icon={<LayoutGrid className="w-4 h-4" />}
                isActive={isActivePath("/widgets")}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav("/widgets")}
              />
            )}
            {menuSections.includes("marketplace") && (
              <SidebarItem
                path="/mcp-marketplace"
                label={t("sidebar.marketplace")}
                icon={<Store className="w-4 h-4" />}
                isActive={isActivePath("/mcp-marketplace")}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav("/mcp-marketplace")}
              />
            )}
            {menuSections.includes("analytics") && (
              <SidebarItem
                path="/analytics"
                label={
                  isEnterprise
                    ? t("sidebar.analytics")
                    : `${t("sidebar.analytics")} \u{1F512}`
                }
                icon={<BarChart3 className="w-4 h-4" />}
                isActive={isActivePath("/analytics")}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav("/analytics")}
              />
            )}
          </SidebarSection>
        )}

        {/* System — Settings link removed (8.3): reachable via UserDropdown only.
             "settings" menu section intentionally NOT removed from MENU_SECTIONS
             (RBAC/menu-filtering risk, out of scope). */}
        {(menuSections.includes("eventLog") || isAdmin) && (
          <SidebarSection
            label={t("sidebar.group.system")}
            storageKey="app-sidebar-system"
            collapsed={collapsed}
          >
            {menuSections.includes("eventLog") && (
              <SidebarItem
                path="/logs"
                label={
                  isEnterprise
                    ? t("sidebar.eventLog")
                    : `${t("sidebar.eventLog")} \u{1F512}`
                }
                icon={<ScrollText className="w-4 h-4" />}
                isActive={isActivePath("/logs")}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav("/logs")}
              />
            )}
            {isAdmin && (
              <SidebarItem
                path="/sso"
                label={isEnterprise ? t("sidebar.sso") : `${t("sidebar.sso")} \u{1F512}`}
                icon={<Shield className="w-4 h-4" />}
                isActive={isActivePath("/sso")}
                primaryColor={primaryColor}
                collapsed={collapsed}
                onClick={() => handleNav("/sso")}
              />
            )}
          </SidebarSection>
        )}
      </nav>

      {/* Bottom footer removed per request — the license tier badge now lives
          only in the TopBar UserDropdown (colored with the primary brand color).
          Theme toggle, language selector, and user block also live in the
          UserDropdown (Feature 7.4 Slice A). Do NOT reintroduce a footer here. */}
    </div>
  );
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * AppSidebar — the permanent left rail (UI revision R-5).
 *
 * Layout top-to-bottom:
 *  1. Header: app icon / Monogram fallback + collapse toggle
 *  2. Subtitle (expanded) — white-label aware
 *  3. New chat (routed only — the workspace chat actions live in ChatPanel)
 *  4. ChatSidebar — the conversation list, scoped to the active workspace
 *  5. Footer: "Menu" button → AppNavOverlay (large menu dialog), then the
 *     user block (avatar/initials + username) → UserMenuDialog
 *
 * The nav overlay + user menu are rendered by the caller (App.tsx) so this
 * component stays presentational; the footer buttons only fire the callbacks.
 *
 * The branding render paths are unchanged from Feature 7.6/7.7 Slice D
 * (covered by AppSidebar.test.tsx): iconBust cache-busting, Monogram
 * fallback (imported from the shared `Monogram` component), subtitle.
 */

import { useState, useEffect } from "react";
import { PanelLeftClose, PanelLeftOpen, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import Monogram from "./Monogram";
import { cn } from "@/lib/utils";

export interface AppSidebarProps {
  appName: string;
  primaryColor: string;
  /** White-label subtitle (BRANDING_APP_SUBTITLE); empty → fallback to t("app.subtitle"). */
  appSubtitle?: string;
  /** White-label icon URL (BRANDING_APP_ICON_URL); empty → fallback to Monogram. */
  appIconUrl?: string;
  /** Authenticated user for the footer user block. */
  user: {
    username: string;
    firstName?: string | null;
    lastName?: string | null;
    avatar?: string | null;
  } | null;
  /** Opens the nav dialog (AppNavOverlay). */
  onOpenNavOverlay: () => void;
  /** Opens the user menu dialog (UserMenuDialog). */
  onOpenUserMenu: () => void;
  t: (key: string) => string;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  isMobile?: boolean;
  children?: React.ReactNode;
}

export default function AppSidebar({
  appName,
  primaryColor,
  appSubtitle,
  appIconUrl,
  user,
  onOpenNavOverlay,
  onOpenUserMenu,
  t,
  sidebarOpen,
  setSidebarOpen,
  isMobile = false,
  children,
}: AppSidebarProps) {
  // Cache-busting token for the white-label app icon (Feature 8 Slice C).
  // `branding-changed` bumps the bust on every upload; persisted to
  // localStorage so a reload still requests the fresh URL.
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

  const displayName =
    user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : user?.username ?? "";

  return (
    <div
      className={cn(
        "relative z-10 flex flex-col bg-card overflow-hidden",
        // whitespace-nowrap only when expanded: in the 60px rail the chat
        // rows must wrap/clip instead of forcing the rail wider.
        !collapsed && "whitespace-nowrap",
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
            // Phase 149 BRAND-01: rail-mode monogram fallback (D-02). The
            // same SVG "S" mark used by the favicon, now imported from the
            // shared `Monogram` component (also used by ChatWordmark).
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

      {/* Body — the workspace conversation list. Hidden in the collapsed
          rail: the 60px strip cannot host the list; the rail keeps only the
          brand mark, the expand toggle, the menu and the user buttons. */}
      <div className={cn("flex-1 min-h-0 flex flex-col overflow-hidden", collapsed && "hidden")}>
        {children}
      </div>

      {/* Footer: menu button → AppNavOverlay, then the user block →
          UserMenuDialog. Always present, all breakpoints. */}
      <div
        className={cn(
          "border-t border-input flex flex-col",
          collapsed ? "px-1 py-2" : "p-2",
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenNavOverlay}
          aria-label={t("nav.openMenu")}
          title={t("nav.openMenu")}
          className={cn(
            "w-full text-muted-foreground hover:text-foreground justify-start gap-2",
            collapsed && "justify-center px-0",
          )}
        >
          <Menu className="w-4 h-4 flex-none" />
          {!collapsed && <span className="text-sm truncate">{t("nav.menu")}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenUserMenu}
          aria-label={t("topbar.userMenu")}
          title={displayName || t("topbar.userMenu")}
          className={cn(
            "w-full justify-start gap-2 rounded-lg hover:bg-accent",
            collapsed && "justify-center px-0",
          )}
        >
          {user?.avatar ? (
            <Avatar className="h-6 w-6">
              <AvatarImage src={user.avatar} alt="" />
              <AvatarFallback className="text-[10px]">{initialsOf(user)}</AvatarFallback>
            </Avatar>
          ) : (
            <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-[10px] font-medium flex items-center justify-center flex-none">
              {initialsOf(user)}
            </span>
          )}
          {!collapsed && (
            <span className="text-sm truncate">{displayName || user?.username || t("common.you")}</span>
          )}
        </Button>
      </div>
    </div>
  );
}

function initialsOf(user: AppSidebarProps["user"]): string {
  if (!user) return "?";
  if (user.firstName && user.lastName) {
    return ((user.firstName[0] ?? "") + (user.lastName[0] ?? "")).toUpperCase();
  }
  return (user.username[0] ?? "?").toUpperCase();
}
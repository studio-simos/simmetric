// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UserDropdown — Feature 7.4 consolidated user menu for the TopBar.
 *
 * Replaces the inline 2-item TopBar dropdown and the duplicated bottom-sidebar
 * user block. Renders: avatar/initials trigger, username + role badge label,
 * Language sub-menu (7 langs, calls i18n.changeLanguage), Theme sub-menu
 * (light/dark/hacker/system via useTheme from @/contexts/ThemeContext — NOT
 * NOT the deprecated next-themes package per RECONCILE.md LOCKED #1/#2), Links
 * (Settings only — Analytics/Admin links removed; both stay reachable via the
 * sidebar), footer (license tier in primary color + app version), and Sign Out
 * (neon-magenta in hacker theme via .hacker-signout).
 *
 * Self-contained: calls useMe/useLicenseInfo internally so TopBar doesn't need
 * new props. Theme + language persistence handled by ThemeContext /
 * react-i18next respectively (both localStorage-backed).
 */
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  LogOut,
  Settings,
  Globe,
  Palette,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useTheme } from "@/contexts/ThemeContext";
import { themeLabels } from "../ThemeToggle";
import { useMe } from "../../queries/useAuth";
import { useLicenseInfo } from "../../queries/useLicense";
import { getEnabledLanguages, ALL_LANGUAGES } from "../../i18n";
import type { Theme } from "@/contexts/ThemeContext";

export interface UserDropdownUser {
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  avatar?: string | null;
}

export interface UserDropdownProps {
  user: UserDropdownUser | null;
  onLogout: () => void;
}

function initials(user: UserDropdownUser | null): string {
  if (!user) return "?";
  if (user.firstName && user.lastName) {
    return ((user.firstName[0] ?? "") + (user.lastName[0] ?? "")).toUpperCase();
  }
  return (user.username[0] ?? "?").toUpperCase();
}

// App version — displayed in the dropdown footer. Injected at build time by
// the `inject-app-version` plugin in vite.config.ts, which writes
// `window.__APP_VERSION__` into index.html from the root package.json. In the
// Jest (ts-jest) transform the plugin never runs, so window.__APP_VERSION__ is
// undefined and we fall back to "—". The typeof window guard keeps both paths
// safe.
const APP_VERSION: string =
  (typeof window !== "undefined" &&
    (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__) ||
  "—";

export default function UserDropdown({ user, onLogout }: UserDropdownProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  // Self-contained: derive admin status + license from hooks.
  const { data: meData } = useMe();
  const { data: license } = useLicenseInfo();

  const isAdmin = meData?.permissions?.includes("admin:settings") ?? false;
  const licenseTier = license?.tier ?? null;

  const enabledLanguages = getEnabledLanguages();

  const langLabel = (code: string): string => {
    const entry = ALL_LANGUAGES.find((l) => l.code === code);
    return entry?.name ?? code;
  };

  const roleLabel = isAdmin
    ? t("user-dropdown.role.admin")
    : t("user-dropdown.role.user");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded px-1 transition-theme"
          aria-label={t("topbar.userMenu")}
        >
          {user?.avatar ? (
            <img
              src={user.avatar}
              alt=""
              className="w-6 h-6 rounded-full object-cover"
            />
          ) : (
            <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-[10px] font-medium flex items-center justify-center">
              {initials(user)}
            </span>
          )}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        {/* Header: username + role badge */}
        <DropdownMenuLabel className="font-mono text-xs text-muted-foreground flex items-center gap-2">
          <span className="truncate text-primary">{user?.username ?? "—"}</span>
          <span className="text-[9px] uppercase tracking-wider border border-border rounded px-1 py-0.5 text-primary">
            {roleLabel}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Language sub-menu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 cursor-pointer">
            <Globe className="w-3.5 h-3.5" />
            {t("user-dropdown.language")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {enabledLanguages.map((code) => (
              <DropdownMenuItem
                key={code}
                onClick={() => i18n.changeLanguage(code)}
                className="gap-2 cursor-pointer justify-between"
              >
                <span>{langLabel(code)}</span>
                {i18n.language === code && <Check className="w-3 h-3" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Theme sub-menu */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 cursor-pointer">
            <Palette className="w-3.5 h-3.5" />
            {t("user-dropdown.theme")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {(Object.keys(themeLabels) as Theme[]).map((key) => (
              <DropdownMenuItem
                key={key}
                onClick={() => setTheme(key)}
                className="gap-2 cursor-pointer justify-between"
              >
                <span>{themeLabels[key]}</span>
                {theme === key && <Check className="w-3 h-3" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        {/* Links */}
        <DropdownMenuItem
          onClick={() => navigate("/settings")}
          className="gap-2 cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5" />
          {t("menu.settings")}
        </DropdownMenuItem>
        {/* Analytics link removed per request — analytics stays reachable via
             the sidebar (AppSidebar, menuSections-gated). Admin item was
             removed earlier (8.4): it duplicated Settings (both → /settings);
             admin remains reachable via the sidebar /sso link. */}

        <DropdownMenuSeparator />

        {/* Footer: license tier (primary-colored) + app version */}
        <div className="px-2 py-1.5 flex items-center justify-between text-[10px] font-mono text-muted-foreground">
          {licenseTier && (
            <span className="uppercase tracking-wider rounded px-1.5 py-0.5 text-primary">
              {t("user-dropdown.license")}: {licenseTier.toUpperCase()}
            </span>
          )}
          <span className="ml-auto text-primary">
            {t("user-dropdown.version")}: v{APP_VERSION}
          </span>
        </div>

        <DropdownMenuSeparator />

        {/* Sign Out — neon-magenta in hacker theme via .hacker-signout */}
        <DropdownMenuItem
          onClick={onLogout}
          className={cn(
            "gap-2 cursor-pointer text-destructive focus:text-destructive hacker-signout",
          )}
        >
          <LogOut className="w-3.5 h-3.5" />
          {t("user-dropdown.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
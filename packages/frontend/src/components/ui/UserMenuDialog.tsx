// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * UserMenuDialog — the large user menu (UI revision R-5).
 *
 * Desktop (≥768px): Claude-style dialog — left rail = account (avatar, name,
 * role) + settings + language + theme; the wide right pane keeps all items
 * legible without hover-guesswork, mirroring the nav overlay's proportions.
 *
 * Mobile (<768px): the left rail surfaces as a LEFT Sheet drawer with an
 * open/close toggle in a top bar — the same master/detail pattern
 * SettingsPage uses (top-bar `PanelLeftOpen`/`X` toggle + breadcrumb).
 * Language and theme keep their existing behaviors
 * (i18n.changeLanguage / ThemeContext) — only the surfaces moved.
 *
 * Enterprise lock badges are NOT needed here: language, theme, settings and
 * sign-out are core features on every tier.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Settings,
  Globe,
  Palette,
  Check,
  LogOut as LogOutIcon,
  ChevronRight,
  ChevronLeft,
  PanelLeftOpen,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useTheme } from "@/contexts/ThemeContext";
import { themeLabels } from "../ThemeToggle";
import { useMe } from "../../queries/useAuth";
import { useLicenseInfo } from "../../queries/useLicense";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getEnabledLanguages, ALL_LANGUAGES } from "../../i18n";
import type { Theme } from "@/contexts/ThemeContext";

export interface UserMenuDialogUser {
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  avatar?: string | null;
}

export interface UserMenuDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserMenuDialogUser | null;
  onLogout: () => void;
}

function initials(user: UserMenuDialogUser | null): string {
  if (!user) return "?";
  if (user.firstName && user.lastName) {
    return ((user.firstName[0] ?? "") + (user.lastName[0] ?? "")).toUpperCase();
  }
  return (user.username[0] ?? "?").toUpperCase();
}

// App version — displayed in the footer. Injected at build time by
// the `inject-app-version` plugin in vite.config.ts, which writes
// `window.__APP_VERSION__` into index.html from the root package.json. In the
// Jest (ts-jest) transform the plugin never runs, so window.__APP_VERSION__ is
// undefined and we fall back to "—". The typeof window guard keeps both paths
// safe.
const APP_VERSION: string =
  (typeof window !== "undefined" &&
    (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__) ||
  "—";

function MenuRow({
  icon,
  children,
  onClick,
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof Button> & {
  icon: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        "w-full justify-start gap-2.5 px-3 py-2 rounded-lg text-sm font-normal",
        destructive && "text-destructive hover:text-destructive hacker-signout",
        className,
      )}
      {...props}
    >
      <span className={cn("flex-none", destructive ? "text-destructive" : "text-muted-foreground")}>
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{children}</span>
    </Button>
  );
}

function SettingsRow({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-left transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <span className="flex-none text-muted-foreground">{icon}</span>
      <span className="flex-1 text-left truncate">{label}</span>
      {active && <Check className="w-3.5 h-3.5" />}
    </button>
  );
}

function LeftRailRow({
  label,
  onClick,
  active,
  trailing,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-left transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent text-accent-foreground" : "text-foreground/80",
      )}
    >
      <span className="flex-1 text-left truncate">{label}</span>
      {trailing ?? <ChevronRight className="w-3.5 h-3.5 opacity-50" />}
    </button>
  );
}

/** Shared left-rail content: account block + settings + language + theme. */
function RailContent({
  user,
  displayName,
  roleLabel,
  t,
  panel,
  onPanel,
}: {
  user: UserMenuDialogUser | null;
  displayName: string;
  roleLabel: string;
  t: (key: string) => string;
  panel: "main" | "language" | "theme";
  onPanel: (p: "main" | "language" | "theme" | "settings") => void;
}) {
  return (
    <>
      {/* Account block — identity, not a control */}
      <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
        {user?.avatar ? (
          <Avatar className="h-9 w-9">
            <AvatarImage src={user.avatar} alt="" />
            <AvatarFallback className="text-xs">{initials(user)}</AvatarFallback>
          </Avatar>
        ) : (
          <span className="w-9 h-9 rounded-full bg-primary text-primary-foreground text-sm font-medium flex items-center justify-center flex-none">
            {initials(user)}
          </span>
        )}
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{displayName || "—"}</div>
          <div className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
            {user?.username && user.username !== displayName && (
              <span>{user.username}</span>
            )}
            <span className="text-[9px] uppercase tracking-wider border border-border rounded px-1 py-0.5 text-primary">
              {roleLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="mx-1 my-1 h-px bg-border" />

      <LeftRailRow
        label={t("user-dropdown.language")}
        active={panel === "language"}
        onClick={() => onPanel("language")}
      />
      <LeftRailRow
        label={t("user-dropdown.theme")}
        active={panel === "theme"}
        onClick={() => onPanel("theme")}
      />
      {/* Settings moved into the rail, below language and theme (UI revision
          R-5.1) — the whole rail is one list of destinations. */}
      <LeftRailRow
        label={t("menu.settings")}
        onClick={() => onPanel("settings")}
        trailing={<Settings className="w-4 h-4 text-muted-foreground" />}
      />
    </>
  );
}

/** Wide-pane panel content, shared by the desktop dialog and mobile drawer. */
function PanelContent({
  panel,
  t,
  enabledLanguages,
  langLabel,
  i18nLanguage,
  changeLanguage,
  theme,
  setTheme,
  onSignOut,
  licenseTier,
}: {
  panel: "main" | "language" | "theme";
  t: (key: string) => string;
  enabledLanguages: readonly string[];
  langLabel: (code: string) => string;
  i18nLanguage: string;
  changeLanguage: (code: string) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  onSignOut: () => void;
  licenseTier: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 flex-1 min-h-0">
      {panel === "main" && (
        <>
          {/* Footer: license tier (primary-colored) + app version */}
          <div className="mt-auto px-3 pt-2 flex items-center justify-between text-[10px] font-mono text-muted-foreground">
            {licenseTier && (
              <span className="uppercase tracking-wider rounded px-1.5 py-0.5 text-primary">
                {t("user-dropdown.license")}: {licenseTier.toUpperCase()}
              </span>
            )}
            <span className="ml-auto text-primary">
              {t("user-dropdown.version")}: v{APP_VERSION}
            </span>
          </div>
          <div className="my-1 h-px bg-border" />
          <MenuRow
            icon={<LogOutIcon className="w-4 h-4" />}
            destructive
            onClick={onSignOut}
          >
            {t("user-dropdown.signOut")}
          </MenuRow>
        </>
      )}

      {panel === "language" && (
        <div className="overflow-y-auto min-h-0">
          {enabledLanguages.map((code) => (
            <SettingsRow
              key={code}
              icon={<Globe className="w-4 h-4" />}
              label={langLabel(code)}
              active={i18nLanguage === code}
              onClick={() => changeLanguage(code)}
            />
          ))}
        </div>
      )}

      {panel === "theme" && (
        <div className="overflow-y-auto min-h-0">
          {(Object.keys(themeLabels) as Theme[]).map((key) => (
            <SettingsRow
              key={key}
              icon={<Palette className="w-4 h-4" />}
              label={themeLabels[key]}
              active={theme === key}
              onClick={() => setTheme(key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function UserMenuDialog({
  open,
  onOpenChange,
  user,
  onLogout,
}: UserMenuDialogProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const isMobile = useIsMobile();

  // Self-contained: derive admin status + license from hooks (same as the
  // former UserDropdown — TopBar/App do not need to thread these).
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

  // Panel state — Claude-style: the rail holds settings + language + theme;
  // the active panel opens in the wide pane, mirroring the nav overlay.
  // (The old "main" value is kept as a no-op base state: the settings
  // destination is a navigation, not a panel — the rail marks nothing active
  // on entry.)
  const [panel, setPanel] = useState<"main" | "language" | "theme">("main");
  // Mobile drawer visibility (the rail's Sheet). Reset on every dialog open.
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  // Reset the panel + drawer every time the dialog re-opens.
  useEffect(() => {
    if (open) {
      setPanel("main");
      setMobileRailOpen(false);
    }
  }, [open]);

  const displayName =
    user?.firstName && user?.lastName
      ? `${user.firstName} ${user.lastName}`
      : user?.username ?? "";

  const goSettings = () => {
    onOpenChange(false);
    navigate("/settings");
  };

  const signOut = () => {
    onOpenChange(false);
    onLogout();
  };

  // ── Mobile (<768px): left Sheet drawer + full-area pane ──
  // Same master/detail pattern as SettingsPage: a top-bar drawer toggle
  // (PanelLeftOpen/X) keeps the rail reachable from any panel, and the
  // drawer header carries its own close (X) affordance.
  if (isMobile) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="max-w-[calc(100%-2rem)] w-[min(560px,100%)] gap-0 p-0 overflow-hidden sm:max-w-[560px]"
          showCloseButton={false}
        >
          <div className="flex relative" role="menu" aria-label={t("topbar.userMenu")}>
            <Sheet open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
              <SheetContent
                side="left"
                className="w-64 max-w-[85vw] p-0 gap-0"
                showCloseButton={false}
              >
                <div className="flex items-center justify-between px-3 py-3 border-b border-border shrink-0">
                  <SheetTitle className="text-sm font-medium">
                    {t("topbar.userMenu")}
                  </SheetTitle>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setMobileRailOpen(false)}
                    className="shrink-0"
                    aria-label={t("user-dropdown.closeMenu")}
                    title={t("user-dropdown.closeMenu")}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1">
                  <div role="menu" aria-label={t("topbar.userMenu")} className="flex flex-col gap-1">
                    <RailContent
                      user={user}
                      displayName={displayName}
                      roleLabel={roleLabel}
                      t={t}
                      panel={panel}
                      onPanel={(p) => {
                        if (p === "settings") {
                          goSettings();
                        } else {
                          setPanel(p);
                          setMobileRailOpen(false);
                        }
                      }}
                    />
                  </div>
                </div>
              </SheetContent>
            </Sheet>

            {/* Full-area pane with a top-bar drawer toggle — the drawer
                trigger must be reachable from any panel. */}
            <div className="flex-1 min-w-0 p-2 flex flex-col min-h-[280px]">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 mb-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setMobileRailOpen(true)}
                  className="shrink-0"
                  aria-label={mobileRailOpen ? t("user-dropdown.closeMenu") : t("user-dropdown.openMenu")}
                  title={mobileRailOpen ? t("user-dropdown.closeMenu") : t("user-dropdown.openMenu")}
                >
                  {mobileRailOpen ? <X className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                </Button>
                <div className="flex items-center gap-1 min-w-0 text-sm">
                  {panel !== "main" && (
                    <button
                      type="button"
                      onClick={() => setPanel("main")}
                      aria-label={t("common.back")}
                      title={t("common.back")}
                      className="rounded-lg p-1 -ml-1 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ChevronLeft className="w-4 h-4 text-muted-foreground" />
                    </button>
                  )}
                  <span className="truncate font-medium text-foreground">
                    {panel === "language"
                      ? t("user-dropdown.language")
                      : panel === "theme"
                        ? t("user-dropdown.theme")
                        : t("topbar.userMenu")}
                  </span>
                </div>
              </div>
              <PanelContent
                panel={panel}
                t={t}
                enabledLanguages={enabledLanguages}
                langLabel={langLabel}
                i18nLanguage={i18n.language}
                changeLanguage={(code) => i18n.changeLanguage(code)}
                theme={theme}
                setTheme={setTheme}
                onSignOut={signOut}
                licenseTier={licenseTier}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Desktop (≥768px): two-pane dialog ──
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[calc(100%-2rem)] w-[min(560px,100%)] gap-0 p-0 overflow-hidden sm:max-w-[560px]"
        showCloseButton={false}
      >
        <div className="flex" role="menu" aria-label={t("topbar.userMenu")}>
          {/* Left rail — account block + settings / language / theme entries */}
          <div className="w-56 flex-none border-r border-border p-2 flex flex-col gap-1">
            <RailContent
              user={user}
              displayName={displayName}
              roleLabel={roleLabel}
              t={t}
              panel={panel}
              onPanel={(p) => {
                if (p === "settings") {
                  goSettings();
                } else {
                  setPanel(p);
                }
              }}
            />
          </div>

          {/* Wide pane — panel content (main / language / theme) */}
          <div className="flex-1 min-w-0 p-2 flex flex-col min-h-[260px]">
            <PanelContent
              panel={panel}
              t={t}
              enabledLanguages={enabledLanguages}
              langLabel={langLabel}
              i18nLanguage={i18n.language}
              changeLanguage={(code) => i18n.changeLanguage(code)}
              theme={theme}
              setTheme={setTheme}
              onSignOut={signOut}
              licenseTier={licenseTier}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { lazy, Suspense, useEffect, useState } from "react";
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useChatNav } from "./contexts/ChatContext";
import { useTheme } from "./contexts/ThemeContext";
import { useEnterpriseModulesContext } from "./contexts/EnterpriseModulesContext";
import { useLicenseTier } from "./hooks/useFeature";
import { useLicenseInfo } from "./queries/useLicense";
import { useProjects } from "./queries/useProjects";
import { useMe, useMenuSections, useLogout } from "./queries/useAuth";
// Phase 152-03 (WIZ-01, D-04) — system initialization state drives the
// App.tsx wizard-vs-login gate. Public query (no token gate) — the wizard
// runs before the user has a JWT.
import { useSystemIsInitialized } from "./queries/useSystem";
import { useWorkspaces } from "./queries/useWorkspaces";
import { apiGet } from "./utils/api";
import ChatPanel from "./components/ChatPanel";
import AnalyticsPanel from "./components/AnalyticsPanel";
import EnterpriseSpinner from "./components/EnterpriseSpinner";
import WorkspaceCreatePanel from "./components/WorkspaceCreatePanel";
import WorkspacesPage from "./components/WorkspacesPage";
import ProjectsPanel from "./components/ProjectsPanel";
import WidgetsPage from "./components/WidgetsPage";
import WidgetDetailPage from "./components/WidgetDetailPage";
import SettingsPage from "./components/SettingsPage";
import DocumentsPage from "./components/DocumentsPage";
import LoginPage from "./components/LoginPage";
import ForcePasswordChange from "./components/ForcePasswordChange";
// Phase 152-03 (WIZ-01, D-01) — SetupWizard renders on a fresh install
// (setup_wizard_mode==="active") instead of LoginPage. Imported eagerly
// (not lazy) because the wizard is the ONLY route reachable when the
// mode is active and the user is unauthenticated — lazy-splitting it
// would add a chunk fetch before the first-run user sees anything.
import SetupWizard from "./components/SetupWizard";
import { Toaster } from "@/components/ui/sonner";
import DashboardPage from "./components/DashboardPage";
import KnowledgeBasePage from "./components/KnowledgeBasePage";
import MarketplacePage from "./components/MarketplacePage";
import MarketplaceDetail from "./components/MarketplaceDetail";
import ArchivesPage from "./components/ArchivesPage";
import ArchiveDetailPage from "./components/ArchiveDetailPage";
import DocumentViewerPage from "./components/DocumentViewerPage";
import SynthesisDashboard from "./components/SynthesisDashboard";
import SynthesisRunDetail from "./components/SynthesisRunDetail";
import UnifiedUploadPage from "./components/UnifiedUploadPage";
import AppSidebar from "./components/AppSidebar";
import UpgradePrompt from "./components/UpgradePrompt";
import { useTranslation } from "react-i18next";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import ModelPalette from "./components/ModelPalette";
import { MENU_SECTIONS } from "@simmetric-chat/shared";
import { getOnSelectModel } from "./hooks/usePaletteCallbacks";
import { cn } from "@/lib/utils";
import TopBar from "./components/TopBar";
import RightPanel from "./components/RightPanel";

// Phase 147 (EPA-11 — D-07): React.lazy at MODULE TOP (NOT inside App —
// Pitfall 2: lazy() in a component body creates a new type each render →
// React unmounts/remounts the panel, resetting internal state on every
// parent re-render). The EventLogPanel chunk loads on-demand ONLY when
// the /logs route is hit AND enterpriseInstalled && tier === "enterprise".
const EventLogPanel = lazy(() => import("./components/EventLogPanel"));
// Phase 147 (EPA-11 — D-07, Plan 02): the SsoSettingsPanel chunk loads
// on-demand ONLY when the /sso route is hit AND isAdmin AND
// enterpriseInstalled && tier === "enterprise".
const SsoSettingsPanel = lazy(() => import("./components/SsoSettingsPanel"));

function App() {
  const { setWorkspaceId, currentWorkspaceId, setChatId, currentChatId } = useChatNav();
  const { resolvedTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: license } = useLicenseInfo();
  const hasToken = !!localStorage.getItem("token");
  const { data: meData, isLoading: meLoading, error: meError } = useMe(hasToken);
  const { data: menuSectionsData, isLoading: menuSectionsLoading } = useMenuSections(hasToken);
  // Phase 152-03 (WIZ-01, D-04) — system init state. `staleTime: 0` (set in
  // useSystem.ts) so this always refetches on App mount, keeping the
  // wizard-vs-login gate fresh. `isLoading` IS folded into the `initializing`
  // Skeleton below — on a fresh install (no token), the auth queries are
  // disabled and resolve instantly, so without this gate `initializing`
  // would flip to false before `systemInit` lands, flashing LoginPage before
  // the wizard branch (App.tsx:404) can take over. Keeping the Skeleton up
  // until the system-init query resolves guarantees the wizard wins the
  // first paint (UI-SPEC §Interaction Contract point 1).
  const { data: systemInit, isLoading: systemInitLoading } = useSystemIsInitialized();
  const logoutMutation = useLogout();

  // SSO token handoff (quick 260808-oin): both SAML and OIDC callbacks
  // redirect to /oauth/callback?token=<JWT>. When the SPA boots on that URL
  // with no stored session, store the JWT under the same localStorage key
  // useLogin uses and strip it from the URL (replace) so it does not linger in
  // the address bar / history (T-260808-01). useMe picks the token up on the
  // next render and the user is authenticated without a manual login.
  // The hasToken guard: (a) a stale ?token= param never clobbers a live
  // session; (b) when a stale session is rejected by useMe (401 → logout
  // clears the token), the effect re-runs and completes the handoff.
  useEffect(() => {
    const token = searchParams.get("token");
    if (token && token.trim() !== "" && !hasToken) {
      localStorage.setItem("token", token);
      navigate("/", { replace: true });
    }
  }, [searchParams, navigate, hasToken]);

  const user = meData ?? null;
  const isAuthenticated = !!meData;
  const isAdmin = meData?.permissions?.includes("admin:settings") ?? false;
  const menuSections = menuSectionsData ?? [];
  const { t } = useTranslation();
  // Phase 147 (EPA-11 — D-08): enterprise gate. `enterpriseInstalled` is
  // the FIRST gate (plugin present); `tier === "enterprise"` is the tier
  // gate; the existing `useFeature("audit_log_immutable")` check INSIDE
  // EventLogPanel (EventLogPanel.tsx:40-49) is the SECOND gate (the
  // feature flag may be off even with enterprise installed).
  const { enterpriseInstalled } = useEnterpriseModulesContext();
  const tier = useLicenseTier();
  const [appName, setAppName] = useState(t("app.name"));
  const [primaryColor, setPrimaryColor] = useState("#4c6ef5");
  const [appSubtitle, setAppSubtitle] = useState("");
  const [appIconUrl, setAppIconUrl] = useState("");
  const [initializing, setInitializing] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState("");
  // Projects + workspaces for the sidebar selectors. useProjects invalidates on
  // rename (useRenameProject) and on create (useCreateProject, Feature 7.3), so
  // the SidebarDropdown reflects changes without a manual refetch.
  const { data: projects = [] } = useProjects(hasToken);
  const { data: allWorkspaces = [] } = useWorkspaces(hasToken);
  const sidebarProjects = projects.map((p) => ({ id: p.id, name: p.name }));
  const sidebarWorkspaces = allWorkspaces
    .filter((w) => w.projectId === selectedProjectId)
    .map((w) => ({ id: w.id, name: w.name }));
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const saved = localStorage.getItem("sidebar-open");
    // Default: expanded on desktop (≥768px), collapsed rail on mobile. The
    // mobile Sheet/TopBar split was removed — mobile now uses the same inline
    // collapsible sidebar as desktop, defaulting to the 60px icon rail.
    return saved !== null ? saved === "true" : window.innerWidth >= 768;
  });

  useEffect(() => {
    localStorage.setItem("sidebar-open", String(sidebarOpen));
  }, [sidebarOpen]);

  // Clear session on 401/403 from useMe
  useEffect(() => {
    if (meError && (meError.status === 401 || meError.status === 403)) {
      logoutMutation.mutate();
    }
  }, [meError, logoutMutation]);

  // Session restoration — runs after auth queries settle.
  // Phase 152-03 (WIZ-01, D-04 follow-up): when there is no token, the auth
  // queries are disabled and resolve instantly, so without waiting on
  // `systemInitLoading` the `initializing` Skeleton would drop before the
  // system-init query lands — flashing LoginPage on a fresh install where
  // the wizard branch (App.tsx:404) should win first paint. We hold the
  // Skeleton until the system-init query resolves in the unauthenticated
  // path; the authenticated path is unchanged.
  useEffect(() => {
    if (meLoading || menuSectionsLoading) return;

    const token = localStorage.getItem("token");
    if (!token) {
      if (systemInitLoading) return;
      setInitializing(false);
      return;
    }

    const restore = async () => {
      const lastProjectId = localStorage.getItem("lastProjectId");
      const lastWorkspaceId = localStorage.getItem("lastWorkspaceId");
      const lastChatId = localStorage.getItem("lastChatId");

      if (lastProjectId) {
        setSelectedProjectId(lastProjectId);
      }

      if (lastWorkspaceId) {
        try {
          const workspace = await apiGet<{ id: string }>(
            `/workspaces/${lastWorkspaceId}`,
          );
          if (workspace && workspace.id) {
            setSelectedWorkspaceId(lastWorkspaceId);
            setWorkspaceId(lastWorkspaceId);

            if (lastChatId) {
              try {
                const chatList = await apiGet<Array<{ id: string }>>(
                  `/workspaces/${lastWorkspaceId}/chats`,
                );
                if (chatList.some((c) => c.id === lastChatId)) {
                  setChatId(lastChatId);
                } else {
                  localStorage.removeItem("lastChatId");
                }
              } catch {
                localStorage.removeItem("lastChatId");
              }
            }
          } else {
            localStorage.removeItem("lastWorkspaceId");
            localStorage.removeItem("lastChatId");
          }
        } catch {
          localStorage.removeItem("lastWorkspaceId");
          localStorage.removeItem("lastChatId");
        }
      }
      setInitializing(false);
    };

    restore();
  }, [meLoading, menuSectionsLoading, meData, systemInitLoading, setWorkspaceId, setChatId]);

  // Load branding after auth; remove inline override on logout
  useEffect(() => {
    if (isAuthenticated) {
      fetchBranding();
    } else {
      applyPrimaryColor(null);
    }
  }, [isAuthenticated]);

  // Listen for real-time branding changes from settings
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.appName) setAppName(detail.appName);
      if (detail.appSubtitle !== undefined) setAppSubtitle(detail.appSubtitle);
      if (detail.appIconUrl !== undefined) setAppIconUrl(detail.appIconUrl);
      if (detail.primaryColor !== undefined) {
        setPrimaryColor(detail.primaryColor);
        applyPrimaryColor(detail.primaryColor);
      }
    };
    window.addEventListener("branding-changed", handler);
    return () => window.removeEventListener("branding-changed", handler);
  }, []);

  // Persist session state when workspace/project changes
  useEffect(() => {
    if (selectedProjectId)
      localStorage.setItem("lastProjectId", selectedProjectId);
    if (selectedWorkspaceId)
      localStorage.setItem("lastWorkspaceId", selectedWorkspaceId);
    if (currentWorkspaceId)
      localStorage.setItem("lastWorkspaceId", currentWorkspaceId);
  }, [selectedProjectId, selectedWorkspaceId, currentWorkspaceId]);

  // Persist lastChatId when context chatId changes
  useEffect(() => {
    if (currentChatId) {
      localStorage.setItem("lastChatId", currentChatId);
    } else {
      localStorage.removeItem("lastChatId");
    }
  }, [currentChatId]);

  const fetchBranding = async () => {
    try {
      const token = localStorage.getItem("token");
      const headers: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : {};
      const res = await fetch("/api/system/settings", { headers });
      if (!res.ok) return;
      const settings: { key: string; value: string }[] = await res.json();
      const appNameEntry = settings.find((s) => s.key === "BRANDING_APP_NAME");
      const colorEntry = settings.find(
        (s) => s.key === "BRANDING_PRIMARY_COLOR",
      );
      const subtitleEntry = settings.find((s) => s.key === "BRANDING_APP_SUBTITLE");
      const iconEntry = settings.find((s) => s.key === "BRANDING_APP_ICON_URL");
      if (appNameEntry?.value) setAppName(appNameEntry.value);
      if (subtitleEntry?.value !== undefined) setAppSubtitle(subtitleEntry.value);
      if (iconEntry?.value !== undefined) setAppIconUrl(iconEntry.value);
      if (colorEntry?.value) {
        setPrimaryColor(colorEntry.value);
        applyPrimaryColor(colorEntry.value);
      }
    } catch {
      // Branding not configured yet
    }
  };

  const applyPrimaryColor = (color: string | null) => {
    const root = document.documentElement.style;
    if (!color) {
      root.removeProperty("--primary");
      root.removeProperty("--primary-foreground");
      root.removeProperty("--ring");
      root.removeProperty("--accent");
      root.removeProperty("--accent-foreground");
      root.removeProperty("--sidebar-primary");
      root.removeProperty("--sidebar-primary-foreground");
      root.removeProperty("--sidebar-accent");
      root.removeProperty("--sidebar-accent-foreground");
      root.removeProperty("--sidebar-ring");
      return;
    }
    root.setProperty("--primary", color);
    root.setProperty("--primary-foreground", `color-mix(in oklab, ${color} 15%, white)`);
    root.setProperty("--ring", `color-mix(in oklab, ${color} 50%, transparent)`);
    root.setProperty("--accent", `color-mix(in oklab, ${color} 12%, var(--background))`);
    root.setProperty("--accent-foreground", `color-mix(in oklab, ${color} 70%, var(--foreground))`);
    root.setProperty("--sidebar-primary", color);
    root.setProperty("--sidebar-primary-foreground", `color-mix(in oklab, ${color} 15%, white)`);
    root.setProperty("--sidebar-accent", `color-mix(in oklab, ${color} 10%, var(--background))`);
    root.setProperty("--sidebar-accent-foreground", `color-mix(in oklab, ${color} 70%, var(--foreground))`);
    root.setProperty("--sidebar-ring", `color-mix(in oklab, ${color} 50%, transparent)`);
  };

  const handleLogout = () => {
    logoutMutation.mutate();
  };

  const isEnterprise = license?.tier === "enterprise";

  // Defensive fallback: if menuSections is empty but user is admin, assume all sections
  const effectiveMenuSections =
    menuSections.length === 0 && isAdmin ? [...MENU_SECTIONS] : menuSections;

  const handlePaletteSelect =
    (selection: { providerId: string; model: string } | null) => {
      const cb = getOnSelectModel();
      if (cb) cb(selection);
      setPaletteOpen(false);
    };

  const handleOpenPalette = () => {
    if (currentWorkspaceId) setPaletteOpen(true);
  };

  const handleOpenComparison = () => {
    window.dispatchEvent(new CustomEvent("toggle-comparison"));
  };

  // Derive current section label for mobile top bar
  const currentSection = (() => {
    const p = location.pathname;
    if (p === "/" || p.startsWith("/chat")) return t("sidebar.chat");
    if (p.startsWith("/dashboard")) return t("sidebar.dashboard");
    if (p.startsWith("/knowledge-base")) return t("sidebar.knowledgeBase");
    if (p.startsWith("/documents") || p.startsWith("/workspace/")) return t("sidebar.documents");
    if (p.startsWith("/uploads")) return t("sidebar.uploads");
    if (p.startsWith("/projects")) return t("sidebar.projects");
    if (p.startsWith("/workspaces") || p.startsWith("/create-workspace")) return t("sidebar.workspaces");
    if (p.startsWith("/widgets")) return t("sidebar.widget");
    if (p.startsWith("/settings")) return t("sidebar.settings");
    if (p.startsWith("/logs")) return t("sidebar.eventLog");
    if (p.startsWith("/analytics")) return t("sidebar.analytics");
    if (p.startsWith("/mcp-marketplace")) return t("sidebar.marketplace");
    if (p.startsWith("/archives")) return t("archives.title");
    if (p.startsWith("/synthesis")) return "Synthesis";
    if (p.startsWith("/sso")) return t("sidebar.sso");
    return "";
  })();

  useKeyboardShortcuts({
    onOpenPalette: handleOpenPalette,
    onOpenComparison: handleOpenComparison,
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (currentWorkspaceId) {
        setPaletteFilter(detail?.filter || "");
        setPaletteOpen(true);
      }
    };
    window.addEventListener("open-palette", handler);
    return () => window.removeEventListener("open-palette", handler);
  }, [currentWorkspaceId]);

  // Show loading state while checking auth
  if (initializing) {
    return (
      <TooltipProvider>
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="h-8 w-48 rounded-md" />
            <Skeleton className="h-4 w-32 rounded-md" />
          </div>
        </div>
      </TooltipProvider>
    );
  }

  // Phase 152-03 (WIZ-01, D-01) — Setup Wizard route branch. Renders the
  // wizard on a fresh install (setup_wizard_mode === "active") when the
  // user is not authenticated, INSTEAD of LoginPage. Inserted AFTER the
  // `initializing` Skeleton (so the Skeleton covers the auth + system
  // query loading gap — no flash of LoginPage — UI-SPEC §Interaction
  // Contract point 1) and BEFORE the `!isAuthenticated` LoginPage branch
  // (so the wizard wins the routing decision when the mode is active).
  // The branch is UX-only — the server 404 gate (Plan 01, D-10) is the
  // real security boundary; a spoofed client mode cannot re-initialize
  // because POST /api/system/initialize 404s when mode === "completed".
  if (!isAuthenticated && systemInit?.setupWizardMode === "active") {
    return (
      <TooltipProvider>
        <Routes>
          <Route path="*" element={<SetupWizard />} />
        </Routes>
        <Toaster />
      </TooltipProvider>
    );
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return (
      <TooltipProvider>
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
        <Toaster />
      </TooltipProvider>
    );
  }

  // Force first-login password change before any app route is reachable
  if (user?.mustChangePassword) {
    return (
      <TooltipProvider>
        <ForcePasswordChange />
        <Toaster />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div
        className={cn(
          "h-[100dvh] overflow-hidden bg-background",
          "flex",
          // Hacker-evolved ambiance: subtle terminal grid + scanline overlay.
          // Only applied when the user has explicitly chosen the hacker theme;
          // light/dark keep the clean shadcn background. (Feature 3.5)
          resolvedTheme === "hacker" && "grid-bg scanlines",
        )}
      >
        <Toaster />
        {paletteOpen && currentWorkspaceId && (
          <ModelPalette
            open={paletteOpen}
            onClose={() => {
              setPaletteOpen(false);
              setPaletteFilter("");
            }}
            onSelect={handlePaletteSelect}
            initialFilter={paletteFilter}
          />
        )}
        <AppSidebar
          appName={appName}
          primaryColor={primaryColor}
          appSubtitle={appSubtitle}
          appIconUrl={appIconUrl}
          isEnterprise={isEnterprise}
          isAdmin={isAdmin}
          menuSections={effectiveMenuSections}
          currentWorkspaceId={currentWorkspaceId}
          selectedProjectId={selectedProjectId}
          setSelectedProjectId={setSelectedProjectId}
          selectedWorkspaceId={selectedWorkspaceId}
          setSelectedWorkspaceId={setSelectedWorkspaceId}
          setWorkspaceId={setWorkspaceId}
          t={t}
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          projects={sidebarProjects}
          workspaces={sidebarWorkspaces}
        />
        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <TopBar
            currentSection={currentSection}
            selectedProjectId={selectedProjectId}
            user={user}
            onLogout={handleLogout}
          />
          <div className="flex-1 flex overflow-hidden min-h-0">
            <div className="flex-1 overflow-hidden min-w-0">
              <Routes>
            <Route path="/" element={<ChatPanel />} />
            <Route
              path="/dashboard"
              element={
                effectiveMenuSections.includes("dashboard") ? (
                  <DashboardPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/knowledge-base"
              element={
                effectiveMenuSections.includes("knowledgeBase") ? (
                  <KnowledgeBasePage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route
              path="/workspace/:workspaceId/documents"
              element={<DocumentsPage />}
            />
            <Route path="/documents/:id" element={<DocumentViewerPage />} />
            <Route
              path="/create-workspace"
              element={<WorkspaceCreatePanel />}
            />
            <Route
              path="/workspaces"
              element={
                effectiveMenuSections.includes("workspaces") ? (
                  <WorkspacesPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/projects"
              element={
                effectiveMenuSections.includes("projects") ? (
                  <ProjectsPanel />
                ) : (
                  <Navigate to="/workspaces" replace />
                )
              }
            />

            {/* Marketplace routes */}
            <Route
              path="/mcp-marketplace"
              element={
                effectiveMenuSections.includes("marketplace") ? (
                  <MarketplacePage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/mcp-marketplace/:entryId"
              element={
                effectiveMenuSections.includes("marketplace") ? (
                  <MarketplaceDetail />
                ) : (
                  <Navigate to="/" />
                )
              }
            />

            {/* Archives routes */}
            <Route
              path="/archives"
              element={
                effectiveMenuSections.includes("knowledgeBase") ? (
                  <ArchivesPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/archives/:archiveId/*"
              element={
                effectiveMenuSections.includes("knowledgeBase") ? (
                  <ArchiveDetailPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />

            {/* Uploads route (Phase 71-03) — unified upload page with per-leg status */}
            <Route
              path="/uploads"
              element={
                effectiveMenuSections.includes("uploads") ? (
                  <UnifiedUploadPage />
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />

            {/* Synthesis routes — sub-page of knowledgeBase, not a separate menu section */}
            <Route
              path="/synthesis"
              element={
                effectiveMenuSections.includes("knowledgeBase") ? (
                  <SynthesisDashboard />
                ) : (
                  <Navigate to="/chat" replace />
                )
              }
            />
            <Route
              path="/synthesis/:runId"
              element={
                effectiveMenuSections.includes("knowledgeBase") ? (
                  <SynthesisRunDetail />
                ) : (
                  <Navigate to="/chat" replace />
                )
              }
            />

            {/* Admin routes */}
            <Route
              path="/logs"
              element={
                effectiveMenuSections.includes("eventLog") ? (
                  // Phase 147 (EPA-11 — D-07/D-08/D-09, SC-3/SC-4):
                  // FIRST gate — enterprise plugin present + Enterprise
                  // tier → load the lazy EventLogPanel chunk inside a
                  // Suspense boundary. The existing `useFeature(
                  // "audit_log_immutable")` check INSIDE EventLogPanel
                  // (EventLogPanel.tsx:40-49) is the SECOND gate (the
                  // feature flag may be off even with enterprise installed).
                  enterpriseInstalled && tier === "enterprise" ? (
                    <Suspense fallback={<EnterpriseSpinner />}>
                      <EventLogPanel />
                    </Suspense>
                  ) : (
                    // Community build (no enterprise plugin) OR Community
                    // tier → render the upgrade card with the
                    // `upgrade.pluginRequired` message when the plugin is
                    // absent; otherwise the default feature-label message.
                    <UpgradePrompt
                      feature="audit_log_immutable"
                      message={!enterpriseInstalled ? t("upgrade.pluginRequired") : undefined}
                    />
                  )
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/analytics"
              element={
                effectiveMenuSections.includes("analytics") ? (
                  <AnalyticsPanel />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/widgets"
              element={
                effectiveMenuSections.includes("widget") ? (
                  <WidgetsPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/widgets/new"
              element={
                effectiveMenuSections.includes("widget") ? (
                  <WidgetDetailPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/widgets/:id"
              element={
                effectiveMenuSections.includes("widget") ? (
                  <WidgetDetailPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/settings"
              element={
                effectiveMenuSections.includes("settings") ? (
                  <SettingsPage />
                ) : (
                  <Navigate to="/" />
                )
              }
            />
            <Route
              path="/sso"
              element={
                // Phase 147 (EPA-11 — D-07/D-08/D-09, SC-3/SC-4, Plan 02):
                // the outermost `isAdmin` gate STAYS (existing RBAC — a
                // non-admin is redirected, not shown an upgrade card).
                // Inside admin: the FIRST enterprise gate
                // (enterpriseInstalled && tier === "enterprise") decides
                // whether to lazy-load the SsoSettingsPanel chunk inside a
                // Suspense boundary OR render the UpgradePrompt fallback.
                // The existing `useFeature("sso_enabled")` check INSIDE
                // SsoSettingsPanel is the SECOND gate (D-08 — the feature
                // flag may be off even with enterprise installed).
                isAdmin ? (
                  enterpriseInstalled && tier === "enterprise" ? (
                    <Suspense fallback={<EnterpriseSpinner />}>
                      <SsoSettingsPanel />
                    </Suspense>
                  ) : (
                    <UpgradePrompt
                      feature="sso_enabled"
                      message={!enterpriseInstalled ? t("upgrade.pluginRequired") : undefined}
                    />
                  )
                ) : (
                  <Navigate to="/" />
                )
              }
            />

            {/* Catch-all redirect */}
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
            </div>
            {/* Right console panel — token stats, skills/MCP, quick settings (Feature 3.5).
                Hidden below lg; collapses to a thin rail. */}
            <RightPanel selectedProjectId={selectedProjectId} />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

export default App;

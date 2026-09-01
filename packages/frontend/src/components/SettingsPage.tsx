// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useEffectEvent, lazy, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMe, useLogout } from "../queries/useAuth";
import { useSettings } from "../queries/useSettings";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ApiError } from "../utils/api";
import { showError } from "../lib/toast";
import { useEnterpriseModulesContext } from "../contexts/EnterpriseModulesContext";
import { useLicenseTier } from "../hooks/useFeature";
import EnterpriseSpinner from "./EnterpriseSpinner";
import UpgradePrompt from "./UpgradePrompt";
import SettingsLLM from "./SettingsLLM";
import SettingsProviders from "./SettingsProviders";
import SettingsVectorDB from "./SettingsVectorDB";
import SettingsUsers from "./SettingsUsers";
import SettingsApiKeys from "./SettingsApiKeys";
import SettingsRoles from "./SettingsRoles";
import SettingsMcpConnections from "./SettingsMcpConnections";
import {
  SettingsProfilePersonal,
  SettingsProfileInstructions,
  SettingsProfileChatData,
} from "./SettingsProfile";
import {
  SettingsGeneralDlp,
  SettingsGeneralLanguages,
  SettingsGeneralResetDb,
} from "./SettingsGeneral";
import SettingsOcr from "./SettingsOcr";
import SettingsSynthesis from "./SettingsSynthesis";
import SettingsMaintenance from "./SettingsMaintenance";
import SettingsAppearance from "./SettingsAppearance";
import SettingsWebSearch from "./SettingsWebSearch";
import SettingsAgentWatchdog from "./SettingsAgentWatchdog";
import SettingsReranker from "./SettingsReranker";
import SettingsVapid from "./SettingsVapid";
import { FiltersTab } from "./FiltersTab";
import DlpAuditPanel from "./DlpAuditPanel";
import SettingsDlpPatterns from "./SettingsDlpPatterns";
import { SettingsTemplates } from "./SettingsTemplates";
import { SettingsSecurityNonAdminUpload } from "./SettingsSecurityNonAdminUpload";
import SettingsPushNotifications from "./SettingsPushNotifications";
import { SETTINGS_TAB_PERMISSIONS } from "@simmetric-chat/shared";
import { useViewTransition } from "./ui/view-transition";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils"
import { Menu, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SettingsMenu, type SettingsMenuGroup } from "./ui/settings-menu";

// Phase 147 (EPA-11 — D-07, Plan 02): React.lazy at MODULE TOP (NOT inside
// SettingsPage — Pitfall 2: lazy() in a component body creates a new type
// each render → React unmounts/remounts the panel, resetting internal state
// on every parent re-render). The SettingsBackups chunk loads on-demand
// ONLY when the advanced → backups sub-section renders AND
// enterpriseInstalled && tier === "enterprise".
//
// NOTE: `SettingsAppearance` is intentionally NOT wrapped in React.lazy — it
// carries community features (theme, font scale, density) that must stay
// visible in a community build. The white-label SECTION inside it is gated
// by the existing in-component `useFeature("white_label")` check (the SECOND
// gate, D-08). See the 147-02-SUMMARY for the appearance-gating decision.
const SettingsBackups = lazy(() => import("./SettingsBackups"));

/**
 * SettingsPage — Feature 3.4a (UI_DESIGN.md).
 *
 * Reorganized into 5 top-level tabs, each nesting the pre-existing settings
 * sub-components as labelled sub-sections:
 *
 *   Profilo        → Informazioni personali, Istruzioni personalizzate, Lingue disponibili
 *   Provider LLM   → Providers, LLM & Embedding (LLM + OCR + Synthesis)
 *   Aspetto        → Appearance (theme / accent / font / density)
 *   Sicurezza      → Roles, Users
 *   Avanzate       → Vector DB, API Keys, MCP Connections, Maintenance,
 *                     Backups, DLP, Chat Data, Reset DB
 *
 * Tab visibility uses SETTINGS_TAB_PERMISSIONS with OR semantics on the
 * permissions of the sub-sections each tab contains (see permissions.ts).
 * `advanced` is always visible because Chat Data (export/import) is available
 * to all users; the admin-only sub-sections inside it are gated individually.
 *
 * Backward compatibility:
 *  - Deep-link `?tab=<legacy>` is mapped onto one of the 5 canonical tabs via
 *    `mapLegacyTab()` (e.g. `?tab=roles` → Sicurezza, `?tab=apikeys` → Avanzate).
 *  - localStorage `lastSettingsSection` may still hold a legacy value; the same
 *    mapper translates it on mount, then we persist the canonical key from
 *    then on.
 */

type Tab = "profile" | "llm" | "appearance" | "security" | "advanced";

/**
 * Canonical sub-section ids. Each maps to a labelled `<SubSection>` inside a
 * tab and to a sub-menu voice in `<SettingsMenu>`. The id is also the anchor
 * used for scroll-to-section (`settings-section-<id>`) and the `?section=`
 * deep link.
 */
type SectionId =
  | "personalInfo"
  | "customInstructions"
  | "languages"
  | "providers"
  | "llmEmbedding"
  | "appearance"
  | "roles"
  | "users"
  | "nonAdminUpload"
  | "notifications"
  | "apiKeys"
  | "vectorDB"
  | "mcpConnections"
  | "maintenance"
  | "backups"
  | "dlp"
  | "webSearch"
  | "agentWatchdog"
  | "reranker"
  | "vapid"
  | "filters"
  | "dlpAudit"
  | "dlpPatterns"
  | "templates"
  | "chatData"
  | "resetDb";

/** i18n label key for each sub-section id (matches `settings.subSections.*`). */
const SECTION_LABEL: Record<SectionId, string> = {
  personalInfo: "settings.subSections.personalInfo",
  customInstructions: "settings.subSections.customInstructions",
  languages: "settings.subSections.languages",
  providers: "settings.subSections.providers",
  llmEmbedding: "settings.subSections.llmEmbedding",
  appearance: "settings.subSections.appearance",
  roles: "settings.subSections.roles",
  users: "settings.subSections.users",
  nonAdminUpload: "settings.subSections.nonAdminUpload",
  notifications: "settings.subSections.notifications",
  apiKeys: "settings.subSections.apiKeys",
  vectorDB: "settings.subSections.vectorDB",
  mcpConnections: "settings.subSections.mcpConnections",
  maintenance: "settings.subSections.maintenance",
  backups: "settings.subSections.backups",
  dlp: "settings.subSections.dlp",
  webSearch: "settings.subSections.webSearch",
  agentWatchdog: "settings.subSections.agentWatchdog",
  reranker: "settings.subSections.reranker",
  vapid: "settings.subSections.vapid",
  filters: "settings.subSections.filters",
  dlpAudit: "settings.subSections.dlpAudit",
  dlpPatterns: "settings.subSections.dlpPatterns",
  templates: "settings.subSections.templates",
  chatData: "settings.subSections.chatData",
  resetDb: "settings.subSections.resetDb",
};

/** DOM anchor id for a sub-section — used by SettingsMenu scroll-to-section. */
function settingsSectionAnchor(id: string): string {
  return `settings-section-${id}`;
}

const TAB_KEYS: { key: Tab; labelKey: string }[] = [
  { key: "profile", labelKey: "settings.tabs.profile" },
  { key: "llm", labelKey: "settings.tabs.llmProviders" },
  { key: "appearance", labelKey: "settings.tabs.appearance" },
  { key: "security", labelKey: "settings.tabs.security" },
  { key: "advanced", labelKey: "settings.tabs.advanced" },
];

// Map every legacy sub-section key (and the canonical ones) onto one of the 5
// top-level tabs. `widgets` is handled separately (redirects to /widgets).
// Note: `apikeys`/`apiKeys` now route to Avanzate (API Keys moved from
// Sicurezza to Avanzate). Unknown values fall back to "profile".
const LEGACY_TAB_MAP: Record<string, Tab> = {
  profile: "profile",
  general: "profile",
  personalinfo: "profile",
  personalInfo: "profile",
  custominstructions: "profile",
  customInstructions: "profile",
  languages: "profile",
  providers: "llm",
  llm: "llm",
  llmEmbedding: "llm",
  appearance: "appearance",
  roles: "security",
  rolesPermissions: "security",
  users: "security",
  usersRBAC: "security",
  security: "security",
  mcpconnections: "advanced",
  mcpConnections: "advanced",
  vectordb: "advanced",
  vectorDB: "advanced",
  apikeys: "advanced",
  apiKeys: "advanced",
  maintenance: "advanced",
  backups: "advanced",
  dlp: "advanced",
  websearch: "advanced",
  webSearch: "advanced",
  agentwatchdog: "advanced",
  agentWatchdog: "advanced",
  reranker: "advanced",
  vapid: "advanced",
  templates: "advanced",
  dlpaudit: "advanced",
  dlpAudit: "advanced",
  chatdata: "advanced",
  chatData: "advanced",
  resetdb: "advanced",
  resetDb: "advanced",
  advanced: "advanced",
};

function mapLegacyTab(raw: string | null): Tab | null {
  if (!raw) return null;
  if ((TAB_KEYS.map((t) => t.key) as string[]).includes(raw)) return raw as Tab;
  return LEGACY_TAB_MAP[raw] ?? null;
}

/** A labelled, separated sub-section within a tab. */
function SubSection({
  id,
  label,
  show,
  children,
}: {
  id: SectionId;
  label: string;
  show: boolean;
  children: ReactNode;
}) {
  if (!show) return null;
  return (
    <section
      id={settingsSectionAnchor(id)}
      className="space-y-4 pt-6 first:pt-0 scroll-mt-2"
    >
      <h3 className="text-sm font-semibold text-foreground border-b border-input pb-2">
        {label}
      </h3>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  // Phase 147 (EPA-11 — D-08, Plan 02): enterprise gate for the backups
  // sub-section. `enterpriseInstalled` is the FIRST gate (plugin present);
  // `tier === "enterprise"` is the tier gate. The existing
  // `useFeature("backup_enabled")` checks INSIDE SettingsBackups (and its
  // children BackupDestinations / BackupJobs / BackupLogs) are the SECOND
  // gate (D-08 — the feature flag may be off even with enterprise installed).
  const { enterpriseInstalled } = useEnterpriseModulesContext();
  const tier = useLicenseTier();
  usePageMeta(t("settings.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.settings") }]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Sub-section currently highlighted in the menu / scrolled to. `null` means
  // no specific section is targeted (the group header is the active voice).
  const [activeSection, setActiveSection] = useState<string | null>(null);
  // Section id awaiting a scroll-to once its tab content is visible. Cleared
  // after the scroll runs (see the effect below).
  const [pendingSection, setPendingSection] = useState<string | null>(null);
  const { isLoading, error: queryError, refetch } = useSettings();
  const { data: user } = useMe();
  const logoutMutation = useLogout();
  const permissions = user?.permissions ?? [];
  const isMobile = useIsMobile();

  // Restore last settings tab on mount, or honor ?tab= deep link.
  // Priority: URL ?tab= (mapped) > localStorage lastSettingsSection (mapped) > default "general".
  useEffect(() => {
    // Legacy deep-link: widget management moved to its own top-level page.
    if (searchParams.get("tab") === "widgets") {
      navigate("/widgets", { replace: true });
      return;
    }
    const sectionParam = searchParams.get("section");
    const mapped = mapLegacyTab(searchParams.get("tab"));
    if (mapped) {
      setActiveTab(mapped);
      // Normalize the persisted value to the canonical key.
      localStorage.setItem("lastSettingsSection", mapped);
      // Honor a `?section=` deep link: scroll to it once the tab is visible.
      if (sectionParam) setPendingSection(sectionParam);
      return;
    }
    const lastSection = localStorage.getItem("lastSettingsSection");
    const lastMapped = mapLegacyTab(lastSection);
    if (lastMapped) setActiveTab(lastMapped);
  }, [searchParams]);

  // Persist active tab (canonical key) whenever it changes.
  useEffect(() => {
    if (activeTab) {
      localStorage.setItem("lastSettingsSection", activeTab);
    }
  }, [activeTab]);

  // Filter tabs based on user permissions (OR on sub-section perms).
  const visibleTabs = TAB_KEYS.filter((tab) => {
    const requiredPerms = SETTINGS_TAB_PERMISSIONS[tab.key];
    if (!requiredPerms || requiredPerms.length === 0) return true;
    return requiredPerms.some((p: string) => permissions.includes(p));
  });

  // Reset to first visible tab if the current tab is no longer visible.
  useEffect(() => {
    if (!user) return; // Don't reset until user permissions are loaded
    if (visibleTabs.length > 0 && !visibleTabs.find((t) => t.key === activeTab)) {
      setActiveTab(visibleTabs[0]!.key);
    }
  }, [visibleTabs, activeTab, user]);

  const error = queryError ? queryError.message : null;
  const errorStatus = queryError instanceof ApiError ? queryError.status : null;

  const triggerAuthRedirect = useEffectEvent(() => {
    logoutMutation.mutate();
    navigate("/");
  });

  useEffect(() => {
    if (errorStatus === 401 || errorStatus === 403) {
      const timer = setTimeout(triggerAuthRedirect, 3000);
      return () => clearTimeout(timer);
    }
  }, [errorStatus]);

  const handleRetry = () => {
    refetch().catch(() => showError(t("settings.errorLoadSettings")));
  };

  // Wrap tab switch in a CSS View Transition for smooth cross-fade
  // (graceful no-op in browsers without view-transition support).
  const transitionTo = useViewTransition();

  // Group header click: switch page (tab), no specific section targeted.
  const handleSelectTab = (tabKey: string) => {
    transitionTo(() => {
      setActiveTab(tabKey as Tab);
      setActiveSection(null);
    });
  };

  // Sub-menu voice click: switch page AND scroll to the matching section.
  const handleSelectSection = (tabKey: string, sectionId: string) => {
    transitionTo(() => {
      setActiveTab(tabKey as Tab);
      setPendingSection(sectionId);
    });
  };

  // Scroll to the pending section once its tab content is visible. Runs after
  // the tab switch renders (rAF waits one frame for layout to settle), then
  // clears the pending id. Cancelled if a newer section is requested first.
  useEffect(() => {
    if (!pendingSection) return;
    const id = pendingSection;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(settingsSectionAnchor(id));
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveSection(id);
      }
      setPendingSection(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [pendingSection]);

  // Per-sub-section permission gates (OR semantics, same as tab visibility).
  const has = (perm: string) => permissions.includes(perm);
  const hasAny = (perms: string[]) => perms.some((p) => permissions.includes(p));

  // Sub-sections per tab with their permission gates. Single source of truth
  // shared by both the `<SettingsMenu>` sub-menu voices and the `<SubSection>`
  // rendering below — so a voice appears in the menu iff its section renders.
  const sectionsFor = (tab: Tab): { id: SectionId; show: boolean }[] => {
    switch (tab) {
      case "profile":
        return [
          { id: "personalInfo", show: true },
          { id: "customInstructions", show: true },
          { id: "languages", show: has("admin:settings") },
        ];
      case "llm":
        return [
          { id: "providers", show: hasAny(["provider:read", "provider:write"]) },
          { id: "llmEmbedding", show: has("admin:settings") },
        ];
      case "appearance":
        return [{ id: "appearance", show: true }];
      case "security":
        return [
          { id: "roles", show: has("admin:roles") },
          { id: "users", show: has("admin:users") },
          // Phase 70 D-11 / Pitfall 6: non-admin upload toggle visible to
          // a settings-only admin. The Security tab itself is visible
          // because SETTINGS_TAB_PERMISSIONS.security includes admin:settings.
          { id: "nonAdminUpload", show: has("admin:settings") },
          { id: "notifications", show: true },
        ];
      case "advanced":
        return [
          { id: "vectorDB", show: has("admin:settings") },
          { id: "apiKeys", show: has("admin:settings") },
          { id: "mcpConnections", show: has("admin:settings") },
          { id: "maintenance", show: has("admin:settings") },
          {
            id: "backups",
            show: hasAny([
              "backup:destination:read",
              "backup:job:read",
              "backup:log:read",
            ]),
          },
          { id: "dlp", show: has("admin:settings") },
          { id: "webSearch", show: has("admin:settings") },
          { id: "agentWatchdog", show: has("admin:settings") },
          { id: "reranker", show: has("admin:settings") },
          { id: "vapid", show: has("admin:settings") },
          { id: "filters", show: has("filters:manage") },
          { id: "dlpAudit", show: has("admin:settings") },
          { id: "templates", show: has("admin:settings") },
          { id: "chatData", show: true },
          { id: "resetDb", show: has("admin:settings") },
        ];
    }
  };

  // Build the two-level menu: one group per visible tab, each with its
  // permission-filtered sub-sections as always-expanded sub-menu voices.
  const menuGroups: SettingsMenuGroup[] = visibleTabs.map((tab) => ({
    key: tab.key,
    labelKey: tab.labelKey,
    sections: sectionsFor(tab.key)
      .filter((s) => s.show)
      .map((s) => ({ id: s.id, labelKey: SECTION_LABEL[s.id] })),
  }));

  const tabContent = (
    <>
      {/* ── Profilo ── */}
      <TabsContent value="profile" className="mt-0">
        <div className="space-y-8">
          <SubSection id="personalInfo" label={t("settings.subSections.personalInfo")} show>
            <SettingsProfilePersonal />
          </SubSection>
          <SubSection id="customInstructions" label={t("settings.subSections.customInstructions")} show>
            <SettingsProfileInstructions />
          </SubSection>
          <SubSection id="languages" label={t("settings.subSections.languages")} show={has("admin:settings")}>
            <SettingsGeneralLanguages />
          </SubSection>
        </div>
      </TabsContent>

      {/* ── LLM Providers ── */}
      <TabsContent value="llm" className="mt-0">
        <div className="space-y-8">
          <SubSection id="providers" label={t("settings.subSections.providers")} show={hasAny(["provider:read", "provider:write"])}>
            <SettingsProviders />
          </SubSection>
          <SubSection id="llmEmbedding" label={t("settings.subSections.llmEmbedding")} show={has("admin:settings")}>
            <SettingsLLM />
            <SettingsOcr />
            <SettingsSynthesis />
          </SubSection>
        </div>
      </TabsContent>

      {/* ── Appearance ── */}
      <TabsContent value="appearance" className="mt-0">
        <div className="space-y-8">
          <SubSection id="appearance" label={t("settings.subSections.appearance")} show>
            <SettingsAppearance />
          </SubSection>
        </div>
      </TabsContent>

      {/* ── Sicurezza ── */}
      <TabsContent value="security" className="mt-0">
        <div className="space-y-8">
          <SubSection id="roles" label={t("settings.subSections.roles")} show={has("admin:roles")}>
            <SettingsRoles />
          </SubSection>
          <SubSection id="users" label={t("settings.subSections.users")} show={has("admin:users")}>
            <SettingsUsers />
          </SubSection>
          {/* Phase 70 D-11 / SC-4: ALLOW_NON_ADMIN_UPLOAD admin toggle. */}
          <SubSection id="nonAdminUpload" label={t("settings.subSections.nonAdminUpload")} show={has("admin:settings")}>
            <SettingsSecurityNonAdminUpload />
          </SubSection>
          <SubSection id="notifications" label="Notifiche Push" show={has("admin:settings")}>
            <SettingsPushNotifications />
          </SubSection>
        </div>
      </TabsContent>

      {/* ── Avanzate ── */}
      <TabsContent value="advanced" className="mt-0">
        <div className="space-y-8">
          <SubSection id="vectorDB" label={t("settings.subSections.vectorDB")} show={has("admin:settings")}>
            <SettingsVectorDB />
          </SubSection>
          <SubSection id="apiKeys" label={t("settings.subSections.apiKeys")} show={has("admin:settings")}>
            <SettingsApiKeys />
          </SubSection>
          <SubSection id="mcpConnections" label={t("settings.subSections.mcpConnections")} show={has("admin:settings")}>
            <SettingsMcpConnections />
          </SubSection>
          <SubSection id="maintenance" label={t("settings.subSections.maintenance")} show={has("admin:settings")}>
            <SettingsMaintenance />
          </SubSection>
          <SubSection id="backups" label={t("settings.subSections.backups")} show={hasAny(["backup:destination:read", "backup:job:read", "backup:log:read"])}>
            {/* Phase 147 (EPA-11 — D-07/D-08/D-09, SC-3/SC-4, Plan 02):
                the outermost `show={hasAny([...])}` permission gate STAYS
                (a user without backup permissions doesn't see the
                sub-section at all — neither panel nor upgrade card).
                Inside: the FIRST enterprise gate
                (enterpriseInstalled && tier === "enterprise") decides
                whether to lazy-load the SettingsBackups chunk inside a
                Suspense boundary OR render the UpgradePrompt fallback. The
                existing `useFeature("backup_enabled")` checks INSIDE
                SettingsBackups (and its children) are the SECOND gate
                (D-08 — the feature flag may be off even with enterprise
                installed). */}
            {enterpriseInstalled && tier === "enterprise" ? (
              <Suspense fallback={<EnterpriseSpinner />}>
                <SettingsBackups />
              </Suspense>
            ) : (
              <UpgradePrompt
                feature="backup_enabled"
                message={!enterpriseInstalled ? t("upgrade.pluginRequired") : undefined}
              />
            )}
          </SubSection>
          <SubSection id="dlp" label={t("settings.subSections.dlp")} show={has("admin:settings")}>
            <SettingsGeneralDlp />
          </SubSection>
          <SubSection id="webSearch" label={t("settings.subSections.webSearch")} show={has("admin:settings")}>
            <SettingsWebSearch />
          </SubSection>
          <SubSection id="agentWatchdog" label={t("settings.subSections.agentWatchdog")} show={has("admin:settings")}>
            <SettingsAgentWatchdog />
          </SubSection>
          <SubSection id="reranker" label={t("settings.subSections.reranker")} show={has("admin:settings")}>
            <SettingsReranker />
          </SubSection>
          <SubSection id="vapid" label={t("settings.subSections.vapid")} show={has("admin:settings")}>
            <SettingsVapid />
          </SubSection>
          <SubSection id="filters" label={t("settings.subSections.filters")} show={has("filters:manage")}>
            <FiltersTab />
          </SubSection>
          <SubSection id="dlpAudit" label={t("settings.subSections.dlpAudit")} show={has("admin:settings")}>
            <DlpAuditPanel />
          </SubSection>
          {/* Quick 260829-ony — DLP pattern configuration admin UI (spec §2.3). */}
          <SubSection id="dlpPatterns" label={t("settings.subSections.dlpPatterns")} show={has("admin:settings")}>
            <SettingsDlpPatterns />
          </SubSection>
          <SubSection id="templates" label={t("settings.subSections.templates")} show={has("admin:settings")}>
            <SettingsTemplates />
          </SubSection>
          <SubSection id="chatData" label={t("settings.subSections.chatData")} show>
            <SettingsProfileChatData />
          </SubSection>
          <SubSection id="resetDb" label={t("settings.subSections.resetDb")} show={has("admin:settings")}>
            <SettingsGeneralResetDb />
          </SubSection>
        </div>
      </TabsContent>
    </>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 sm:px-6 py-4 border-b border-border">
        <h2 className="text-xl font-semibold text-foreground">{t("settings.pageTitle")}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t("settings.pageDescription")}</p>
      </div>

      {/* Error banner */}
      {error && (
        <div className={cn("mx-6 mt-4 px-4 py-3 rounded-lg flex items-center justify-between", errorStatus === 401 || errorStatus === 403
            ? "bg-accent text-accent-foreground"
            : "bg-destructive text-destructive-foreground")}>
          <span className="text-sm">{
            errorStatus === 401 || errorStatus === 403
              ? t("settings.errorSessionExpired")
              : errorStatus === 500
                ? t("settings.errorServer")
                : error
          }</span>
          {!(errorStatus === 401 || errorStatus === 403) && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              disabled={isLoading}
              className="ml-4"
            >
              {isLoading ? "Retrying..." : "Retry"}
            </Button>
          )}
        </div>
      )}

      {/*
        Feature 7.5 — console-style vertical layout.
        `<Tabs orientation="vertical">` is kept ONLY as the controlled state
        container (value/onValueChange) + TabsContent host, so the React 19
        `Activity` keep-alive, `useViewTransition` cross-fade and deep-link
        `?tab=` wiring are all preserved. The radix tab list/trigger are dropped —
        the desktop rail and the mobile Sheet both render `<SettingsMenu>`
        (plain-button nav), which works inside the Sheet portal that lives
        outside the `<Tabs>` tree.
      */}
      <Tabs
        value={activeTab}
        onValueChange={handleSelectTab}
        orientation="vertical"
        className="flex-1 flex min-h-0"
      >
        {isMobile ? (
          <>
            {/*
              Mobile — console-style transparent overlay. The menu trigger is
              pinned to the top-right as an `absolute` overlay (`pointer-events-
              none` container, `pointer-events-auto` button with a translucent
              backdrop). The sections column fills the whole strip and scrolls
              behind it, so the settings area is covered by content with no
              divider line — mirroring the ChatPanel title-bar (see ChatPanel
              ~line 530). The Sheet is anchored right to match the trigger
              position, symmetric to the chat console Sheet.
            */}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetContent side="right" className="w-64 p-0" showCloseButton={false}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <SheetTitle>{t("settings.pageTitle")}</SheetTitle>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setMobileMenuOpen(false)}
                    className="h-9 w-9"
                    aria-label={t("settings.closeMenu", "Close menu")}
                  >
                    <X className="h-5 w-5" />
                  </Button>
                </div>
                <SettingsMenu
                  groups={menuGroups}
                  activeTab={activeTab}
                  activeSection={activeSection}
                  onSelectTab={(v) => {
                    handleSelectTab(v);
                    setMobileMenuOpen(false);
                  }}
                  onSelectSection={(v, sectionId) => {
                    handleSelectSection(v, sectionId);
                    setMobileMenuOpen(false);
                  }}
                />
              </SheetContent>
            </Sheet>
            <div className="relative flex-1 min-h-0 min-w-0">
              <div className="absolute top-0 inset-x-0 z-30 flex items-center justify-end gap-2 px-3 sm:px-4 py-2 pointer-events-none">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileMenuOpen(true)}
                  className="pointer-events-auto shrink-0 -mr-1 bg-background/60 backdrop-blur-sm"
                  aria-label={t("settings.openTabsMenu", "Open settings menu")}
                  title={t("settings.openTabsMenu", "Open settings menu")}
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </div>
              {/* Sections — fill the whole area, scroll behind the overlay */}
              <div className="h-full overflow-y-auto overflow-x-hidden p-3 sm:p-6">{tabContent}</div>
            </div>
          </>
        ) : (
          <>
            {/* Desktop 240px rail (w-60 ≈ 240px) */}
            <aside className="w-60 shrink-0 min-h-0 border-r border-border overflow-y-auto">
              <SettingsMenu
                groups={menuGroups}
                activeTab={activeTab}
                activeSection={activeSection}
                onSelectTab={handleSelectTab}
                onSelectSection={handleSelectSection}
                className="gap-0"
              />
            </aside>
            {/* Content column */}
            <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-3 sm:p-6">{tabContent}</div>
          </>
        )}
      </Tabs>
    </div>
  );
}
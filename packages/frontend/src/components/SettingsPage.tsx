// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useEffectEvent, lazy, Suspense, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMe, useLogout, useMenuSections } from "../queries/useAuth";
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
import SettingsAgencyUsers from "./SettingsAgencyUsers";
// Phase 189 (WSIS-03, D-19): per-workspace admin access panel.
import SettingsWorkspaceAccess from "./SettingsWorkspaceAccess";
import SettingsApiKeys from "./SettingsApiKeys";
import SettingsRoles from "./SettingsRoles";
import SettingsMcpConnections from "./SettingsMcpConnections";
// Phase 199 (199-02, ECCO-05): external chat-connector admin panel —
// Settings sub-section beside mcpConnections (D-08, no new route).
import SettingsConnectors from "./SettingsConnectors";
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
import { SettingsQuotaPresets } from "./SettingsQuotaPresets";
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
// Phase 192 (DLP-05/DLP-06, UI-SPEC surface 4): eval-gate panel + legacy
// backfill trigger — sibling card rendered DIRECTLY below SettingsGeneralDlp.
import DlpDocumentScanPanel from "./DlpDocumentScanPanel";
import { SettingsTemplates } from "./SettingsTemplates";
import { SettingsSecurityNonAdminUpload } from "./SettingsSecurityNonAdminUpload";
import SettingsPushNotifications from "./SettingsPushNotifications";
import { SETTINGS_TAB_PERMISSIONS } from "@simmetric-chat/shared";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils"
import { ChevronRight, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
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

type Tab = "profile" | "llm" | "appearance" | "security" | "advanced" | "team";

/**
 * Canonical sub-section ids. Each maps to a labelled `<SubSection>` inside a
 * tab and to a sub-menu voice in `<SettingsMenu>`. The id is also the anchor
 * used for scroll-to-section (`settings-section-<id>`) and the `?section=`
 * deep link.
 */
type SectionId =
  | "quotaPresets"
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
  // Phase 206 (AGENCY-01, D-10): team tab (agencyUsers voice).
  | "agencyUsers"
  | "resetDb"
  // Phase 189 (WSIS-03, D-19): admin per-workspace access panel (Security tab).
  | "workspaceAccess"
  // Phase 199 (199-02, ECCO-05): external chat-connector admin panel (D-08).
  | "connectors"
  // Phase 206 (AGENCY-01, D-10): agency team-management voice (team tab).
  | "agencyUsers";

/** i18n label key for each sub-section id (matches `settings.subSections.*`). */
const SECTION_LABEL: Record<SectionId, string> = {
  quotaPresets: "settings.quotaPresets.title",
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
  // Phase 189 (WSIS-03, D-19): admin per-workspace access panel.
  workspaceAccess: "settings.subSections.workspaceAccess",
  // Phase 199 (199-02, ECCO-05): external chat-connector admin panel.
  connectors: "settings.subSections.connectors",
  // Phase 206 (AGENCY-01, D-10): agency team voice.
  agencyUsers: "settings.subSections.agencyUsers",
};

/** DOM anchor id for a sub-section — used by SettingsMenu scroll-to-section. */
function settingsSectionAnchor(id: string): string {
  return `settings-section-${id}`;
}

/** The menu voice currently open as a detail page. */
interface DetailVoice {
  tab: Tab;
  /** i18n label key of the open voice (group header OR sub-section). */
  labelKey: string;
  /** Sub-section id when a sub-menu voice is open, null for a group page. */
  sectionId: string | null;
}

/**
 * Fallback i18n label key for a tab key (kept in sync with TAB_KEYS).
 * Used when a voice is opened before SECTION_LABEL lookup would fail.
 */
function labelKeyOf(tab: Tab): string {
  return TAB_KEYS.find((t) => t.key === tab)?.labelKey ?? "settings.pageTitle";
}

const TAB_KEYS: { key: Tab; labelKey: string }[] = [
  { key: "profile", labelKey: "settings.tabs.profile" },
  { key: "llm", labelKey: "settings.tabs.llmProviders" },
  { key: "appearance", labelKey: "settings.tabs.appearance" },
  { key: "security", labelKey: "settings.tabs.security" },
  { key: "advanced", labelKey: "settings.tabs.advanced" },
  // Phase 206 (AGENCY-01, D-10): agency team-management tab (permission-gated).
  { key: "team", labelKey: "settings.tabs.team" },
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
  // Phase 199 (199-02, ECCO-05): deep-link parity for the connectors
  // sub-section (the mcpconnections/mcpConnections twin precedent).
  connectors: "advanced",
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

/**
 * Animated wrapper for the settings detail page (master-detail transition).
 *
 * Keyed by the open voice: changing the key remounts the element, which
 * restarts the `settings-slide-page` CSS animation (slide-in from the
 * right, ease-out) — no transition-state bookkeeping, correct on every
 * browser. Reduced-motion users get the plain swap (media query in
 * index.css).
 */
function SettingsSlide({ slideKey, children }: { slideKey: string; children: ReactNode }) {
  return (
    <div
      key={slideKey}
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden settings-scroll settings-slide-page"
    >
      {children}
    </div>
  );
}

/**
 * Detail page for a top-level tab (group header voice): every visible
 * sub-section of that tab, rendered as labelled `<SubSection>` blocks —
 * the same markup the old tab column rendered. One page = one menu voice.
 */
function GroupPage({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const me = useMe();
  const user = me.data;
  const { enterpriseInstalled } = useEnterpriseModulesContext();
  const tier = useLicenseTier();
  const has = (perm: string) => (user?.permissions ?? []).includes(perm);
  const hasAny = (perms: string[]) => perms.some((p) => (user?.permissions ?? []).includes(p));

  switch (tab) {
    case "profile":
      return (
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
      );
    case "llm":
      return (
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
      );
    case "appearance":
      // The appearance tab is a single sub-section: its group page renders
      // it directly, so a group-header click never lands on a blank page.
      return <SettingsAppearance />;
    case "team":
      // Phase 206 (AGENCY-01, D-10): single-component tab (appearance idiom) —
      // all option lists arrive server-derived; the client never computes
      // the lattice.
      return <SettingsAgencyUsers />;
    case "security":
      return (
        <div className="space-y-8">
          <SubSection id="roles" label={t("settings.subSections.roles")} show={has("admin:roles")}>
            <SettingsRoles />
          </SubSection>
          <SubSection id="users" label={t("settings.subSections.users")} show={has("admin:users")}>
            <SettingsUsers />
          </SubSection>
          {/* Phase 189 (WSIS-03, D-19): per-workspace admin access panel.
              189-REVIEW WR-05: gated to admin:settings ONLY — the server's
              isAdmin authorization tier is admin:settings (utils/auth.ts:69),
              so an admin:users-only admin was advertised a capability the
              server 403s on every list/grant/revoke call. */}
          <SubSection id="workspaceAccess" label={t("settings.subSections.workspaceAccess")} show={has("admin:settings")}>
            <SettingsWorkspaceAccess />
          </SubSection>
          {/* Phase 70 D-11 / SC-4: ALLOW_NON_ADMIN_UPLOAD admin toggle. */}
          <SubSection id="nonAdminUpload" label={t("settings.subSections.nonAdminUpload")} show={has("admin:settings")}>
            <SettingsSecurityNonAdminUpload />
          </SubSection>
          <SubSection id="notifications" label="Notifiche Push" show={has("admin:settings")}>
            <SettingsPushNotifications />
          </SubSection>
        </div>
      );
    case "advanced":
      return (
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
          {/* Phase 199 (199-02, ECCO-05): external chat-connector admin
              panel — directly below mcpConnections. Gate is connector:view
              (D-08: a view-only admin sees the cards; actions are gated
              connector:manage inside the panel). */}
          <SubSection id="connectors" label={t("settings.subSections.connectors")} show={has("connector:view")}>
            <SettingsConnectors />
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
            {/* Phase 192 (UI-SPEC surface 4): eval-gate + backfill panel sits
                DIRECTLY below the chat-side DLP card, same sub-section. */}
            <DlpDocumentScanPanel />
          </SubSection>
          <SubSection id="quotaPresets" label={t("settings.quotaPresets.title")} show={has("admin:settings")}>
            {/* Phase 207 (CLOUD-04, D-08): install-level quota presets. */}
            <SettingsQuotaPresets />
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
      );
    default:
      return null;
  }
}

/**
 * Detail page for one single sub-section voice (from the rail sub-menu):
 * just that section, standalone.
 */
function SectionPage({ id }: { id: SectionId }) {
  const { t } = useTranslation();
  const { enterpriseInstalled } = useEnterpriseModulesContext();
  const tier = useLicenseTier();

  switch (id) {
    case "personalInfo":
      return <SettingsProfilePersonal />;
    case "customInstructions":
      return <SettingsProfileInstructions />;
    case "languages":
      return <SettingsGeneralLanguages />;
    case "providers":
      return <SettingsProviders />;
    case "llmEmbedding":
      return (
        <div className="space-y-8">
          <SettingsLLM />
          <SettingsOcr />
          <SettingsSynthesis />
        </div>
      );
    case "appearance":
      return <SettingsAppearance />;
    // Phase 206 (AGENCY-01): detail arm for the agencyUsers voice.
    case "agencyUsers":
      return <SettingsAgencyUsers />;
    case "roles":
      return <SettingsRoles />;
    case "users":
      return <SettingsUsers />;
    // Phase 189 (WSIS-03, D-19): detail-page arm of the per-workspace
    // access panel (rail sub-menu voice open as its own page).
    case "workspaceAccess":
      return <SettingsWorkspaceAccess />;
    case "nonAdminUpload":
      return <SettingsSecurityNonAdminUpload />;
    case "notifications":
      return <SettingsPushNotifications />;
    case "vectorDB":
      return <SettingsVectorDB />;
    case "apiKeys":
      return <SettingsApiKeys />;
    case "mcpConnections":
      return <SettingsMcpConnections />;
    // Phase 199 (199-02, ECCO-05): the only new component mount (D-08).
    case "connectors":
      return <SettingsConnectors />;
    case "maintenance":
      return <SettingsMaintenance />;
    case "backups":
      return enterpriseInstalled && tier === "enterprise" ? (
        <Suspense fallback={<EnterpriseSpinner />}>
          <SettingsBackups />
        </Suspense>
      ) : (
        <UpgradePrompt
          feature="backup_enabled"
          message={!enterpriseInstalled ? t("upgrade.pluginRequired") : undefined}
        />
      );
    case "dlp":
      // Phase 192: the detail-page arm carries BOTH DLP cards in the same
      // order as the group page (chat-side card, then the document-scan panel).
      return (
        <div className="space-y-8">
          <SettingsGeneralDlp />
          <DlpDocumentScanPanel />
        </div>
      );
    case "webSearch":
      return <SettingsWebSearch />;
    case "agentWatchdog":
      return <SettingsAgentWatchdog />;
    case "reranker":
      return <SettingsReranker />;
    case "vapid":
      return <SettingsVapid />;
    case "filters":
      return <FiltersTab />;
    case "dlpAudit":
      return <DlpAuditPanel />;
    case "dlpPatterns":
      return <SettingsDlpPatterns />;
    case "templates":
      return <SettingsTemplates />;
    case "chatData":
      return <SettingsProfileChatData />;
    case "resetDb":
      return <SettingsGeneralResetDb />;
    default:
      return null;
  }
}

export default function SettingsPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  usePageMeta(t("settings.pageTitle"), [{ label: t("breadcrumb.home"), path: "/" }, { label: t("breadcrumb.settings") }]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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
    const mapped = mapLegacyTab(searchParams.get("tab"));
    if (mapped) {
      setActiveTab(mapped);
      // Normalize the persisted value to the canonical key.
      localStorage.setItem("lastSettingsSection", mapped);
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

  // Filter tabs: Phase 206 (VIS-01, D-15) — the SERVER-resolved
  // settingsSections win when the visibility payload is present; the
  // SETTINGS_TAB_PERMISSIONS OR-permissions stay as the in-code fallback
  // (defensive when the payload lacks the key).
  const { data: visibilityData } = useMenuSections();
  const serverSettingsSections = visibilityData?.settingsSections;
  const visibleTabs = TAB_KEYS.filter((tab) => {
    if (serverSettingsSections) return serverSettingsSections.includes(tab.key);
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

  // Group header click (via the `<Tabs>` controlled container): reset to the
  // tab's overview page.
  const handleSelectTab = (tabKey: string) => {
    setActiveTab(tabKey as Tab);
  };

  // Per-sub-section permission gates (OR semantics, same as tab visibility).
  const has = (perm: string) => permissions.includes(perm);
  const hasAny = (perms: string[]) => perms.some((p) => permissions.includes(p));

  // Sub-sections per tab with their permission gates. Single source of truth
  // shared by both the `<SettingsMenu>` sub-menu voices and the detail-page
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
      // Phase 206 (AGENCY-01, D-10): the team tab renders its single
      // component directly in the detail area (appearance idiom); the voice
      // mirrors that with a permission-gated show flag.
      case "team":
        return [{ id: "agencyUsers", show: has("agency:users:manage") }];
      case "security":
        return [
          { id: "roles", show: has("admin:roles") },
          { id: "users", show: has("admin:users") },
          // Phase 189 (WSIS-03, D-19): per-workspace access panel — gated to
          // admin:settings ONLY (WR-05: matches the server authorization tier,
          // isAdmin = admin:settings in utils/auth.ts:69).
          { id: "workspaceAccess", show: has("admin:settings") },
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
          // Phase 199 (199-02, ECCO-05): connectors sub-section voice —
          // gated connector:view (menu/page parity with the SubSection).
          { id: "connectors", show: has("connector:view") },
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
          // Quick 260910-dzh — menu/page parity: GroupPage + SectionPage
          // render dlpPatterns; the rail must carry the same voice.
          { id: "dlpPatterns", show: has("admin:settings") },
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

  // Master-detail UI state (both desktop and mobile share it — only the rail
  // rendering differs: inline `<aside>` on desktop, left Sheet drawer on
  // mobile). `detailVoice` = the open page (group OR sub-section); `null`
  // when the whole rail overview is visible.
  const [detailVoice, setDetailVoice] = useState<DetailVoice | null>(null);
  // Rail visibility (desktop): slides away when a voice is opened, slides
  // back when the detail top-bar toggle is pressed.
  const [railVisible, setRailVisible] = useState(true);
  // Detail page scroll target — cleared once the scroll runs.
  const [detailScroll, setDetailScroll] = useState<string | null>(null);

  // Open a menu voice as a full detail page (rail slides away).
  const openDetail = (tab: Tab, labelKey: string, sectionId: string | null) => {
    setDetailVoice({ tab, labelKey, sectionId });
    setRailVisible(false);
    setActiveTab(tab);
  };

  /*
   * Master-detail layout (UI revision: settings as a console).
   *
   *   • DETAIL  — the right-hand settings page. One visible page at a time:
   *     a group voice renders ALL of that tab's sub-sections stacked; a
   *     sub-section voice renders just that section. Enters with a
   *     slide-from-right animation on every voice change (keyed remount).
   *   • MASTER  — the left rail (`SettingsMenu`) with the full two-level
   *     menu, always in the DOM. Opening a voice slides it away (CSS
   *     translate + margin transition, translated off-canvas so
   *     `overflow-hidden` never clips it); the detail top-bar toggle
   *     (`PanelLeftOpen`) slides it back. On mobile the rail is a LEFT
   *     Sheet drawer with its own open/close toggle instead.
   *
   * `<Tabs>` stays as the controlled state container so deep-link `?tab=`
   * wiring, localStorage persistence and the `<TabsContent>` keep-alive are
   * preserved; the radix tab list/trigger are not rendered — the same
   * `<SettingsMenu>` (plain-button nav, works inside the Sheet portal)
   * drives both the desktop rail and the mobile drawer.
   */
  const isDetail = detailVoice !== null;
  const activeGroupLabel = isDetail
    ? (TAB_KEYS.find((t) => t.key === detailVoice!.tab)?.labelKey ?? null)
    : null;
  const detailSlideKey = detailVoice ? `${detailVoice.tab}:${detailVoice.labelKey}` : "none";

  // Scroll the detail page to the targeted sub-section once it is visible
  // (sub-menu deep links). `block: "start"` + the section's `scroll-mt`
  // clear the sticky top bar.
  useEffect(() => {
    if (!isDetail || !detailScroll) return;
    const id = detailScroll;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(settingsSectionAnchor(id));
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      setDetailScroll(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [isDetail, detailScroll]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header — hidden in the embedded (dialog) variant: the dialog already
          carries the close affordance and the left rail is the navigation. */}
      {!embedded && (
        <div className="px-3 sm:px-6 py-4 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">{t("settings.pageTitle")}</h2>
          <p className="text-sm text-muted-foreground mt-1">{t("settings.pageDescription")}</p>
        </div>
      )}

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

      <Tabs
        value={activeTab}
        onValueChange={handleSelectTab}
        orientation="vertical"
        className="flex-1 flex min-h-0"
      >
        {/* ── Desktop / embedded (≥768px): inline rail + detail column ── */}
        {!isMobile && (
          <>
            {/* MASTER — the two-level menu rail. Always in the DOM; opening
                a voice slides it away (translate + margin, never w-0, so
                the focus ring never clips mid-animation). */}
            <aside
              className={cn(
                "w-60 shrink-0 min-h-0 border-r border-border overflow-hidden bg-background transition-all duration-300 ease-in-out",
                railVisible ? "settings-rail-open" : "settings-rail-closed",
              )}
              aria-hidden={!railVisible}
              aria-label={t("settings.menuLabel", "Settings sections")}
            >
              <div className="h-full overflow-y-auto overflow-x-hidden settings-scroll">
                <SettingsMenu
                  groups={menuGroups}
                  activeVoice={detailVoice}
                  onSelectTab={(tabKey) => openDetail(tabKey as Tab, labelKeyOf(tabKey as Tab), null)}
                  onSelectSection={(tabKey, sectionId) => {
                    openDetail(tabKey as Tab, SECTION_LABEL[sectionId as SectionId] ?? labelKeyOf(tabKey as Tab), sectionId);
                  }}
                  className="gap-0"
                />
              </div>
            </aside>
            {/* DETAIL — the right column. Shows the active tab's full page
                (all its sub-sections stacked) when the rail is visible, or
                the focused voice's page after a voice is opened. Slides on
                every voice change (keyed remount → restart the animation). */}
            <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
              {isDetail ? (
                <>
                  {/* Detail top bar: rail toggle + breadcrumb (group › page). */}
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRailVisible((o) => !o)}
                      className="h-9 w-9 shrink-0"
                      aria-label={railVisible ? t("settings.closeMenu", "Close menu") : t("settings.openTabsMenu", "Open settings menu")}
                      title={railVisible ? t("settings.closeMenu", "Close menu") : t("settings.openTabsMenu", "Open settings menu")}
                    >
                      {railVisible ? (
                        <PanelLeftClose className="h-5 w-5" />
                      ) : (
                        <PanelLeftOpen className="h-5 w-5" />
                      )}
                    </Button>
                    <div className="flex items-center gap-1 min-w-0 text-sm">
                      <span className="shrink-0 text-muted-foreground">
                        {activeGroupLabel ? t(activeGroupLabel) : null}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                      <span className="truncate font-medium text-foreground">
                        {t(detailVoice.labelKey)}
                      </span>
                    </div>
                  </div>
                  <SettingsSlide slideKey={detailSlideKey}>
                    {detailVoice.sectionId ? (
                      <SectionPage id={detailVoice.sectionId as SectionId} />
                    ) : (
                      <GroupPage tab={detailVoice.tab} />
                    )}
                  </SettingsSlide>
                </>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 sm:p-6">
                  <TabsContent value={activeTab} className="mt-0">
                    <GroupPage tab={activeTab} />
                  </TabsContent>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Mobile (<768px): left drawer (Sheet) + full-area page ── */}
        {isMobile && (
          <>
            {/* MASTER — the two-level menu in a LEFT drawer with its own
                open/close toggle. */}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetContent side="left" className="w-72 max-w-[85vw] p-0" showCloseButton={false}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
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
                {/* The drawer body scrolls vertically; over-wide menu
                    entries never clip — they scroll within the drawer. */}
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden settings-scroll">
                  <SettingsMenu
                    groups={menuGroups}
                    activeVoice={detailVoice}
                    onSelectTab={(tabKey) => {
                      openDetail(tabKey as Tab, labelKeyOf(tabKey as Tab), null);
                      setMobileMenuOpen(false);
                    }}
                    onSelectSection={(tabKey, sectionId) => {
                      openDetail(tabKey as Tab, SECTION_LABEL[sectionId as SectionId] ?? labelKeyOf(tabKey as Tab), sectionId);
                      setDetailScroll(sectionId);
                      setMobileMenuOpen(false);
                    }}
                  />
                </div>
              </SheetContent>
            </Sheet>
            {/* DETAIL — fills the whole area with its own vertical scrollbar
                (horizontal scrolling is delegated to the individual
                over-wide blocks — tables, forms, code — so each oversized
                element scrolls within itself instead of stretching the
                whole page). A top-bar drawer toggle + breadcrumb
                (group › page) keep the location visible. */}
            <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
              {/* Top bar: drawer toggle + breadcrumb (always visible on
                  mobile — the drawer trigger must be reachable from any
                  page). */}
              <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileMenuOpen((o) => !o)}
                  className="h-9 w-9 shrink-0"
                  aria-label={mobileMenuOpen ? t("settings.closeMenu", "Close menu") : t("settings.openTabsMenu", "Open settings menu")}
                  title={mobileMenuOpen ? t("settings.closeMenu", "Close menu") : t("settings.openTabsMenu", "Open settings menu")}
                >
                  {mobileMenuOpen ? <X className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
                </Button>
                <div className="flex items-center gap-1 min-w-0 text-sm">
                  <span className="shrink-0 text-muted-foreground">
                    {activeGroupLabel ? t(activeGroupLabel) : null}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" />
                  <span className="truncate font-medium text-foreground">
                    {detailVoice ? t(detailVoice.labelKey) : t("settings.pageTitle")}
                  </span>
                </div>
              </div>
              {isDetail ? (
                <SettingsSlide slideKey={detailSlideKey}>
                  <div className="p-3 sm:p-6 max-w-full">
                    {detailVoice.sectionId ? (
                      <SectionPage id={detailVoice.sectionId as SectionId} />
                    ) : (
                      <GroupPage tab={detailVoice.tab} />
                    )}
                  </div>
                </SettingsSlide>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 sm:p-6">
                  <TabsContent value={activeTab} className="mt-0">
                    <GroupPage tab={activeTab} />
                  </TabsContent>
                </div>
              )}
            </div>
          </>
        )}
      </Tabs>
    </div>
  );
}
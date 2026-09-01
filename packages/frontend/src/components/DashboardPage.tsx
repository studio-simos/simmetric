// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useChatNav } from "../contexts/ChatContext";
import { useWorkspaces } from "../queries/useWorkspaces";
import { useLicenseInfo } from "../queries/useLicense";
import { useSessionTokens } from "../queries/useChatTokens";
import { useSynthesisPendingCount } from "../queries/useSynthesis";
import { useArchives } from "../queries/useArchives";
import {
  MessageSquare,
  FileText,
  BookOpen,
  FlaskConical,
  Settings,
  BarChart3,
  ShieldCheck,
  Cpu,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface QuickLink {
  path: string;
  labelKey: string;
  icon: React.ReactNode;
  descKey: string;
  /** Optional menu section gate; link hidden if user lacks the section. */
  section?: string;
}

export default function DashboardPage() {
  const { t } = useTranslation();
  usePageMeta(t("dashboard.pageTitle"), [
    { label: t("breadcrumb.home"), path: "/" },
    { label: t("dashboard.pageTitle") },
  ]);
  const navigate = useNavigate();
  const { currentWorkspaceId } = useChatNav();
  const { data: workspaces = [] } = useWorkspaces();
  const { data: license } = useLicenseInfo();
  const { data: tokens } = useSessionTokens(currentWorkspaceId ?? undefined);
  const { data: pendingSynthesisData } = useSynthesisPendingCount();
  const pendingSynthesis = pendingSynthesisData?.count ?? 0;
  const { data: archives = [] } = useArchives();

  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId) ?? null;
  const isEnterprise = license?.tier === "enterprise";

  const quickLinks: QuickLink[] = [
    { path: "/", labelKey: "sidebar.chat", icon: <MessageSquare className="w-5 h-5" />, descKey: "dashboard.links.chat" },
    { path: "/documents", labelKey: "sidebar.documents", icon: <FileText className="w-5 h-5" />, descKey: "dashboard.links.documents" },
    { path: "/knowledge-base", labelKey: "sidebar.knowledgeBase", icon: <BookOpen className="w-5 h-5" />, descKey: "dashboard.links.knowledgeBase" },
    { path: "/synthesis", labelKey: "synthesis.sidebar.label", icon: <FlaskConical className="w-5 h-5" />, descKey: "dashboard.links.synthesis", section: "synthesis" },
    { path: "/analytics", labelKey: "sidebar.analytics", icon: <BarChart3 className="w-5 h-5" />, descKey: "dashboard.links.analytics", section: "analytics" },
    { path: "/settings", labelKey: "sidebar.settings", icon: <Settings className="w-5 h-5" />, descKey: "dashboard.links.settings", section: "settings" },
  ];

  return (
    <div className="h-full overflow-y-auto p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-foreground font-mono tracking-tight">
          {t("dashboard.welcome", { name: currentWorkspace?.name ?? t("app.name") })}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("dashboard.subtitle")}</p>
      </div>

      {/* Status row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatusCard
          icon={<ShieldCheck className="w-4 h-4" />}
          label={t("dashboard.status.tier")}
          value={license ? license.tier.toUpperCase() : "—"}
          valueClass={isEnterprise ? "text-primary" : "text-muted-foreground"}
        />
        <StatusCard
          icon={<Cpu className="w-4 h-4" />}
          label={t("dashboard.status.airgap")}
          value={t("dashboard.status.airgapped")}
          valueClass="text-primary"
        />
        <StatusCard
          icon={<MessageSquare className="w-4 h-4" />}
          label={t("dashboard.status.tokensToday")}
          value={tokens ? `${(tokens.totalInput + tokens.totalOutput).toLocaleString()}` : "—"}
          valueClass="font-mono text-primary"
          mono
        />
      </div>

      {/* Current workspace */}
      {currentWorkspace ? (
        <div className="rounded-lg border border-input bg-card p-5">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3 font-mono">
            {t("dashboard.currentWorkspace")}
          </h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-semibold text-foreground">{currentWorkspace.name}</p>
              <p className="text-xs text-muted-foreground mt-1 font-mono">
                {currentWorkspace.id.substring(0, 8)}…
              </p>
            </div>
            <button
              onClick={() => navigate("/")}
              className="rounded border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-theme"
            >
              {t("dashboard.openChat")}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-input bg-card/50 p-5 text-center">
          <p className="text-sm text-muted-foreground">{t("dashboard.noWorkspace")}</p>
        </div>
      )}

      {/* Quick links */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3 font-mono">
          {t("dashboard.quickLinks")}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {quickLinks.map((link) => (
            <button
              key={link.path}
              onClick={() => navigate(link.path)}
              className={cn(
                "group flex items-start gap-3 rounded-lg border border-input bg-card p-4 text-left transition-theme hover:border-primary/50 hover:bg-accent",
              )}
            >
              <span className="mt-0.5 text-muted-foreground group-hover:text-primary transition-colors">
                {link.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{t(link.labelKey)}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">{t(link.descKey)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Knowledge snapshot */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg border border-input bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">{t("dashboard.kb.archives")}</p>
          <p className="text-2xl font-semibold text-foreground mt-1 font-mono">{archives.length}</p>
        </div>
        <div className="rounded-lg border border-input bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono">{t("dashboard.kb.synthesisPending")}</p>
          <p className="text-2xl font-semibold text-foreground mt-1 font-mono">{pendingSynthesis}</p>
        </div>
      </div>
    </div>
  );
}

function StatusCard({
  icon,
  label,
  value,
  valueClass,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-input bg-card p-4 flex items-center gap-3">
      <span className="text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground uppercase tracking-wider font-mono truncate">{label}</p>
        <p className={cn("text-base font-semibold truncate", mono && "font-mono", valueClass)}>{value}</p>
      </div>
    </div>
  );
}
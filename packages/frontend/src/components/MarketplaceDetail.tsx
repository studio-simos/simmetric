// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChatNav } from "../contexts/ChatContext";
import {
  useMarketplaceCatalog,
  useInstallMarketplaceEntry,
  useUninstallMarketplaceEntry,
} from "../queries/useMarketplace";
import { useMcpConnections, useTestMcpConnection } from "../queries/useMcpConnections";
import { showSuccess, showError } from "../lib/toast";
import { apiGet } from "../utils/api";
import MarketplaceInstallDialog from "./MarketplaceInstallDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbSeparator,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldCheck, Check, ChevronLeft, KeyRound } from "lucide-react";
import type { CatalogEntry } from "../queries/useMarketplace";
import { getErrorMessage } from "../utils/errorUtils";

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const rtf = new Intl.RelativeTimeFormat(navigator.language, { numeric: "auto" });
  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  if (minutes > 0) return rtf.format(-minutes, "minute");
  return rtf.format(-seconds, "second");
}

// Phase 197 (MCPO-03 D-06): display name for OAuth-provider copy interpolation
// — never shown as a raw registry key.
function oauthProviderDisplayName(provider: string | null | undefined): string {
  return provider === "google" ? "Google" : "Microsoft";
}

interface InstalledTool {
  name: string;
  description?: string;
}

export default function MarketplaceDetail() {
  const { entryId } = useParams<{ entryId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const { currentWorkspaceId } = useChatNav();
  useMarketplaceCatalog(currentWorkspaceId ?? undefined);
  const { data: connections = [] } = useMcpConnections();
  const testMutation = useTestMcpConnection();
  const installMutation = useInstallMarketplaceEntry();
  const uninstallMutation = useUninstallMarketplaceEntry();

  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installedTools, setInstalledTools] = useState<InstalledTool[]>([]);
  const [installing, setInstalling] = useState(false);
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);

  useEffect(() => {
    if (!entryId) return;

    let cancelled = false;

    async function loadEntry() {
      setLoading(true);
      setError(null);
      try {
        const result = await apiGet<CatalogEntry>(`/mcp-marketplace/${entryId}`);
        if (!cancelled) {
          setEntry(result);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(getErrorMessage(err, "Failed to load entry"));
          setLoading(false);
        }
      }
    }

    loadEntry();

    return () => {
      cancelled = true;
    };
    // Only run on mount and when entryId changes
     
  }, [entryId]);

  // When entry is installed and connections are available, fetch live tools
  useEffect(() => {
    if (!entry?.isInstalled || !currentWorkspaceId) return;

    const conn = connections.find(
      (c) => c.workspaceId === currentWorkspaceId && c.name === entry.name
    );

    if (conn) {
      testMutation.mutateAsync(conn.id).then((result) => {
        if (result.success && result.tools) {
          setInstalledTools(result.tools);
        }
      }).catch(() => {
        // Test connection failed — tools will remain empty
      });
    }
  }, [entry?.isInstalled, currentWorkspaceId, connections, entry?.name]);

  const handleInstall = () => {
    if (!entry || !currentWorkspaceId) return;
    setShowInstallDialog(true);
  };

  const confirmInstall = async (headers: Record<string, string>) => {
    if (!entry || !currentWorkspaceId) return;
    setInstalling(true);
    try {
      await installMutation.mutateAsync({ entryId: entry.id, workspaceId: currentWorkspaceId, headers });
      // Update local entry state to reflect installed status
      setEntry({ ...entry, isInstalled: true });
      // Phase 197 (MCPO-03 D-05/D-06, UI-SPEC §4): OAuth-entry installs get
      // the completion-guidance toast; non-OAuth entries keep the existing
      // copy byte-identically.
      if (entry.authType === "oauth") {
        showSuccess(
          t("marketplace.toast.installSuccessOAuth", {
            name: entry.name,
            provider: oauthProviderDisplayName(entry.oauthProvider),
          })
        );
      } else {
        showSuccess(t("marketplace.toast.installSuccess", { name: entry.name }));
      }
      setShowInstallDialog(false);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        showError(t("marketplace.toast.alreadyInstalled", { name: entry.name }));
      } else {
        showError(t("marketplace.toast.installFailed", { name: entry.name }));
      }
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async () => {
    if (!entry || !currentWorkspaceId) return;
    setUninstalling(true);
    try {
      await uninstallMutation.mutateAsync({ entryId: entry.id, workspaceId: currentWorkspaceId });
      setEntry({ ...entry, isInstalled: false });
      showSuccess(t("marketplace.toast.uninstallSuccess", { name: entry.name }));
    } catch {
      showError(t("marketplace.toast.uninstallFailed", { name: entry.name }));
    } finally {
      setUninstalling(false);
      setShowUninstallConfirm(false);
    }
  };

  // Loading state — skeleton
  if (loading && !entry) {
    return (
      <div className="h-full overflow-y-auto p-6 pt-[32px]">
        <Skeleton className="w-full h-[300px] rounded-xl" />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="h-full overflow-y-auto p-6 pt-[32px]">
        <div className="bg-destructive/10 text-destructive border border-destructive/20 p-[16px] rounded-lg mb-[24px]">
          {t("marketplace.empty.error")}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/mcp-marketplace")}
          className="flex items-center gap-2"
        >
          <ChevronLeft className="w-4 h-4" />
          {t("marketplace.detail.backToList")}
        </Button>
      </div>
    );
  }

  // Not found state
  if (!loading && !error && !entry) {
    return (
      <div className="h-full overflow-y-auto p-6 pt-[32px] text-center">
        <p className="text-muted-foreground mb-[16px]">{t("marketplace.empty.notFound")}</p>
        <Button
          variant="link"
          size="sm"
          onClick={() => navigate("/mcp-marketplace")}
        >
          Back to Marketplace
        </Button>
      </div>
    );
  }

  // Main loaded state
  if (!entry) return null;

  const matchingConnection = connections.find(
    (c) => c.workspaceId === currentWorkspaceId && c.name === entry.name
  );

  return (
    <div className="h-full overflow-y-auto p-6 pt-[32px]">
      {/* Breadcrumb */}
      <Breadcrumb className="mb-[24px]">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/mcp-marketplace">Marketplace</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{entry.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Section 1 — Back button */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/mcp-marketplace")}
          className="flex items-center gap-2 mb-[24px]"
        >
          <ChevronLeft className="w-4 h-4" />
          {t("marketplace.detail.backToList")}
        </Button>
      </div>

      {/* Section 2 — Header */}
      <div className="mb-[24px] flex items-start justify-between">
        <div>
          <h1 className="text-[24px] font-semibold text-foreground">
            {entry.name}
          </h1>
          <div className="flex items-center gap-3 mt-[8px]">
            {entry.author && (
              <span className="text-sm text-muted-foreground">
                {t("marketplace.detail.byAuthor", { author: entry.author })}
              </span>
            )}
            {entry.version && (
              <span className="text-xs text-muted-foreground bg-accent px-2 py-0.5 rounded">
                {t("marketplace.card.version", { version: entry.version })}
              </span>
            )}
            {entry.verificationTier === "official" && (
              <Badge
                variant="default"
                className="inline-flex items-center gap-1 text-xs font-medium"
                title={t("mcp.badges.tooltipOfficial")}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                {t("mcp.badges.official")}
              </Badge>
            )}
            {entry.verificationTier === "verified_community" && (
              <Badge
                variant="secondary"
                className="inline-flex items-center gap-1 text-xs font-medium"
                title={t("mcp.badges.tooltipVerifiedCommunity")}
              >
                <Check className="w-3.5 h-3.5" />
                {t("mcp.badges.verifiedCommunity")}
              </Badge>
            )}
            {/* Phase 197 (MCPO-03 D-06/UI-SPEC §3): OAuth indicator after the
                verification-tier badges — outline neutral, accent reserved. */}
            {entry.authType === "oauth" && (
              <Badge
                variant="outline"
                className="inline-flex items-center gap-1 text-xs font-medium cursor-default"
                title={t("marketplace.card.oauthBadgeTooltip", {
                  provider: oauthProviderDisplayName(entry.oauthProvider),
                })}
              >
                <KeyRound className="w-3.5 h-3.5" />
                {t("marketplace.card.oauthBadge", {
                  provider: oauthProviderDisplayName(entry.oauthProvider),
                })}
              </Badge>
            )}
          </div>
          {/* Phase 197 (MCPO-03 D-05/D-06, UI-SPEC §4): pending-connection
              guidance — the entry is installed, OAuth-capable, and the
              matching connection still sits in oauthStatus=pending. The admin
              completes it in MCP Settings via the existing Connect flow. */}
          {entry.isInstalled &&
            entry.authType === "oauth" &&
            matchingConnection?.oauthStatus === "pending" && (
              <div className="flex items-center gap-2 mt-[8px]">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("marketplace.detail.pendingConnect", {
                    provider: oauthProviderDisplayName(entry.oauthProvider),
                  })}
                </p>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-primary"
                  onClick={() => navigate("/settings?tab=mcpConnections")}
                >
                  {t("marketplace.detail.openMcpSettings")}
                </Button>
              </div>
            )}
          <div className="flex items-center gap-2 mt-[8px]">
            {/* Health status badge */}
            {entry.healthStatus === "healthy" ? (
              <Badge
                variant="default"
                className="inline-flex items-center gap-1.5 text-xs"
                title={t("mcp.badges.tooltipHealthy") + (entry.lastHealthCheck ? " " + formatRelativeTime(entry.lastHealthCheck) : "")}
              >
                <span className="w-2 h-2 rounded-full bg-primary-foreground" />
                {t("mcp.badges.healthy")}
              </Badge>
            ) : entry.healthStatus === "stale" ? (
              <Badge
                variant="secondary"
                className="inline-flex items-center gap-1.5 text-xs"
                title={t("mcp.badges.tooltipStale") + (entry.lastHealthCheck ? " " + formatRelativeTime(entry.lastHealthCheck) : "")}
              >
                <span className="w-2 h-2 rounded-full bg-secondary-foreground" />
                {t("mcp.badges.stale")}
              </Badge>
            ) : entry.healthStatus === "down" ? (
              <Badge
                variant="destructive"
                className="inline-flex items-center gap-1.5 text-xs"
                title={t("mcp.badges.tooltipDown") + (entry.lastHealthCheck ? " " + formatRelativeTime(entry.lastHealthCheck) : "")}
              >
                <span className="w-2 h-2 rounded-full bg-destructive-foreground" />
                {t("mcp.badges.down")}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="inline-flex items-center gap-1.5 text-xs"
                title={t("mcp.badges.tooltipNotChecked")}
              >
                <span className="w-2 h-2 rounded-full bg-muted-foreground" />
                {t("mcp.badges.notChecked")}
              </Badge>
            )}
            {/* Commit recency badge */}
            {entry.lastCommitDate && (() => {
              const monthsAgo = (Date.now() - new Date(entry.lastCommitDate!).getTime()) / (1000 * 60 * 60 * 24 * 30);
              if (monthsAgo <= 12) {
                return monthsAgo <= 6 ? (
                  <Badge
                    variant="default"
                    className="inline-flex items-center gap-1 text-xs"
                    title={t("mcp.badges.tooltipActiveMaintenance")}
                  >
                    {t("mcp.badges.activelyMaintained")}
                  </Badge>
                ) : (
                  <Badge
                    variant="secondary"
                    className="inline-flex items-center gap-1 text-xs"
                    title={t("mcp.badges.tooltipStaleMaintenance")}
                  >
                    {t("mcp.badges.staleMaintenance")}
                  </Badge>
                );
              }
              return null;
            })()}
            {/* Last verified timestamp */}
            <span className="text-xs text-muted-foreground">
              {entry.lastHealthCheck
                ? `${t("mcp.badges.lastVerified")}: ${formatRelativeTime(entry.lastHealthCheck)}`
                : t("mcp.badges.neverChecked")}
            </span>
          </div>
        </div>

        <div>
          {entry.isInstalled ? (
            <div className="flex items-center gap-2">
              {/* quick 260919-l6s: the ✓ Installed indicator stays so the
                  state remains explicit next to the now-visible uninstall
                  control. */}
              <span className="flex items-center gap-1 text-primary font-medium text-sm">
                <Check className="w-3.5 h-3.5" />
                {t("marketplace.card.installed")}
              </span>
              {/* quick 260919-l6s: Uninstall is a visible, clearly-labeled
                  destructive-outline button (previously a hidden three-dots
                  ghost icon — undiscoverable). Same styling family as the
                  card's Uninstall button. Opens the EXISTING confirmation
                  dialog; confirming uninstalls from the current workspace. */}
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/30"
                disabled={uninstalling}
                onClick={() => setShowUninstallConfirm(true)}
              >
                {t("marketplace.install.uninstall")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={!currentWorkspaceId || installing}
              title={!currentWorkspaceId ? t("marketplace.detail.selectWorkspace") : undefined}
            >
              {installing ? t("marketplace.detail.installing") : t("marketplace.detail.install")}
            </Button>
          )}
        </div>
      </div>

      {/* AlertDialog for uninstall confirmation */}
      <AlertDialog open={showUninstallConfirm} onOpenChange={setShowUninstallConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("common.uninstall", "Uninstall")} {entry.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {/* Phase 197 (D-08/SC-3, UI-SPEC §6): OAuth entries surface the
                  revoke+wipe confirm body; non-OAuth entries keep the existing
                  copy byte-identically. */}
              {entry.authType === "oauth"
                ? t("marketplace.uninstallConfirmOAuth")
                : t("mcp.uninstallConfirm", "This will disconnect and remove the MCP server from this workspace. This action cannot be undone.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowUninstallConfirm(false)} disabled={uninstalling}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={handleUninstall}
              disabled={uninstalling}
            >
              {uninstalling ? t("marketplace.detail.uninstalling") : t("common.uninstall", "Uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pre-install configuration dialog (optional auth/extra headers) */}
      <MarketplaceInstallDialog
        open={showInstallDialog}
        onOpenChange={setShowInstallDialog}
        entryName={entry.name}
        installing={installing}
        onConfirm={confirmInstall}
      />

      {/* Section 3 — Description card */}
      <div className="mb-[32px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl font-semibold">{t("marketplace.detail.description")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CardDescription className="text-sm leading-relaxed whitespace-pre-wrap">
              {entry.description || t("marketplace.detail.noDescription")}
            </CardDescription>
          </CardContent>
        </Card>
      </div>

      {/* Section 4 — Tools card */}
      <div className="mb-[32px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl font-semibold">{t("marketplace.detail.toolsSection")}</CardTitle>
          </CardHeader>
          <CardContent>
            {entry.isInstalled ? (
              <div className="space-y-[6px]">
                {matchingConnection ? (
                  installedTools.length > 0 ? (
                    installedTools.map((tool, idx) => (
                      <div
                        key={idx}
                        className="py-[8px] border-b border-border last:border-b-0"
                      >
                        <div className="font-medium text-foreground">
                          {tool.name}
                        </div>
                        <div className="text-sm text-muted-foreground mt-[2px]">
                          {tool.description || t("marketplace.detail.noToolDescription")}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground italic">
                      {t("marketplace.detail.noToolsDiscovered")}
                    </p>
                  )
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    {t("marketplace.detail.connectionUnavailable")}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                {t("marketplace.detail.toolsAfterInstall")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

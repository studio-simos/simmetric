// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
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
  CardFooter,
} from "@/components/ui/card";
import { ShieldCheck, Check } from "lucide-react";
import type { CatalogEntry } from "../queries/useMarketplace";

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

interface MarketplaceCardProps {
  entry: CatalogEntry;
  currentWorkspaceId: string | null;
  onInstall: (entryId: string) => void;
  onUninstall: (entryId: string) => void;
  onNavigate: (entryId: string) => void;
}

export default function MarketplaceCard({
  entry,
  currentWorkspaceId,
  onInstall,
  onUninstall,
  onNavigate,
}: MarketplaceCardProps) {
  const { t } = useTranslation();
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);

  return (
    <Card
      onClick={() => onNavigate(entry.id)}
      className="relative cursor-pointer hover:shadow-md transition-shadow"
    >
      {/* Health status badge — absolute top-right */}
      {entry.healthStatus === "healthy" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="default"
              className="absolute top-2 right-2 inline-flex items-center gap-1.5 text-xs cursor-default"
            >
              <span className="w-2 h-2 rounded-full bg-primary-foreground" />
              {t("mcp.badges.healthy")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top">{t("mcp.badges.tooltipHealthy") + (entry.lastHealthCheck ? " " + formatRelativeTime(entry.lastHealthCheck) : "")}</TooltipContent>
        </Tooltip>
      ) : entry.healthStatus === "stale" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="absolute top-2 right-2 inline-flex items-center gap-1.5 text-xs cursor-default"
            >
              <span className="w-2 h-2 rounded-full bg-secondary-foreground" />
              {t("mcp.badges.stale")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top">{t("mcp.badges.tooltipStale") + (entry.lastHealthCheck ? " " + formatRelativeTime(entry.lastHealthCheck) : "")}</TooltipContent>
        </Tooltip>
      ) : entry.healthStatus === "down" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="destructive"
              className="absolute top-2 right-2 inline-flex items-center gap-1.5 text-xs cursor-default"
            >
              <span className="w-2 h-2 rounded-full bg-destructive-foreground" />
              {t("mcp.badges.down")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top">{t("mcp.badges.tooltipDown") + (entry.lastHealthCheck ? " " + formatRelativeTime(entry.lastHealthCheck) : "")}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="absolute top-2 right-2 inline-flex items-center gap-1.5 text-xs cursor-default"
            >
              <span className="w-2 h-2 rounded-full bg-muted-foreground" />
              {t("mcp.badges.notChecked")}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top">{t("mcp.badges.tooltipNotChecked")}</TooltipContent>
        </Tooltip>
      )}

      <CardHeader className="pb-0">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 pr-[80px]">
            <CardTitle className="text-lg font-semibold text-foreground">
              {entry.name}
            </CardTitle>
            {entry.verificationTier === "official" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="default"
                    className="inline-flex items-center gap-1 text-xs font-medium shrink-0 cursor-default"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {t("mcp.badges.official")}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top">{t("mcp.badges.tooltipOfficial")}</TooltipContent>
              </Tooltip>
            )}
            {entry.verificationTier === "verified_community" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="inline-flex items-center gap-1 text-xs font-medium shrink-0 cursor-default"
                  >
                    <Check className="w-3.5 h-3.5" />
                    {t("mcp.badges.verifiedCommunity")}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top">{t("mcp.badges.tooltipVerifiedCommunity")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <CardDescription className="text-sm mt-2 line-clamp-2">
          {entry.description}
        </CardDescription>
        <div className="flex items-center gap-2 mt-3">
          <Badge variant="outline" className="text-xs">
            {entry.category ? t(`marketplace.categories.${entry.category}`, { defaultValue: entry.category }) : t("marketplace.categories.other")}
          </Badge>
          <span className="text-xs text-muted-foreground">{t("marketplace.card.toolsLabel")}</span>
        </div>
      </CardContent>

      <CardFooter className="flex items-center justify-between pt-3">
        <span className="text-xs text-muted-foreground">
          {entry.author && entry.version
            ? `${entry.author} v${entry.version}`
            : entry.author
              ? entry.author
              : entry.version
                ? `v${entry.version}`
                : ""}
        </span>

        {entry.isInstalled ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Uninstall ${entry.name}`}
                >
                  <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v.01M12 12v.01M12 18v.01" />
                  </svg>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={(e) => {
                    e.preventDefault();
                    setShowUninstallDialog(true);
                  }}
                >
                  {t("common.uninstall", "Uninstall")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialog open={showUninstallDialog} onOpenChange={setShowUninstallDialog}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t("common.uninstall", "Uninstall")} {entry.name}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("mcp.uninstallConfirm", "This MCP server will be removed from the workspace.")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setShowUninstallDialog(false)}>
                    {t("common.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground"
                    onClick={() => {
                      onUninstall(entry.id);
                      setShowUninstallDialog(false);
                    }}
                  >
                    {t("common.uninstall", "Uninstall")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onInstall(entry.id);
                }}
                disabled={!currentWorkspaceId}
              >
                {t("marketplace.install.button")}
              </Button>
            </TooltipTrigger>
            {!currentWorkspaceId && <TooltipContent side="top">{t("marketplace.install.selectWorkspace")}</TooltipContent>}
          </Tooltip>
        )}
      </CardFooter>
    </Card>
  );
}

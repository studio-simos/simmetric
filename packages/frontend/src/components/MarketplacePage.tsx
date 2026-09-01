// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useDeferredValue } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useChatNav } from "../contexts/ChatContext";
import {
  useMarketplaceCatalog,
  useInstallMarketplaceEntry,
  useUninstallMarketplaceEntry,
} from "../queries/useMarketplace";
import { showSuccess, showError } from "../lib/toast";
import MarketplaceCard from "./MarketplaceCard";
import MarketplaceInstallDialog from "./MarketplaceInstallDialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils"
export default function MarketplacePage() {

  const navigate = useNavigate();
  const { t } = useTranslation();

  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<{ id: string; name: string } | null>(null);

  const currentWorkspaceId = useChatNav().currentWorkspaceId;

  const { data: entries = [], isLoading, error } = useMarketplaceCatalog(currentWorkspaceId ?? undefined);
  const installMutation = useInstallMarketplaceEntry();
  const uninstallMutation = useUninstallMarketplaceEntry();

  // Extract unique categories dynamically from catalog data
  const uniqueCategories =
    [...new Set(entries.map((e) => e.category).filter(Boolean))] as string[];

  // Filter entries by deferred search query and active category
  const filteredEntries =
    entries.filter((e) => {
      const q = deferredQuery.toLowerCase();
      const matchesSearch =
        !q ||
        e.name.toLowerCase().includes(q) ||
        (e.description && e.description.toLowerCase().includes(q));
      const matchesCategory =
        !activeCategory || e.category === activeCategory;
      return matchesSearch && matchesCategory;
    });

  // Install: open the pre-install config dialog (lets admin add auth headers)
  const handleInstall = (entryId: string) => {
    if (!currentWorkspaceId) return;
    const entry = entries.find((e) => e.id === entryId);
    setInstallTarget({ id: entryId, name: entry?.name || entryId });
  };

  // Confirm install from the dialog, with optional headers
  const confirmInstall = async (headers: Record<string, string>) => {
    if (!currentWorkspaceId || !installTarget) return;
    const { id: entryId, name } = installTarget;
    try {
      await installMutation.mutateAsync({ entryId, workspaceId: currentWorkspaceId, headers });
      showSuccess(t("marketplace.toast.installSuccess", { name }));
      setInstallTarget(null);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        showError(t("marketplace.toast.alreadyInstalled", { name }));
      } else {
        showError(t("marketplace.toast.installFailed", { name }));
      }
    }
  };

  // Uninstall handler with success/error toast feedback
  const handleUninstall = async (entryId: string) => {
    if (!currentWorkspaceId) return;
    const entry = entries.find((e) => e.id === entryId);
    const name = entry?.name || entryId;
    try {
      await uninstallMutation.mutateAsync({ entryId, workspaceId: currentWorkspaceId });
      showSuccess(t("marketplace.toast.uninstallSuccess", { name }));
    } catch {
      showError(t("marketplace.toast.uninstallFailed", { name }));
    }
  };

  // Navigate to detail page
  const handleNavigate = (entryId: string) => {
    navigate(`/mcp-marketplace/${entryId}`);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Section 1 — Page header */}
      <div className="pt-[32px] pb-[24px]">
        <h1 className="text-[28px] font-semibold text-foreground">
          {t("marketplace.title")}
        </h1>
      </div>

      {/* Error state banner */}
      {error && (
        <div className="mb-[24px] bg-destructive text-destructive-foreground p-[16px] rounded-lg">
          {t("marketplace.empty.error")}
        </div>
      )}

      {/* Section 2 — Search bar */}
      <div className="mb-[24px] max-w-[600px]">
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-secondary-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("marketplace.searchPlaceholder")}
            className="pl-10 pr-4 py-2.5 text-sm"
          />
        </div>
      </div>

      {/* Section 3 — Category filter pills */}
      {uniqueCategories.length > 0 && (
        <div className="mb-[24px]">
          <div className="flex gap-2 overflow-x-auto pb-1">
            <Button
              variant="ghost"
              onClick={() => setActiveCategory(null)}
              className={cn("px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap", activeCategory === null
                  ? "bg-primary/60 text-white hover:bg-primary/60"
                  : "bg-accent text-muted-foreground hover:bg-accent")}
            >
              {t("marketplace.categories.all")}
            </Button>
            {uniqueCategories.map((cat) => (
              <Button
                variant="ghost"
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={cn("px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap", activeCategory === cat
                    ? "bg-primary/60 text-white hover:bg-primary/60"
                    : "bg-accent text-muted-foreground hover:bg-accent")}
              >
                {t(`marketplace.categories.${cat}`, { defaultValue: cat })}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Section 4 — Catalog grid */}
      <div>
        {/* Loading state: skeleton cards */}
        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[24px]">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader className="pb-0">
                  <Skeleton className="h-6 w-3/4" />
                </CardHeader>
                <CardContent className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                </CardContent>
                <CardFooter>
                  <Skeleton className="h-8 w-20" />
                </CardFooter>
              </Card>
            ))}
          </div>
        )}

        {/* Empty state: no entries at all */}
        {!isLoading && entries.length === 0 && (
          <div className="text-center py-[48px] text-muted-foreground">
            {t("marketplace.empty.noResults")}
          </div>
        )}

        {/* Empty state: filtered to zero */}
        {!isLoading && entries.length > 0 && filteredEntries.length === 0 && (
          <div className="text-center py-[48px] text-muted-foreground">
            {t("marketplace.empty.noResults")}<br />
            {t("marketplace.empty.noResultsBody")}
          </div>
        )}

        {/* Catalog grid with cards */}
        {!isLoading && filteredEntries.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-[24px]">
            {filteredEntries.map((entry) => (
              <MarketplaceCard
                key={entry.id}
                entry={entry}
                currentWorkspaceId={currentWorkspaceId}
                onInstall={handleInstall}
                onUninstall={handleUninstall}
                onNavigate={handleNavigate}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pre-install configuration dialog (optional auth/extra headers) */}
      <MarketplaceInstallDialog
        open={!!installTarget}
        onOpenChange={(open) => { if (!open) setInstallTarget(null); }}
        entryName={installTarget?.name ?? ""}
        installing={installMutation.isPending}
        onConfirm={confirmInstall}
      />
    </div>
  );
}

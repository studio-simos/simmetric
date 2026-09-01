// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Provider preset catalog dialog (quick task 260723-ps2).
 *
 * Lists the 20 seeded provider presets grouped by category with search and
 * category filter chips. OpenAI-compatible/api-key presets install in one
 * click (inline apiKey prompt); OAuth presets render a Docs link with
 * install disabled; still-pending native-type presets (xiaomi/minimax) install
 * but show a "handler pending" warning badge upfront. Gemini's native handler
 * shipped (quick 260723-uzf) and installs normally.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useProviderPresets,
  useInstallProviderPreset,
  type ProviderPresetWithInstall,
} from "../queries/useProviderPresets";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import type { ProviderPresetCategory } from "@simmetric-chat/shared";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CATEGORY_FILTERS: Array<"All" | ProviderPresetCategory> = [
  "All",
  "OpenAI-compatible",
  "Cloud (api-key)",
  "Local",
  "Native",
  "OAuth (manual)",
];

// Native types whose runtime handler is still pending. Gemini shipped its
// native handler in quick 260723-uzf, so it shows a normal install — only
// xiaomi and minimax still surface the "handler pending" badge.
const NATIVE_TYPES = new Set(["xiaomi", "minimax"]);

export default function ProviderPresetCatalog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const { data: presets = [], isLoading } = useProviderPresets(open);
  const installMutation = useInstallProviderPreset();

  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<"All" | ProviderPresetCategory>("All");
  // apiKey input per preset slug being installed
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");

  const filtered = (() => {
    const q = search.trim().toLowerCase();
    return presets.filter((p) => {
      if (activeCategory !== "All" && p.category !== activeCategory) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q) ||
        (p.defaultModel ?? "").toLowerCase().includes(q)
      );
    });
  })();

  function handleInstall(preset: ProviderPresetWithInstall) {
    if (preset.requiresOAuth || preset.isInstalled) return;
    // No apiKey needed for authMethod "none" (LM Studio).
    if (preset.authMethod === "none") {
      runInstall(preset, undefined);
      return;
    }
    setInstallingSlug(preset.slug);
    setApiKeyInput("");
  }

  function runInstall(preset: ProviderPresetWithInstall, apiKey: string | undefined) {
    setInstallingSlug(null);
    installMutation.mutate(
      { presetId: preset.id, apiKey },
      {
        onSuccess: () => {
          showSuccess(t("providerPreset.installSuccess", { name: preset.name }));
        },
        onError: (err) => {
          const status = (err as { status?: number }).status;
          if (status === 422) {
            showError(t("providerPreset.installOAuthError"));
          } else if (status === 409) {
            showError(t("providerPreset.installConflict"));
          } else {
            showError(getErrorMessage(err) || t("providerPreset.installOAuthError"));
          }
        },
      },
    );
  }

  function confirmApiKey(preset: ProviderPresetWithInstall) {
    runInstall(preset, apiKeyInput.trim() || undefined);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("providerPreset.title")}</DialogTitle>
          <DialogDescription>{t("providerPreset.search")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            placeholder={t("providerPreset.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t("providerPreset.search")}
          />

          <div className="flex flex-wrap gap-2">
            {CATEGORY_FILTERS.map((cat) => {
              const key =
                cat === "All"
                  ? "all"
                  : cat === "OpenAI-compatible"
                    ? "openai-compatible"
                    : cat === "Cloud (api-key)"
                      ? "cloud"
                      : cat === "OAuth (manual)"
                        ? "oauth"
                        : cat.toLowerCase();
              const label = cat === "All"
                ? t("providerPreset.category.all")
                : t(`providerPreset.category.${key}`);
              return (
                <Button
                  key={cat}
                  size="sm"
                  variant={activeCategory === cat ? "default" : "outline"}
                  onClick={() => setActiveCategory(cat)}
                >
                  {label}
                </Button>
              );
            })}
          </div>

          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">…</div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("providerPreset.search")}
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  installing={installingSlug === preset.slug}
                  apiKeyInput={apiKeyInput}
                  onApiKeyInputChange={setApiKeyInput}
                  onInstall={() => handleInstall(preset)}
                  onConfirmApiKey={() => confirmApiKey(preset)}
                  onCancelApiKey={() => setInstallingSlug(null)}
                  installPending={
                    installMutation.isPending &&
                    installMutation.variables?.presetId === preset.id
                  }
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface RowProps {
  preset: ProviderPresetWithInstall;
  installing: boolean;
  apiKeyInput: string;
  onApiKeyInputChange: (v: string) => void;
  onInstall: () => void;
  onConfirmApiKey: () => void;
  onCancelApiKey: () => void;
  installPending: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function PresetRow({
  preset,
  installing,
  apiKeyInput,
  onApiKeyInputChange,
  onInstall,
  onConfirmApiKey,
  onCancelApiKey,
  installPending,
  t,
}: RowProps) {
  const isNative = NATIVE_TYPES.has(preset.type);
  return (
    <div className="rounded-lg border border-input p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground">{preset.name}</span>
            <Badge variant="secondary">{preset.type}</Badge>
            {isNative && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Badge variant="outline" className="border-amber-500 text-amber-600">
                        {t("providerPreset.nativePendingBadge")}
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("providerPreset.nativePendingTooltip")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {preset.requiresOAuth && (
              <Badge variant="outline" className="border-blue-500 text-blue-600">
                {t("providerPreset.manualSetup")}
              </Badge>
            )}
            {preset.isInstalled && (
              <Badge variant="secondary" className="bg-green-100 text-green-700">
                {t("providerPreset.installed")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">
            {preset.description}
          </p>
          <div className="text-xs text-muted-foreground">
            {preset.defaultModel
              ? `${t("providerPreset.defaultModel")}: ${preset.defaultModel}`
              : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {preset.requiresOAuth ? (
            <a
              href={preset.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              {t("providerPreset.docs")}
            </a>
          ) : (
            <Button
              size="sm"
              disabled={preset.isInstalled || installPending}
              onClick={onInstall}
            >
              {preset.isInstalled
                ? t("providerPreset.installed")
                : t("providerPreset.install")}
            </Button>
          )}
          {!preset.requiresOAuth && (
            <a
              href={preset.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:underline"
            >
              {t("providerPreset.docs")}
            </a>
          )}
        </div>
      </div>

      {installing && (
        <div className="flex items-center gap-2 pt-1">
          <Input
            type="password"
            placeholder={t("providerPreset.apiKeyPlaceholder")}
            value={apiKeyInput}
            onChange={(e) => onApiKeyInputChange(e.target.value)}
            aria-label={t("providerPreset.apiKey")}
          />
          <Button size="sm" onClick={onConfirmApiKey} disabled={installPending}>
            {t("providerPreset.install")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelApiKey}>
            {t("common.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
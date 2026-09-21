// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useModelPalette } from "../hooks/useModelPalette";
import { Badge } from "@/components/ui/badge";
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";

interface ModelOption {
  id: string;
  name: string;
  displayName: string | null;
  providerId: string;
  providerName: string;
  providerType: "ollama" | "openai" | "anthropic" | "openrouter";
  isDefault: boolean;
  isLocal: boolean;
  capabilities: string[];
}

interface ModelPaletteProps {
  open: boolean;
  onClose: () => void;
  onSelect: (selection: { providerId: string; model: string } | null) => void;
  currentValue?: { providerId?: string; model?: string } | null;
  initialFilter?: string;
}

function ProviderIcon({ type }: { type: string }) {
  if (type === "ollama") {
    return (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" />
      </svg>
    );
  }
  if (type === "openai") {
    return (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 00-.516-4.91 6.046 6.046 0 00-6.51-2.9A6.065 6.065 0 0011.734.4a6.09 6.09 0 00-5.8 4.005 6.015 6.015 0 00-3.994 3.9 6.09 6.09 0 00.516 4.91 6.046 6.046 0 002.017 7.504 6.065 6.065 0 003.528 1.58 6.015 6.015 0 003.9 3.994 6.09 6.09 0 004.91-.516 6.046 6.046 0 007.504-2.017 6.065 6.065 0 001.58-3.528 6.015 6.015 0 003.994-3.9 6.09 6.09 0 00-.516-4.91z" />
      </svg>
    );
  }
  if (type === "openrouter") {
    return (
      <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
      <path d="M17.304 3.541l-5.717 16.918H8.698l5.717-16.918h2.889zM8.698 3.541L3 20.459h2.998L11.696 3.54H8.698z" />
    </svg>
  );
}

const capabilityKeyMap: Record<string, string> = {
  "local-only": "chat.capabilities.localOnly",
  "fastest": "chat.capabilities.fastest",
  "smartest": "chat.capabilities.smartest",
  "reasoning": "chat.capabilities.reasoning",
};

export default function ModelPalette({ open, onClose, onSelect, currentValue, initialFilter }: ModelPaletteProps) {
  const { t } = useTranslation();
  const { groupedModels, defaultModel, searchQuery, setSearchQuery, filteredModels } = useModelPalette();

  useEffect(() => {
    if (open && initialFilter !== undefined) {
      setSearchQuery(initialFilter);
    }
  }, [open, initialFilter, setSearchQuery]);

  const isMac = (() => {
    if (typeof navigator !== "undefined") {
      return navigator.platform.toLowerCase().includes("mac");
    }
    return false;
  })();

  const macTip = t("chat.palette.comparisonTipMac", "Cmd+Shift+M to compare models (coming soon)");
  const winTip = t("chat.palette.comparisonTipWin", "Ctrl+Shift+M to compare models (coming soon)");

  return (
    <CommandDialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Command shouldFilter={false}>
        <CommandInput
          placeholder={t("chat.palette.searchPlaceholder", "Search model...")}
          value={searchQuery}
          onValueChange={setSearchQuery}
        />
        <CommandList>
          <CommandEmpty>{t("chat.modelSelector.noModels", "No models available")}</CommandEmpty>
          {/* Default option — clears the per-chat override so the chat follows
              the workspace/global default. Mirrors the former header ModelSelector
              dropdown's first item. Highlighted when nothing is explicitly
              selected (currentValue null → default is the active model). */}
          <CommandGroup>
            <CommandItem
              value="default"
              onSelect={() => {
                onSelect(null);
                onClose();
              }}
            >
              <span className={cn("flex items-center gap-1.5", !currentValue?.providerId && "font-medium text-primary")}>
                <span className="text-primary text-[10px]">★</span>
                {defaultModel
                  ? t("chat.modelSelector.defaultWithModel", "Default ({{model}} — {{provider}})", {
                      model: defaultModel.displayName || defaultModel.name,
                      provider: defaultModel.providerName,
                    })
                  : t("chat.modelSelector.default", "Default")}
              </span>
            </CommandItem>
          </CommandGroup>
          {Object.entries(groupedModels).map(([providerKey, models]) => (
            <CommandGroup key={providerKey} heading={models[0]?.providerName ?? ""}>
              {models.map((model: ModelOption) => {
                const isSelected = currentValue?.providerId === model.providerId && currentValue?.model === model.name;
                return (
                  <CommandItem
                    key={model.id}
                    value={model.name}
                    onSelect={() => {
                      onSelect({ providerId: model.providerId, model: model.name });
                      onClose();
                    }}
                  >
                    <ProviderIcon type={model.providerType} />
                    <span className={isSelected ? "font-medium text-primary" : ""}>
                      {model.displayName || model.name}
                    </span>
                    <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 rounded">
                        {model.isLocal ? "Local" : "Cloud"}
                      </Badge>
                      {model.capabilities?.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0.5 rounded">
                          {t(capabilityKeyMap[tag] || tag)}
                        </Badge>
                      ))}
                      {model.isDefault && (
                        <span className="text-[10px] text-primary">★</span>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
          {filteredModels.length === 0 && (
            <CommandEmpty>{t("chat.modelSelector.noModels", "No models available")}</CommandEmpty>
          )}
        </CommandList>
        <CommandSeparator />
        <div className="px-4 py-2.5 flex justify-between items-center bg-card">
          <span className="text-xs text-muted-foreground">
            {t("chat.palette.footerHints", "↑↓ to navigate, Enter to select, Escape to close")}
          </span>
          <span className="text-xs text-muted-foreground">
            {isMac ? (
              <>
                <kbd className="font-mono text-[10px] border rounded px-1 py-0.5">Cmd+Shift+M</kbd>
                <span>{macTip.slice("Cmd+Shift+M".length)}</span>
              </>
            ) : (
              <>
                <kbd className="font-mono text-[10px] border rounded px-1 py-0.5">Ctrl+Shift+M</kbd>
                <span>{winTip.slice("Ctrl+Shift+M".length)}</span>
              </>
            )}
          </span>
        </div>
      </Command>
    </CommandDialog>
  );
}

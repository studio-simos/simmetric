// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelPalette } from "../hooks/useModelPalette";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

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

interface ModelSelectorProps {
  value: { providerId?: string; model?: string } | null;
  onChange: (selection: { providerId: string; model: string } | null) => void;
  unavailableModel?: { providerId: string; model: string } | null;
  isStale?: boolean;
}

export function ProviderIcon({ type }: { type: string }) {
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

export const capabilityKeyMap: Record<string, string> = {
  "local-only": "chat.capabilities.localOnly",
  "cloud": "chat.capabilities.cloud",
  "fastest": "chat.capabilities.fastest",
  "smartest": "chat.capabilities.smartest",
  "reasoning": "chat.capabilities.reasoning",
};

export default function ModelSelector({ value, onChange, unavailableModel, isStale }: ModelSelectorProps) {
  const { t } = useTranslation();
  const { models: availableModels, groupedModels, defaultModel, searchQuery, setSearchQuery, filteredModels } = useModelPalette();
  const [open, setOpen] = useState(false);

  const selected = availableModels.find(
    (m) => value?.providerId === m.providerId && value?.model === m.name
  );

  const defaultLabel = defaultModel
    ? t("chat.modelSelector.defaultWithModel", "Default ({{model}} — {{provider}})", {
        model: defaultModel.displayName || defaultModel.name,
        provider: defaultModel.providerName,
      })
    : t("chat.modelSelector.default", "Default");

  const displayLabel = selected
    ? (selected.displayName || selected.name)
    : value?.model
      ? value.model
      : t("chat.modelSelector.default", "Default");

  const isUnavailable = unavailableModel && !availableModels.find(
    (m) => unavailableModel.providerId === m.providerId && unavailableModel.model === m.name
  );

  const triggerProviderType = selected
    ? selected.providerType
    : defaultModel
      ? defaultModel.providerType
      : null;

  const triggerCapabilities = selected
    ? selected.capabilities
    : defaultModel
      ? defaultModel.capabilities
      : [];

  const tooltipLabel = isUnavailable
    ? t("chat.modelSelector.unavailable", "Model no longer available")
    : isStale
      ? t("chat.modelSelector.stale", "Model availability data is stale")
      : value
        ? `${selected?.providerName || ""} / ${displayLabel}`
        : t("chat.modelSelector.default", "Default");

  const triggerClass = isUnavailable
    ? "border-destructive text-destructive hover:border-destructive"
    : isStale
      ? "border-dashed border-warning text-muted-foreground hover:text-foreground hover:border-primary"
      : "border-border text-muted-foreground hover:text-foreground hover:border-primary";

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearchQuery(""); }}>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md max-w-[200px] h-auto ${triggerClass}`}
            >
              {isUnavailable && <span className="flex-shrink-0">⚠</span>}
              {triggerProviderType && <ProviderIcon type={triggerProviderType} />}
              <span className="truncate">{displayLabel}</span>
              {triggerCapabilities?.map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0.5 rounded">
                  {t(capabilityKeyMap[tag] || tag)}
                </Badge>
              ))}
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="top">{tooltipLabel}</TooltipContent>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={t("chat.modelSelector.searchPlaceholder", "Search model...")}
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
            <CommandList>
              <CommandEmpty>{t("chat.modelSelector.noModels", "No models available")}</CommandEmpty>
              <CommandItem
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                  setSearchQuery("");
                }}
              >
                <span className={!value ? "font-medium text-primary" : ""}>
                  {defaultLabel}
                </span>
              </CommandItem>

              {Object.entries(groupedModels).map(([providerKey, models]) => (
                <CommandGroup key={providerKey} heading={models[0]?.providerName ?? ""}>
                  {models.map((model: ModelOption) => { 

                    const isSelected = value?.providerId === model.providerId && value?.model === model.name;
                    return (
                      <CommandItem
                        key={model.id}
                        value={model.name}
                        onSelect={() => {
                          onChange({ providerId: model.providerId, model: model.name });
                          setOpen(false);
                          setSearchQuery("");
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
          </Command>
        </PopoverContent>
      </Popover>
    </Tooltip>
  );
}

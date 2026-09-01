// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useDeferredValue } from "react";
import { useAvailableModels } from "../queries/useProviders";

export interface ModelOption {
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

function groupByProvider(models: ModelOption[]): Record<string, ModelOption[]> {
  return models.reduce<Record<string, ModelOption[]>>((acc, model) => {
    const key = `${model.providerType}:${model.providerId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(model);
    return acc;
  }, {});
}

export function useModelPalette() {
  const modelsQuery = useAvailableModels();
  const availableModels = modelsQuery.data ?? [];

  const [searchQuery, setSearchQuery] = useState("");
  const deferredQuery = useDeferredValue(searchQuery);

  const filteredModels = (() => {
    if (!deferredQuery.trim()) return availableModels;
    const q = deferredQuery.toLowerCase();
    return availableModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.displayName && m.displayName.toLowerCase().includes(q))
    );
  })();

  const groupedModels = groupByProvider(filteredModels);

  const flatModels = Object.values(groupedModels).flat();

  const defaultModel =
    availableModels.find((m) => m.isDefault) || availableModels[0] || null;

  return {
    models: availableModels,
    groupedModels,
    flatModels,
    defaultModel,
    searchQuery,
    setSearchQuery,
    filteredModels,
    isLoading: modelsQuery.isLoading,
    error: modelsQuery.error,
  };
}

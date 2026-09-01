// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { useAvailableModels } from "../queries/useProviders";
import { showSuccess, showError } from "../lib/toast";
import { Button } from "@/components/ui/button";

interface ModelOption {
  providerId: string;
  providerName: string;
  providerType: string;
  modelName: string;
  modelDisplayName: string | null;
}

export default function SettingsSynthesis() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { isReadOnly } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();
  const { data: availableModels = [] } = useAvailableModels();

  // Derive initial values from system settings
  const initialProviderId = settings?.find((s) => s.key === "SYNTHESIS_LLM_PROVIDER_ID")?.value ?? "";

  const initialModel = settings?.find((s) => s.key === "SYNTHESIS_LLM_MODEL")?.value ?? "";

  const [selectedProviderId, setSelectedProviderId] = useState(initialProviderId);
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);

  // Update local state when settings load/change
  useEffect(() => {
    setSelectedProviderId(initialProviderId);
  }, [initialProviderId]);

  useEffect(() => {
    setSelectedModel(initialModel);
  }, [initialModel]);

  // Group models by provider name for optgroup rendering
  const groupedModels = (() => {
    const groups: Record<string, ModelOption[]> = {};
    for (const m of availableModels) {
      const list = groups[m.providerName] ?? [];
      list.push({
        providerId: m.providerId,
        providerName: m.providerName,
        providerType: m.providerType,
        modelName: m.name,
        modelDisplayName: m.displayName,
      });
      groups[m.providerName] = list;
    }
    return groups;
  })();

  // When user selects a model, we derive providerId from the model option
  const handleModelChange = (providerId: string, modelName: string) => {
    setSelectedProviderId(providerId);
    setSelectedModel(modelName);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const configs: { key: string; value: string }[] = [];

      if (!isReadOnly("SYNTHESIS_LLM_PROVIDER_ID")) {
        configs.push({ key: "SYNTHESIS_LLM_PROVIDER_ID", value: selectedProviderId });
      }
      if (!isReadOnly("SYNTHESIS_LLM_MODEL")) {
        configs.push({ key: "SYNTHESIS_LLM_MODEL", value: selectedModel });
      }

      if (configs.length === 0) {
        setSaving(false);
        return;
      }

      const result = await updateSettings(configs);
      if (result.rejected.length > 0) {
        showError(t("settings.synthesis.saveFailed"));
      } else {
        showSuccess(t("settings.synthesis.saveSuccess"));
      }
    } catch {
      showError(t("settings.synthesis.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const hasDbConfig = selectedProviderId && selectedModel;

  return (
    <div className="bg-card rounded-lg border border-input p-5 mt-6">
      <h4 className="text-sm font-semibold text-foreground mb-4">
        {t("settings.synthesis.title")}
      </h4>
      <p className="text-xs text-muted-foreground mb-4">
        {t("settings.synthesis.sectionDescription")}
      </p>

      <div className="space-y-4">
        {/* Model Selector */}
        <div>
          <label
            htmlFor="synthesis-model-select"
            className="block text-xs font-medium text-muted-foreground mb-2"
          >
            {t("settings.synthesis.modelLabel")}
          </label>
          <select
            id="synthesis-model-select"
            value={hasDbConfig ? `${selectedProviderId}:${selectedModel}` : ""}
            onChange={(e) => {
              const val = e.target.value;
              if (!val) {
                handleModelChange("", "");
                return;
              }
              const [providerId, ...modelParts] = val.split(":");
              const modelName = modelParts.join(":");
              handleModelChange(providerId ?? "", modelName);
            }}
            className="bg-input border border-input rounded-md px-3 py-2 text-sm w-full"
          >
            <option value="">{t("settings.synthesis.modelPlaceholder")}</option>
            {Object.entries(groupedModels).map(([providerName, models]) => (
              <optgroup key={providerName} label={providerName}>
                {models.map((m) => (
                  <option
                    key={`${m.providerId}:${m.modelName}`}
                    value={`${m.providerId}:${m.modelName}`}
                  >
                    {m.modelDisplayName || m.modelName}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Env fallback indicator */}
        {!hasDbConfig && (
          <p className="text-xs text-muted-foreground">
            {t("settings.synthesis.envFallback", { model: "SYNTHESIS_LLM_MODEL" })}
          </p>
        )}
      </div>

      {/* Save Button */}
      <div className="pt-4">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? t("common.saving") : t("settings.saveChanges")}
        </Button>
      </div>
    </div>
  );
}

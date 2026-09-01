// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSettings, useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { useOcrModels } from "../queries/useOcrModels";
import { showSuccess, showError } from "../lib/toast";
import { Button } from "@/components/ui/button";
import OcrModelSelector from "./OcrModelSelector";
import OcrModeSelector from "./OcrModeSelector";
import OcrCustomInstructions from "./OcrCustomInstructions";

export default function SettingsOcr() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { isReadOnly } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();

  const {
    data: models = [],
    isLoading: modelsLoading,
    error: modelsError,
  } = useOcrModels();

  // Derive initial values from system settings
  const initialModel = settings?.find((s) => s.key === "OCR_DEFAULT_MODEL")?.value ?? "";

  const initialMode = settings?.find((s) => s.key === "OCR_DEFAULT_MODE")?.value ?? "";

  const initialInstructions = settings?.find((s) => s.key === "OCR_DEFAULT_CUSTOM_INSTRUCTIONS")?.value ?? "";

  const [model, setModel] = useState(initialModel);
  const [ocrMode, setOcrMode] = useState(initialMode);
  const [customInstructions, setCustomInstructions] = useState(initialInstructions);
  const [saving, setSaving] = useState(false);
  const [modelTransitioning, setModelTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update local state when settings load/change
  useEffect(() => {
    setModel(initialModel);
  }, [initialModel]);

  useEffect(() => {
    setOcrMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    setCustomInstructions(initialInstructions);
  }, [initialInstructions]);

  // Resolve config for selected model
  const selectedConfig = models.find((m) => m.name === model);
  const supportedModes = selectedConfig?.supportedModes ?? [];

  // Handle model change with auto-select first mode
  const handleModelChange = (newModel: string) => {
    setModelTransitioning(true);
    setModel(newModel);
    if (transitionTimeoutRef.current) {
      clearTimeout(transitionTimeoutRef.current);
    }
    transitionTimeoutRef.current = setTimeout(() => {
      setModelTransitioning(false);
    }, 100);

    const config = models.find((m) => m.name === newModel);
    const firstSupported = config?.supportedModes?.[0] ?? "";
    setOcrMode(firstSupported);
  };

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const configs: { key: string; value: string }[] = [];

      if (!isReadOnly("OCR_DEFAULT_MODEL")) {
        configs.push({ key: "OCR_DEFAULT_MODEL", value: model });
      }
      if (!isReadOnly("OCR_DEFAULT_MODE")) {
        configs.push({ key: "OCR_DEFAULT_MODE", value: ocrMode });
      }
      if (!isReadOnly("OCR_DEFAULT_CUSTOM_INSTRUCTIONS")) {
        configs.push({ key: "OCR_DEFAULT_CUSTOM_INSTRUCTIONS", value: customInstructions });
      }

      if (configs.length === 0) {
        setSaving(false);
        return;
      }

      const result = await updateSettings(configs);
      if (result.rejected.length > 0) {
        showError(t("settings.ocr.saveFailed"));
      } else {
        showSuccess(t("settings.ocr.saveSuccess"));
      }
    } catch {
      showError(t("settings.ocr.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card rounded-lg border border-input p-5 mt-6">
      <h4 className="text-sm font-semibold text-foreground mb-4">
        {t("settings.ocr.title")}
      </h4>
      <p className="text-xs text-muted-foreground mb-4">
        {t("settings.ocr.sectionDescription")}
      </p>

      <div className="space-y-4">
        {/* Model Selector */}
        <OcrModelSelector
          value={model}
          onChange={handleModelChange}
          models={models}
          isLoading={modelsLoading}
          error={modelsError ?? null}
        />

        {/* Mode Selector */}
        <OcrModeSelector
          value={ocrMode}
          onChange={setOcrMode}
          supportedModes={supportedModes}
          isTransitioning={modelTransitioning}
        />

        {/* Custom Instructions */}
        <OcrCustomInstructions
          value={customInstructions}
          onChange={setCustomInstructions}
        />
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

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import { AppInput } from "@/components/ui/app";
import { Button } from "@/components/ui/button";

const FIELDS = [
  { key: "AGENT_WALLCLOCK_TIMEOUT_MS", labelKey: "settings.agentWatchdog.wallclockTimeout", default: "600000" },
  { key: "AGENT_MAX_TOTAL_TOKENS", labelKey: "settings.agentWatchdog.maxTotalTokens", default: "200000" },
  { key: "AGENT_MAX_CONTEXT_BYTES", labelKey: "settings.agentWatchdog.maxContextBytes", default: "500000" },
  { key: "AGENT_MAX_TOOL_OUTPUT_LENGTH", labelKey: "settings.agentWatchdog.maxToolOutputLength", default: "5000" },
  { key: "AGENT_MAX_SKILL_EXECUTION_MS", labelKey: "settings.agentWatchdog.maxSkillExecutionMs", default: "60000" },
  { key: "AGENT_LOOP_DETECTION_WINDOW", labelKey: "settings.agentWatchdog.loopDetectionWindow", default: "3" },
  { key: "AGENT_MEMORY_CHAR_LIMIT", labelKey: "settings.agentWatchdog.memoryCharLimit", default: "2000" },
  { key: "AGENT_MEMORY_REVIEW_INTERVAL", labelKey: "settings.agentWatchdog.memoryReviewInterval", default: "10" },
  { key: "AGENT_MEMORY_DEDUP_THRESHOLD", labelKey: "settings.agentWatchdog.memoryDedupThreshold", default: "0.92" },
] as const;

export default function SettingsAgentWatchdog() {
  const { t } = useTranslation();
  const { getValue, isReadOnly } = useSettingsHelpers();
  const { mutateAsync: updateSettings, isPending } = useUpdateSettings();

  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const f of FIELDS) {
      next[f.key] = getValue(f.key) || f.default;
    }
    setValues(next);
    // `getValue` is a settings-reader helper recreated each render from the
    // settings query. The effect rebuilds the whole `values` map from all
    // FIELDS, so re-running only on the two highest-impact keys (wallclock +
    // total tokens) is the intended trigger — re-running on every settings
    // key would be wasteful and listing the unstable `getValue` itself would
    // force a re-run every render. (D-05 pattern 3 — intentional, documented.)
  }, [getValue("AGENT_WALLCLOCK_TIMEOUT_MS"), getValue("AGENT_MAX_TOTAL_TOKENS")]);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    try {
      const configs = FIELDS.map((f) => ({ key: f.key, value: values[f.key] ?? f.default }));
      await updateSettings(configs);
      showSuccess(t("common.success"));
    } catch (err) {
      showError(getErrorMessage(err));
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">
          {t("settings.subSections.agentWatchdog")}
        </h4>
        <p className="text-xs text-muted-foreground mt-1">
          {t("settings.agentWatchdog.description")}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <AppInput
            key={f.key}
            label={t(f.labelKey)}
            type="number"
            value={values[f.key] ?? ""}
            onChange={(e) => handleChange(f.key, e.target.value)}
            disabled={isReadOnly(f.key)}
            placeholder={f.default}
          />
        ))}
      </div>

      <Button size="sm" onClick={handleSave} disabled={isPending}>
        {isPending ? t("common.loading") : t("common.save")}
      </Button>
    </div>
  );
}
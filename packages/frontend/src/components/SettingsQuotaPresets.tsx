// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 207 (Plan 04 Task 3, CLOUD-04 D-08): install-level quota presets —
// UI-editable via the existing DB>ENV>default system-settings cascade. Rides
// the useSettingsHelpers/useUpdateSettings pattern (SettingsGeneralDlp idiom).
// Admin-only mount (SettingsPage `show={has("admin:settings")}`); the server
// PUT /api/system/settings is the enforcer.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { showSuccess, showError } from "../lib/toast";

export function SettingsQuotaPresets() {
  const { t } = useTranslation();
  const { getValue } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();

  const [tokenPreset, setTokenPreset] = useState("");
  const [storagePreset, setStoragePreset] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Hydrate from the resolved settings (DB > ENV > default — the source hint
  // the settings list carries is display-only here; empty/0 = unset).
  useEffect(() => {
    setTokenPreset(getValue("QUOTA_TOKEN_DEFAULT") || "");
    setStoragePreset(getValue("QUOTA_STORAGE_GB_DEFAULT") || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getValue("QUOTA_TOKEN_DEFAULT"), getValue("QUOTA_STORAGE_GB_DEFAULT")]);

  const validate = (): boolean => {
    setFieldError(null);
    const tk = tokenPreset.trim();
    const st = storagePreset.trim();
    if (tk !== "" && tk !== "0" && !/^[1-9][0-9]*$/.test(tk)) {
      setFieldError(t("settings.users.quota.invalidTokenLimit"));
      return false;
    }
    if (st !== "" && st !== "0" && !/^(0|[0-9]+(\.[0-9]{1,2})?)$/.test(st)) {
      setFieldError(t("settings.users.quota.invalidStorageGb"));
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      await updateSettings([
        { key: "QUOTA_TOKEN_DEFAULT", value: tokenPreset.trim() || "0" },
        { key: "QUOTA_STORAGE_GB_DEFAULT", value: storagePreset.trim() },
      ]);
      showSuccess(t("settings.quotaPresets.saved"));
    } catch {
      showError(t("settings.quotaPresets.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="quota-presets">
      <div>
        <h4 className="text-sm font-semibold text-foreground">{t("settings.quotaPresets.title")}</h4>
        <p className="text-xs text-muted-foreground">{t("settings.quotaPresets.description")}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="quotaTokenPreset">{t("settings.quotaPresets.tokenLabel")}</Label>
        <Input
          id="quotaTokenPreset"
          type="number"
          min={0}
          placeholder={t("settings.users.quota.noPresetPlaceholder")}
          value={tokenPreset}
          onChange={(e) => setTokenPreset(e.target.value)}
          className="max-w-xs"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="quotaStoragePreset">{t("settings.quotaPresets.storageLabel")}</Label>
        <Input
          id="quotaStoragePreset"
          type="number"
          min={0}
          step="0.01"
          placeholder={t("settings.users.quota.noPresetPlaceholder")}
          value={storagePreset}
          onChange={(e) => setStoragePreset(e.target.value)}
          className="max-w-xs"
        />
      </div>
      {fieldError ? <p className="text-sm text-[var(--error-text)]">{fieldError}</p> : null}
      <div>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? t("common.saving") : t("settings.quotaPresets.save")}
        </Button>
      </div>
    </div>
  );
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsSecurityNonAdminUpload — Phase 70 D-11 / SC-4.
 *
 * Dedicated admin toggle for the global `ALLOW_NON_ADMIN_UPLOAD` SystemConfig
 * key. Mirrors `SettingsGeneralDlp` (SettingsGeneral.tsx:36-88) but with the
 * opposite fail-closed polarity: only the literal `"true"` enables uploads
 * for non-admins (D-03). When disabled, only admins can upload files; the
 * per-workspace `Workspace.allowMemberUploads` flag still applies as the OR
 * second operand enforced server-side by `assertNonAdminUploadAllowed`
 * (Plan 70-01, D-02).
 *
 * Lives under the Security tab in `SettingsPage` as its own sub-section
 * (`nonAdminUpload`), gated by `has("admin:settings")`. Pitfall 6: the
 * Security tab itself is visible to a settings-only admin because
 * `SETTINGS_TAB_PERMISSIONS.security` includes `admin:settings`
 * (permissions.ts, additive).
 *
 * No-restart contract (SC-4): the toggle calls `PUT /api/system/settings`
 * with `[{ key: "ALLOW_NON_ADMIN_UPLOAD", value: "true"|"false" }]`. The
 * server's `systemConfigService.getSetting` queries the DB fresh on every
 * call (no in-memory cache, DB > ENV > Default), so the next upload request
 * sees the new value without a server restart. The integration test
 `settings.integration.test.ts` locks this contract.
 */
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { showError } from "../lib/toast";
import { Switch } from "@/components/ui/switch";

export function SettingsSecurityNonAdminUpload() {
  const { t } = useTranslation();
  const { getValue } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();

  // D-03 fail-closed: only literal "true" allows non-admin uploads. Every
  // other value (undefined, "", "false", "yes", "TRUE") denies. Opposite
  // polarity of SettingsGeneralDlp which uses `!== "false"`.
  const [checked, setChecked] = useState(getValue("ALLOW_NON_ADMIN_UPLOAD") === "true");

  // IN-06 (Phase 70 review follow-up): extract `currentValue` outside the
  // useEffect deps array. The previous shape `getValue("ALLOW_NON_ADMIN_UPLOAD")`
  // evaluated inside the deps array was an anti-pattern (expression evaluation
  // in deps). Pulling it into a const mirrors `SettingsGeneralDlp` and makes
  // the dependency stable (string primitive, referentially stable from
  // TanStack Query cache).
  const currentValue = getValue("ALLOW_NON_ADMIN_UPLOAD");

  // Sync local state when the server-side value changes (e.g. after a
  // successful mutation invalidates the settings query and the helpers
  // re-read the fresh value).
  useEffect(() => {
    setChecked(currentValue === "true");
  }, [currentValue]);

  const handleToggle = async (v: boolean) => {
    setChecked(v);
    try {
      await updateSettings([
        { key: "ALLOW_NON_ADMIN_UPLOAD", value: String(v) },
      ]);
    } catch {
      // Revert optimistic state on failure.
      setChecked(!v);
      // WR-02 (Phase 70 review follow-up): surface the revert to the user
      // via a localized error toast. Mirrors SettingsGeneral.tsx:173 pattern
      // (showError on mutation failure). The t(...) key is pre-localized;
      // no getErrorMessage needed since the mutation throws and the
      // localized revert notice is the actionable message.
      showError(t("settings.security.nonAdminUploadToggleError"));
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t("settings.security.nonAdminUploadLabel")}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t("settings.security.nonAdminUploadDesc")}
          </p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={handleToggle}
          aria-label={t("settings.security.nonAdminUploadLabel")}
        />
      </div>
    </div>
  );
}


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

export default function SettingsVapid() {
  const { t } = useTranslation();
  const { getValue, isReadOnly } = useSettingsHelpers();
  const { mutateAsync: updateSettings, isPending } = useUpdateSettings();

  const [publicKey, setPublicKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [subject, setSubject] = useState("");

  useEffect(() => {
    setPublicKey(getValue("VAPID_PUBLIC_KEY") || "");
    setPrivateKey(getValue("VAPID_PRIVATE_KEY") || "");
    setSubject(getValue("VAPID_SUBJECT") || "");
    // `getValue` is a settings-reader helper recreated each render from the
    // settings query; the actual dependency values it returns for the three
    // VAPID keys are already inlined as deps below, so listing `getValue`
    // itself would force a re-run every render (it is not a stable ref).
    // (D-05 pattern 3 — intentional, documented.)
  }, [getValue("VAPID_PUBLIC_KEY"), getValue("VAPID_PRIVATE_KEY"), getValue("VAPID_SUBJECT")]);

  const handleSave = async () => {
    try {
      await updateSettings([
        { key: "VAPID_PUBLIC_KEY", value: publicKey },
        { key: "VAPID_PRIVATE_KEY", value: privateKey },
        { key: "VAPID_SUBJECT", value: subject },
      ]);
      showSuccess(t("common.success"));
    } catch (err) {
      showError(getErrorMessage(err));
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">
          {t("settings.subSections.vapid")}
        </h4>
        <p className="text-xs text-muted-foreground mt-1">
          {t("settings.vapid.description")}
        </p>
      </div>

      <div className="space-y-3">
        <AppInput
          label={t("settings.vapid.publicKey")}
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          disabled={isReadOnly("VAPID_PUBLIC_KEY")}
          placeholder="BOp..."
        />
        <AppInput
          label={t("settings.vapid.privateKey")}
          type="password"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          disabled={isReadOnly("VAPID_PRIVATE_KEY")}
          placeholder="••••"
        />
        <AppInput
          label={t("settings.vapid.subject")}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={isReadOnly("VAPID_SUBJECT")}
          placeholder="mailto:admin@example.com"
        />
      </div>

      <Button size="sm" onClick={handleSave} disabled={isPending}>
        {isPending ? t("common.loading") : t("common.save")}
      </Button>
    </div>
  );
}
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

export default function SettingsReranker() {
  const { t } = useTranslation();
  const { getValue, isReadOnly } = useSettingsHelpers();
  const { mutateAsync: updateSettings, isPending } = useUpdateSettings();

  const [enabled, setEnabled] = useState("false");
  const [candidatePool, setCandidatePool] = useState("4");

  useEffect(() => {
    setEnabled(getValue("rag_reranker_enabled") || "false");
    setCandidatePool(getValue("rag_reranker_candidate_pool") || "4");
    // `getValue` is a settings-reader helper recreated each render from the
    // settings query; the actual dependency values it returns for the two
    // reranker keys are already inlined as deps below, so listing `getValue`
    // itself would force a re-run every render (it is not a stable ref).
    // (D-05 pattern 3 — intentional, documented.)
  }, [getValue("rag_reranker_enabled"), getValue("rag_reranker_candidate_pool")]);

  const handleSave = async () => {
    try {
      await updateSettings([
        { key: "rag_reranker_enabled", value: enabled },
        { key: "rag_reranker_candidate_pool", value: candidatePool },
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
          {t("settings.subSections.reranker")}
        </h4>
        <p className="text-xs text-muted-foreground mt-1">
          {t("settings.reranker.description")}
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled === "true"}
              onChange={(e) => setEnabled(e.target.checked ? "true" : "false")}
              disabled={isReadOnly("rag_reranker_enabled")}
              className="accent-primary"
            />
            <span className="text-sm text-foreground">{t("settings.reranker.enabled")}</span>
          </label>
        </div>

        <AppInput
          label={t("settings.reranker.candidatePool")}
          type="number"
          value={candidatePool}
          onChange={(e) => setCandidatePool(e.target.value)}
          disabled={isReadOnly("rag_reranker_candidate_pool")}
          placeholder="4"
        />
      </div>

      <Button size="sm" onClick={handleSave} disabled={isPending}>
        {isPending ? t("common.loading") : t("common.save")}
      </Button>
    </div>
  );
}
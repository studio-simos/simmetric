// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Settings, RefreshCw, Check, AlertTriangle } from "lucide-react";
import {
  useArchive,
  useArchiveConfig,
  useUpdateArchiveConfig,
  useTriggerIndexing,
} from "../queries/useArchives";
import { apiPut } from "../utils/api";
import { showSuccess, showError } from "../lib/toast";
import type { ArchiveConfigInput } from "@simmetric-chat/shared";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AppInput, AppSelect, AppTextarea } from "@/components/ui/app";
import { SelectItem } from "@/components/ui/select";
import { getErrorMessage } from "../utils/errorUtils";
interface ArchiveConfigPanelProps {
  archiveId: string;
}

export function ArchiveConfigPanel({ archiveId }: ArchiveConfigPanelProps) {
  const { t } = useTranslation();
  const { data: archiveConfig } = useArchiveConfig(archiveId);
  const { data: currentArchive } = useArchive(archiveId);
  const updateConfig = useUpdateArchiveConfig();
  const triggerIndex = useTriggerIndexing();
  const [indexingStatus, setIndexingStatus] = useState<"idle" | "indexing" | "done" | "error">("idle");
  const loading = updateConfig.isPending;
  const [autoIndex, setAutoIndex] = useState(false);
  const [persona, setPersona] = useState<"conservative" | "balanced" | "exploratory">("balanced");
  const [purpose, setPurpose] = useState("");
  const [scope, setScope] = useState("");
  const [linkMin, setLinkMin] = useState(0.005);
  const [linkMax, setLinkMax] = useState(0.15);

  // archiveConfig fetched automatically by useArchiveConfig

  useEffect(() => {
    if (archiveConfig) {
      setPersona(archiveConfig.agentPersona || "balanced");
      setPurpose(archiveConfig.purpose || "");
      setScope(archiveConfig.scope || "");
      if (archiveConfig.linkingDensity) {
        setLinkMin(archiveConfig.linkingDensity.min);
        setLinkMax(archiveConfig.linkingDensity.max);
      }
    }
  }, [archiveConfig]);

  useEffect(() => {
    if (currentArchive) {
      setAutoIndex(currentArchive.autoIndex || false);
    }
  }, [currentArchive]);

  const handleSave = async () => {
    const config: Partial<ArchiveConfigInput> = {
      agentPersona: persona,
      purpose,
      scope,
      linkingDensity: { min: linkMin, max: linkMax },
    };
    try {
      await updateConfig.mutateAsync({ archiveId, config });
      showSuccess(t("config.saved", "Configuration saved"));
    } catch (err: unknown) {
      showError(getErrorMessage(err, t("config.saveError", "Failed to save configuration")));
    }
  };

  const handleAutoIndexToggle = async () => {
    const next = !autoIndex;
    setAutoIndex(next);
    await apiPut(`/archives/${archiveId}`, { autoIndex: next });
  };

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Settings size={18} />
          {t("config.title")}
        </h3>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={loading}
          autoFocus
        >
          {loading ? t("common.saving") : t("common.save")}
        </Button>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
          <div>
            <p className="text-sm font-medium text-foreground">{t("config.autoIndex")}</p>
            <p className="text-xs text-muted-foreground">{t("config.autoIndexDesc")}</p>
          </div>
          <Switch
            checked={autoIndex}
            onCheckedChange={() => handleAutoIndexToggle()}
            aria-label={t("config.autoIndex")}
          />
        </div>

        <AppSelect
          label={t("config.agentPersona")}
          value={persona}
          onValueChange={(value) => {
            if (value === "conservative" || value === "balanced" || value === "exploratory") {
              setPersona(value);
            }
          }}
        >
          <SelectItem value="conservative">{t("config.personaConservative")}</SelectItem>
          <SelectItem value="balanced">{t("config.personaBalanced")}</SelectItem>
          <SelectItem value="exploratory">{t("config.personaExploratory")}</SelectItem>
        </AppSelect>

        <div className="grid grid-cols-2 gap-4">
          <AppInput
            type="number"
            step={0.001}
            label={t("config.linkDensityMin")}
            value={String(linkMin)}
            onChange={(e) => setLinkMin(parseFloat(e.target.value))}
          />
          <AppInput
            type="number"
            step={0.001}
            label={t("config.linkDensityMax")}
            value={String(linkMax)}
            onChange={(e) => setLinkMax(parseFloat(e.target.value))}
          />
        </div>

        <AppTextarea
          label={t("config.purpose")}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          rows={2}
        />

        <AppTextarea
          label={t("config.scope")}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          rows={2}
        />
      </div>

      <div className="flex items-center gap-3 pt-4 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            setIndexingStatus("indexing");
            try {
              await triggerIndex.mutateAsync(archiveId);
              setIndexingStatus("done");
            } catch {
              setIndexingStatus("error");
            }
          }}
          disabled={indexingStatus === "indexing"}
        >
          <RefreshCw size={16} className={indexingStatus === "indexing" ? "animate-spin" : ""} />
          {indexingStatus === "indexing" ? t("config.indexing") : t("config.indexNow")}
        </Button>
        {indexingStatus === "done" && (
          <span className="flex items-center gap-1 text-sm text-emerald-600"><Check size={14} /> {t("config.indexDone")}</span>
        )}
        {indexingStatus === "error" && (
          <span className="flex items-center gap-1 text-sm text-red-500"><AlertTriangle size={14} /> {t("config.indexError")}</span>
        )}
      </div>
    </div>
  );
}

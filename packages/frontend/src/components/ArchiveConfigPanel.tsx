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
import { renderMarkdown } from "../utils/markdown";
import type { ArchiveConfigInput } from "@simmetric-chat/shared";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AppInput, AppSelect, AppTextarea } from "@/components/ui/app";
import { SelectItem } from "@/components/ui/select";
import { getErrorMessage } from "../utils/errorUtils";

const SCHEMA_PROMPT_MAX = 10000;

/**
 * Default schema-prompt template body (UI-SPEC Copywriting Contract).
 * Code constant, NOT i18n chrome — it is admin-editable archive config data
 * and must not drift with the UI language. Mirrors spec §2.1 sections and
 * carries the raw_sources immutability line (spec §2.5).
 */
export const DEFAULT_TEMPLATE_BODY = `# Wiki Editorial Guidelines

## Page Structure
- One topic per page; use short, specific titles.
- Link related pages with wikilinks.

## Naming Conventions
- Slugs in kebab-case, max 50 chars.

## Tone
- Neutral, factual, concise. No marketing language.

## Maintenance
- Update pages instead of creating duplicates.
- raw_sources/ is immutable — never modify original source files.
  Always create new wiki pages to summarize or reference sources.
`;

interface ArchiveConfigPanelProps {
  archiveId: string;
}

export function ArchiveConfigPanel({ archiveId }: ArchiveConfigPanelProps) {
  const { t } = useTranslation();
  // WR-02 (Phase 187 code review): expose the query's loading flag — Save must
  // be disabled until the config query has hydrated, or an early save PUTs
  // `schemaPrompt: ""` + default persona/purpose over the stored blob
  // (whole-blob replace wipes admin-authored guidance).
  const { data: archiveConfig, isLoading: configLoading } = useArchiveConfig(archiveId);
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
  const [schemaPrompt, setSchemaPrompt] = useState("");
  const [preview, setPreview] = useState(false);

  // archiveConfig fetched automatically by useArchiveConfig

  useEffect(() => {
    if (archiveConfig) {
      setPersona(archiveConfig.agentPersona || "balanced");
      setPurpose(archiveConfig.purpose || "");
      setScope(archiveConfig.scope || "");
      setSchemaPrompt(archiveConfig.schemaPrompt || "");
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
    // WR-02 belt-and-suspenders: skip the save entirely while the config query
    // has not hydrated (the disabled button is the primary guard; this covers
    // programmatic invocations and stale-click races).
    if (!archiveConfig) return;
    const config: Partial<ArchiveConfigInput> = {
      agentPersona: persona,
      purpose,
      scope,
      linkingDensity: { min: linkMin, max: linkMax },
      schemaPrompt,
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

  const schemaPromptOverLimit = schemaPrompt.length > SCHEMA_PROMPT_MAX;

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
          disabled={loading || schemaPromptOverLimit || configLoading}
          autoFocus
        >
          {loading ? t("archives.schemaPrompt.saving") : t("archives.schemaPrompt.save")}
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

      <div className="space-y-4">
        <h4 className="text-lg font-semibold text-foreground">{t("archives.schemaPrompt.label")}</h4>
        <AppTextarea
          label={t("archives.schemaPrompt.label")}
          value={schemaPrompt}
          onChange={(e) => setSchemaPrompt(e.target.value)}
          rows={12}
          className="font-mono min-h-[300px]"
          placeholder={t("archives.schemaPrompt.placeholder")}
          helperText={`${t("archives.schemaPrompt.helper")} ${t("archives.schemaPrompt.advisoryNote")}`}
          error={schemaPromptOverLimit ? t("archives.schemaPrompt.overLimitError") : undefined}
        />
        <div className="flex items-center gap-2 mt-1">
          {schemaPrompt.length === 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSchemaPrompt(DEFAULT_TEMPLATE_BODY)}
            >
              {t("archives.schemaPrompt.useTemplate")}
            </Button>
          )}
          <div className="inline-flex rounded-lg border border-border bg-muted p-[3px] gap-1">
            <button
              type="button"
              aria-pressed={!preview}
              onClick={() => setPreview(false)}
              className={`px-2.5 py-0.5 rounded-md text-sm ${
                !preview ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {t("archives.schemaPrompt.tabEdit")}
            </button>
            <button
              type="button"
              aria-pressed={preview}
              onClick={() => setPreview(true)}
              className={`px-2.5 py-0.5 rounded-md text-sm ${
                preview ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"
              }`}
            >
              {t("archives.schemaPrompt.tabPreview")}
            </button>
          </div>
        </div>
        <p
          className={`text-xs mt-1 ${schemaPromptOverLimit ? "text-destructive" : "text-muted-foreground"}`}
        >
          {t("archives.schemaPrompt.charCount", { count: schemaPrompt.length })}
        </p>
        {preview && (
          <div
            className="rounded-lg border border-border bg-card p-3 text-sm"
            data-testid="schema-preview"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(schemaPrompt) }}
          />
        )}
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
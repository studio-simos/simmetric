// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsHelpers, useUpdateSettings } from "../queries/useSettings";
import { showSuccess, showError } from "../lib/toast";
import { getErrorMessage } from "../utils/errorUtils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SettingsWebSearch() {
  const { t } = useTranslation();
  const { getValue } = useSettingsHelpers();
  const { mutateAsync: updateSettings } = useUpdateSettings();

  const [provider, setProvider] = useState("searxng");
  const [searxngUrl, setSearxngUrl] = useState("");

  useEffect(() => {
    setProvider(getValue("web_search_provider") || "searxng");
    setSearxngUrl(getValue("searxng_url") || "");
    // `getValue` is a settings-reader helper recreated each render from the
    // settings query; the actual dependency values it returns for the two
    // web-search keys are already inlined as deps below, so listing `getValue`
    // itself would force a re-run every render (it is not a stable ref).
    // (D-05 pattern 3 — intentional, documented.)
  }, [getValue("web_search_provider"), getValue("searxng_url")]);

  const handleProviderChange = async (value: string) => {
    const prev = provider;
    setProvider(value);
    try {
      await updateSettings([{ key: "web_search_provider", value }]);
      showSuccess(t("settings.webSearch.provider") + ": " + value);
    } catch (err) {
      setProvider(prev);
      showError(getErrorMessage(err));
    }
  };

  const handleSearxngUrlChange = async (value: string) => {
    const prev = searxngUrl;
    setSearxngUrl(value);
    try {
      await updateSettings([{ key: "searxng_url", value }]);
    } catch (err) {
      setSearxngUrl(prev);
      showError(getErrorMessage(err));
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">
          {t("settings.webSearch.title")}
        </h4>
        <p className="text-xs text-muted-foreground mt-1">
          {t("settings.webSearch.description")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="web-search-provider" className="text-sm">
          {t("settings.webSearch.provider")}
        </Label>
        <Select value={provider} onValueChange={handleProviderChange}>
          <SelectTrigger id="web-search-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="searxng">
              {t("settings.webSearch.searxng")}
            </SelectItem>
            <SelectItem value="tavily">
              {t("settings.webSearch.tavily")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {provider === "searxng" && (
        <div className="space-y-2">
          <Label htmlFor="searxng-url" className="text-sm">
            {t("settings.webSearch.searxngUrl")}
          </Label>
          <Input
            id="searxng-url"
            value={searxngUrl}
            onChange={(e) => setSearxngUrl(e.target.value)}
            onBlur={(e) => handleSearxngUrlChange(e.target.value)}
            placeholder={t("settings.webSearch.searxngUrlPlaceholder")}
          />
        </div>
      )}

      {provider === "tavily" && (
        <div className="text-xs text-muted-foreground italic bg-accent/50 border border-border rounded-md p-3">
          {t("settings.webSearch.tavilyKeyNote")}
        </div>
      )}
    </div>
  );
}
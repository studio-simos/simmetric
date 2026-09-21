// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { ProviderIcon } from "./ModelSelector";
import { Button } from "@/components/ui/button";

import { cn } from "@/lib/utils"
interface MobileTabSwitcherProps {
  activeTab: "A" | "B";
  onTabChange: (tab: "A" | "B") => void;
  paneAModel: { providerId?: string; model?: string } | null;
  paneBModel: { providerId?: string; model?: string } | null;
}

export default function MobileTabSwitcher({
  activeTab,
  onTabChange,
  paneAModel,
  paneBModel,
}: MobileTabSwitcherProps) {
  const { t } = useTranslation();

  const providerTypeFromModel = (model: { providerId?: string; model?: string } | null) => {
    if (!model?.providerId) return "ollama";
    const pid = model.providerId.toLowerCase();
    if (pid.includes("openai")) return "openai";
    if (pid.includes("anthropic")) return "anthropic";
    if (pid.includes("openrouter")) return "openrouter";
    return "ollama";
  };

  const modelDisplay = (model: { providerId?: string; model?: string } | null) => {
    return model?.model || t("chat.modelSelector.default");
  };

  return (
    <div role="tablist" className="flex flex-col md:hidden border-b border-border bg-card">
      <Button
        variant="ghost"
        role="tab"
        aria-selected={activeTab === "A"}
        onClick={() => onTabChange("A")}
        className={cn("flex-1 px-3 py-2 text-sm flex items-center justify-center gap-1.5 rounded-none", activeTab === "A"
            ? "border-b-2 border-primary text-primary font-medium"
            : "text-muted-foreground")}
      >
        <ProviderIcon type={providerTypeFromModel(paneAModel)} />
        <span>
          {t("chat.comparison.tabLabel")} {modelDisplay(paneAModel)}
        </span>
      </Button>
      <Button
        variant="ghost"
        role="tab"
        aria-selected={activeTab === "B"}
        onClick={() => onTabChange("B")}
        className={cn("flex-1 px-3 py-2 text-sm flex items-center justify-center gap-1.5 rounded-none", activeTab === "B"
            ? "border-b-2 border-primary text-primary font-medium"
            : "text-muted-foreground")}
      >
        <ProviderIcon type={providerTypeFromModel(paneBModel)} />
        <span>
          {t("chat.comparison.tabLabel")} {modelDisplay(paneBModel)}
        </span>
      </Button>
    </div>
  );
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";

/**
 * Upgrade prompt for a gated feature.
 *
 * Phase 140 (EPA-02): the `feature` prop type was widened from `FeatureFlag`
 * to `string` so the component can be rendered with commodity flag names
 * (`web_search`, `lead_export`, `widget_analytics`) that were removed from
 * the `FeatureFlag` union. The i18n key lookup
 * `t(\`upgrade.featureLabels.${feature}\`)` is string-indexed, so it still
 * resolves. Phase 147 will rework frontend conditional enterprise loading.
 */
interface UpgradePromptProps {
  feature: string;
  message?: string;
}

export default function UpgradePrompt({ feature, message }: UpgradePromptProps) {
  const { t } = useTranslation();

  return (
    <div className="border border-input bg-accent rounded-lg p-6 text-center">
      <div className="text-primary text-2xl mb-2">&#128274;</div>
      <h3 className="text-lg font-semibold text-foreground mb-1">
        {t("upgrade.title")}
      </h3>
      <p className="text-sm text-muted-foreground mb-3">
        {message ||
          t("upgrade.featureMessage", { feature: t(`upgrade.featureLabels.${feature}`) })}
      </p>
      <a
        href="https://simmetric.chat/enterprise"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block px-6 py-2 rounded-lg text-sm font-medium text-white hover:opacity-90 transition-opacity"
        
      >
        {t("upgrade.cta")}
      </a>
    </div>
  );
}
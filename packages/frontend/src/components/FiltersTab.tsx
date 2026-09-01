// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useTranslation } from "react-i18next";
import { useFilters, useUpdateFilter } from "../queries/useFilters";
import { Switch } from "@/components/ui/switch";
import { showSuccess, showError } from "../lib/toast";

/**
 * FiltersTab — admin UI for filter plugins (Phase 100-03, D-04).
 *
 * Rendered as a sub-section of Settings → Avanzate. Lists all registered
 * filter plugins with name, priority, enabled toggle, inlet/outlet presence
 * badges, and description. Toggling calls PATCH /api/filters/:name and
 * invalidates the filters query cache. Permission gate is in SettingsPage
 * (filters:manage), NOT here — this component only renders when the parent
 * gate has already verified the permission.
 */
export function FiltersTab() {
  const { t } = useTranslation();
  const { data: plugins, isLoading, error } = useFilters();
  const updateFilter = useUpdateFilter();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-[var(--text-muted)]">
        <span className="text-sm">{t("settings.filters.loading")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-4 text-sm text-[var(--error-text)]">
        {t("settings.filters.error")}
      </div>
    );
  }

  if (!plugins || plugins.length === 0) {
    return (
      <div className="py-4 text-sm text-[var(--text-muted)]">
        {t("settings.filters.noPlugins")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--text-muted)]">
        {t("settings.filters.description")}
      </p>
      <div className="rounded-lg border border-[var(--border)] overflow-hidden">
        {plugins.map((plugin, idx) => (
          <div
            key={plugin.name}
            className={`flex items-center justify-between gap-4 px-4 py-3 ${
              idx > 0 ? "border-t border-[var(--border)]" : ""
            } bg-[var(--surface)]`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[var(--text)]">
                  {plugin.name}
                </span>
                <span className="inline-flex items-center rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                  {t("settings.filters.priority")}: {plugin.priority}
                </span>
                {plugin.hasInlet && (
                  <span className="inline-flex items-center rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                    {t("settings.filters.inlet")}
                  </span>
                )}
                {plugin.hasOutlet && (
                  <span className="inline-flex items-center rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                    {t("settings.filters.outlet")}
                  </span>
                )}
                {plugin.outletStreaming && (
                  <span className="inline-flex items-center rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                    {t("settings.filters.streaming")}
                  </span>
                )}
              </div>
              {plugin.description && (
                <p className="mt-1 text-sm text-[var(--text-muted)]">
                  {plugin.description}
                </p>
              )}
            </div>
            <Switch
              checked={plugin.enabled}
              disabled={updateFilter.isPending}
              aria-label={plugin.name}
              onCheckedChange={(checked) => {
                updateFilter.mutate(
                  { name: plugin.name, enabled: checked },
                  {
                    onSuccess: () =>
                      showSuccess(
                        checked
                          ? t("settings.filters.enable")
                          : t("settings.filters.disable"),
                      ),
                    onError: () => showError(t("settings.filters.error")),
                  },
                );
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
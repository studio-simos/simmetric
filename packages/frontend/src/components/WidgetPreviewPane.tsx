// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsHelpers } from "../queries/useSettings";
import { resolveWidgetServiceUrl } from "../utils/widgetServiceUrl";

interface WidgetPreviewPaneProps {
  widgetId: string | null;
  primaryColor?: string;
  position?: string;
  locale?: string;
  autoOpenDelay?: string;
  // 260917-mz6: bumped by WidgetForm after each successful save — the src
  // gains &r=<key> so the iframe remounts and refetches the config (the
  // loader iframe route is per-request fresh; PUT already cache-busts).
  // 0 (never bumped) omits the param entirely (Pitfall 3: omission-not-empty).
  reloadKey?: number;
}

/**
 * Live preview pane (D-05, ADM-02): iframe to the widget service embed with
 * query overrides (?primaryColor, ?position, ?locale — loader.ts:259-277
 * override chain). The src is debounced 500ms on watched values (OQ4) so
 * typing does not spam the widget service (T-128-06). Create mode (no
 * widgetId) renders a static placeholder card.
 *
 * Quick 260826-hx5 (D-02): `?autoOpenDelay` forwards the live form value so
 * the preview auto-opens after the configured delay WITHOUT waiting for the
 * iframe's config fetch to resolve (the original bug: useTriggers saw
 * autoOpenDelay=null before the config fetch landed). Absent/empty → the
 * param is omitted entirely (Pitfall 3: an always-sent `autoOpenDelay=`
 * would shadow the DB config the loader falls back to).
 */
export default function WidgetPreviewPane({
  widgetId,
  primaryColor,
  position,
  locale,
  autoOpenDelay,
  reloadKey,
}: WidgetPreviewPaneProps) {
  const { t } = useTranslation();
  const { getValue } = useSettingsHelpers();

  // widgetServiceUrl resolution — identical to WidgetForm.tsx. Same-origin by
  // default (the widget is served behind the app origin via reverse proxy);
  // NEVER derived from SERVER_URL (docker-internal hostname → mixed content,
  // G-151-1a root cause).
  const widgetServiceUrl = resolveWidgetServiceUrl(
    getValue("WIDGET_SERVICE_URL") || "",
    window.location.origin
  );

  const buildSrc = useCallback((): string => {
    if (!widgetId) return "";
    // encodeURIComponent on every param (T-128-04 — research Known Threat
    // Patterns; loader.ts:111 pattern). Manual concatenation (not
    // URLSearchParams) so each param is encoded exactly once.
    const color = encodeURIComponent(primaryColor ?? "#4c6ef5");
    const pos = encodeURIComponent(position ?? "bottom-right");
    // Absent ?locale= is treated as absent — never send locale= (Pitfall 3).
    const loc = locale ? `&locale=${encodeURIComponent(locale)}` : "";
    // Quick 260826-hx5 (D-02): absent/empty autoOpenDelay → omit the param
    // entirely so the loader falls back to the DB config (Pitfall 3).
    const delay =
      autoOpenDelay && autoOpenDelay !== ""
        ? `&autoOpenDelay=${encodeURIComponent(autoOpenDelay)}`
        : "";
    // 260917-mz6: reload-on-save — a non-zero reloadKey appends &r=<key> so
    // the iframe remounts with fresh config. 0/undefined omits the param.
    const reload = reloadKey ? `&r=${encodeURIComponent(String(reloadKey))}` : "";
    return `${widgetServiceUrl}/widget/${widgetId}?primaryColor=${color}&position=${pos}${loc}${delay}${reload}`;
  }, [widgetId, primaryColor, position, locale, autoOpenDelay, reloadKey, widgetServiceUrl]);

  const [src, setSrc] = useState<string>(buildSrc);

  // 500ms debounce on watched values (OQ4) with cleanup.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSrc(buildSrc());
    }, 500);
    return () => clearTimeout(timer);
  }, [buildSrc]);

  if (!widgetId) {
    return (
      <div className="bg-background rounded-lg border border-border p-4 flex items-center justify-center min-h-[400px]">
        <p className="text-sm text-muted-foreground">{t("widgets.preview.placeholder")}</p>
      </div>
    );
  }

  return (
    <div className="bg-background rounded-lg border border-border">
      <iframe
        src={src}
        title="Widget preview"
        className="w-full h-full border-0 rounded-lg min-h-[400px]"
      />
    </div>
  );
}

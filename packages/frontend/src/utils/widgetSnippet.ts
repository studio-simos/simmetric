// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Dynamic widget embed snippet builder (Quick 260826-p0d, D-01/D-04/D-05).
 *
 * Replaces the static `EMBED_SNIPPET_TEMPLATE` in WidgetForm.tsx. The snippet
 * is self-documenting: toggling a display trigger in the admin form
 * immediately reflects the right query param on the `<script src>` URL.
 *
 * Omission-not-empty contract (D-05, Pitfall 3): when an option is
 * OFF/unset/empty its query param is OMITTED entirely — never an empty
 * `&param=`. The loader route treats an absent query as absent and falls
 * back to the DB-saved config (query > DB priority, D-03).
 *
 * The wire formats mirror the loader route handler (loader.ts):
 *  - autoOpenDelay: numeric string (Number()+isNaN guard on the route side).
 *  - autoOpenUrlPatterns: URL-encoded JSON-encoded string of string[]
 *    (the DB column shape — the widget client JSON.parses it).
 *  - exitIntentEnabled: "1" (LOADER_JS boolean convention; the route accepts
 *    "1" or "true").
 */

export interface WidgetSnippetOptions {
  /** Toggle for "auto-open after N seconds". When false the param is omitted. */
  autoOpenByTimeEnabled?: boolean;
  /** Seconds string (form field is a string; parsed as int). */
  autoOpenDelay?: string;
  /** Toggle for "auto-open on matching URL". When false the param is omitted. */
  autoOpenByUrlEnabled?: boolean;
  /** Comma-separated patterns (e.g. "/pricing/*, /contact"). */
  autoOpenUrlPatterns?: string;
  /** Toggle for exit-intent auto-open. When false the param is omitted. */
  exitIntentEnabled?: boolean;
}

/**
 * Build the copyable widget embed snippet HTML.
 *
 * @param widgetId - the widget id (already saved — edit mode only).
 * @param widgetServiceUrl - origin of the widget service (resolved same-origin).
 * @param options - live form values for the three trigger toggles.
 * @returns the full snippet HTML string (container div + script tag).
 */
export function buildWidgetSnippet(
  widgetId: string,
  widgetServiceUrl: string,
  options: WidgetSnippetOptions = {},
): string {
  const params: string[] = [];

  // autoOpenDelay: include only when the time toggle is ON AND the value is a
  // positive-ish numeric string (mirrors the loader.ts Number()+isNaN guard —
  // a malformed "abc" is skipped, not emitted as autoOpenDelay=NaN).
  if (options.autoOpenByTimeEnabled === true) {
    const trimmed = (options.autoOpenDelay ?? "").trim();
    const parsed = Number(trimmed);
    if (trimmed !== "" && !isNaN(parsed)) {
      params.push(`autoOpenDelay=${encodeURIComponent(trimmed)}`);
    }
  }

  // autoOpenUrlPatterns: comma-separated in the form field, JSON-encoded string
  // of string[] on the wire (same shape as the DB column the loader reads at
  // loader.ts:593). Include only when the URL toggle is ON AND the split+trim
  // yields at least one non-empty pattern.
  if (options.autoOpenByUrlEnabled === true) {
    const patterns = (options.autoOpenUrlPatterns ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (patterns.length > 0) {
      params.push(`autoOpenUrlPatterns=${encodeURIComponent(JSON.stringify(patterns))}`);
    }
  }

  // exitIntentEnabled: boolean toggle — "1" is the wire value (LOADER_JS
  // convention; the route accepts "1" or "true").
  if (options.exitIntentEnabled === true) {
    params.push("exitIntentEnabled=1");
  }

  const base = `${widgetServiceUrl}/widget/${widgetId}.js`;
  const query = params.length > 0 ? `?${params.join("&")}` : "";

  // The container div + script tag structure is preserved byte-identically
  // from the old EMBED_SNIPPET_TEMPLATE (WidgetForm.tsx:86-97): the Italian
  // comment text, the fixed inline style, the data-target attribute.
  return `<!-- Aggiungi questo container dove vuoi che appaia il widget -->
<div
  id="simmetric-chat-widget"
  data-widget-id="${widgetId}"
  style="position: fixed; bottom: 0; right: 0; width: 400px; height: 600px; z-index: 9999; border: none; pointer-events: none;"
></div>
<!-- Inserisci questo script prima di </body> -->
<script
  data-target="simmetric-chat-widget"
  src="${base}${query}"
></script>`;
}
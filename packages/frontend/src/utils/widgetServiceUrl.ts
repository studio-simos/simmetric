// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Single source of truth for widget service URL resolution (151-02, G-151-1a/1b).
 *
 * The widget service is served same-origin via reverse proxy: static + loader
 * routes under /widget/ and the widget's API under
 * /api/(sessions|config|chat|lead) (nginx in docker, Vite dev/preview proxies
 * locally). The browser-facing URL is therefore `window.location.origin` —
 * NOT a port-derived URL and NOT SERVER_URL (which is the docker-internal
 * hostname `http://server:3000` and leaks into browser-facing URLs when used
 * here — the G-151-1a mixed-content root cause).
 *
 * `configured` is the optional WIDGET_SERVICE_URL override (a no-op extension
 * point; the key is deliberately NOT exposed via GET /api/system/settings, so
 * in practice it is always ""). When non-empty it wins; otherwise the caller's
 * origin is used. Trailing slashes are stripped so callers can concatenate
 * `/widget/...` without double slashes.
 */
export function resolveWidgetServiceUrl(configured: string, origin: string): string {
  const base = configured || origin;
  return base.replace(/\/+$/, "");
}

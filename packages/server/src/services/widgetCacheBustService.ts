// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WID-04 / 65-03 — push HTTP cache-bust for the widget config cache.
 *
 * `fireWidgetCacheBust(widgetId)` is a fire-and-forget HTTP POST to the widget
 * service's internal `POST /api/config/:widgetId/cache-bust` endpoint. The
 * widget service keeps a 5-minute in-memory cache of widget appearance config
 * (`packages/widget/src/routes/config.ts`); without a push, worst-case
 * staleness after `PUT /api/widgets/:id` is 5 minutes. With this push, the
 * visitor sees fresh branding on the next iframe load (loader fetches with
 * Cache-Control: no-cache).
 *
 * Design constraints (D-07):
 *   - Per-widgetId (NOT a global flush) — widget service deletes only the
 *     single cache entry.
 *   - Non-blocking — caller does NOT await; the internal `.catch` swallows
 *     network errors so `PUT /api/widgets/:id` always returns 200 even if the
 *     widget service is unreachable. The 5-min TTL is the safety net.
 *   - Authenticated via `X-Api-Key` shared secret when `WIDGET_API_KEY` is
 *     configured on both sides. When the server-side key is unset, the helper
 *     is a no-op (admin can disable push and rely on TTL alone).
 */
import axios from "axios";
import { getEnv } from "../config/env";
import { logger } from "../utils/logger";

export function fireWidgetCacheBust(widgetId: string): void {
  const env = getEnv();
  if (!env.WIDGET_API_KEY) {
    logger.warn("[widgetCacheBust] skipped — WIDGET_API_KEY not set", { widgetId });
    return;
  }

  axios
    .post(
      `${env.WIDGET_SERVICE_URL}/api/config/${widgetId}/cache-bust`,
      {},
      {
        timeout: 2000,
        headers: { "X-Api-Key": env.WIDGET_API_KEY },
      },
    )
    .then(() => logger.info("[widgetCacheBust] ok", { widgetId }))
    .catch(() =>
      logger.warn("[widgetCacheBust] failed (non-blocking)", { widgetId }),
    );
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Filter Chain Runner (D-02, D-03, D-05)
 *
 * Executes the inlet (pre-LLM) and outlet (post-LLM pre-user) chains in
 * ascending priority order with try/catch per plugin. A plugin that throws
 * is caught, logged with the [filters] prefix, and skipped — the chat
 * continues (D-05 crash isolation). A plugin returning undefined (void)
 * is pass-through; a plugin returning a new FilterContext replaces the
 * current context for subsequent plugins.
 *
 * Phase 100-01 — filter-plugin-system-last-feature.
 */
import type { FilterContext } from "./types";
import { getEnabledFilters } from "./filterRegistry";
import { logger } from "../utils/logger";

/**
 * Execute the inlet chain: pre-LLM, modifies the user message.
 * Priority order: DLP(-1) → plugin(0) → plugin(1) → ...
 * try/catch per plugin: crash → log + skip, chat continues (D-05).
 */
export async function runInlet(ctx: FilterContext): Promise<FilterContext> {
  const plugins = getEnabledFilters()
    .filter(p => p.inlet !== undefined)
    .sort((a, b) => a.priority - b.priority);

  let currentCtx = ctx;
  for (const plugin of plugins) {
    try {
      const result = await plugin.inlet!(currentCtx);
      if (result !== undefined) {
        currentCtx = result;
      }
    } catch (err) {
      logger.warn(`[filters] Plugin "${plugin.name}" inlet crashed, skipping`, {
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue to next plugin — crash doesn't break the chat (D-05)
    }
  }
  return currentCtx;
}

/**
 * Execute the outlet chain: post-LLM pre-user, modifies the assistant response.
 * Priority order: DLP(-1) → plugin(0) → plugin(1) → ...
 * try/catch per plugin: crash → log + skip, chat continues (D-05).
 */
export async function runOutlet(ctx: FilterContext): Promise<FilterContext> {
  const plugins = getEnabledFilters()
    .filter(p => p.outlet !== undefined)
    .sort((a, b) => a.priority - b.priority);

  let currentCtx = ctx;
  for (const plugin of plugins) {
    try {
      const result = await plugin.outlet!(currentCtx);
      if (result !== undefined) {
        currentCtx = result;
      }
    } catch (err) {
      logger.warn(`[filters] Plugin "${plugin.name}" outlet crashed, skipping`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return currentCtx;
}
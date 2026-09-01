// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Filter Plugin Registry (D-01, D-06)
 *
 * Map-based registry mirroring the agent skills.ts pattern. registerFilter
 * validates the reserved priority band (D-06): priority < 0 is for system
 * plugins only — only the DLP plugin (name === 'dlp') may register at
 * priority < 0. Any other plugin attempting priority < 0 throws at
 * registration time (fail-fast, never reaches chat time).
 *
 * Phase 100-01 — filter-plugin-system-last-feature.
 */
import type { FilterPlugin } from "./types";
import { logger } from "../utils/logger";

const filterRegistry = new Map<string, FilterPlugin>();

/**
 * Register a filter plugin. Validates the reserved priority band (D-06):
 * throws if a non-DLP plugin attempts priority < 0. Overwrites duplicates
 * with a warn log.
 */
export function registerFilter(plugin: FilterPlugin): void {
  if (plugin.priority < 0 && plugin.name !== "dlp") {
    throw new Error(
      `Reserved priority band: priority < 0 is for system plugins only (plugin "${plugin.name}" tried priority ${plugin.priority})`,
    );
  }
  if (filterRegistry.has(plugin.name)) {
    logger.warn(`[filters] Plugin "${plugin.name}" already registered, overwriting`);
  }
  filterRegistry.set(plugin.name, plugin);
  logger.info(`[filters] Registered plugin "${plugin.name}" (priority ${plugin.priority})`);
}

export function getFilter(name: string): FilterPlugin | undefined {
  return filterRegistry.get(name);
}

export function getAllFilters(): FilterPlugin[] {
  return Array.from(filterRegistry.values());
}

/**
 * Returns enabled plugins (enabled !== false). The enabled flag is set at
 * init time from SystemConfig filter_<name>_enabled (default true).
 */
export function getEnabledFilters(): FilterPlugin[] {
  return Array.from(filterRegistry.values()).filter(p => p.enabled !== false);
}

/** Test-only helper — clears the registry. */
export function _clearAllFilters(): void {
  filterRegistry.clear();
}
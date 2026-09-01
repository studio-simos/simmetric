// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Filter Plugin Discovery at Startup (D-01)
 *
 * Scans the filters/plugins/ directory at server startup, dynamic imports
 * each .ts/.js file, validates the default export has a string `name` and
 * number `priority`, registers it via registerFilter (which enforces the
 * reserved priority band — D-06), and checks SystemConfig
 * filter_<name>_enabled to set the enabled flag (default true).
 *
 * Mirrors the providerRegistry.ts backup-provider discovery pattern.
 *
 * Phase 100-01 — filter-plugin-system-last-feature.
 */
import fs from "fs";
import path from "path";
import { registerFilter, getAllFilters } from "./filterRegistry";
import { getSetting } from "../services/systemConfigService";
import { logger } from "../utils/logger";
import type { FilterPlugin } from "./types";

export async function initFilters(): Promise<void> {
  const pluginsDir = path.join(__dirname, "plugins");

  if (!fs.existsSync(pluginsDir)) {
    logger.info("[filters] No plugins directory found, skipping filter initialization");
    return;
  }

  const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"));

  for (const file of files) {
    try {
      const filePath = path.join(pluginsDir, file);
      const module = (await import(filePath)) as { default?: FilterPlugin };
      const plugin = module?.default;

      if (
        !plugin ||
        typeof plugin !== "object" ||
        typeof plugin.name !== "string" ||
        typeof plugin.priority !== "number"
      ) {
        logger.warn(`[filters] Plugin file "${file}" does not export a valid FilterPlugin, skipping`);
        continue;
      }

      // D-06: registerFilter validates the reserved priority band
      registerFilter(plugin);

      // D-01: check SystemConfig for enable/disable (default true)
      const configKey = `filter_${plugin.name}_enabled`;
      const setting = await getSetting(configKey as Parameters<typeof getSetting>[0]);
      plugin.enabled = setting.value !== "false";
    } catch (err) {
      logger.error(`[filters] Failed to load plugin "${file}"`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(`[filters] Initialized ${getAllFilters().length} filter plugins`);
}
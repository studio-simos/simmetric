// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-02, D-04/D-03) — managed plugin loader skeleton.
 *
 * Boot facade over `createPluginLoader` (mirrors the saasLoader facade
 * shape): iterates `PluginInstall` rows and loads each ENABLED row through
 * the managed resolver chain with `failureMode: "fail-soft"`.
 *
 * Resolver chain (P1 native-wins): step 1 = native `require.resolve` on the
 * plugin's package name — if native resolves, the managed load is SKIPPED
 * BEFORE the loader even runs and the row is left untouched (the registry
 * must never shadow a natively-installed plugin); step 2 =
 * `createRequire(storage/plugins/<slug>/package.json)` + require(main).
 *
 * Fail-soft (D-03): a register throw records status="failed" + lastError
 * and boot CONTINUES — no process.exit is reachable from this path.
 *
 * The `managedResolver` rides the same two-step PluginResolver seam as the
 * native `__pluginResolver` (NEVER collapsed to a single require —
 * pluginLoaderCore.ts:104-107 comment); tests inject via the options
 * object (D-04), no env vars, no monkey-patching.
 */

import type { Express } from "express";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import {
  createPluginLoader,
  buildPluginContext,
  LicenseGateError,
  type PluginLoader,
} from "./pluginLoaderCore";
import { resolvePluginLicense } from "./pluginLicenseService";
import { PLUGINS_STORAGE_DIR } from "./pluginManagerService";

/**
 * Managed rows loaded at boot — `shutdownManagedPlugins()` drains their
 * registries REVERSE load order (D-09).
 */
const managedLoaders: PluginLoader[] = [];

/** package.json path inside a managed plugin's registry dir. */
function pkgJsonPath(slug: string): string {
  return path.join(PLUGINS_STORAGE_DIR, slug, "package.json");
}

/**
 * The two-step managed resolver for one row (D-04): step 1 native
 * `require.resolve(packageName)` (native wins — but loadManagedPlugins
 * already short-circuits the P1 case BEFORE constructing the loader, so
 * step 1 inside the chain is a second guard), step 2 the managed dir.
 * Tests override this per-row via the options object.
 */
function buildManagedResolver(slug: string): {
  resolve(specifier: string): string;
  load(modulePath: string): unknown;
} {
  return {
    resolve(_specifier: string): string {
      const requireFromPlugin = createRequire(pkgJsonPath(slug));
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath(slug), "utf8")) as { main?: string };
      // pkg.main is a FILE path inside the archive, not a package specifier —
      // normalize to "./main" so createRequire resolves it relative to the
      // plugin anchor (a bare specifier would fall through node_modules
      // lookup and MODULE_NOT_FOUND, which loadPlugin's D-06 arm would then
      // misread as "community build no-op").
      const main = pkg.main ?? "index.js";
      const specifier =
        main.startsWith("./") || main.startsWith("../") || path.isAbsolute(main) ? main : `./${main}`;
      return requireFromPlugin.resolve(specifier);
    },
    load(modulePath: string): unknown {
      return require(modulePath);
    },
  };
}

/**
 * Load every enabled managed row (boot step — inserted AFTER
 * loadSaaSPlugin and BEFORE mountCatchAlls when index.ts wires it in
 * 202-03; bootOrder pins land with that wiring). DISABLED rows skip with a
 * log; native-resolved slugs skip the managed load entirely (row ignored
 * for loading, P1).
 */
export async function loadManagedPlugins(app: Express): Promise<void> {
  let rows: Array<{
    id: string;
    slug: string;
    packageName: string;
    apiVersion: number;
    enabled: boolean;
    licenseMode: string;
  }>;
  try {
    rows = (await prisma.pluginInstall.findMany()) as Awaited<
      ReturnType<typeof prisma.pluginInstall.findMany>
    >;
  } catch (err: unknown) {
    // No table (pre-migration DB) → managed loading is a no-op; never block boot.
    logger.warn("[managed] pluginInstall unavailable — skipping managed loads", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const row of rows) {
    if (!row.enabled) {
      logger.info(`[managed:${row.slug}] disabled — skipping`, {});
      continue;
    }

    // P1 native-wins: a native install of the same package shadows the
    // managed row — the row stays untouched (no loaded/failed writes).
    try {
      require.resolve(row.packageName);
      logger.info(
        `[managed:${row.slug}] natively resolvable ("${row.packageName}") — native wins, managed load skipped (P1)`,
        {},
      );
      continue;
    } catch {
      // Not native — proceed with the managed chain.
    }

    // D-04: the managed chain rides the same two-step seam shape. The row
    // name is the LOADER's log prefix; the resolver consults the plugin's
    // own module graph via createRequire (storage/plugins/<slug>).
    //
    // Phase 202 (PLGM-03, D4/D6): the license gate is passed ONLY for
    // licenseMode=platform rows — none/self rows NEVER consult
    // resolvePluginLicense (P3 is a behavioral pin, not a comment). Inside
    // the loader the gate fires AFTER probe/apiVersion acceptance and
    // BEFORE register; a refusal throws LicenseGateError which this catch
    // turns into "row stays installed" (never loaded, never failed, D4) —
    // the reason enum is logged, never the license material (P4).
    const licenseGate =
      row.licenseMode === "platform"
        ? async () => await resolvePluginLicense(row.packageName)
        : undefined;

    const loader = createPluginLoader({
      name: `managed:${row.slug}`,
      specifier: row.packageName,
      acceptedApiVersions: [1, 2],
      label: `plugin ${row.packageName}`,
      buildContext: (pluginApp, registries) => buildPluginContext(pluginApp, registries),
      managedResolver: buildManagedResolver(row.slug),
      failureMode: "fail-soft",
      licenseGate,
    });

    try {
      await loader.loadPlugin(app);
      await prisma.pluginInstall.update({
        where: { id: row.id },
        data: { status: "loaded", lastError: null },
      });
      logger.info(`[managed:${row.slug}] loaded`, {});
    } catch (err: unknown) {
      // D4 (PLGM-03): a license-gate refusal is NOT a failure — the row
      // stays status="installed" (never loaded, never failed). Log the
      // reason enum only (P4/T-202-28: observable, never silent) and move on.
      if (err instanceof LicenseGateError) {
        logger.warn(`[managed:${row.slug}] not licensed — row stays installed (D4)`, {
          reason: err.reason,
        });
        continue;
      }
      // D-03 fail-soft: record + continue — NEVER process.exit on this path.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await prisma.pluginInstall.update({
          where: { id: row.id },
          data: { status: "failed", lastError: message },
        });
      } catch (updateErr: unknown) {
        logger.warn(`[managed:${row.slug}] failed to record failure`, {
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
      logger.error(`[managed:${row.slug}] load failed — boot continues (fail-soft, D-03)`, {
        error: message,
      });
    }
    managedLoaders.push(loader);
  }
}

/**
 * Graceful-shutdown stub — per-loader teardown drains here in REVERSE load
 * order (managed → SaaS → enterprise is wired in 202-02's
 * shutdownSequence extraction; that plan owns managedLoader.ts wiring).
 */
export async function shutdownManagedPlugins(): Promise<void> {
  for (const loader of managedLoaders.reverse()) {
    try {
      await loader.shutdown();
    } catch (err: unknown) {
      logger.warn("[managed] loader shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  managedLoaders.length = 0;
}
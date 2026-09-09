// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 186 (SAAS-05) — SaaS plugin loader + shutdown seam.
 *
 * Optionally loads the `@simmetric-chat/saas` plugin package at boot and
 * hands it a `SaaSPluginContext` (the shared PluginContext surface PLUS the
 * 5 v2 members — D-01/D-02). Community builds (no SaaS package installed)
 * log an info-level no-op and continue (SC-4).
 *
 * Decisions locked in 186-CONTEXT.md (semantics come VERBATIM from the
 * shared core — D-08/D-09):
 *  - D-08: package name `@simmetric-chat/saas`, resolved via the SAME
 *    `__pluginResolver` seam as enterprise (require.resolve from the
 *    server root; delivery = tarball extracted into node_modules, the
 *    loader only uses require.resolve).
 *  - D-09: fail-loud semantics byte-copied from the enterprise loader:
 *    MODULE_NOT_FOUND = community no-op (log info, no SaaS routes);
 *    broken install (load/registration throw) = `process.exit(1)` —
 *    NEVER silent degradation of a paying plugin. Same behavior in dev.
 *  - D-03: per-loader apiVersion acceptance — the SaaS loader requires
 *    `[2]` (the SaaS contract exists only in v2; the downgrade guard cuts
 *    BOTH ways — an apiVersion-1 plugin handed here is a fail-loud exit,
 *    T-186-01b).
 *  - D-10: boot order `initLicense → loadEnterprisePlugin →
 *    loadSaaSPlugin → mountCatchAlls` + teardown REVERSE (SaaS shutdown
 *    BEFORE enterprise), both before `prisma.$disconnect()` — pinned by
 *    `__tests__/bootOrder.test.ts`.
 */
import type { Express } from "express";
import { createPluginLoader, buildSaaSPluginContext, __pluginResolver } from "./pluginLoaderCore";

// Re-export the shared test-injection seam — the saasLoader.test.ts
// save/restore pattern overrides THIS export (the same singleton object the
// core owns; mirrored from the enterpriseLoader facade, Plan 01).
export { __pluginResolver };

/**
 * Per-loader loader instance (Phase 186 — RESEARCH Pattern 1). Differs from
 * the enterprise loader ONLY in the parameterized fields: name ("saas"),
 * specifier (D-08), acceptedApiVersions ([2] — D-03, hardcoded, NOT the
 * API_VERSION const … which happens to be 2, but the hardcoded list keeps
 * Pitfall 1 structurally impossible), and the ctx build (the shared factory
 * + the 5 v2 members — D-02). Own registry bundle → reverse teardown
 * assertable (D-10, Pitfall 2).
 */
const loader = createPluginLoader({
  name: "saas",
  specifier: "@simmetric-chat/saas",
  acceptedApiVersions: [2],
  label: "SaaS",
  // Forward the OWNING loader's registries into the shared factory — the
  // ctx's registerScheduler/onShutdown methods close over THIS loader's
  // per-loader bundle (Pitfall 2: a default fresh bundle would make
  // shutdownSaaSPlugin() drain an empty registry, unassertable reverse
  // teardown).
  buildContext: (app, registries) => buildSaaSPluginContext(app, registries),
});

/**
 * Optionally load the SaaS plugin package and register it against the
 * server's SaaSPluginContext. Async because `plugin.register(ctx)` may
 * return a Promise (Parte II billing init).
 *
 * Boot order (D-10): MUST be called AFTER `loadEnterprisePlugin(app)` and
 * BEFORE `mountCatchAlls(app)` (plugin routes registered before the
 * catch-alls — T-186-06). Enforced by `__tests__/bootOrder.test.ts`.
 */
export async function loadSaaSPlugin(app: Express): Promise<void> {
  return loader.loadPlugin(app);
}

/**
 * Graceful shutdown — stop SaaS plugin schedulers and invoke onShutdown
 * callbacks. MUST be called BEFORE `shutdownEnterprisePlugin()` (D-10
 * reverse load order) and before `prisma.$disconnect()`. Enforced by
 * `__tests__/bootOrder.test.ts`. Per-teardown 5s cap semantics come from
 * the shared core teardown (Phase 146 D-03 shape).
 */
export async function shutdownSaaSPlugin(): Promise<void> {
  return loader.shutdown();
}
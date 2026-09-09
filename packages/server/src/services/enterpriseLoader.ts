// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 140 (EPA-01) — Enterprise plugin loader + shutdown seam.
 *
 * Optionally loads the `@simmetric-chat/enterprise` plugin package at boot
 * and hands it a `PluginContext` (D-01/D-02). Community builds (no
 * enterprise package installed) log an info-level no-op and continue.
 *
 * Decisions locked in 140-CONTEXT.md:
 *  - D-03: apiVersion runtime check — mismatch → process.exit(1)
 *  - D-05: two-step require.resolve → require (never collapse —
 *          collapsing is fail-open; a broken install must not be mistaken
 *          for "not installed")
 *  - D-06: community no-op logs at info level with "community" + "no-op"
 *  - D-07: register() throws → logger.error + process.exit(1) (fail-loud,
 *          NOT fail-open — a broken enterprise install cannot silently
 *          degrade to community and hide the outage from a paying customer)
 *  - D-08: boot order — loadEnterprisePlugin runs AFTER prisma.$connect +
 *          initLicense and BEFORE the scheduler block (enforced by
 *          bootOrder.test.ts)
 *
 * Phase 186 (SAAS-05) — this module is now a THIN FACADE over
 * `pluginLoaderCore.ts` (D-02): the resolver seam, the ctx factory
 * (buildPluginContext), the fail-loud arms, and the teardown bookkeeping
 * all live in the core, shared with the SaaS loader (zero duplication,
 * SC-2). Per-loader apiVersion acceptance (D-03): `acceptedApiVersions`
 * is the HARDCODED [1] here — NOT the shared API_VERSION const (which
 * is now 2; Pitfall 1: a [API_VERSION] here would exit(1) every real
 * enterprise install after the contract bump).
 */

import type { Express } from "express";
import { createPluginLoader, buildPluginContext, __pluginResolver } from "./pluginLoaderCore";

export { __pluginResolver };

/**
 * Per-loader loader instance (Phase 186 — RESEARCH Pattern 1). The
 * enterprise loader differs from the SaaS loader ONLY in the
 * parameterized fields: name, specifier, acceptedApiVersions ([1] —
 * hardcoded, NOT the API_VERSION const, D-03/Pitfall 1), and the ctx
 * build (the shared v1-surface factory — D-02).
 */
const loader = createPluginLoader({
  name: "enterprise",
  specifier: "@simmetric-chat/enterprise",
  acceptedApiVersions: [1],
  // Forward the OWNING loader's registries into the shared factory — the
  // ctx's registerScheduler/onShutdown methods must close over the
  // loader's per-loader bundle (Phase 186 Pitfall 2: a default fresh
  // bundle here would make shutdownEnterprisePlugin() drain an empty
  // registry, unassertable reverse teardown).
  buildContext: (app, registries) => buildPluginContext(app, registries),
});

/**
 * Optionally load the enterprise plugin package and register it against
 * the server's PluginContext. Async because `plugin.register(ctx)` may
 * return a Promise (future SSO init / backup bootstrap).
 *
 * Boot order (D-08): MUST be called AFTER `prisma.$connect()` and
 * `initLicense()`, and BEFORE the `NODE_ENV === "production"` scheduler
 * block. Enforced by `__tests__/bootOrder.test.ts`.
 */
export async function loadEnterprisePlugin(app: Express): Promise<void> {
  return loader.loadPlugin(app);
}

/**
 * Graceful shutdown — stop plugin schedulers and invoke onShutdown
 * callbacks. MUST be called BEFORE `prisma.$disconnect()` so plugin
 * teardown can still hit the DB (RESEARCH Finding 2). Enforced by
 * `__tests__/bootOrder.test.ts`.
 *
 * Phase 146 (D-03 — SC-2): each `scheduler.stop()` and each `onShutdown`
 * callback is wrapped in a 5s-per-teardown `Promise.race([fn, timeout])`
 * so a single hanging teardown cannot block the rest of the shutdown
 * sequence (per-teardown cap semantics live in the core teardown).
 */
export async function shutdownEnterprisePlugin(): Promise<void> {
  return loader.shutdown();
}
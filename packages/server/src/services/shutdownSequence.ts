// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 202 (PLGM-04, D-06) — the ONE graceful-shutdown path.
 *
 * `gracefulShutdown` extracted VERBATIM from index.ts:1154-1197 (a move,
 * not a rewrite — every comment and decision citation preserved per D-06).
 * The SIGTERM/SIGINT handlers (index.ts) and the POST /api/plugins/restart
 * route (202-03/202-04) all call THIS function — a second, restart-specific
 * teardown variant is an anti-pattern (T-202-10) and is never introduced.
 *
 * Phase 202 (D-09) teardown order: managed → SaaS → enterprise →
 * prisma.$disconnect. `shutdownManagedPlugins()` runs BEFORE
 * `shutdownSaaSPlugin()` so per-loader registries drain (5s-per-teardown
 * caps live in pluginLoaderCore) while the DB is still connected — pinned
 * by bootOrder.test.ts.
 */

import prisma from "../utils/prisma";
import { logger } from "../utils/logger";
import { stopConnectorPollScheduler } from "./connectors/connectorPoller";
import { closeDiscordGateway } from "./connectors/discordGateway";
import { shutdownMCPConnections } from "../agent/mcpClient";
import { stopJobQueue } from "./jobQueue";
import { shutdownManagedPlugins } from "./managedLoader";
import { shutdownSaaSPlugin } from "./saasLoader";
import { shutdownEnterprisePlugin } from "./enterpriseLoader";

// Graceful shutdown — stop backup jobs before disconnecting.
// WR-02: race the shutdown sequence against a 5s hard timeout so a hanging
// `client.close()` on an unresponsive external MCP server cannot keep the
// process alive past the container runtime's grace period. On timeout we
// force-exit rather than waiting indefinitely for the SDK to settle.
export const gracefulShutdown = async (signal: string): Promise<void> => {
  logger.info(`[server] ${signal} received — shutting down gracefully`);
  const shutdownSequence = (async () => {
    // Phase 198 (198-03, D-15): stop the connector poll scheduler — the
    // clearInterval handle prevents a dangling 25s long-poll loop during
    // teardown.
    stopConnectorPollScheduler();
    // Phase 199 (199-03, D-05): close every Discord Gateway client FIRST
    // in the teardown — the operator close(1000) never reconnects (OQ-3),
    // and the sockets are dead before prisma.$disconnect() below.
    closeDiscordGateway();
    // Phase 146 (EPA-06): the backup scheduler stop moved to the enterprise
    // plugin — invoked via shutdownEnterprisePlugin()'s schedulers.stop().
    // Phase 165 (Q-02/Q-03): all 7 per-scheduler shutdown calls (mcpReaper
    // + synthesisReaper + vectorCleanup + mcpHealthCheck + wikiConsistency
    // + uploadDraftReaper + chatMessageReaper) were removed — pg-boss
    // stopJobQueue (called below) drains all workers across the 7 cron
    // queues.
    await shutdownMCPConnections(); // D-08: close all activeConnections delete-first
    // Phase 164 (SCALE-04, Q-04, D-04): drain pg-boss in-flight jobs (4.5s
    // cap) AFTER the scheduler shutdowns and BEFORE
    // shutdownEnterprisePlugin() + prisma.$disconnect() so the queue can
    // drain while the DB is still up. stopJobQueue is null-safe (no-op when
    // the queue never started / already stopped). Phase 165 (Q-02/Q-03)
    // removed all 7 per-scheduler shutdowns (mcpReaper + 4 interval
    // schedulers + 2 daily reapers) — pg-boss stopJobQueue drains all their
    // workers. Boot-order invariant enforced by src/__tests__/bootOrder.test.ts.
    await stopJobQueue();
    // Phase 140 (EPA-01): stop plugin schedulers + invoke onShutdown
    // callbacks BEFORE prisma.$disconnect() so plugin teardown can
    // still hit the DB. Enforced by bootOrder.test.ts.
    // Phase 202 (D-09): managed plugins stop FIRST — REVERSE load order
    // (managed → SaaS → enterprise), each before prisma.$disconnect().
    await shutdownManagedPlugins();
    // Phase 186 (SAAS-05, D-10): REVERSE load order — SaaS stops BEFORE
    // enterprise. Both before prisma.$disconnect().
    await shutdownSaaSPlugin();
    await shutdownEnterprisePlugin();
    await prisma.$disconnect();
  })();
  const timeout = new Promise<void>((resolve) => setTimeout(() => resolve(), 5000));
  await Promise.race([shutdownSequence, timeout]);
  process.exit(0);
};
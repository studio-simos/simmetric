// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import type { Request, Response, NextFunction } from "express";
import { isFeatureEnabled, getLicenseInfo, getFeatureLimit } from "../services/licenseService";
import type { FeatureFlag } from "@simmetric-chat/shared";
import prisma from "../utils/prisma";
import { logger } from "../utils/logger";

/**
 * Phase 186 (SAAS-05, D-06) — the QuotaEnforcer single-slot registry.
 *
 * Module-level `null` by default (community builds — no SaaS plugin), set
 * by the SaaS plugin at boot via `ctx.registerQuotaEnforcer(fn)` which
 * forwards here (pluginLoaderCore.ts buildSaaSPluginContext — the ONE real
 * forward among the 5 v2 hooks, alias-imported as `addQuotaEnforcer` in the
 * core to avoid the Pitfall-3 recursive self-call).
 *
 * Same IoC shape as `setAuditLogDelegate` (eventLogService.ts:18-29) and
 * `setLimitOverride` (licenseService.ts): the consumer (`requireFeatureLimit`
 * below) reads the module-level var at request time. The `null` reset
 * supports Parte II reactive revocation (clearLimitOverrides-style).
 */
type QuotaEnforcerFn = (input: {
  organizationId: string;
  flag: string;
  current: number;
}) => Promise<{ allowed: boolean; current?: number; limit?: number }> | { allowed: boolean; current?: number; limit?: number };

let quotaEnforcer: QuotaEnforcerFn | null = null;

/** D-06 (186): register/clear the quota enforcer (single slot; null resets). */
export function setQuotaEnforcer(fn: QuotaEnforcerFn | null): void {
  quotaEnforcer = fn;
}

/** Middleware that blocks the request if the feature flag is disabled */
export function requireFeature(flag: FeatureFlag) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!isFeatureEnabled(flag)) {
      res.status(402).json({
        error: "This feature requires an Enterprise license",
        feature: flag,
        tier: getLicenseInfo().tier,
      });
      return;
    }
    next();
  };
}

/** Middleware that enforces numeric license limits (e.g. max_workspaces, max_projects, max_widgets) */
export function requireFeatureLimit(
  flag: FeatureFlag,
  model: "workspace" | "project" | "widget" | "synthesisRun" | "synthesis_run" | "backupDestination",
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const limit = getFeatureLimit(flag);
    // Infinity means no limit (Enterprise)
    if (limit === Infinity) {
      next();
      return;
    }

    // Phase 185 (SAAS-04c, D-07): the org comes ONLY from req.organizationId
    // (tenantContext-resolved upstream in the chain — membership-derived,
    // never client input, T-185-14). Unresolvable org → 404 fail-closed
    // BEFORE the try block: org ambiguity must never fail-open (D-07) and
    // must never count globally (T-185-13 global-count leak). The
    // catch { next() } arm below stays ONLY for transient count-query
    // failures.
    const organizationId = req.organizationId;
    if (!organizationId) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Phase 186 (SAAS-05, D-06): `count` is hoisted OUT of the try so the
    // transient catch below covers ONLY the count query. The core 402 arm
    // and the enforcer consult run AFTER the try/catch — an enforcer throw
    // can never fall into the transient-catch fail-open `next()` arm.
    let count: number;
    try {
      switch (model) {
        case "workspace":
          count = await prisma.workspace.count({ where: { organizationId, deletedAt: null } });
          break;
        case "project":
          count = await prisma.project.count({ where: { organizationId, deletedAt: null } });
          break;
        case "synthesisRun":
        case "synthesis_run":
          // NO deletedAt filter — SynthesisRun has no deletedAt column
          // (schema.prisma — Pitfall 4); adding one would be an
          // out-of-scope schema change. Org filter is the only fix.
          count = await prisma.synthesisRun.count({ where: { organizationId } });
          break;
        case "backupDestination":
          count = await prisma.backupDestination.count({ where: { organizationId, deletedAt: null } });
          break;
        default:
          count = await prisma.widget.count({ where: { organizationId, deletedAt: null } });
          break;
      }
    } catch (err: unknown) {
      // If the count query fails, don't block the request (transient DB
      // errors only — org-unresolvable is handled fail-closed above).
      // WR-03 (185-05): the swallowed error is now logged with the flag —
      // a SUSTAINED count failure silently disabling every gate must leave a
      // server-side signal. ACCEPT-AS-DEBT (185-05 deferred dispositions):
      // a fail-closed arm after N consecutive failures (circuit breaker) is
      // deliberately deferred — the D-07 org guard above already covers the
      // ambiguity class; the breaker needs an operational failure-count
      // policy that belongs with Parte II observability.
      logger.warn("[license] count query failed — allowing request", {
        error: err instanceof Error ? err.message : String(err),
        flag,
      });
      next();
      return;
    }

    // Core 402 arm — FIRST and unskippable (Pitfall 4): the enforcer is
    // consulted only when the core count passes, so a plugin enforcer can
    // never widen a core deny (T-186-04).
    if (count >= limit) {
      res.status(402).json({
        error: `${model} limit reached. Your plan allows up to ${limit} ${model}s.`,
        feature: flag,
        limit,
        current: count,
        tier: getLicenseInfo().tier,
      });
      return;
    }

    // Phase 186 (SAAS-05, D-06): core pass → the registered QuotaEnforcer
    // decides (its verdict supplies custom current/limit for the 402 body —
    // keys stay byte-identical to the frozen 185 D-06 shape). No enforcer →
    // byte-identical 185 behavior (SC-4). The arm sits AFTER the try/catch
    // so an enforcer throw can NEVER fall into the transient-catch fail-open
    // `next()` (Pitfall 5): it responds 500 and returns, with org/flag
    // context logged (WR-03 posture).
    if (quotaEnforcer) {
      try {
        const verdict = await quotaEnforcer({ organizationId, flag, current: count });
        if (!verdict.allowed) {
          res.status(402).json({
            error: `${model} limit reached. Your plan allows up to ${verdict.limit ?? limit} ${model}s.`,
            feature: flag,
            limit: verdict.limit ?? limit,
            current: verdict.current ?? count,
            tier: getLicenseInfo().tier,
          });
          return;
        }
      } catch (enforcerErr: unknown) {
        logger.error("[license] quota enforcer failed", {
          error: enforcerErr instanceof Error ? enforcerErr.message : String(enforcerErr),
          organizationId,
          flag,
        });
        res.status(500).json({ error: "Quota check failed" });
        return;
      }
    }
    next();
  };
}
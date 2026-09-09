// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TenantContext — the AsyncLocalStorage (ALS) carrier for per-request tenant
 * isolation (Phase 185, SAAS-04a).
 *
 * D-01: the organizationId in the store is resolved SERVER-SIDE only (live
 * membership, ApiKey.organizationId, or the Widget row) — never from client
 * input. This module is the dumb carrier: it holds and restores context, it
 * never resolves it.
 *
 * Node docs-verified semantics (nodejs.org/api/async_context.html):
 * - `run()` wraps the downstream chain so the store is visible to every async
 *   continuation started within the callback — the only blessed pattern.
 * - `enterWith()` is NEVER used here: it mutates the CURRENT execution's store
 *   and leaks into later handlers on the same sync execution (the module is
 *   request-scoped, not ambient).
 *
 * scopeToOrg (D-03, primary mechanism): where-composer that MERGES the org
 * filter with caller filters — compose, never replace (same discipline as
 * `withSoftDelete`, utils/prisma.ts). It adds ONLY `organizationId`; it does
 * NOT auto-inject `deletedAt: null` because tenant models without the column
 * (SynthesisRun, DlpPattern, WidgetSession) would TS-error at the call site.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The per-request tenant store carried by the ALS instance. */
export interface TenantStore {
  organizationId: string;
  /** D-05 escape-hatch signal — platform surfaces (MCP/collector/admin). */
  bypass: boolean;
}

/** Module-singleton ALS carrier. `name` aids async-hook diagnostics. */
export const tenantStorage = new AsyncLocalStorage<TenantStore>({
  name: "tenantContext",
});

/** Read the current tenant store (undefined outside a tenant run — jobs/boot). */
export function getTenantContext(): TenantStore | undefined {
  return tenantStorage.getStore();
}

/**
 * Wrap the downstream chain in the tenant store.
 *
 * ALWAYS `run()`, NEVER `enterWith()` — enterWith leaks the store into
 * subsequent handlers on the same sync execution (Node docs: "run() should be
 * preferred over enterWith() unless there are strong reasons").
 */
export function runInTenant<T>(store: TenantStore, fn: () => T): T {
  return tenantStorage.run(store, fn);
}

/**
 * D-05 escape hatch: run `fn` with the bypass sentinel set. The Prisma
 * tenantScope extension skips ALL scoping for the duration. Every call site
 * must be citeable in the org-b suite test (admin/platform paths only:
 * MCP SSE admin-only, seed, migration-adjacent scripts, audit sweep).
 */
export function bypassTenantScope<T>(fn: () => T): T {
  return tenantStorage.run({ organizationId: "BYPASS", bypass: true }, fn);
}

/** True only inside a `bypassTenantScope()` window (or a bypass store). */
export function isTenantBypassed(): boolean {
  return tenantStorage.getStore()?.bypass === true;
}

/**
 * D-03 primary mechanism: merge `organizationId` into a caller's where-clause.
 *
 * - Composes with caller filters (the org key is spread LAST — WR-01, 185-05:
 *   a caller `where` carrying an `organizationId` key is a collision, and the
 *   CONTEXT org always WINS so the tenant filter can never be silently
 *   downgraded by client-influenced data; the other caller keys survive).
 * - NEVER auto-injects `deletedAt: null` — models without the column
 *   (SynthesisRun, DlpPattern) would TS-error; the caller adds soft-delete
 *   filters itself (withSoftDelete discipline).
 * - Grep-verifiable per D-03: every tenant-scoped route query declares it.
 */
export function scopeToOrg<T extends object>(
  organizationId: string,
  where?: T,
): T & { organizationId: string } {
  return { ...(where ?? {}), organizationId } as T & { organizationId: string };
}
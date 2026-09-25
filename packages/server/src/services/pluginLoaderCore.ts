// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 186 (SAAS-05, D-02) — shared plugin loader core.
 *
 * The SINGLE loader machinery (resolver seam + ctx factory + fail-loud
 * arms + bookkeeping) extracted VERBATIM from `enterpriseLoader.ts`
 * (Phase 140). Both the enterprise loader and the Phase-186 SaaS loader
 * are thin facades over `createPluginLoader` — zero duplication of the
 * resolve → require → register sequence (SC-2).
 *
 * Decision citations carried from the extraction source
 * (140-CONTEXT.md / 186-CONTEXT.md):
 *  - D-05 (140): two-step require.resolve → require (never collapse —
 *    collapsing is fail-open; a broken install must not be mistaken
 *    for "not installed")
 *  - D-06 (140): community no-op logs at info level with "community" + "no-op"
 *  - D-07 (140): register() throws → logger.error + process.exit(1)
 *    (fail-loud, NOT fail-open — a broken install cannot silently degrade
 *    to community and hide the outage from a paying customer)
 *  - D-02 (186): the ctx factory (buildPluginContext) is SHARED — both
 *    loaders hand their plugin the SAME ctx surface.
 *  - D-03 (186): apiVersion acceptance is PER-LOADER (`acceptedApiVersions`)
 *    — enterpriseLoader accepts [1], saasLoader requires [2]. The shared
 *    `API_VERSION` const (now 2) is the SAAS gate only; a loader that
 *    compared against the const post-bump would exit(1) every real
 *    enterprise install (Pitfall 1).
 *  - Per-loader registries (186, Pattern 4 / Pitfall 2): the schedulers
 *    Map + shutdownCallbacks array are created INSIDE createPluginLoader
 *    so each loader's teardown drains independently (reverse teardown
 *    SaaS-before-enterprise per D-10).
 */

import type { Express } from "express";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { authMiddleware } from "../middleware/auth";
import { tenantContextMiddleware } from "../middleware/tenantContext";
import { getLicenseInfo } from "./licenseService";
import {
  type PluginContext,
  type PluginScheduler,
  type MinimalPrismaClient,
  type AuditLog,
  type AuditLogEvent,
  type ConfigKeyValidator,
} from "@simmetric-chat/shared";
import { setAuditLogDelegate } from "./eventLogService";
// Phase 145 (Pitfall 1): alias import to avoid the name collision between
// the `ctx.registerConfigKeyValidator` method (defined on the ctx object
// literal below) and the community `registerConfigKeyValidator` export.
// The alias mirrors the Phase 144 `setAuditLogDelegate` → `registerAuditLogWriter`
// pattern. Without the alias, `registerConfigKeyValidator(fn)` inside the
// ctx method body would be a recursive self-call (stack overflow at boot).
import { registerConfigKeyValidator as addConfigKeyValidator } from "./systemConfigService";
// Phase 147 (Pitfall 1 — same alias pattern as Phase 145): alias import to
// avoid the name collision between the `ctx.overrideFeatureLimit` method
// (defined on the ctx object literal below) and the community
// `setLimitOverride` export. The alias `addLimitOverride` mirrors the
// Phase 145 `addConfigKeyValidator` convention. Without the alias, a future
// rename of the ctx method to `setLimitOverride` would produce a recursive
// self-call (stack overflow at boot).
import { setLimitOverride as addLimitOverride } from "./licenseService";
// Phase 186 (SAAS-05, D-06 — Pitfall 3 alias convention): the ONE real v2
// hook forward. `ctx.registerQuotaEnforcer(fn)` (defined on the ctx object
// literal in buildSaaSPluginContext below) must NOT call an import of the
// same name — a body calling `setQuotaEnforcer` via an import named
// `setQuotaEnforcer` would be a recursive self-call (stack overflow at
// boot, Phase 145 Pitfall 1 recurrence). Alias-imported as
// `addQuotaEnforcer`, mirroring `addConfigKeyValidator` / `addLimitOverride`.
import { setQuotaEnforcer as addQuotaEnforcer } from "../middleware/license";
import type {
  SaaSPluginContext,
  QuotaEnforcer,
  BillingProvider,
  PlanResolver,
  TenantProvisioner,
} from "@simmetric-chat/shared";

/**
 * Per-loader registry bundle (Phase 186, Pattern 4 / Pitfall 2). One
 * bundle per created loader — `createPluginLoader` owns it, the ctx
 * methods close over it, and `shutdown()` drains ONLY this bundle so
 * `shutdownSaaSPlugin()` / `shutdownEnterprisePlugin()` are independently
 * sequenceable (D-10 reverse teardown).
 */
export interface PluginRegistries {
  /** Registered schedulers — stopped during graceful shutdown. */
  schedulers: Map<string, PluginScheduler>;
  /** Registered onShutdown callbacks — invoked during graceful shutdown. */
  shutdownCallbacks: Array<() => void | Promise<void>>;
}

/**
 * Resolve + load seam (D-05 two-step). Production uses the real
 * `require.resolve` → `require(resolvedPath)` pair. Tests override these
 * to simulate "not installed" (resolve throws MODULE_NOT_FOUND) and
 * "broken install" (load throws) without needing the real package on disk.
 *
 * The two-step is NEVER collapsed into a single `require(name)` try/catch:
 * that would conflate "not installed" with "broken install" and silently
 * degrade a paying customer's broken enterprise install to community
 * (fail-open — exactly what D-07 forbids).
 */
interface PluginResolver {
  resolve(specifier: string): string;
  load(modulePath: string): unknown;
}

/** @internal — exported for test injection only. */
export const __pluginResolver: PluginResolver = {
  resolve(specifier: string): string {
    // Branch-free since Phase 180 (PUB-02): the Phase-146 test-mock env-var
    // redirect was removed from production code. Subprocess tests that
    // need a mock plugin inject via the `tsx -r` bootstrap fixture
    // (__tests__/fixtures/enterpriseMockBootstrap.ts) which overrides this
    // resolver in the child before boot — no production env-var read
    // remains.
    return require.resolve(specifier);
  },
  load(modulePath: string): unknown {
    return require(modulePath);
  },
};

/**
 * Per-loader loader options (Phase 186 — RESEARCH Pattern 1). The two
 * loaders differ ONLY in these fields: `name` (log prefix), `specifier`
 * (hardcoded module id — never operator/config input, T-186-02),
 * `acceptedApiVersions` (per-loader acceptance, D-03), and `buildContext`
 * (the shared factory, + the v2 hooks for SaaS).
 */
export interface PluginLoaderOptions {
  /** Loader name — log prefix (e.g. "enterprise" | "saas"). */
  name: string;
  /** Hardcoded plugin package specifier (never operator/config input). */
  specifier: string;
  /**
   * apiVersion values this loader accepts (D-03 per-loader check).
   * Hardcoded per loader — NEVER the shared `API_VERSION` const
   * (Pitfall 1: after the contract bump to 2, a `[API_VERSION]` here
   * would exit(1) every real enterprise install declaring apiVersion 1).
   */
  acceptedApiVersions: number[];
  /**
   * Optional display label for the package-name-bearing log strings
   * (defaults to `name`). The enterprise strings say "no enterprise
   * package found" / "Enterprise package found but failed to load";
   * the SaaS loader passes `label: "SaaS"` so its strings read
   * "no SaaS package found" / "SaaS package found but failed to load".
   */
  label?: string;
  /** Build the PluginContext handed to `plugin.register(ctx)`. */
  buildContext: (app: Express, registries: PluginRegistries) => PluginContext;
  /**
   * Phase 202 (D-04): optional managed-registry fallback resolver —
   * mirrors the two-step PluginResolver shape (resolve(specifier) →
   * load(modulePath)). ABSENT (native enterprise/SaaS loaders) ⇒
   * byte-identical Phase-186 behavior (P2: never downgraded to fail-soft).
   */
  managedResolver?: PluginResolver;
  /**
   * Phase 202 (D-03 fail-soft): "fail-loud" (default) keeps every
   * process.exit(1) arm byte-identically (native callers that omit this
   * option are unaffected); "fail-soft" (managed rows) records the failure
   * + continues boot — the row carries the lastError, never the process.
   */
  failureMode?: "fail-loud" | "fail-soft";
  /**
   * Phase 202 (PLGM-03, D4/D6): per-loader license gate — invoked AFTER
   * probe/apiVersion acceptance and BEFORE register. The gate is CALLER-OWNED
   * (P3): the managed loader passes it ONLY for licenseMode=platform rows;
   * none/self rows never get a gate, so resolvePluginLicense is never
   * consulted for them. A refusal throws LicenseGateError so the caller
   * distinguishes "not licensed" (row stays INSTALLED — never loaded, never
   * failed, D4) from a hard load failure. Native loaders never pass a gate →
   * byte-identical behavior (P2).
   */
  licenseGate?: () => Promise<{ ok: boolean; reason: string }>;
}

/**
 * Phase 202 (PLGM-03, D4): thrown by the loadPlugin license-gate hook when
 * the caller-owned gate refuses the row. NEVER reaches the fail-loud/fail-soft
 * exit/record arms — the managed loader catches this class FIRST and keeps
 * the row installed (a not-licensed plugin is not a failure, D4/D6).
 */
export class LicenseGateError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`license gate refused (${reason})`);
    this.name = "LicenseGateError";
    this.reason = reason;
  }
}

/** A loader created by `createPluginLoader` — load at boot, shutdown reverse. */
export interface PluginLoader {
  loadPlugin(app: Express): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Phase 186 (D-02) — the SHARED ctx factory. Both loaders call this SAME
 * factory, so the ctx surface is identical for enterprise and SaaS
 * (CONTEXT.md specifics: "due plugin, una superficie"). Extracted VERBATIM
 * from `enterpriseLoader.ts:167-284` — every comment carrying a decision
 * ID is preserved byte-for-byte.
 *
 * `registries` defaults to a fresh bundle; `createPluginLoader` always
 * passes its own so the ctx's registerScheduler/onShutdown methods close
 * over the OWNING loader's registries (per-loader teardown, D-10).
 */
export function buildPluginContext(
  app: Express,
  registries: PluginRegistries = { schedulers: new Map(), shutdownCallbacks: [] },
): PluginContext {
  return {
    app,
    // PrismaClient is structurally compatible but lacks the loose string
    // index signature MinimalPrismaClient declares (it has typed model
    // accessors instead). Cast through unknown to satisfy the contract —
    // the enterprise plugin accesses models via the index signature.
    prisma: prisma as unknown as MinimalPrismaClient,
    logger,
    env: getEnv() as unknown as Record<string, unknown>,
    licenseInfo: getLicenseInfo(),
    mountProtected(pathOrRouter: string | unknown, routerArg?: unknown): void {
      // Phase 143 (Finding 1) overload: mountProtected(router) → /api/enterprise
      // (default, backward-compatible with Phase 142 health route);
      // mountProtected("/api/sso", router) → /api/sso (explicit path).
      // D-07: apply community authMiddleware before the plugin's router. The
      // core owns auth (it has authMiddleware + JWT_SECRET); the plugin owns
      // the route handler. Hitting any enterprise route without a valid
      // Authorization header returns 401 (SC-4).
      //
      // CR-05 (185-05, T-185-21): the TENANT slot sits BETWEEN auth and the
      // plugin router (authMiddleware → tenantContextMiddleware → router,
      // D-09). Enterprise routers cannot import community middleware — this
      // loader is the ONLY seam — so without the slot here, req.organizationId
      // stayed undefined on every enterprise surface: requireFeatureLimit's
      // D-07 guard 404ed every request (backup creation hard-broken for
      // paying customers) and tenant-model reads ran unscoped. The tenant
      // middleware resolves the org from the JWT principal's live membership
      // (D-01) and opens the ALS run, so enterprise requireFeatureLimit
      // counting and scoped reads work identically to community routes.
      const path = typeof pathOrRouter === "string" ? pathOrRouter : "/api/enterprise";
      const router = typeof pathOrRouter === "string"
        ? routerArg as unknown as import("express").Router
        : pathOrRouter as unknown as import("express").Router;
      app.use(path, authMiddleware, tenantContextMiddleware, router);
    },
    mountPublic(pathOrRouter: string | unknown, routerArg?: unknown): void {
      // Phase 143 (Finding 1) overload: mountPublic(router) → /api/enterprise
      // (default — standardized; the Phase 142 hardcoded `/api/sso` was the
      // Finding 1 bug); mountPublic("/api/auth", router) → /api/auth (explicit
      // path for SAML/OIDC callbacks, SCIM with own Bearer auth).
      // mountPublic: NO authMiddleware (unauthenticated — SAML/OIDC callbacks
      // are IdP-initiated; SCIM applies its own scimAuth Bearer token).
      //
      // Tenant-slot posture (CR-05, 185-05): NO tenant slot — DOCUMENTED
      // auth-tier exception (D-02 style). IdP-initiated SAML/OIDC callbacks
      // have NO principal yet (the callback itself CREATES the session), and
      // SCIM applies its own Bearer auth — there is no principal to resolve
      // an org from, and a tenant slot here would fail-closed 404 every
      // IdP round-trip. Enterprise surfaces mounted through mountPublic are
      // auth-tier surfaces, not tenant-tier surfaces.
      const path = typeof pathOrRouter === "string" ? pathOrRouter : "/api/enterprise";
      const router = typeof pathOrRouter === "string"
        ? routerArg as unknown as import("express").Router
        : pathOrRouter as unknown as import("express").Router;
      app.use(path, router);
    },
    // Phase 143 capabilities: core-owned auth/crypto delegated to the plugin.
    // The enterprise package can only import @simmetric-chat/shared; it
    // cannot import the community authService/encryptionService. Use require()
    // to avoid circular-import risk (both are community-internal modules the
    // loader already imports transitively). Cites D-02 + RESEARCH Open Q 3.
    generateToken(userId: string): string {
      const { generateToken } = require("./authService") as { generateToken: (userId: string) => string };
      return generateToken(userId);
    },
    decrypt(ciphertext: string): string {
      const { decrypt } = require("./encryptionService") as { decrypt: (ciphertext: string) => string };
      return decrypt(ciphertext);
    },
    encrypt(plaintext: string): string {
      const { encrypt } = require("./encryptionService") as { encrypt: (plaintext: string) => string };
      return encrypt(plaintext);
    },
    // Phase 193 (LDAP-03 — RESEARCH Pitfall 4 option b): core-owned
    // auth-cache eviction delegated to the plugin. Same lazy-require
    // delegate idiom as generateToken/decrypt above (the enterprise
    // package cannot import community services; the loader owns the
    // seam). Non-blocking: invalidateAuthCache never throws (Redis
    // failures are logged inside authService), so the forward is a
    // plain await.
    async invalidateAuthCache(userId: string): Promise<void> {
      const { invalidateAuthCache } = require("./authService") as {
        invalidateAuthCache: (userId: string) => Promise<void>;
      };
      await invalidateAuthCache(userId);
    },
    // Phase 193 (LDAP-03 — RESEARCH Open Question 1 option b): delegates
    // to createPersonalWorkspace (Phase 189 substrate). The three args
    // are forwarded verbatim; a PersonalWorkspaceConflictError thrown by
    // the service propagates to the enterprise caller as a thrown Error
    // (the enterprise JIT arm catches and maps it to the uniform
    // failure arm).
    provisionPersonalWorkspace(
      userId: string,
      workspaceName: string,
      organizationId: string,
    ): Promise<unknown> {
      const { createPersonalWorkspace } = require("./personalWorkspaceService") as {
        createPersonalWorkspace: (
          userId: string,
          workspaceName: string,
          organizationId: string,
        ) => Promise<unknown>;
      };
      return createPersonalWorkspace(userId, workspaceName, organizationId);
    },
    registerScheduler(name: string, scheduler: PluginScheduler): void {
      registries.schedulers.set(name, scheduler);
      // Start immediately (RESEARCH Finding 2) — the loader runs at boot,
      // after prisma.$connect, so the scheduler can safely hit the DB.
      void Promise.resolve(scheduler.start()).catch((err: unknown) => {
        logger.error(`[enterprise] Scheduler "${name}" failed to start`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onShutdown(fn: () => void | Promise<void>): void {
      registries.shutdownCallbacks.push(fn);
    },
    // D-11 (Phase 144): registerAuditLogWriter — called by enterprise
    // register(ctx) to inject the enterprise audit writer into the community
    // logEvent() shim. Forwards to setAuditLogDelegate(fn) in eventLogService.ts.
    registerAuditLogWriter(fn: (event: AuditLogEvent) => Promise<void>): void {
      setAuditLogDelegate(fn);
    },
    // D-01 (Phase 145): registerConfigKeyValidator — called by enterprise
    // register(ctx) to inject the branding config-key validator into the
    // community updateSettings() loop. Forwards to the community setter
    // (alias import — Pitfall 1). Same IoC shape as registerAuditLogWriter.
    registerConfigKeyValidator(fn: ConfigKeyValidator): void {
      addConfigKeyValidator(fn);
    },
    // D-10 (Phase 144): replace the throwing stub with the real AuditLog
    // interface. The enterprise register(ctx) sets this field with its
    // implementation; the community loader initializes it as a placeholder.
    // The community logEvent() shim does NOT use ctx.auditLog — it delegates
    // via registerAuditLogWriter (D-11).
    auditLog: undefined as unknown as AuditLog,
    // D-01 (Phase 147 — EPA-07): real override resolver. Forwards to the
    // community `setLimitOverride` setter via the alias import
    // (`addLimitOverride` — Phase 145 Pitfall 1 pattern). The module-level
    // `limitOverrides` map lives in `licenseService.ts` (D-03 — beside
    // `getFeatureLimit` for zero-indirection reads); `getFeatureLimit()`
    // consults the map FIRST (D-01). Reactive revocation: `clearLimitOverrides()`
    // runs at the START of `initLicense()` and in `getLicenseInfo()`'s
    // runtime-expiry branch (SC-1). Signature byte-identical to Phase 140
    // D-02 — no shared version bump (D-11).
    overrideFeatureLimit(flag: string, value: number): void {
      addLimitOverride(flag, value);
    },
  };
}

/**
 * Phase 186 (SAAS-05, D-01/D-02/D-06/D-07) — the v2 SaaS ctx wrapper.
 *
 * Spreads the SHARED `buildPluginContext(app, registries)` output (the SaaS
 * plugin receives the FULL enterprise-identical surface — Pitfall 8 parity,
 * "due plugin, una superficie") and adds the 5 v2 members typed as
 * `SaaSPluginContext`:
 *
 *  - `registerQuotaEnforcer` (D-06): the ONE real forward — delegates to
 *    the `setQuotaEnforcer` single-slot registry in middleware/license.ts
 *    (alias-imported as `addQuotaEnforcer` — Pitfall 3). `requireFeatureLimit`
 *    consults the registry AFTER the core 402 arm (core deny wins).
 *  - `registerBillingProvider` / `registerPlanResolver` /
 *    `registerTenantProvisioner` (D-07): registry-style stubs — throw
 *    synchronously "not wired until Parte II". A stub that returns instead
 *    of throwing is a silent no-op (Pitfall 5); no core consumption this
 *    phase.
 *  - `issueTenantLicense` (D-04): rejects "not wired until Parte II" — NO
 *    private-key env read and NO signing code in core; the real RS256
 *    implementation is Parte II plugin infra.
 */
export function buildSaaSPluginContext(
  app: Express,
  registries: PluginRegistries = { schedulers: new Map(), shutdownCallbacks: [] },
): SaaSPluginContext {
  const base = buildPluginContext(app, registries);
  return {
    ...base,
    registerBillingProvider(_provider: BillingProvider): void {
      throw new Error("not wired until Parte II");
    },
    registerQuotaEnforcer(enforcer: QuotaEnforcer): void {
      // D-06: real forward into the middleware/license.ts registry (the
      // consumption point consults it when the core count passes). Alias
      // import — Pitfall 3.
      addQuotaEnforcer(enforcer);
    },
    registerPlanResolver(_resolver: PlanResolver): void {
      throw new Error("not wired until Parte II");
    },
    registerTenantProvisioner(_provisioner: TenantProvisioner): void {
      throw new Error("not wired until Parte II");
    },
    issueTenantLicense(
      _organizationId: string,
      _plan: string,
      _expiresAt: Date,
    ): Promise<string> {
      return Promise.reject(new Error("not wired until Parte II"));
    },
  };
}

/**
 * Optionally load the plugin package named by `options.specifier` and
 * register it against the server's PluginContext. Async because
 * `plugin.register(ctx)` may return a Promise (future SSO init / backup
 * bootstrap). The fail-loud sequence is the VERBATIM `enterpriseLoader.ts`
 * :106-297 machinery with `name` interpolated into every log string
 * (D-09 — the SaaS loader copies the enterprise semantics by construction).
 */
export function createPluginLoader(options: PluginLoaderOptions): PluginLoader {
  // Per-loader registries (Pitfall 2): created per LOADER (closure state),
  // not module-level — each loader's shutdown drains only its own bundle.
  const registries: PluginRegistries = { schedulers: new Map(), shutdownCallbacks: [] };

  const name = options.name;
  const label = options.label ?? options.name;
  const Label = label.charAt(0).toUpperCase() + label.slice(1);

  async function loadPlugin(app: Express): Promise<void> {
    // Phase 202 (D-04/D-03): the managed path swaps the resolver for the
    // managed chain (rides the SAME two-step PluginResolver seam shape —
    // NEVER collapsed; pluginLoaderCore.ts:104-107). Native callers
    // (managedResolver absent) get byte-identical Phase-186 behavior (P2).
    const resolver = options.managedResolver ?? __pluginResolver;
    const failSoft = options.failureMode === "fail-soft";
    let modulePath: string;
    try {
      modulePath = resolver.resolve(options.specifier);
    } catch (resolveErr: unknown) {
      const code = (resolveErr as { code?: string })?.code;
      if (code === "MODULE_NOT_FOUND") {
        // D-06: community build — info level, "community" + "no-op".
        logger.info(
          `[${name}] Community build — no ${label} package found (no-op)`,
          { reason: "MODULE_NOT_FOUND" },
        );
        return;
      }
      // Any other resolve error is fail-loud — never fail-open. Managed rows
      // (fail-soft) record the failure and let boot continue (D-03).
      logger.error(`[${name}] Failed to resolve ${label} package`, {
        error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
        code,
      });
      if (failSoft) {
        throw new Error(`[${name}] resolve failed: ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`, { cause: resolveErr });
      }
      process.exit(1);
      return; // unreachable, keeps TS happy
    }

    let pluginModule: unknown;
    try {
      pluginModule = resolver.load(modulePath);
    } catch (loadErr: unknown) {
      // D-07: broken install (ERR_REQUIRE_ESM, SyntaxError, etc.) — fail-loud.
      // Managed rows (fail-soft) record + continue (D-03).
      logger.error(`[${name}] ${Label} package found but failed to load`, {
        error: loadErr instanceof Error ? loadErr.message : String(loadErr),
      });
      if (failSoft) {
        throw new Error(`[${name}] load failed: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`, { cause: loadErr });
      }
      process.exit(1);
      return;
    }

    // The plugin package exports its plugin as the default export.
    // Support both `module.exports = plugin` and
    // `module.exports = { __esModule: true, default: plugin }`.
    const plugin = (
      pluginModule && typeof pluginModule === "object" && "default" in (pluginModule as Record<string, unknown>)
        ? (pluginModule as { default: { apiVersion?: number; register?: (ctx: PluginContext) => void | Promise<void> } }).default
        : (pluginModule as { apiVersion?: number; register?: (ctx: PluginContext) => void | Promise<void> })
    );

    if (!plugin || typeof plugin.register !== "function") {
      logger.error(`[${name}] ${Label} package did not export a valid plugin (missing register)`, {});
      if (failSoft) {
        throw new Error(`[${name}] missing register`);
      }
      process.exit(1);
      return;
    }

    // D-03 (186): runtime apiVersion check, PER LOADER. Compile-time-only is
    // insufficient — a mismatched package must fail loud at boot. The
    // acceptance list is hardcoded per loader (enterprise [1], SaaS [2]) —
    // NEVER the shared API_VERSION const (Pitfall 1).
    const declaredVersion = plugin.apiVersion;
    if (declaredVersion === undefined || !options.acceptedApiVersions.includes(declaredVersion)) {
      logger.error(`[${name}] API version mismatch`, {
        expected: options.acceptedApiVersions.join("|"),
        got: plugin.apiVersion,
      });
      if (failSoft) {
        throw new Error(`[${name}] apiVersion mismatch (expected ${options.acceptedApiVersions.join("|")}, got ${String(declaredVersion)})`);
      }
      process.exit(1);
      return;
    }

    const ctx: PluginContext = options.buildContext(app, registries);

    // Phase 202 (PLGM-03, D4/D6): the per-loader license gate — AFTER
    // probe/apiVersion acceptance, BEFORE register. Caller-owned (P3): only
    // the managed loader passes it, and only for licenseMode=platform rows.
    // A refusal throws LicenseGateError (NOT the fail-loud/fail-soft arms —
    // the gate sits before the register try/catch and propagates untouched):
    // the managed loader catches it and keeps the row installed (D4), so a
    // not-licensed plugin is never recorded as failed, never loaded, and
    // never registers.
    if (options.licenseGate) {
      const verdict = await options.licenseGate();
      if (!verdict.ok) {
        logger.warn(`[${name}] license gate — skipping register`, {
          reason: verdict.reason,
        });
        throw new LicenseGateError(verdict.reason);
      }
    }

    try {
      await plugin.register(ctx);
      logger.info(`[${name}] Plugin registered successfully`);
    } catch (registerErr: unknown) {
      // D-07: fail-loud. NEVER catch-and-continue to community — that
      // would silently strip a paying customer's enterprise features.
      // Managed rows (fail-soft) record + continue (D-03): the row carries
      // the lastError, the boot continues, the process never exits.
      logger.error(`[${name}] Plugin registration failed`, {
        error: registerErr instanceof Error ? registerErr.message : String(registerErr),
      });
      if (failSoft) {
        throw new Error(`[${name}] register failed: ${registerErr instanceof Error ? registerErr.message : String(registerErr)}`, { cause: registerErr });
      }
      process.exit(1);
    }
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
   * sequence. The existing 5s outer cap in `gracefulShutdown`
   * (`index.ts` — `Promise.race([shutdownSequence, timeout])`) stays as
   * the container-runtime grace-period hard limit; the per-teardown race
   * prevents one bad teardown from consuming the whole budget.
   */
  async function shutdown(): Promise<void> {
    for (const [schedulerName, scheduler] of registries.schedulers) {
      try {
        await Promise.race([
          scheduler.stop(),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch (err: unknown) {
        logger.warn(`[${name}] Scheduler "${schedulerName}" failed to stop cleanly`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    registries.schedulers.clear();

    for (const cb of registries.shutdownCallbacks) {
      try {
        await Promise.race([
          cb(),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch (err: unknown) {
        logger.warn(`[${name}] onShutdown callback failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    registries.shutdownCallbacks.length = 0;
  }

  return { loadPlugin, shutdown };
}
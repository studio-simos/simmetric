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
 */

import type { Express } from "express";
import { logger } from "../utils/logger";
import prisma from "../utils/prisma";
import { getEnv } from "../config/env";
import { authMiddleware } from "../middleware/auth";
import { getLicenseInfo } from "./licenseService";
import {
  API_VERSION,
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

/** Registered schedulers — stopped during graceful shutdown. */
const schedulers = new Map<string, PluginScheduler>();
/** Registered onShutdown callbacks — invoked during graceful shutdown. */
const shutdownCallbacks: Array<() => void | Promise<void>> = [];

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
 * Optionally load the enterprise plugin package and register it against
 * the server's PluginContext. Async because `plugin.register(ctx)` may
 * return a Promise (future SSO init / backup bootstrap).
 *
 * Boot order (D-08): MUST be called AFTER `prisma.$connect()` and
 * `initLicense()`, and BEFORE the `NODE_ENV === "production"` scheduler
 * block. Enforced by `__tests__/bootOrder.test.ts`.
 */
export async function loadEnterprisePlugin(app: Express): Promise<void> {
  let modulePath: string;
  try {
    modulePath = __pluginResolver.resolve("@simmetric-chat/enterprise");
  } catch (resolveErr: unknown) {
    const code = (resolveErr as { code?: string })?.code;
    if (code === "MODULE_NOT_FOUND") {
      // D-06: community build — info level, "community" + "no-op".
      logger.info(
        "[enterprise] Community build — no enterprise package found (no-op)",
        { reason: "MODULE_NOT_FOUND" },
      );
      return;
    }
    // Any other resolve error is fail-loud — never fail-open.
    logger.error("[enterprise] Failed to resolve enterprise package", {
      error: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
      code,
    });
    process.exit(1);
    return; // unreachable, keeps TS happy
  }

  let pluginModule: unknown;
  try {
    pluginModule = __pluginResolver.load(modulePath);
  } catch (loadErr: unknown) {
    // D-07: broken install (ERR_REQUIRE_ESM, SyntaxError, etc.) — fail-loud.
    logger.error("[enterprise] Enterprise package found but failed to load", {
      error: loadErr instanceof Error ? loadErr.message : String(loadErr),
    });
    process.exit(1);
    return;
  }

  // The enterprise package exports its plugin as the default export.
  // Support both `module.exports = plugin` and
  // `module.exports = { __esModule: true, default: plugin }`.
  const plugin = (
    pluginModule && typeof pluginModule === "object" && "default" in (pluginModule as Record<string, unknown>)
      ? (pluginModule as { default: { apiVersion?: number; register?: (ctx: PluginContext) => void | Promise<void> } }).default
      : (pluginModule as { apiVersion?: number; register?: (ctx: PluginContext) => void | Promise<void> })
  );

  if (!plugin || typeof plugin.register !== "function") {
    logger.error("[enterprise] Enterprise package did not export a valid plugin (missing register)", {});
    process.exit(1);
    return;
  }

  // D-03: runtime apiVersion check. Compile-time-only is insufficient —
  // a mismatched enterprise package must fail loud at boot.
  if (plugin.apiVersion !== API_VERSION) {
    logger.error("[enterprise] API version mismatch", {
      expected: API_VERSION,
      got: plugin.apiVersion,
    });
    process.exit(1);
    return;
  }

  const ctx: PluginContext = {
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
      const path = typeof pathOrRouter === "string" ? pathOrRouter : "/api/enterprise";
      const router = typeof pathOrRouter === "string"
        ? routerArg as unknown as import("express").Router
        : pathOrRouter as unknown as import("express").Router;
      app.use(path, authMiddleware, router);
    },
    mountPublic(pathOrRouter: string | unknown, routerArg?: unknown): void {
      // Phase 143 (Finding 1) overload: mountPublic(router) → /api/enterprise
      // (default — standardized; the Phase 142 hardcoded `/api/sso` was the
      // Finding 1 bug); mountPublic("/api/auth", router) → /api/auth (explicit
      // path for SAML/OIDC callbacks, SCIM with own Bearer auth).
      // mountPublic: NO authMiddleware (unauthenticated — SAML/OIDC callbacks
      // are IdP-initiated; SCIM applies its own scimAuth Bearer token).
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
    registerScheduler(name: string, scheduler: PluginScheduler): void {
      schedulers.set(name, scheduler);
      // Start immediately (RESEARCH Finding 2) — the loader runs at boot,
      // after prisma.$connect, so the scheduler can safely hit the DB.
      void Promise.resolve(scheduler.start()).catch((err: unknown) => {
        logger.error(`[enterprise] Scheduler "${name}" failed to start`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onShutdown(fn: () => void | Promise<void>): void {
      shutdownCallbacks.push(fn);
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

  try {
    await plugin.register(ctx);
    logger.info("[enterprise] Plugin registered successfully");
  } catch (registerErr: unknown) {
    // D-07: fail-loud. NEVER catch-and-continue to community — that
    // would silently strip a paying customer's enterprise features.
    logger.error("[enterprise] Plugin registration failed", {
      error: registerErr instanceof Error ? registerErr.message : String(registerErr),
    });
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
export async function shutdownEnterprisePlugin(): Promise<void> {
  for (const [name, scheduler] of schedulers) {
    try {
      await Promise.race([
        scheduler.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err: unknown) {
      logger.warn(`[enterprise] Scheduler "${name}" failed to stop cleanly`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  schedulers.clear();

  for (const cb of shutdownCallbacks) {
    try {
      await Promise.race([
        cb(),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err: unknown) {
      logger.warn("[enterprise] onShutdown callback failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  shutdownCallbacks.length = 0;
}
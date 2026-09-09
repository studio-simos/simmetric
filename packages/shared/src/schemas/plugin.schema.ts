// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Phase 140 (EPA-01) — Enterprise Plugin Architecture contract.
 *
 * Structural TypeScript interfaces describing the plugin seam between the
 * server boot sequence and the optional `@simmetric-chat/enterprise` package.
 *
 * IMPORTANT: This file lives in `@simmetric-chat/shared`, which has a strict
 * zero-runtime-dep rule (only `zod`). It MUST NOT import `express` or
 * `@prisma/client` — both would violate the shared kernel boundary. Instead
 * we declare structural interfaces (`MinimalExpressApp`,
 * `MinimalPrismaClient`) that describe only the surface the plugin contract
 * needs. The enterprise package casts `ctx.app as unknown as Express` at its
 * own boundary (per 140-CONTEXT.md D-01 / 140-RESEARCH Pattern 3).
 *
 * Decisions locked in 140-CONTEXT.md:
 *  - D-01/D-02: PluginContext + EnterprisePlugin shape (EPA-01 surface)
 *  - D-03: apiVersion runtime check (`API_VERSION = 1 as const`)
 *  - D-07: register-throws → process.exit(1) (enforced in the loader, not here)
 *  - D-10/D-11 (Phase 144): auditLog is a typed `AuditLog` contract +
 *    `registerAuditLogWriter(fn)` hook (replaces the Phase 140 throwing stub)
 *  - overrideFeatureLimit is a stub until Phase 147
 *
 * Phase 186 (SAAS-05) — contract v2 (additive bump, D-01):
 *  - API_VERSION 1 → 2 (the SAAS gate; enterprise acceptance stays
 *    loader-side per D-03)
 *  - `SaaSPluginContext extends PluginContext` — additive interface, NOT
 *    optional props scattered into the base (D-01): 4 hook-registration
 *    methods + `issueTenantLicense`. The stub BODIES (throwing) live in
 *    the ctx BUILD (pluginLoaderCore.ts / D-02) — the interface is the
 *    contract only.
 *  - `BillingProvider` / `QuotaEnforcer` / `PlanResolver` /
 *    `TenantProvisioner`: minimal Part I hook interfaces (the
 *    `ConfigKeyValidator` call-signature pattern); Parte II widens
 *    additively.
 *  - `SaaSPlugin`: mirrors EnterprisePlugin with `apiVersion: 2`.
 *  - NO signing surface (D-04): no LICENSE_PRIVATE_KEY, no signing code —
 *    the real tenant-license implementation is Parte II plugin infra.
 */

import type { EntityType, LicenseInfo } from "../types";
import type { ConfigKey } from "./config.schema";

/**
 * Phase 144 (EPA-04 — D-10): the input shape for an audit log write.
 * The community `logEvent()` shim builds this object from its positional
 * args and passes it to the enterprise writer via `registerAuditLogWriter`.
 *
 */
export interface AuditLogEvent {
  entityType: EntityType;
  entityId: string;
  action: string;
  userId: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Phase 144 (EPA-04 — D-10): the audit log contract the enterprise plugin
 * implements. Replaces the Phase 140 `auditLog(event: unknown): Promise<void>`
 * throwing stub. The enterprise `register(ctx)` provides an `AuditLog`
 * implementation that writes to `event_logs` via the `simmetric_audit_writer`
 * role (D-05). The community `logEvent()` shim does NOT call `ctx.auditLog`
 * directly — it delegates via the `registerAuditLogWriter` hook (D-11) so the
 * shim never imports the enterprise package.
 *
 */
export interface AuditLog {
  log(event: AuditLogEvent): Promise<void>;
}

/**
 * Phase 145 (EPA-05 — D-01): a config-key validator injected by the
 * enterprise plugin. The community `updateSettings()` loop calls every
 * registered validator for each config key, passing the resolved
 * `LicenseInfo`. Returns `{ allowed: false, reason }` to reject a key,
 * `{ allowed: true }` to allow it, or `null` to express no opinion (the
 * branding validator returns `null` for non-`BRANDING_*` keys). Same IoC
 * shape as `registerAuditLogWriter` (Phase 144 D-11).
 *
 */
export interface ConfigKeyValidator {
  (key: ConfigKey, licenseInfo: LicenseInfo): { allowed: boolean; reason?: string } | null;
}

/**
 * Plugin API version. Bumped only on breaking contract changes.
 * The loader checks the plugin's `apiVersion` at boot and fails loud
 * (process.exit(1)) on mismatch (D-03).
 *
 * Phase 186 (SAAS-05): per-loader acceptance (D-03). The constant is the
 * SAAS gate — `saasLoader` requires `[2]`; `enterpriseLoader` keeps its
 * HARDCODED `[1]` acceptance (EnterprisePlugin.apiVersion stays the
 * literal 1 — enterprise acceptance is loader-side, not const-side; a
 * loader comparing against this const post-bump would exit(1) every real
 * enterprise install, Pitfall 1).
 */
export const API_VERSION = 2 as const;

/**
 * Structural subset of `@prisma/client`'s `PrismaClient` that the plugin
 * contract needs. Avoids importing `@prisma/client` into the shared kernel
 * (zero-dep rule). The real prisma singleton (from
 * `packages/server/src/utils/prisma.ts`) is structurally assignable to this
 * interface — the index signature covers all generated model accessors.
 */
export interface MinimalPrismaClient {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  // `$executeRaw` / `$queryRaw` are typed loosely — plugins that need raw
  // SQL cast at their own boundary. The loose typing keeps shared free of
  // the Prisma generated client.
  $executeRaw: unknown;
  $queryRaw: unknown;
  /** Generated model accessors (e.g. `prisma.user.findMany`). */
  [model: string]: unknown;
}

/**
 * Structural subset of `express.Express` needed for `mountProtected` /
 * `mountPublic`. The enterprise package casts to the full `Express` type at
 * its boundary (`ctx.app as unknown as Express`).
 */
export interface MinimalExpressApp {
  use(path: string, router: unknown): void;
  use(router: unknown): void;
}

/**
 * Structural subset of the server's winston logger shape (info/warn/error/debug
 * with optional meta object). Mirrors `packages/server/src/utils/logger.ts`.
 */
export interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * A scheduler registered by the plugin. `start` is called immediately on
 * registration (at boot); `stop` is called during graceful shutdown (before
 * `prisma.$disconnect()`).
 */
export interface PluginScheduler {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/**
 * Context handed to `EnterprisePlugin.register(ctx)` at boot. This is the
 * full EPA-01 surface (D-02). The plugin receives direct access to the
 * Express app, the Prisma singleton, the logger, env config, and the
 * resolved license info, plus mount/register callbacks.
 *
 * Stub fields (D-02):
 *  - `overrideFeatureLimit`: throws "not wired until Phase 147"
 *
 */
export interface PluginContext {
  /** Express app — mount routers via `mountProtected`/`mountPublic`. */
  app: MinimalExpressApp;
  /** Prisma singleton (never `new PrismaClient()`). */
  prisma: MinimalPrismaClient;
  /** Server winston logger. */
  logger: MinimalLogger;
  /** Parsed + validated env config (from `getEnv()`). */
  env: Record<string, unknown>;
  /** Resolved license info (Community or Enterprise). */
  licenseInfo: LicenseInfo;
  /**
   * Mount a router at the protected enterprise path prefix. Default:
   * `/api/enterprise` (backward-compatible with the Phase 142 health route).
   * With a path arg: mounts at that exact prefix (e.g. `/api/sso` for admin
   * SSO config routes). Phase 142 D-07 amendment: the loader applies the
   * community `authMiddleware` (Bearer JWT verify + jti revocation) BEFORE
   * the plugin's router — the core owns auth, the plugin owns the route
   * handler. Hitting any enterprise route without a valid `Authorization`
   * header returns 401 (SC-4). The plugin does NOT need to apply its own
   * auth middleware.
   *
   * Phase 143 (Finding 1) amendment: the path-arg overload exists because
   * SSO routes must preserve their original paths (`/api/sso/*`, `/api/auth/*`,
   * `/scim/v2/*`). The Phase 142 hardcoded single prefix would mount SAML at
   * `/api/enterprise/saml/login` — WRONG, breaking every customer's IdP
   * callback URL config. The no-arg overload stays default `/api/enterprise`
   * (backward-compatible with the Phase 142 health route).
   */
  mountProtected(router: unknown): void;
  mountProtected(path: string, router: unknown): void;
  /**
   * Mount a router at the public path prefix. Default: `/api/enterprise`
   * (standardized in Phase 143 — the Phase 142 `mountPublic` hardcoded
   * `/api/sso`, which was the Finding 1 bug). With a path arg: mounts at
   * that exact prefix (e.g. `/api/auth` for SAML/OIDC callback routes,
   * `/scim/v2` for SCIM routes with their own Bearer auth). Used for
   * unauthenticated SSO callback endpoints + SCIM (which applies its own
   * `scimAuth` Bearer token middleware internally).
   */
  mountPublic(router: unknown): void;
  mountPublic(path: string, router: unknown): void;
  /**
   * Issue a JWT for a user (core-owned auth capability delegated to the
   * plugin). Phase 143 amendment: the enterprise package can only import
   * `@simmetric-chat/shared` — it cannot import the community `authService`.
   * The SSO callback routes (SAML/OIDC) need to issue a JWT after a
   * successful IdP callback, so the core-owned `generateToken` is delegated
   * via `ctx`. Cites D-02 (published PluginContext contract) + the
   * cross-package import resolution (RESEARCH Open Question 3).
   */
  generateToken(userId: string): string;
  /**
   * Decrypt an AES-256-GCM ciphertext (core-owned crypto delegated to the
   * plugin). The enterprise SSO routes/services need to decrypt
   * `SsoConfig.clientSecretEncrypted` before sending it to the IdP. The
   * community `encryptionService` stays in the community repo (widely
   * used); the enterprise package accesses it via `ctx.decrypt`.
   */
  decrypt(ciphertext: string): string;
  /**
   * Encrypt a plaintext to AES-256-GCM ciphertext (core-owned crypto
   * delegated to the plugin). The enterprise `saveSsoConfig` encrypts the
   * client secret before storage via `ctx.encrypt` — same crypto as the
   * community (AES-256-GCM, T-113-01-01).
   */
  encrypt(plaintext: string): string;
  /**
   * Register a named scheduler. `start()` is called immediately; `stop()` is
   * called during graceful shutdown.
   */
  registerScheduler(name: string, scheduler: PluginScheduler): void;
  /**
   * Register a teardown callback invoked during graceful shutdown (before
   * `prisma.$disconnect()`).
   */
  onShutdown(fn: () => void | Promise<void>): void;
  /**
   * Phase 144 (EPA-04 — D-11): register the enterprise audit log writer into
   * the community `logEvent()` shim. The enterprise `register(ctx)` calls
   * `ctx.registerAuditLogWriter(writer)` at boot; the loader forwards the
   * call to `setAuditLogDelegate(fn)` in `eventLogService.ts`. The community
   * shim then delegates every `logEvent()` audit write to this function. This
   * is the inversion-of-control seam: the shim holds a module-level delegate
   * set by this hook — it never imports the enterprise package (same pattern
   * as `mountProtected`: core owns the shim/mount point, plugin provides the
   * writer/router).
   */
  registerAuditLogWriter(fn: (event: AuditLogEvent) => Promise<void>): void;
  /**
   * Phase 145 (EPA-05 — D-01): register a config-key validator into the
   * community `updateSettings()` loop. The enterprise `register(ctx)` calls
   * this at boot to inject the branding validator. The loader forwards the
   * call to the community `registerConfigKeyValidator(fn)` setter in
   * `systemConfigService.ts` (module-level `configKeyValidators[]` array).
   * Same IoC pattern as `registerAuditLogWriter` (Phase 144 D-11).
   */
  registerConfigKeyValidator(fn: ConfigKeyValidator): void;
  /**
   * Phase 144 (EPA-04 — D-10): the typed audit log contract. Replaces the
   * Phase 140 throwing stub (`auditLog(event: unknown): Promise<void>`). The
   * enterprise `register(ctx)` sets this field with its `AuditLog`
   * implementation; the community loader initializes it as a placeholder
   * (`undefined as unknown as AuditLog`). Used by enterprise-internal routes
   * (the `eventLogs.ts` reader) — NOT by the community `logEvent()` shim,
   * which delegates via `registerAuditLogWriter` (D-11).
   */
  auditLog: AuditLog;
  /**
   * Phase 147 (EPA-07 — D-01): real resolver — replaces the Phase 140
   * throwing stub. Called by the enterprise plugin at `register(ctx)` boot
   * to raise a numeric limit (e.g. `max_workspaces` to `Infinity`).
   * Forwards to `licenseService.setLimitOverride` via an alias import in
   * `enterpriseLoader.ts` (Phase 145 Pitfall 1 pattern).
   *
   * Reactive revocation: `clearLimitOverrides()` runs at the START of
   * `initLicense()` (D-02 — Pitfall 3) and in `getLicenseInfo()`'s
   * runtime-expiry branch (SC-1), so a Community JWT loaded after an
   * Enterprise one cannot inherit `Infinity` overrides.
   *
   * Signature byte-identical to Phase 140 D-02 — no shared version bump
   * (D-11). Only the implementation changed (from a throwing stub to a
   * real resolver); the `PluginContext` type is unchanged.
   */
  overrideFeatureLimit(flag: string, value: number): void;
}

/**
 * The contract an enterprise plugin package (`@simmetric-chat/enterprise`)
 * must export as its default export. `apiVersion` is a literal `1` — the
 * loader rejects any other value at boot (D-03).
 */
export interface EnterprisePlugin {
  /** Must equal `API_VERSION` (1). Literal type — not `number`. */
  apiVersion: 1;
  /** Optional human-readable plugin name (e.g. "@simmetric-chat/enterprise"). */
  name?: string;
  /** Optional plugin version string (e.g. "1.0.0"). */
  version?: string;
  /**
   * Register the plugin against the provided context. May be async (SSO
   * init / backup bootstrap in future phases). If this throws, the loader
   * calls `process.exit(1)` (D-07 fail-loud).
   */
  register(ctx: PluginContext): void | Promise<void>;
}

/**
 * Phase 186 (SAAS-05) — minimal Part I hook interfaces.
 *
 * Each follows the `ConfigKeyValidator` call-signature pattern (:60-72):
 * a minimal Part I shape, widened ADDITIVELY by the Parte II SaaS plugin
 * fork (CONTEXT.md Discretion). They are structural type contracts only —
 * no runtime behavior in shared.
 */

/**
 * D-07 (186): billing hook — minimal empty marker in Part I. Parte II
 * (LemonSqueezy integration) widens it additively with checkout /
 * subscription management call signatures. Empty marker interface on
 * purpose (no-op-member placeholder) — eslint no-empty-object-type
 * suppressed with allowInterfaces semantics.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- minimal Part I marker; Parte II widens additively
export interface BillingProvider {}

/**
 * D-06 (186): quota enforcer consulted by `requireFeatureLimit` (Phase 185
 * org-scoped counters) when core passes. The verdict may be sync or async
 * (A4); `current`/`limit` are optional overrides the enforcer supplies for
 * the 402 body (185 D-06 frozen shape). Precedence is core-deny-wins
 * (enforced in middleware/license.ts — a plugin cannot widen a core deny).
 */
export interface QuotaEnforcer {
  (input: { organizationId: string; flag: string; current: number }):
    | Promise<{ allowed: boolean; current?: number; limit?: number }>
    | { allowed: boolean; current?: number; limit?: number };
}

/**
 * D-07 (186): plan resolver hook — minimal empty marker in Part I. Parte II
 * (plan definitions) widens it additively.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- minimal Part I marker; Parte II widens additively
export interface PlanResolver {}

/**
 * D-07 (186): tenant provisioner hook — minimal empty marker in Part I.
 * Parte II (org provisioning at checkout) widens it additively.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- minimal Part I marker; Parte II widens additively
export interface TenantProvisioner {}

/**
 * Phase 186 (SAAS-05 — D-01): the v2 plugin context. ADDITIVE interface
 * extending PluginContext — the SaaS plugin receives the FULL shared
 * surface (both loaders call the SAME `buildPluginContext` factory, D-02)
 * plus these five v2 members.
 *
 * Stub semantics (D-02/D-07): the 4 hook-registration methods and
 * `issueTenantLicense` THROW "not wired until Parte II" — the throwing
 * stubs live in the ctx BUILD, not here (the interface is the contract;
 * the bodies arrive with Parte II). The ONE real forward is
 * `registerQuotaEnforcer` (D-06 — the enforcer is consumed by
 * `requireFeatureLimit` this phase).
 */
export interface SaaSPluginContext extends PluginContext {
  /**
   * D-07 (186): registry-style stub — throws "not wired until Parte II".
   * No core consumption this phase; runtime consumption arrives with
   * Parte II (billing).
   */
  registerBillingProvider(provider: BillingProvider): void;
  /**
   * D-06 (186): the one REAL forward. Registers the quota enforcer into
   * the middleware/license.ts single-slot registry (`setQuotaEnforcer`,
   * alias-imported — Pitfall 3); `requireFeatureLimit` consults it when
   * the core count passes (core deny always wins).
   */
  registerQuotaEnforcer(enforcer: QuotaEnforcer): void;
  /**
   * D-07 (186): registry-style stub — throws "not wired until Parte II".
   */
  registerPlanResolver(resolver: PlanResolver): void;
  /**
   * D-07 (186): registry-style stub — throws "not wired until Parte II".
   */
  registerTenantProvisioner(provisioner: TenantProvisioner): void;
  /**
   * D-04 (186): tenant-license issuance stub — throws "not wired until
   * Parte II". The REAL implementation (RS256 signing with the
   * operator-only LICENSE_PRIVATE_KEY, kid rotation per the
   * simmetric-license-tool registry, revocation) is Parte II plugin
   * infra; the core NEVER signs (only verifies with the embedded public
   * key, D-05).
   */
  issueTenantLicense(organizationId: string, plan: string, expiresAt: Date): Promise<string>;
}

/**
 * Phase 186 (SAAS-05 — D-03): the contract a SaaS plugin package
 * (`@simmetric-chat/saas`) must export as its default export. `apiVersion`
 * is a literal `2` — the SAAS contract exists only in v2; the saasLoader
 * rejects any other value at boot (per-loader acceptance, downgrade guard
 * cuts both ways).
 */
export interface SaaSPlugin {
  /** Must equal `API_VERSION` (2) — the SAAS gate. Literal type — not `number`. */
  apiVersion: 2;
  /** Optional human-readable plugin name (e.g. "@simmetric-chat/saas"). */
  name?: string;
  /** Optional plugin version string (e.g. "1.0.0"). */
  version?: string;
  /**
   * Register the plugin against the provided context. May be async. If
   * this throws, the loader calls `process.exit(1)` (D-09 fail-loud,
   * verbatim enterprise semantics).
   */
  register(ctx: SaaSPluginContext): void | Promise<void>;
}
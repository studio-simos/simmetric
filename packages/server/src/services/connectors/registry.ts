// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

// Phase 198 (198-02 Task 1, D-03) — the connector platform-adapter registry.
//
// REPLACES the 198-01b stub IN-PLACE (same file path, same export surface:
// isPlatformImplemented/getAdapter — routes/connectors.ts imports these
// unchanged; its create/validate 400 "Platform not implemented yet" flips to
// success automatically once Plan 03 registers the telegram adapter).
//
// The Map is module-level (mcpClient.ts `connectionLocks` precedent) and
// LOOKUP FAILS CLOSED (D-03): an unimplemented platform has NO adapter, so
// `getAdapter()` returns undefined and callers MUST branch on it — there is
// no default adapter, no fallback platform. registerAdapter overwrites
// idempotently (a platform has at most one adapter per process).

import type { PlatformAdapter } from "./base";

/**
 * The adapter Map (mcpClient.ts Map precedent): keyed by platform name
 * ("telegram" | "discord" | "slack" | "whatsapp" — the D-03 closed enum).
 * Plan 03 fills it: registerAdapter("telegram", telegramAdapter).
 */
const adapters = new Map<string, PlatformAdapter>();

/**
 * Register an adapter for a platform (D-03). Idempotent overwrite: the most
 * recent registration for a platform wins (a platform has at most one
 * adapter per process). Called by each platform adapter's module init (and
 * directly by tests to install fakes).
 */
export function registerAdapter(platform: string, adapter: PlatformAdapter): void {
  adapters.set(platform, adapter);
}

/**
 * Adapter lookup — callers fail closed on undefined (D-03): the webhook
 * tenant slot, the admin routes, and the messageRouter all branch on the
 * undefined case rather than assuming an adapter exists.
 */
export function getAdapter(platform: string): PlatformAdapter | undefined {
  return adapters.get(platform);
}

/**
 * Fail-closed platform predicate (D-03): true only when an adapter is
 * registered for the platform. Drives the admin routes' 400 "Platform not
 * implemented yet" arm (create/validate/test) and the DELETE/webhook-setup
 * best-effort platform-side call guards.
 */
export function isPlatformImplemented(platform: string): boolean {
  return adapters.has(platform);
}

/**
 * Clear ALL registrations (tests only — each unit suite owns a fresh
 * registry: module-level Maps persist across jest tests in a file).
 */
export function clearAdapters(): void {
  adapters.clear();
}
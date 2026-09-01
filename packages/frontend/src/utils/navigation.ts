// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Navigation helper — single indirection for full-page navigations.
 *
 * Quick 260808-p5y: jsdom 26 (jest-environment-jsdom 30.x) freezes
 * `window.location` (non-configurable `location` property and `href`
 * accessor), so tests cannot stub `window.location.href = path` directly.
 * Components keep the exact same production behavior — this wrapper is
 * mocked at the module boundary in tests.
 */
export function navigateTo(path: string): void {
  window.location.href = path;
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Full-page redirect indirection (196-03, D-03): the OAuth connect flow
 * navigates the whole page to the provider authorizeUrl via window.location
 * .assign — NEVER a popup or secondary browser window. Extracted into its
 * own module so component tests can stub it: jsdom's window.location is
 * non-configurable (jsdom 26), so a direct spy is impossible.
 */
export function assignRedirect(url: string): void {
  window.location.assign(url);
}
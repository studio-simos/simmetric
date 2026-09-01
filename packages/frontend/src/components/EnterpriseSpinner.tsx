// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * EnterpriseSpinner — Phase 147 (EPA-11 — D-07). Minimal Suspense fallback for
 * `React.lazy`-wrapped enterprise UI chunks. The chunks are already bundled
 * (the component source lives in the community repo); the Suspense boundary
 * is for the chunk parse, not a network fetch — so a minimal div is
 * sufficient. Extracted to a shared component in Plan 02 so both `App.tsx`
 * and `SettingsPage.tsx` import the SAME helper (DRY — Plan 01 declared it
 * inline in App.tsx).
 */
export default function EnterpriseSpinner() {
  return <div className="p-6 text-muted-foreground">Loading…</div>;
}
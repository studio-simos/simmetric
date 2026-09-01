// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * uiDensity — FOUC-safe UI density helper (Feature 3.4b / FONT-01 companion).
 *
 * The user-saved density (comfortable/compact) toggles the `density-compact`
 * class on <html>. This module mirrors the FOUC-safe pattern in
 * `contexts/ThemeContext.tsx`: a module-level init call runs at import time
 * (before React render) so the class is set on first paint, even on a direct
 * reload of `/chat`. `main.tsx` imports this module for its side effect.
 *
 * Only the literal class name `density-compact` is toggled (boolean), so a
 * tampered localStorage value cannot inject markup (T-66.1-08). Unknown values
 * fall back to "comfortable" (T-66.1-09: bad localStorage cannot throw).
 */

export type Density = "comfortable" | "compact";

export const UI_DENSITY_KEY = "uiDensity";

export function readDensity(): Density {
  if (typeof localStorage === "undefined") return "comfortable";
  return localStorage.getItem(UI_DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

export function applyDensity(d: Density): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("density-compact", d === "compact");
}

// Synchronous FOUC-safe initialization at module level — runs on first import.
// main.tsx imports this module BEFORE rendering <App />, so the class is set
// before the first paint (mirrors ThemeContext.tsx:39-44).
const initialDensity = readDensity();
applyDensity(initialDensity);
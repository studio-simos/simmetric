// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * uiFontScale — FOUC-safe UI font-scale helper (Feature 3.4b / FONT-01).
 *
 * The user-saved UI font scale (sm/md/lg) is applied as the `--ui-font-scale`
 * CSS var on <html>. This module mirrors the FOUC-safe pattern in
 * `contexts/ThemeContext.tsx`: a module-level init call runs at import time
 * (before React render) so the var is set on first paint, even on a direct
 * reload of `/chat`. `main.tsx` imports this module for its side effect.
 *
 * The values are constrained to a literal map, so a tampered localStorage
 * value cannot inject CSS (T-66.1-08). Unknown values fall back to "md"
 * (T-66.1-09: bad localStorage cannot throw).
 */

export type UiFontScale = "sm" | "md" | "lg";

export const UI_FONT_SCALE_KEY = "uiFontScale";

/**
 * @public — documented FOUC-safe bootstrap API (packages/frontend/AGENTS.md
 * lists the full export surface of this lib). Consumed internally by
 * readUiFontScale/applyUiFontScale; kept exported for SettingsAppearance
 * parity tooling (Phase 180 reviewed-keep).
 */
export const UI_FONT_SCALE_VALUES: Record<UiFontScale, string> = {
  sm: "0.9375rem",
  md: "1rem",
  lg: "1.0625rem",
};

export function readUiFontScale(): UiFontScale {
  if (typeof localStorage === "undefined") return "md";
  const v = localStorage.getItem(UI_FONT_SCALE_KEY);
  return v === "sm" || v === "lg" ? v : "md";
}

export function applyUiFontScale(scale: UiFontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--ui-font-scale",
    UI_FONT_SCALE_VALUES[scale],
  );
}

// Synchronous FOUC-safe initialization at module level — runs on first import.
// main.tsx imports this module BEFORE rendering <App />, so the CSS var is set
// before the first paint (mirrors ThemeContext.tsx:39-44).
const initialScale = readUiFontScale();
applyUiFontScale(initialScale);
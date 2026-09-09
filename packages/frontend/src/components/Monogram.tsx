// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Monogram — the Simmetric Chat "S" letter-mark (Phase 149 BRAND-01 / D-06,
 * extracted from AppSidebar.tsx in the UI revision sweep).
 *
 * Single source of truth for the "S" geometry shared between the favicon
 * (`packages/frontend/public/favicon.svg`), the AppSidebar rail-mode fallback
 * and the chat empty-state wordmark. A future brand-asset swap changes this
 * one component (and the favicon file) to update all sites in sync.
 *
 * Inline SVG — no remote URL, no SSRF surface (T-149-03 accept).
 */

export interface MonogramProps {
  /** Rendered square size in px. */
  size: number;
  /** Fill of the "S" glyph. The rounded-square background is always #FDFAF4 (favicon-matched). */
  color: string;
  className?: string;
}

export default function Monogram({ size, color, className }: MonogramProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label="Simmetric Chat"
      className={className ?? "rounded-md"}
    >
      {/* Warm off-white rounded-square background — matches the favicon's
          hardcoded fill so the mark reads in both light/dark contexts
          without depending on currentColor / CSS context. */}
      <rect width="32" height="32" rx="8" ry="8" fill="#FDFAF4" />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontSize="20"
        fontWeight="700"
        fill={color}
      >
        S
      </text>
    </svg>
  );
}
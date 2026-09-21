// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * 188-03 (WGTA-02, D-09): the product fallback mark — a self-contained Preact
 * copy of the frontend Monogram geometry (`packages/frontend/src/components/
 * Monogram.tsx`). The widget is a Preact IIFE bundle with zero runtime shared
 * imports; the React component CANNOT be imported across that boundary
 * (research anti-pattern list) — the geometry is COPIED verbatim. A brand
 * swap updates Monogram.tsx, the favicon file, and this copy.
 *
 * SVG-with-text caveat (research Pattern 5): the <text> glyph is fine inside
 * the iframe component — this is an image-like BRAND MARK, not a UI icon
 * surface. The Phase 131 "zero text glyphs" rule targets UI icon surfaces
 * (close/send/FAB icons); this component renders the "S" monogram.
 *
 * Inline SVG only — no remote URL, no fetching, no SSRF surface (T-188-12
 * accept: static inline SVG, no runtime cost beyond a component render).
 */

export interface ProductMarkProps {
  /** Rendered square size in px. */
  size: number;
  /** Fill of the "S" glyph. The rounded-square background is always #FDFAF4 (favicon-matched). */
  color: string;
  className?: string;
}

export default function ProductMark({ size, color, className }: ProductMarkProps) {
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
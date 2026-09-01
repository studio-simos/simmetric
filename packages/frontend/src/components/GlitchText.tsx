// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { type HTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

export interface GlitchTextProps extends HTMLAttributes<HTMLSpanElement> {
  /** The text rendered and also used for the glitch ::before/::after layers. */
  text: string;
  /** Render as h1..h3 / p via className; defaults to a bold inline span. */
  as?: "span" | "h1" | "h2" | "h3";
}

const glitchTextVariants = cva("glitch-text font-mono font-bold");

/**
 * GlitchText — title with animated glitch effect (Feature 3.6 / UI_DESIGN.md).
 * Use ONLY on important titles; animation is reduced-respect via index.css.
 * Requires the `data-text` attribute which the ::before/::after pseudo layers read.
 *
 * CVA-rewritten in Feature 6.3. Kept as a PLAIN function component (no forwardRef)
 * to preserve the existing public API exactly.
 */
export function GlitchText({ text, as: As = "span", className, ...props }: GlitchTextProps) {
  return (
    <As className={cn(glitchTextVariants(), className)} data-text={text} {...props}>
      {text}
    </As>
  );
}


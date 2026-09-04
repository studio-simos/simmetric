// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

export type NeonColor = "green" | "cyan" | "magenta" | "amber";

export interface NeonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  color?: NeonColor;
  /** Render solid neon fill + glow (default) or outline-only with glow on hover. */
  variant?: "solid" | "ghost";
}

const NEON_HEX: Record<NeonColor, string> = {
  green: "#00ff9c",
  cyan: "#00d4ff",
  magenta: "#ff00aa",
  amber: "#ffaa00",
};

export const neonButtonVariants = cva(
  "px-3 py-1.5 text-sm font-medium transition-all duration-150 hover:brightness-110 focus:outline-none focus-visible:ring-2",
  {
    variants: {
      variant: {
        solid: "",
        ghost: "hover:bg-[rgba(255,255,255,0.05)]",
      },
      glow: {
        green: "neon-glow-green",
        cyan: "neon-glow-cyan",
        magenta: "",
        amber: "",
      },
    },
    defaultVariants: {
      variant: "solid",
      glow: "green",
    },
  },
);

/**
 * NeonButton — primary/secondary action with neon glow (Feature 3.6 / UI_DESIGN.md).
 * Styled inline so it composes cleanly with the existing shadcn Button when needed.
 * CVA-rewritten in Feature 6.3 — inline `style` colors are KEPT so tests reading
 * `btn.style.backgroundColor` continue to resolve to the exact rgb() values.
 */
export const NeonButton = forwardRef<HTMLButtonElement, NeonButtonProps>(
  function NeonButton(
    { color = "green", variant = "solid", className, style, children, ...props },
    ref,
  ) {
    const hex = NEON_HEX[color];

    const solidStyle: React.CSSProperties = {
      backgroundColor: variant === "solid" ? hex : "transparent",
      color: variant === "solid" ? "#0a0e14" : hex,
      border: `1px solid ${hex}`,
      borderRadius: "4px",
      ...style,
    };

    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          neonButtonVariants({ variant, glow: color }),
          className,
        )}
        style={solidStyle}
        {...props}
      >
        {children}
      </button>
    );
  },
);

export default NeonButton;
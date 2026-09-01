// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { forwardRef, type HTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

export type GlassPanelProps = HTMLAttributes<HTMLDivElement>;

const glassPanelVariants = cva("glass-panel");

/**
 * GlassPanel — glassmorphism wrapper (Feature 3.6 / UI_DESIGN.md).
 * Use ONLY on top-level panels: backdrop-filter is expensive.
 * CVA-rewritten in Feature 6.3 for consistency with the shadcn Button pattern.
 */
export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(
  function GlassPanel({ className, children, ...props }, ref) {
    return (
      <div ref={ref} className={cn(glassPanelVariants(), className)} {...props}>
        {children}
      </div>
    );
  },
);


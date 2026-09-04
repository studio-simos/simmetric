// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { type HTMLAttributes, type ElementType } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const terminalTextVariants = cva("font-mono", {
  variants: {
    tone: {
      muted: "text-muted-foreground",
      accent: "text-[var(--color-hacker-neon-green)]",
    },
  },
  defaultVariants: {
    tone: "muted",
  },
});

export type TerminalTextProps = HTMLAttributes<HTMLElement> &
  VariantProps<typeof terminalTextVariants> & {
    as?: ElementType;
    prompt?: boolean;
  };

/**
 * TerminalText — monospaced text wrapper with optional block-cursor prompt (Feature 6.3).
 * The ▌ glyph is decorative (not translated). No i18n keys.
 */
export function TerminalText({
  tone,
  as,
  prompt,
  className,
  children,
  ...props
}: TerminalTextProps) {
  const Comp: ElementType = as ?? "span";
  return (
    <Comp className={cn(terminalTextVariants({ tone }), className)} {...props}>
      {prompt ? <>▌ {children}</> : children}
    </Comp>
  );
}

export default TerminalText;
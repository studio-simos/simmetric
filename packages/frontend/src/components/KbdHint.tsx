// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { forwardRef, type HTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const kbdHintVariants = cva(
  "chat-kbd-hint mt-1.5 text-[11px] font-mono text-muted-foreground transition-opacity duration-300",
  {
    variants: {
      visible: {
        true: "opacity-100",
        false: "opacity-0",
      },
    },
    defaultVariants: {
      visible: true,
    },
  },
);

export type KbdHintProps = HTMLAttributes<HTMLParagraphElement> & {
  visible?: boolean;
};

/**
 * KbdHint — keyboard shortcut hint paragraph (Feature 6.3 CVA primitive).
 * Reproduces the ChatInputArea kbd-hint markup exactly. The shortcut string is
 * passed as children (already translated by the caller via t()).
 */
export const KbdHint = forwardRef<HTMLParagraphElement, KbdHintProps>(
  function KbdHint({ visible = true, className, children, ...props }, ref) {
    return (
      <p
        ref={ref}
        className={cn(kbdHintVariants({ visible }), className)}
        aria-hidden="true"
        {...props}
      >
        {children}
      </p>
    );
  },
);


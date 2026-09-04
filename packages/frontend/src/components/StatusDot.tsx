// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { forwardRef, type HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const statusDotVariants = cva("inline-block rounded-full", {
  variants: {
    status: {
      connected: "bg-[var(--color-hacker-neon-green)]",
      disconnected: "bg-muted-foreground",
      error: "bg-destructive",
      pending: "bg-[var(--color-hacker-neon-amber)]",
    },
    size: {
      sm: "size-1.5",
      md: "size-2.5",
    },
  },
  defaultVariants: {
    status: "disconnected",
    size: "md",
  },
});

export type StatusDotProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof statusDotVariants>;

/**
 * StatusDot — small status indicator dot (Feature 6.3 CVA primitive).
 * Decorative by default (aria-hidden="true"); callers can override via props.
 */
export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(
  function StatusDot({ status, size, className, ...props }, ref) {
    return (
      <span
        ref={ref}
        className={cn(statusDotVariants({ status, size }), className)}
        data-status={status ?? "disconnected"}
        aria-hidden="true"
        {...props}
      />
    );
  },
);

export default StatusDot;
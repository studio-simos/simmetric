// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import * as React from "react"

import { cn } from "@/lib/utils"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"

export interface AppTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  helperText?: string
  error?: string
}

export function AppTextarea({
  label,
  helperText,
  error,
  className,
  id: providedId,
  ...rest
}: AppTextareaProps) {
  const generatedId = React.useId()
  const id = providedId ?? generatedId

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Textarea
        id={id}
        aria-invalid={!!error || undefined}
        className={cn(error ? "border-destructive" : "", className)}
        {...rest}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!error && helperText && (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      )}
    </div>
  )
}

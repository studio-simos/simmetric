// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import * as React from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface AppInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  helperText?: string
  error?: string
}

export function AppInput({
  ref,
  label,
  helperText,
  error,
  className,
  id: providedId,
  ...rest
}: AppInputProps & { ref?: React.Ref<HTMLInputElement> }) {
  const generatedId = React.useId()
  const id = providedId ?? generatedId

  return (
    <div className="flex flex-col gap-1.5">
      {label && <Label htmlFor={id}>{label}</Label>}
      <Input
        ref={ref}
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
AppInput.displayName = "AppInput"

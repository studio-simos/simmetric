// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import * as React from "react"

import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"

export interface AppSelectProps {
  label?: string
  helperText?: string
  error?: string
  placeholder?: string
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
  disabled?: boolean
  name?: string
  id?: string
  className?: string
}

export function AppSelect({
  label,
  helperText,
  error,
  placeholder,
  value,
  onValueChange,
  children,
  disabled,
  name,
  id: providedId,
  className,
}: AppSelectProps) {
  const generatedId = React.useId()
  const id = providedId ?? generatedId

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <Select
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        name={name}
      >
        <SelectTrigger
          id={id}
          className={cn(error ? "border-destructive" : "")}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!error && helperText && (
        <p className="text-xs text-muted-foreground">{helperText}</p>
      )}
    </div>
  )
}

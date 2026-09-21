// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SidebarDropdown — Feature 7.2 Slice B (quick task 260714-n3q).
 *
 * Select wrapper wired to TanStack Query items. Renders an uppercase mono
 * label + a shadcn Select with the provided items. Used for the project and
 * workspace selectors at the top of the sidebar. Maintains the same pattern
 * as the inline Sidebar in App.tsx (lines 760-813), including the "+ Add
 * workspace" option via `addOption`.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface SidebarDropdownItem {
  id: string;
  name: string;
}

export interface SidebarDropdownProps {
  /** Uppercase monospace label (i18n key resolved by caller). */
  label: string;
  /** Currently selected value (empty string = nothing selected). */
  value: string;
  /** Called when the user selects a value (including addOption.value). */
  onValueChange: (value: string) => void;
  /** Items to render in the dropdown. */
  items: SidebarDropdownItem[];
  /** Placeholder shown when no value is selected. */
  placeholder: string;
  /** Whether the dropdown is disabled (e.g. workspace selector without a project). */
  disabled?: boolean;
  /** Optional trailing option (e.g. { value: "__add__", label: "+ Add workspace" }). */
  addOption?: { value: string; label: string };
}

export default function SidebarDropdown({
  label,
  value,
  onValueChange,
  items,
  placeholder,
  disabled = false,
  addOption,
}: SidebarDropdownProps) {
  return (
    <div className="px-3 py-3 border-b border-input/60">
      <label
        className="block px-3 py-1 text-[10px] font-mono uppercase tracking-wider select-none text-[var(--sidebar-dropdown-label)]"
      >
        {label}
      </label>
      <Select value={value || undefined} onValueChange={onValueChange}>
        <SelectTrigger className="mt-1 w-full text-sm" disabled={disabled}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
          {addOption ? (
            <>
              <SelectSeparator />
              <SelectItem value={addOption.value}>{addOption.label}</SelectItem>
            </>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}
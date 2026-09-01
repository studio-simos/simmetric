// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Sidebar primitives barrel — Feature 7.2 Slice B (quick task 260714-n3q).
 *
 * Console-style sidebar building blocks: SidebarSection (collapsible group),
 * SidebarItem (nav item with icon + active state), SidebarLink (direct link),
 * SidebarDropdown (Select wired to TanStack Query items).
 */

export { default as SidebarSection } from "./SidebarSection";

export { default as SidebarItem } from "./SidebarItem";

export { default as SidebarLink } from "./SidebarLink";

export { default as SidebarDropdown } from "./SidebarDropdown";
export type { SidebarDropdownItem } from "./SidebarDropdown";
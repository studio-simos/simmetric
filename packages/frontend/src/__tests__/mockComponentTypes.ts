// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Shared prop types for inline mock components in jest.mock factories.
 *
 * Mock components in tests render children and optionally spread a few
 * arbitrary props onto a plain DOM node. These types let the mocks stay
 * type-safe without resorting to `any` (which trips `@typescript-eslint/no-explicit-any`).
 *
 * - {@link ChildrenOnlyProps} for mocks that only consume `children`.
 * - {@link MockComponentProps} for mocks that spread the rest of the props
 *   onto a DOM node (the index signature types extra props as `unknown`,
 *   which is assignable to DOM attributes via spread).
 */
import type { ReactNode } from "react";

export interface ChildrenOnlyProps {
  children?: ReactNode;
}

export interface MockComponentProps {
  children?: ReactNode;
  [key: string]: unknown;
}
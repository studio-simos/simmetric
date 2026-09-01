// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { createContext, useContext, type ReactNode } from "react";
import { useEnterpriseModules } from "../hooks/useEnterpriseModules";

interface EnterpriseModulesContextValue {
  enterpriseInstalled: boolean;
  modules: string[];
}

const EnterpriseModulesContext = createContext<EnterpriseModulesContextValue | null>(null);

/**
 * Phase 147 (EPA-11 — D-06): provider that calls `useEnterpriseModules`
 * once at the app root and exposes `{ enterpriseInstalled, modules }` to
 * the tree via React Context. Mirrors the `ThemeContext` shape. Mounted
 * inside `QueryClientProvider` (the hook uses TanStack Query) and inside
 * `BrowserRouter` (consumed by route elements) in `main.tsx`.
 */
export function EnterpriseModulesProvider({ children }: { children: ReactNode }) {
  const value = useEnterpriseModules();
  return (
    <EnterpriseModulesContext.Provider value={value}>
      {children}
    </EnterpriseModulesContext.Provider>
  );
}

/**
 * Consume the enterprise-modules context. Mirrors the `ThemeContext`
 * null-guard pattern: a consumer rendered outside the provider gets a
 * safe `enterpriseInstalled: false` default — NOT a crash — so test
 * renders and any mis-ordered subtrees degrade gracefully.
 */
export function useEnterpriseModulesContext(): EnterpriseModulesContextValue {
  const ctx = useContext(EnterpriseModulesContext);
  if (!ctx) {
    return { enterpriseInstalled: false, modules: [] };
  }
  return ctx;
}
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Test utilities — wraps components in QueryClientProvider and other common providers.
 * Use these instead of @testing-library/react's raw render/renderHook for any
 * component that uses TanStack Query.
 */
import { ReactNode } from "react";
import { render as rtlRender, renderHook as rtlRenderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(ui: ReactNode, options?: Parameters<typeof rtlRender>[1]) {
  const queryClient = createTestQueryClient();
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
    ...options,
  });
}

export function renderHookWithProviders<TResult, TProps>(
  callback: (props: TProps) => TResult
) {
  const queryClient = createTestQueryClient();
  return rtlRenderHook(callback, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Test rendering utilities mirroring the PRODUCTION provider tree from
 * `src/main.tsx` (D-04). LoginPage (and other SSO-era components) traverse the
 * full provider chain — QueryClientProvider > Router > ThemeProvider >
 * ChatProvider > PageMetaProvider — so component tests must mirror that tree
 * to exercise the real consumption paths instead of papering over missing
 * providers.
 *
 * ESM `.tsx` — the frontend jest config treats `.tsx` as ESM (`module.type:
 * "esm"` + `extensionsToTreatAsEsm`), so this file uses `import`/`export`.
 *
 * Per D-04: NO StrictMode (double-invokes effects — flaky useEffect
 * assertions) and NO ErrorBoundary (swallows errors — bad for test failure
 * visibility). The util mirrors the CONTEXT providers LoginPage reads, not
 * the dev-only wrappers. MemoryRouter replaces BrowserRouter (jsdom-safe,
 * avoids `window.history` side effects; standard RTL choice).
 */
import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../contexts/ThemeContext";
import { ChatProvider } from "../contexts/ChatContext";
import { PageMetaProvider } from "../contexts/PageMetaContext";

/**
 * Build a FRESH QueryClient per test. A fresh client prevents cross-test
 * cache leakage (Pitfall 5) — the production `queryClient` singleton in
 * `src/queries/queryClient.ts` is intentionally NOT used. Retries are
 * disabled so a failing query in one test does not retry-flap into the next.
 */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

type RenderWithProvidersOptions = RenderOptions & { initialEntries?: string[] };

/**
 * Render `ui` wrapped in the production-mirrored provider tree:
 * QueryClientProvider > MemoryRouter > ThemeProvider > ChatProvider >
 * PageMetaProvider. A fresh QueryClient is created per call.
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: RenderWithProvidersOptions,
): ReturnType<typeof render> {
  const { initialEntries = ["/"], ...renderOptions } = options ?? {};
  const client = makeTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <ThemeProvider>
          <ChatProvider>
            <PageMetaProvider>{ui}</PageMetaProvider>
          </ChatProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
    renderOptions,
  );
}
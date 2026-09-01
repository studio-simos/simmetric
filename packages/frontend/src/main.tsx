// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queries/queryClient";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ChatProvider } from "./contexts/ChatContext";
import { PageMetaProvider } from "./contexts/PageMetaContext";
import { EnterpriseModulesProvider } from "./contexts/EnterpriseModulesContext";
import "./i18n";
import "./index.css";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "@fontsource/jetbrains-mono";
// FOUC-safe bootstrap: apply saved UI font scale + density to <html> BEFORE
// React render. Module-level init in these libs mirrors ThemeContext.tsx —
// the CSS var `--ui-font-scale` and the `density-compact` class are set on
// first paint, even on a direct reload of /chat (FONT-01).
import "./lib/uiFontScale";
import "./lib/uiDensity";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";

// Register service worker for web push notifications
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration failure is non-fatal — push notifications just won't work
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ThemeProvider>
            <ChatProvider>
              <PageMetaProvider>
                {/* Phase 147 (EPA-11 — D-06): innermost provider — uses
                    TanStack Query (needs QueryClientProvider above) and is
                    consumed by route elements in App.tsx (needs BrowserRouter
                    above). Mounts ONCE; EnterpriseModulesContext exposes
                    { enterpriseInstalled, modules } to the tree. */}
                <EnterpriseModulesProvider>
                  <App />
                </EnterpriseModulesProvider>
              </PageMetaProvider>
            </ChatProvider>
          </ThemeProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SSO token handoff — App-level test (quick 260808-oin).
 *
 * Both SAML and OIDC callbacks redirect to /oauth/callback?token=<JWT>. The
 * SPA must store that JWT in localStorage under the "token" key (the same key
 * useLogin uses) and strip it from the URL. Rendered through the production
 * provider tree (renderWithProviders) with all queries + heavy components
 * mocked, so the unauthenticated branch (LoginPage fallback) renders.
 */

import { useLocation } from "react-router-dom";
import "@testing-library/jest-dom";
import { screen, act } from "@testing-library/react";
import { renderWithProviders } from "./testUtils";
import App from "../App";

// ──────────────────────────────────────────────────────
// Mocks — i18n, queries, contexts, heavy components
// ──────────────────────────────────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("../queries/useAuth", () => ({
  useMe: () => ({ data: undefined, isLoading: false, error: undefined }),
  useMenuSections: () => ({ data: [], isLoading: false }),
  useLogout: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("../queries/useLicense", () => ({
  useLicenseInfo: () => ({ data: undefined }),
}));

jest.mock("../queries/useProjects", () => ({
  useProjects: () => ({ data: [] }),
}));

jest.mock("../queries/useWorkspaces", () => ({
  useWorkspaces: () => ({ data: [] }),
}));

jest.mock("../utils/api", () => ({
  apiGet: jest.fn().mockResolvedValue(null),
}));

// Mock every component App imports so the module graph stays light and the
// test only exercises the unauthenticated branch.
jest.mock("../components/ChatPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/EventLogPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/AnalyticsPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/SsoSettingsPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/WorkspaceCreatePanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/WorkspacesPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/ProjectsPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/WidgetsPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/SettingsPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/DocumentsPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/LoginPage", () => ({ __esModule: true, default: () => <div data-testid="login-page" /> }));
jest.mock("../components/ForcePasswordChange", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/DashboardPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/KnowledgeBasePage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/MarketplacePage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/MarketplaceDetail", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/ArchivesPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/ArchiveDetailPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/DocumentViewerPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/SynthesisDashboard", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/SynthesisRunDetail", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/UnifiedUploadPage", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/AppSidebar", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/TopBar", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/RightPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("../components/ModelPalette", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
jest.mock("@/components/ui/skeleton", () => ({ Skeleton: () => <div /> }));
jest.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ──────────────────────────────────────────────────────
// Location probe — observes router navigation
// ──────────────────────────────────────────────────────

function LocationProbe() {
  const location = useLocation();
  return <div id="router-path">{location.pathname}</div>;
}

describe("SSO token handoff (App)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores the ?token= JWT and strips it from the URL when unauthenticated", async () => {
    renderWithProviders(
      <>
        <App />
        <LocationProbe />
      </>,
      { initialEntries: ["/oauth/callback?token=saml-jwt-abc"] },
    );

    // The unauthenticated branch renders (LoginPage fallback) and the handoff
    // effect stores the token under the useLogin key.
    await act(async () => {});
    expect(screen.getByTestId("login-page")).toBeInTheDocument();
    expect(localStorage.getItem("token")).toBe("saml-jwt-abc");
    expect(document.getElementById("router-path")).toHaveTextContent("/");
  });

  it("does NOT clobber an existing session with a stale ?token= param", async () => {
    localStorage.setItem("token", "existing-live-session");

    renderWithProviders(
      <>
        <App />
        <LocationProbe />
      </>,
      { initialEntries: ["/oauth/callback?token=stale-jwt"] },
    );

    await act(async () => {});
    expect(localStorage.getItem("token")).toBe("existing-live-session");
  });

  it("ignores an empty ?token= param", async () => {
    renderWithProviders(
      <>
        <App />
        <LocationProbe />
      </>,
      { initialEntries: ["/oauth/callback?token="] },
    );

    await act(async () => {});
    expect(localStorage.getItem("token")).toBeNull();
  });
});

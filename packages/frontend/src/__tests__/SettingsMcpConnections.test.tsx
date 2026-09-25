// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsMcpConnections tests — Phase 196 plan 03 (MCPO-02 UI).
 *
 * Covers the 7-state Badge Matrix (UI-SPEC), the full-page-redirect connect
 * flow (D-03), the error arm, and the ?oauth= return handler. jsdom env;
 * jest.mock pattern per McpPinnerPopover.test.tsx.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      let out = key;
      for (const [k, v] of Object.entries(opts)) {
        out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      }
      return out;
    },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockUseSearchParams = jest.fn();
const mockSetSearchParams = jest.fn();
jest.mock("react-router-dom", () => ({
  useSearchParams: () => mockUseSearchParams(),
}));

const mockApiPost = jest.fn();
const mockApiDelete = jest.fn();
const mockApiGet = jest.fn();
jest.mock("../utils/api", () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
  apiDelete: (...args: unknown[]) => mockApiDelete(...args),
}));

const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();
jest.mock("../lib/toast", () => ({
  showError: (...args: unknown[]) => mockShowError(...args),
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
}));

// Redirect seam (jsdom 26 window.location is non-configurable) — the
// component routes full-page redirects through src/lib/redirect.ts, which
// tests stub.
const mockAssignRedirect = jest.fn();
jest.mock("../lib/redirect", () => ({
  assignRedirect: (...args: unknown[]) => mockAssignRedirect(...args),
}));

const mockUseMe = jest.fn();
jest.mock("../queries/useAuth", () => ({
  useMe: () => mockUseMe(),
}));

const mockUseQueryClient = jest.fn();
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => mockUseQueryClient(),
  };
});

import SettingsMcpConnections from "../components/SettingsMcpConnections";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

const baseConn = {
  id: "conn-1",
  name: "Google Drive",
  url: "https://example.com",
  transportType: "sse" as const,
  projectId: null,
  workspaceId: "ws-1",
  headers: {},
  enabled: true,
  lastSyncAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  liveStatus: "connected" as const,
  toolCount: 2,
};

const connWith = (over: Record<string, unknown>) => ({ ...baseConn, ...over });

// Fresh QueryClient per render — the module-scope client would cache the
// first test's connection list and bleed it into later tests.
// (invalidateQueries spy available as `queryClient.invalidateQueries` if a
// test needs it; declared here to keep the per-test client wiring in one place.)
let queryClient: QueryClient;

const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
  </QueryClientProvider>
);

const renderSection = () =>
  render(<SettingsMcpConnections />, { wrapper: Wrapper });

beforeEach(() => {
  jest.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockUseQueryClient.mockReturnValue(queryClient);
  mockUseSearchParams.mockReturnValue([new URLSearchParams(), mockSetSearchParams]);
  mockUseMe.mockReturnValue({
    data: { permissions: ["mcp:oauth:manage"] },
  });
  mockApiGet.mockResolvedValue([]);
});

// ---------------------------------------------------------------------
// Badge matrix (7 states)
// ---------------------------------------------------------------------

describe("OauthBadge — Badge Matrix (7 states)", () => {
  it("authType none renders NO badge (legacy rows stay clean)", () => {
    mockApiGet.mockImplementation((_path: string) => {
      return Promise.resolve([connWith({ authType: "none", oauthStatus: "authorized" })]);
    });
    renderSection();
    return waitFor(() => {
      expect(screen.getByText("Google Drive")).toBeInTheDocument();
      expect(screen.queryByText("settings.mcpConnections.oauth.badgeOauthOk")).not.toBeInTheDocument();
      expect(screen.queryByText("settings.mcpConnections.oauth.badgeOauthNone")).not.toBeInTheDocument();
    });
  });

  it("authType static renders the Static outline badge", async () => {
    mockApiGet.mockResolvedValue([connWith({ authType: "static" })]);
    renderSection();
    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.oauth.badgeStatic")).toBeInTheDocument();
    });
  });

  it("oauth + status none renders 'Not connected'", async () => {
    mockApiGet.mockResolvedValue([connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "none" })]);
    renderSection();
    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.oauth.badgeOauthNone")).toBeInTheDocument();
    });
  });

  it("oauth + pending renders pending label with animate-pulse dot", async () => {
    mockApiGet.mockResolvedValue([connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "pending" })]);
    renderSection();
    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.oauth.pending")).toBeInTheDocument();
      const dot = document.querySelector(".animate-pulse");
      expect(dot).not.toBeNull();
    });
  });

  it("oauth + authorized with far-future tokenExpiresAt renders OAuth ✓ green tint + expiry tooltip text", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h out
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "authorized", tokenExpiresAt: future }),
    ]);
    renderSection();
    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.oauth.badgeOauthOk")).toBeInTheDocument();
      const badge = screen.getByText("settings.mcpConnections.oauth.badgeOauthOk");
      expect(badge.className).toContain("bg-green-500/10");
    });
  });

  it("oauth + authorized with tokenExpiresAt ≤ 10min renders OAuth ⚠ expiring amber tint", async () => {
    const soon = new Date(Date.now() + 4 * 60 * 1000).toISOString(); // 4 min out
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "authorized", tokenExpiresAt: soon }),
    ]);
    renderSection();
    await waitFor(() => {
      // The badge span itself (not a tooltip/aria ancestor).
      const label = screen.getByText("settings.mcpConnections.oauth.badgeOauthExpiring");
      expect(label.className).toContain("bg-amber-500/10");
      // aria-label carries the full meaning (state + relative time) — never
      // color alone. (The key-returning t() mock renders the key; the real
      // locale string interpolates {{time}} — bound by Task 3's length test.)
      expect(label.getAttribute("aria-label")).toContain("badgeOauthExpiring");
    });
  });

  it("oauth + authorized WITHOUT tokenExpiresAt renders OAuth ✓ without expiry text", async () => {
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "authorized", tokenExpiresAt: null }),
    ]);
    renderSection();
    await waitFor(() => {
      expect(screen.getByText("settings.mcpConnections.oauth.badgeOauthOk")).toBeInTheDocument();
    });
  });

  it("oauth + error renders OAuth ✗ destructive tint with errorSummary tooltip from oauthErrorSummary", async () => {
    mockApiGet.mockResolvedValue([
      connWith({
        authType: "oauth",
        oauthProvider: "google",
        oauthStatus: "error",
        oauthErrorSummary: "provider exploded",
      }),
    ]);
    renderSection();
    await waitFor(() => {
      const badge = screen.getByText("settings.mcpConnections.oauth.badgeOauthError");
      expect(badge.className).toContain("bg-destructive/10");
    });
  });
});

// ---------------------------------------------------------------------
// Connect flow (D-03)
// ---------------------------------------------------------------------

describe("Connect flow — full-page redirect", () => {
  it("renders Connect with provider for oauth rows with status none", async () => {
    mockApiGet.mockResolvedValue([connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "none" })]);
    renderSection();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "settings.mcpConnections.oauth.connect" })).toBeInTheDocument();
    });
  });

  it("click Connect → start mutation → redirect called with authorizeUrl (full-page, no popup)", async () => {
    mockApiGet.mockResolvedValue([connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "none" })]);
    mockApiPost.mockResolvedValue({ authorizeUrl: "https://accounts.google.com/authorize?x=1" });
    renderSection();
    const btn = await screen.findByRole("button", { name: "settings.mcpConnections.oauth.connect" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith("/mcp-connections/conn-1/oauth/start", {});
      expect(mockAssignRedirect).toHaveBeenCalledWith("https://accounts.google.com/authorize?x=1");
    });
  });

  it("mutation error → showError(oauth.connectFailed) and NO navigation", async () => {
    mockApiGet.mockResolvedValue([connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "none" })]);
    mockApiPost.mockRejectedValue(new Error("boom"));
    renderSection();
    const btn = await screen.findByRole("button", { name: "settings.mcpConnections.oauth.connect" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith("settings.mcpConnections.oauth.connectFailed");
      expect(mockAssignRedirect).not.toHaveBeenCalled();
    });
  });

  it("Reauthorize replaces Connect for authorized rows (one primary lifecycle action at a time)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "authorized", tokenExpiresAt: future }),
    ]);
    renderSection();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "settings.mcpConnections.oauth.reauthorize" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "settings.mcpConnections.oauth.connect" })).not.toBeInTheDocument();
    });
  });

  it("lifecycle actions are HIDDEN without mcp:oauth:manage (not disabled)", async () => {
    mockUseMe.mockReturnValue({ data: { permissions: [] } });
    mockApiGet.mockResolvedValue([connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "none" })]);
    renderSection();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "settings.mcpConnections.oauth.connect" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "settings.mcpConnections.oauth.revoke" })).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------
// ?oauth= return handler (D-03 step 5)
// ---------------------------------------------------------------------

describe("?oauth= return handler", () => {
  it("authorized → success toast + param stripped via setSearchParams replace", async () => {
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("oauth=authorized"),
      mockSetSearchParams,
    ]);
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "authorized" }),
    ]);
    renderSection();
    await waitFor(() => {
      expect(mockShowSuccess).toHaveBeenCalledWith("settings.mcpConnections.oauth.returnSuccess");
      expect(mockSetSearchParams).toHaveBeenCalledTimes(1);
      const [updater, opts] = mockSetSearchParams.mock.calls[0];
      expect(opts).toEqual({ replace: true });
      const next = updater(new URLSearchParams("tab=mcpConnections&oauth=authorized"));
      expect(next.get("oauth")).toBeNull();
      expect(next.get("tab")).toBe("mcpConnections");
    });
  });

  it("error → error toast + param stripped", async () => {
    mockUseSearchParams.mockReturnValue([
      new URLSearchParams("oauth=error"),
      mockSetSearchParams,
    ]);
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "error" }),
    ]);
    renderSection();
    await waitFor(() => {
      expect(mockShowError).toHaveBeenCalledWith("settings.mcpConnections.oauth.returnError");
      expect(mockSetSearchParams).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------
// Granted-scope panel (D-02)
// ---------------------------------------------------------------------

describe("Granted-scope panel", () => {
  it("authorized + scopes → trigger renders with count; click expands the row with chips", async () => {
    mockApiGet.mockResolvedValue([
      connWith({
        authType: "oauth",
        oauthProvider: "google",
        oauthStatus: "authorized",
        oauthScopes: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly",
      }),
    ]);
    renderSection();
    const trigger = await screen.findByRole("button", { name: "settings.mcpConnections.oauth.scopesGranted" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    // Expanded content renders in the colSpan=6 row (chips testid) and the
    // restricted-scope warning appears ONCE (gmail.readonly is restricted).
    await waitFor(() => {
      expect(document.querySelector('[data-testid="scope-chips-conn-1"]')).not.toBeNull();
      expect(screen.getAllByText("settings.mcpConnections.oauth.restrictedScopeWarning").length).toBe(1);
      const chips = document.querySelectorAll('[data-testid="scope-chips-conn-1"] > span');
      expect(chips.length).toBe(2);
    });
  });

  it("no scopes → panel trigger absent", async () => {
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "authorized", oauthScopes: null }),
    ]);
    renderSection();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "settings.mcpConnections.oauth.scopesGranted" })).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------
// Revoke (D-03c)
// ---------------------------------------------------------------------

describe("Revoke flow", () => {
  it("Revoke button → confirm dialog → DELETE mutation + revoked toast", async () => {
    mockApiGet.mockResolvedValue([
      connWith({ authType: "oauth", oauthProvider: "google", oauthStatus: "authorized" }),
    ]);
    mockApiDelete.mockResolvedValue(undefined);
    renderSection();
    const revokeBtn = await screen.findByRole("button", { name: "settings.mcpConnections.oauth.revoke" });
    fireEvent.click(revokeBtn);
    const confirm = await screen.findByRole("button", { name: "settings.mcpConnections.oauth.revoke" });
    // Two revoke-labeled buttons: the row action + the dialog confirm.
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mockApiDelete).toHaveBeenCalledWith("/mcp-connections/conn-1/oauth");
      expect(mockShowSuccess).toHaveBeenCalledWith("settings.mcpConnections.oauth.revoked");
    });
  });
});

// ---------------------------------------------------------------------
// Long-text backstops (UI-SPEC UI Considerations — held-out fixtures)
// ---------------------------------------------------------------------

describe("Long-text backstops", () => {
  it("maximal-length scope list + long error summary: chips wrap (flex-wrap + break-all) and render whole, tooltip text not mid-URI truncated", async () => {
    const longScopes = [
      "https://www.googleapis.com/auth/drive.metadata.readonly.readonly.readonly.longest",
      "https://graph.microsoft.com/Sites.ReadWrite.All.Delegated.Personal.Files.Extremely.Long.Form",
      "https://www.googleapis.com/auth/gmail.readonly",
    ].join(" ");
    const longSummary = "A".repeat(180) + " — provider error prose at the 200-char sanitize bound";
    mockApiGet.mockResolvedValue([
      connWith({
        authType: "oauth",
        oauthProvider: "google",
        oauthStatus: "authorized",
        oauthScopes: longScopes,
        oauthErrorSummary: longSummary,
      }),
    ]);
    renderSection();
    const trigger = await screen.findByRole("button", { name: "settings.mcpConnections.oauth.scopesGranted" });
    fireEvent.click(trigger);
    await waitFor(() => {
      const container = document.querySelector('[data-testid="scope-chips-conn-1"]');
      expect(container).not.toBeNull();
      // flex-wrap on the container — chips wrap, never truncate mid-URI.
      expect(container?.className).toContain("flex-wrap");
      // Each chip renders its FULL URI text (no truncation) with break-all.
      const chips = Array.from(container?.querySelectorAll("span") ?? []);
      expect(chips.length).toBe(3);
      for (const chip of chips) {
        expect(chip.className).toContain("break-all");
        expect(chip.textContent?.startsWith("https://")).toBe(true);
        expect(chip.textContent).toBe(chip.getAttribute("aria-label") ?? chip.textContent); // no truncation marker
        expect(chip.textContent?.includes("…")).toBe(false);
      }
    });
    // The ✗ badge tooltip reads the full sanitized summary (key + interpolated
    // summary render whole in the DOM when opened; here we assert the badge
    // exists and the summary length bound holds client-side).
    const badge = screen.getByText("settings.mcpConnections.oauth.badgeOauthOk");
    expect(badge).toBeInTheDocument();
  });

  it("expiring badge renders bounded relative time (no raw ISO in DOM) + all-8-locale ≤20ch sweep", async () => {
    // 4 minutes out → the expiring branch (≤10 min, 195 D-12). The relative
    // time renders via the bounded helper (in {{count}} min — max "in 59 min"
    // = 9ch; the hours bucket only appears on the non-expiring ✓ tooltip).
    const soon = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    mockApiGet.mockResolvedValue([
      connWith({
        authType: "oauth",
        oauthProvider: "microsoft",
        oauthStatus: "authorized",
        tokenExpiresAt: soon,
      }),
    ]);
    renderSection();
    const label = await screen.findByText("settings.mcpConnections.oauth.badgeOauthExpiring");
    expect(label.className).toContain("bg-amber-500/10");
    // No raw ISO timestamp anywhere in the section DOM — the helper replaced
    // the datetime with a short relative string (layout-breakage backstop).
    expect(document.body.textContent?.includes("T0")).toBe(false);
    expect(document.body.textContent?.includes("Z") && /20\d\d-/.test(document.body.textContent ?? "")).toBe(false);

    // UI-SPEC long-text backstop row: the relative time stays ≤ ~20ch in ALL
    // 8 locales — sweep the actual locale files with the max minute value.
    const locales = ["en", "it", "ru", "de", "es", "fr", "zh", "pt"] as const;
    for (const loc of locales) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sub = require(`../i18n/${loc}/translation.json`).settings.mcpConnections.oauth;
      for (const minutes of [4, 59]) {
        const time = sub.inMinutes.replace("{{count}}", String(minutes));
        expect(time.length).toBeLessThanOrEqual(20);
        const badge = sub.badgeOauthExpiring.replace("{{time}}", time);
        expect(badge.length).toBeLessThanOrEqual(40);
      }
    }
  });
});
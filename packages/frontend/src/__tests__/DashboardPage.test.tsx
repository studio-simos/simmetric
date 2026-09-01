// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DashboardPage component tests — Feature 3.3 (new landing page).
 *
 * Status cards (tier / airgap / tokens today), the current-workspace card,
 * the quick-links grid, and the knowledge snapshot (archives + synthesis
 * pending). We mock the query/context/page-meta dependencies.
 */
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      let s = key;
      for (const [k, v] of Object.entries(opts)) {
        s = s.replace(new RegExp(`{{${k}}}`, "g"), String(v));
      }
      return s;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockUseChatNav = jest.fn();
jest.mock("../contexts/ChatContext", () => ({
  useChatNav: () => mockUseChatNav(),
}));

const mockUseWorkspaces = jest.fn();
jest.mock("../queries/useWorkspaces", () => ({
  useWorkspaces: () => mockUseWorkspaces(),
}));

const mockUseLicenseInfo = jest.fn();
jest.mock("../queries/useLicense", () => ({
  useLicenseInfo: () => mockUseLicenseInfo(),
}));

const mockUseSessionTokens = jest.fn();
jest.mock("../queries/useChatTokens", () => ({
  useSessionTokens: (...args: unknown[]) => mockUseSessionTokens(...args),
}));

const mockUseSynthesisPendingCount = jest.fn();
jest.mock("../queries/useSynthesis", () => ({
  useSynthesisPendingCount: () => mockUseSynthesisPendingCount(),
}));

const mockUseArchives = jest.fn();
jest.mock("../queries/useArchives", () => ({
  useArchives: () => mockUseArchives(),
}));

jest.mock("@/hooks/usePageMeta", () => ({
  usePageMeta: () => {},
}));

import { render, screen, fireEvent } from "@testing-library/react";
import DashboardPage from "../components/DashboardPage";

function setup({
  workspaceId = "ws-1",
  workspaces = [{ id: "ws-1", name: "Research Lab" }],
  license = { tier: "community" },
  tokens = undefined,
  pending = { count: 0 },
  archives = [],
}: {
  workspaceId?: string | null;
  workspaces?: { id: string; name: string }[];
  license?: { tier: string } | null;
  tokens?: { totalInput: number; totalOutput: number } | null;
  pending?: { count: number };
  archives?: unknown[];
} = {}) {
  mockUseChatNav.mockReturnValue({ currentWorkspaceId: workspaceId });
  mockUseWorkspaces.mockReturnValue({ data: workspaces });
  mockUseLicenseInfo.mockReturnValue({ data: license });
  mockUseSessionTokens.mockReturnValue({ data: tokens });
  mockUseSynthesisPendingCount.mockReturnValue({ data: pending });
  mockUseArchives.mockReturnValue({ data: archives });

  return render(<DashboardPage />);
}

describe("DashboardPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the welcome heading and subtitle", () => {
    setup();
    expect(screen.getByText("dashboard.welcome")).toBeInTheDocument();
    expect(screen.getByText("dashboard.subtitle")).toBeInTheDocument();
  });

  it("renders the three status cards (tier / airgap / tokens today)", () => {
    setup({ license: { tier: "enterprise" }, tokens: { totalInput: 100, totalOutput: 200 } });
    expect(screen.getByText("dashboard.status.tier")).toBeInTheDocument();
    expect(screen.getByText("dashboard.status.airgap")).toBeInTheDocument();
    expect(screen.getByText("dashboard.status.tokensToday")).toBeInTheDocument();
    // Enterprise tier is rendered uppercase.
    expect(screen.getByText("ENTERPRISE")).toBeInTheDocument();
    // Token total 300 (jsdom: no grouping).
    expect(screen.getByText("300")).toBeInTheDocument();
  });

  it("renders the current workspace card when a workspace is active", () => {
    setup();
    expect(screen.getByText("Research Lab")).toBeInTheDocument();
    expect(screen.getByText("dashboard.currentWorkspace")).toBeInTheDocument();
  });

  it("shows the no-workspace state when no workspace matches", () => {
    setup({ workspaceId: null, workspaces: [{ id: "ws-1", name: "X" }] });
    expect(screen.getByText("dashboard.noWorkspace")).toBeInTheDocument();
    expect(screen.queryByText("dashboard.currentWorkspace")).not.toBeInTheDocument();
  });

  it("navigates home when the Open Chat button is clicked", () => {
    setup();
    fireEvent.click(screen.getByText("dashboard.openChat"));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("renders the quick-links grid and navigates on click", () => {
    setup();
    expect(screen.getByText("dashboard.quickLinks")).toBeInTheDocument();
    // A known quick-link label (sidebar.chat) rendered as a link button.
    fireEvent.click(screen.getByText("sidebar.chat"));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("renders the knowledge snapshot (archives count + synthesis pending)", () => {
    setup({ pending: { count: 2 }, archives: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] });
    expect(screen.getByText("dashboard.kb.archives")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("dashboard.kb.synthesisPending")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
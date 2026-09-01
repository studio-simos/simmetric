// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TokenStatsDetail component tests (Feature 2: Token Counter).
 *
 * TokenStatsDetail is the presentational Conversation/Today breakdown reused
 * inside the RightPanel "Token Stats" collapsible tendina (quick 260723-nnr
 * follow-up 3). It renders no header/close button — the host section owns
 * those — so the title + onClose assertions from the old chat-area
 * TokenCounterPanel wrapper are gone.
 */
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockUseChatTokens = jest.fn();
const mockUseSessionTokens = jest.fn();

jest.mock("../queries/useChatTokens", () => ({
  useChatTokens: (...args: unknown[]) => mockUseChatTokens(...args),
  useSessionTokens: (...args: unknown[]) => mockUseSessionTokens(...args),
}));

import { render, screen, fireEvent } from "@testing-library/react";
import TokenStatsDetail from "../components/TokenCounterPanel";

const PROPS = {
  workspaceId: "ws-1",
  chatId: "chat-1",
};

describe("TokenStatsDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the conversation totals", () => {
    mockUseChatTokens.mockReturnValue({
      data: { totalInput: 170, totalOutput: 110, total: 280 },
      isLoading: false,
    });
    mockUseSessionTokens.mockReturnValue({
      data: { totalInput: 0, totalOutput: 0, total: 0 },
      isLoading: false,
    });

    render(<TokenStatsDetail {...PROPS} />);

    // Numbers are formatted (170 stays as "170", 1100 -> "1.1k")
    expect(screen.getByText("170")).toBeInTheDocument();
    expect(screen.getByText("110")).toBeInTheDocument();
    expect(screen.getByText("280")).toBeInTheDocument();
  });

  it("formats thousands with k suffix", () => {
    mockUseChatTokens.mockReturnValue({
      data: { totalInput: 1500, totalOutput: 2500, total: 4000 },
      isLoading: false,
    });
    mockUseSessionTokens.mockReturnValue({
      data: { totalInput: 0, totalOutput: 0, total: 0 },
      isLoading: false,
    });

    render(<TokenStatsDetail {...PROPS} />);

    expect(screen.getByText("1.5k")).toBeInTheDocument();
    expect(screen.getByText("2.5k")).toBeInTheDocument();
    expect(screen.getByText("4k")).toBeInTheDocument();
  });

  it("switches to the Today view", () => {
    mockUseChatTokens.mockReturnValue({
      data: { totalInput: 100, totalOutput: 50, total: 150 },
      isLoading: false,
    });
    mockUseSessionTokens.mockReturnValue({
      data: { totalInput: 5000, totalOutput: 3000, total: 8000 },
      isLoading: false,
    });

    render(<TokenStatsDetail {...PROPS} />);

    fireEvent.click(screen.getByText("Today"));
    expect(screen.getByText("5k")).toBeInTheDocument();
    expect(screen.getByText("3k")).toBeInTheDocument();
    expect(screen.getByText("8k")).toBeInTheDocument();
  });

  it("shows empty state when conversation has no usage", () => {
    mockUseChatTokens.mockReturnValue({
      data: { totalInput: 0, totalOutput: 0, total: 0 },
      isLoading: false,
    });
    mockUseSessionTokens.mockReturnValue({
      data: { totalInput: 0, totalOutput: 0, total: 0 },
      isLoading: false,
    });

    render(<TokenStatsDetail {...PROPS} />);

    expect(
      screen.getByText("No token usage recorded for this conversation yet.")
    ).toBeInTheDocument();
  });
});
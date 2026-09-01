// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KnowledgeBasePage component tests — Feature 3.3 (knowledge hub landing page).
 *
 * Hub cards (Archives / Synthesis), the recent-archives list (loading / empty /
 * populated), the New Archive button → dialog, and the view-all link. We mock
 * the query/router/page-meta dependencies and stub ArchiveCard +
 * ArchiveCreateDialog.
 */
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockUseArchives = jest.fn();
jest.mock("../queries/useArchives", () => ({
  useArchives: () => mockUseArchives(),
}));

const mockUseSynthesisPendingCount = jest.fn();
jest.mock("../queries/useSynthesis", () => ({
  useSynthesisPendingCount: () => mockUseSynthesisPendingCount(),
}));

jest.mock("@/hooks/usePageMeta", () => ({
  usePageMeta: () => {},
}));

// Stub the heavy child components — the page owns layout + dialog open state.
jest.mock("../components/ArchiveCard", () => ({
  __esModule: true,
  default: ({ archive }: { archive: { id: string } }) => (
    <div data-testid={`archive-card-${archive.id}`} />
  ),
}));

jest.mock("../components/ArchiveCreateDialog", () => ({
  __esModule: true,
  default: ({ open }: { open: boolean; onOpenChange: (o: boolean) => void }) =>
    open ? <div data-testid="create-dialog" /> : null,
}));

import { render, screen, fireEvent } from "@testing-library/react";
import KnowledgeBasePage from "../components/KnowledgeBasePage";

function setup({
  archives = [],
  loading = false,
  pending = { count: 0 },
}: {
  archives?: { id: string }[];
  loading?: boolean;
  pending?: { count: number };
} = {}) {
  mockUseArchives.mockReturnValue({ data: archives, isLoading: loading });
  mockUseSynthesisPendingCount.mockReturnValue({ data: pending });
  return render(<KnowledgeBasePage />);
}

describe("KnowledgeBasePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the page title, subtitle, and New Archive button", () => {
    setup();
    expect(screen.getByText("knowledgeBase.pageTitle")).toBeInTheDocument();
    expect(screen.getByText("knowledgeBase.subtitle")).toBeInTheDocument();
    expect(screen.getByText("archives.newArchive")).toBeInTheDocument();
  });

  it("renders the two hub cards and navigates to their destinations on click", () => {
    setup({ pending: { count: 5 } });
    // Archives hub → /archives
    fireEvent.click(screen.getByText("archives.title").closest("button")!);
    expect(mockNavigate).toHaveBeenLastCalledWith("/archives");

    // Synthesis hub → /synthesis
    fireEvent.click(screen.getByText("synthesis.sidebar.label").closest("button")!);
    expect(mockNavigate).toHaveBeenLastCalledWith("/synthesis");
  });

  it("shows the loading placeholder while archives are loading", () => {
    setup({ loading: true });
    expect(screen.getByText("common.loading")).toBeInTheDocument();
  });

  it("shows the empty state when there are no archives", () => {
    setup({ archives: [] });
    expect(screen.getByText("archives.empty.body")).toBeInTheDocument();
  });

  it("renders up to six archive cards when archives exist", () => {
    const archives = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}` }));
    setup({ archives });
    // Only the first six are sliced into the grid.
    archives.slice(0, 6).forEach((a) => {
      expect(screen.getByTestId(`archive-card-${a.id}`)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("archive-card-a6")).not.toBeInTheDocument();
  });

  it("navigates to /archives via the view-all link", () => {
    setup();
    fireEvent.click(screen.getByText("knowledgeBase.viewAll"));
    expect(mockNavigate).toHaveBeenCalledWith("/archives");
  });

  it("opens the create-archive dialog when the New Archive button is clicked", () => {
    setup();
    expect(screen.queryByTestId("create-dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("archives.newArchive"));
    expect(screen.getByTestId("create-dialog")).toBeInTheDocument();
  });
});
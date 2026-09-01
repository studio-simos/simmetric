// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DocumentViewerPage tests — loading, error, success (markdown render),
 * empty text, processing, copy button.
 *
 * Mirrors ArchivePageFullView.test.tsx mock setup: mock react-i18next,
 * renderMarkdown, toast, and the useDocumentText hook. Wraps in
 * MemoryRouter so useParams/useNavigate work in isolation.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("../utils/markdown", () => ({
  renderMarkdown: (text: string) => `<div>${text}</div>`,
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

const useDocumentTextMock = jest.fn();
jest.mock("../queries/useDocuments", () => ({
  useDocumentText: (...args: unknown[]) => useDocumentTextMock(...args),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderWithProviders } from "./test-utils";
import { showSuccess } from "../lib/toast";
import DocumentViewerPage from "../components/DocumentViewerPage";

// ── Mock data ────────────────────────────────────────────────────

const completedFixture = {
  text: "# Report\n\nSome extracted text.",
  length: 30,
  name: "report.md",
  type: "md",
  status: "completed",
};

function renderViewer(route = "/documents/doc-1") {
  return renderWithProviders(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/documents/:id" element={<DocumentViewerPage />} />
        <Route path="/documents" element={<div data-testid="documents-list" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: completed document with text.
  useDocumentTextMock.mockReturnValue({
    data: completedFixture,
    isLoading: false,
    error: null,
  });
  // clipboard stub
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

// ── Tests ────────────────────────────────────────────────────────

describe("DocumentViewerPage", () => {
  it("loading: renders Skeleton placeholder", () => {
    useDocumentTextMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    renderViewer();
    // Skeleton renders inside the Card header.
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("error: renders documents.notFound copy", () => {
    useDocumentTextMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Network error"),
    });
    renderViewer();
    expect(screen.getByText("documents.notFound")).toBeInTheDocument();
  });

  it("success: renders markdown body via renderMarkdown", () => {
    renderViewer();
    // renderMarkdown mock wraps in <div>; body text appears via dangerouslySetInnerHTML.
    expect(screen.getByText(/Some extracted text\./)).toBeInTheDocument();
    // Header shows document name.
    expect(screen.getByText("report.md")).toBeInTheDocument();
  });

  it("DOC-01 success: body container is a single vertical scroll (overflow-y-auto) — no pagination", () => {
    renderViewer();
    // The CardContent body uses overflow-y-auto so long documents scroll in
    // one column instead of paginating. Assert the structural invariante.
    const scrollContainer = document.querySelector(".overflow-y-auto");
    expect(scrollContainer).toBeInTheDocument();
    // No pagination controls rendered in the read-only viewer.
    expect(screen.queryByRole("button", { name: /prev|next|page/i })).not.toBeInTheDocument();
  });

  it("empty text: renders documents.emptyTextBody copy", () => {
    useDocumentTextMock.mockReturnValue({
      data: { ...completedFixture, text: "" },
      isLoading: false,
      error: null,
    });
    renderViewer();
    expect(screen.getByText("documents.emptyTextTitle")).toBeInTheDocument();
    expect(screen.getByText("documents.emptyTextBody")).toBeInTheDocument();
  });

  it("processing: renders documents.processing copy when status !== completed", () => {
    useDocumentTextMock.mockReturnValue({
      data: { ...completedFixture, status: "processing", text: "" },
      isLoading: false,
      error: null,
    });
    renderViewer();
    expect(screen.getByText("documents.processing")).toBeInTheDocument();
  });

  it("copy button: calls navigator.clipboard.writeText + showSuccess", async () => {
    renderViewer();
    const copyBtn = screen.getByRole("button", { name: /documents\.copyText/ });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        completedFixture.text,
      );
    });
    await waitFor(() => {
      expect(showSuccess).toHaveBeenCalledWith("documents.copySuccess");
    });
  });

  it("back button: renders documents.backToList label", () => {
    renderViewer();
    expect(
      screen.getAllByText("documents.backToList").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
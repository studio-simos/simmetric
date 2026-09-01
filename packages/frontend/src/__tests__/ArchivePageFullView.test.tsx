// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchivePageFullView edit-mode tests (KBPG-03 / D-03 / D-05 / D-06)
 *
 * Covers: read-mode render, edit toggle, save (mutateAsync + exit), 400
 * violations banner (persistent, edit stays open), 409 concurrent conflict
 * (toast + invalidate + exit), preview toggle (renderMarkdown of draft),
 * cancel (exits edit, read content preserved).
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// Mock markdown renderer (avoid DOMPurify/highlight.js in jsdom).
jest.mock("../utils/markdown", () => ({
  renderMarkdown: (text: string) => `<div>${text}</div>`,
}));

jest.mock("../lib/toast", () => ({
  showInfo: jest.fn(),
  showError: jest.fn(),
  showSuccess: jest.fn(),
}));

const useArchivePageMock = jest.fn();
const mutateAsyncMock = jest.fn();
jest.mock("../queries/useArchives", () => ({
  useArchivePage: (...args: unknown[]) => useArchivePageMock(...args),
  useUpdatePage: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
}));

// Mock useQueryClient so 409-path invalidateQueries is observable. Keep the
// rest of @tanstack/react-query real so QueryClientProvider still works.
const mockQueryClient = { invalidateQueries: jest.fn() };
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => mockQueryClient,
  };
});

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import { ApiError } from "../utils/api";
import { showError } from "../lib/toast";
import ArchivePageFullView from "../components/ArchivePageFullView";
import type { ArchivePage } from "../queries/useArchives";

// ── Mock data ────────────────────────────────────────────────────

function mockPage(overrides: Partial<ArchivePage> = {}): ArchivePage {
  return {
    id: "page-1",
    archiveId: "archive-1",
    slug: "page-one",
    title: "Page One",
    category: "entities",
    frontmatter: null,
    bodyText: "# Page One\n\nContent.",
    contentHash: "abc",
    wikilinks: [],
    deletedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderView(props: Partial<React.ComponentProps<typeof ArchivePageFullView>> = {}) {
  const defaults: React.ComponentProps<typeof ArchivePageFullView> = {
    archiveId: "archive-1",
    slug: "page-one",
  };
  return renderWithProviders(<ArchivePageFullView {...defaults} {...props} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  useArchivePageMock.mockReturnValue({
    data: mockPage(),
    isLoading: false,
    error: null,
  });
  mutateAsyncMock.mockResolvedValue({});
});

// ── Tests ────────────────────────────────────────────────────────

describe("ArchivePageFullView", () => {
  it("read mode: renders page body via renderMarkdown", () => {
    renderView();
    // Body text "Content." appears only in the rendered body, not the title.
    expect(screen.getByText(/Content\./)).toBeInTheDocument();
  });

  it("edit toggle: clicking Edit shows textarea with draftBody = page.bodyText", () => {
    renderView();
    fireEvent.click(screen.getByTestId("archive-page-edit-btn"));
    const textarea = screen.getByTestId("archive-page-edit-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe("# Page One\n\nContent.");
  });

  it("save: calls mutateAsync with { archiveId, slug, data: { body } } and exits edit on success", async () => {
    renderView();
    fireEvent.click(screen.getByTestId("archive-page-edit-btn"));
    const textarea = screen.getByTestId("archive-page-edit-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "# Edited\n\nNew body." } });
    fireEvent.click(screen.getByTestId("archive-page-save-btn"));
    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        archiveId: "archive-1",
        slug: "page-one",
        data: { body: "# Edited\n\nNew body." },
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("archive-page-edit-textarea")).not.toBeInTheDocument();
    });
  });

  it("400 violations: shows persistent violations banner and edit stays open", async () => {
    mutateAsyncMock.mockRejectedValue(
      new ApiError(400, "Schema validation failed", { violations: ["no empty heading"] }),
    );
    renderView();
    fireEvent.click(screen.getByTestId("archive-page-edit-btn"));
    fireEvent.click(screen.getByTestId("archive-page-save-btn"));
    await waitFor(() => {
      expect(screen.getByText("no empty heading")).toBeInTheDocument();
    });
    // Edit mode persists (textarea still present).
    expect(screen.getByTestId("archive-page-edit-textarea")).toBeInTheDocument();
  });

  it("409 concurrent: shows error toast, invalidates page query, exits edit mode", async () => {
    mutateAsyncMock.mockRejectedValue(new ApiError(409, "Conflict"));
    renderView();
    fireEvent.click(screen.getByTestId("archive-page-edit-btn"));
    fireEvent.click(screen.getByTestId("archive-page-save-btn"));
    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("archives.page.concurrentConflict");
    });
    expect(mockQueryClient.invalidateQueries).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByTestId("archive-page-edit-textarea")).not.toBeInTheDocument();
    });
  });

  it("preview toggle: renders renderMarkdown output of draftBody", () => {
    renderView();
    fireEvent.click(screen.getByTestId("archive-page-edit-btn"));
    // Source textarea visible before preview.
    expect(screen.getByTestId("archive-page-edit-textarea")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("archive-page-preview-btn"));
    // Textarea replaced by preview render.
    expect(screen.queryByTestId("archive-page-edit-textarea")).not.toBeInTheDocument();
    // renderMarkdown mock wraps in <div>; body text rendered via dangerouslySetInnerHTML.
    expect(screen.getByText(/Content\./)).toBeInTheDocument();
  });

  it("cancel: exits edit mode and read content is preserved", () => {
    renderView();
    fireEvent.click(screen.getByTestId("archive-page-edit-btn"));
    const textarea = screen.getByTestId("archive-page-edit-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "discarded draft" } });
    fireEvent.click(screen.getByTestId("archive-page-cancel-btn"));
    expect(screen.queryByTestId("archive-page-edit-textarea")).not.toBeInTheDocument();
    // Original read-mode body still present.
    expect(screen.getByText(/Content\./)).toBeInTheDocument();
  });
});
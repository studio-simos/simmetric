// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveSidebar component smoke tests
 *
 * Verifies the standalone sidebar renders search input, category badges,
 * page list items, and handles click events correctly.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mutateAsyncMock = jest.fn().mockResolvedValue({});
const deletePageMock = jest.fn().mockResolvedValue({});
jest.mock("../queries/useArchives", () => ({
  useUpdatePage: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
  useDeletePage: () => ({ mutateAsync: deletePageMock, isPending: false }),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import ArchiveSidebar from "../components/ArchiveSidebar";
import type { ArchivePage } from "../queries/useArchives";

// ── Mock data ────────────────────────────────────────────────────

function mockPages(): ArchivePage[] {
  return [
    {
      id: "page-1",
      archiveId: "test-archive-id",
      slug: "page-one",
      title: "Page One",
      category: "entities",
      frontmatter: null,
      bodyText: "Content of page one.",
      contentHash: "abc123",
      wikilinks: ["page-two"],
      relatedCount: 3,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "page-2",
      archiveId: "test-archive-id",
      slug: "page-two",
      title: "Page Two",
      category: "concepts",
      frontmatter: null,
      bodyText: "Content of page two.",
      contentHash: "def456",
      wikilinks: [],
      relatedCount: 0,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
}

function renderSidebar(props: Partial<{
  archiveId: string;
  pages: ArchivePage[];
  onPageClick: (slug: string) => void;
  onDeletePage: (slug: string) => void;
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}> = {}) {
  const defaults = {
    archiveId: "test-archive",
    pages: mockPages(),
    onPageClick: jest.fn(),
    onDeletePage: jest.fn(),
    selectedCategory: "all",
    onCategoryChange: jest.fn(),
    searchQuery: "",
    onSearchChange: jest.fn(),
  };
  return render(<ArchiveSidebar {...defaults} {...props} />);
}

// ── Tests ────────────────────────────────────────────────────────

describe("ArchiveSidebar", () => {
  it("renders search input", () => {
    renderSidebar();
    expect(
      screen.getByPlaceholderText("archiveDetail.searchPlaceholder")
    ).toBeInTheDocument();
  });

  it("renders category badges", () => {
    renderSidebar();
    expect(screen.getByText("archiveDetail.categories.all")).toBeInTheDocument();
    expect(screen.getByText("archiveDetail.categories.entities")).toBeInTheDocument();
    expect(screen.getByText("archiveDetail.categories.concepts")).toBeInTheDocument();
    expect(screen.getByText("archiveDetail.categories.decisions")).toBeInTheDocument();
  });

  it("renders page list items", () => {
    renderSidebar();
    expect(screen.getByText("Page One")).toBeInTheDocument();
    expect(screen.getByText("Page Two")).toBeInTheDocument();
    // Page rows no longer carry a FileText icon; title sits on its own line.
    const rowIcons = document.querySelectorAll("[class*='cursor-pointer'] .lucide-file-text");
    expect(rowIcons.length).toBe(0);
    // Rename (Pencil) action buttons are always visible, not only on hover.
    // Per-row delete (Trash2) was removed in quick task 2db70973 — deletion
    // is now bulk-only via the toolbar 'Delete Selected' button.
    const pencilButtons = document.querySelectorAll(".lucide-pencil");
    expect(pencilButtons.length).toBeGreaterThanOrEqual(2);
    const trashButtons = document.querySelectorAll(".lucide-trash-2");
    expect(trashButtons.length).toBe(0);
  });

  // Quick 260723-ke9: the per-row counter is now the i18n "relatedPages"
  // label (topic-overlap related page count), not the raw wikilinks length.
  // The mock useTranslation returns the key verbatim, so we assert the key
  // renders for each page row.
  it("renders the relatedPages label for each page row (quick 260723-ke9)", () => {
    renderSidebar();
    const labels = screen.getAllByText("archives.page.relatedPages");
    expect(labels.length).toBe(2);
  });

  it("calls onPageClick when page clicked", () => {
    const onPageClick = jest.fn();
    renderSidebar({ onPageClick });
    fireEvent.click(screen.getByText("Page One"));
    expect(onPageClick).toHaveBeenCalledWith("page-one");
  });

  // KBPG-01 (D-07): native overflow-y-auto scrollbar replaces radix ScrollArea
  it("scroll container has overflow-y-auto class", () => {
    const { container } = renderSidebar();
    expect(container.querySelector(".overflow-y-auto")).not.toBeNull();
  });

  it("does not render a radix ScrollArea viewport", () => {
    const { container } = renderSidebar();
    expect(container.querySelector("[data-radix-scroll-area-viewport]")).toBeNull();
  });

  // KBPG-02 (D-01/D-02): inline rename pencil per row
  describe("inline rename", () => {
    beforeEach(() => {
      mutateAsyncMock.mockClear();
      mutateAsyncMock.mockResolvedValue({});
    });

    it("pencil click renders an Input prefilled with the page title", () => {
      renderSidebar();
      const pencil = screen.getAllByLabelText("archives.page.rename")[0];
      fireEvent.click(pencil);
      const input = document.querySelector("input[type='text']") as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe("Page One");
    });

    it("Enter saves the new title via useUpdatePage", async () => {
      renderSidebar();
      fireEvent.click(screen.getAllByLabelText("archives.page.rename")[0]);
      const input = document.querySelector("input[type='text']") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "New Title" } });
      fireEvent.submit(input.form!);
      await Promise.resolve();
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        archiveId: "test-archive",
        slug: "page-one",
        data: { title: "New Title" },
      });
    });

    it("Escape cancels rename without calling mutateAsync", () => {
      renderSidebar();
      fireEvent.click(screen.getAllByLabelText("archives.page.rename")[0]);
      const input = document.querySelector("input[type='text']") as HTMLInputElement;
      fireEvent.keyDown(input, { key: "Escape" });
      expect(mutateAsyncMock).not.toHaveBeenCalled();
      expect(document.querySelector("input[type='text']")).toBeNull();
    });

    it("empty input on Enter is rejected (no mutation)", async () => {
      renderSidebar();
      fireEvent.click(screen.getAllByLabelText("archives.page.rename")[0]);
      const input = document.querySelector("input[type='text']") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.submit(input.form!);
      await Promise.resolve();
      expect(mutateAsyncMock).not.toHaveBeenCalled();
    });
  });
});

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * OcrPreviewModal component tests — UX-02 per-page binding (Phase 179)
 *
 * Wave 0 gap closed: this component previously had ZERO tests. The suite pins
 * the D-02 contract: BOTH panes render from the same pageResults slice the
 * left pane paginates; page identity flows from server-provided pageNumber;
 * no cross-page markdown concatenation remains (T-179-03).
 */

import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

const approveMutate = jest.fn().mockResolvedValue(undefined);
const rejectMutate = jest.fn().mockResolvedValue(undefined);

jest.mock("../../queries/useOcrJobs", () => ({
  useApproveOcrJob: () => ({ mutateAsync: approveMutate }),
  useRejectOcrJob: () => ({ mutateAsync: rejectMutate }),
}));

jest.mock("../../queries/keys", () => ({
  queryKeys: {
    archive: { pages: (id: string) => ["archives", id, "pages"] },
  },
}));

// renderMarkdown passthrough with a marker so tests can see what was rendered
jest.mock("../../utils/markdown", () => ({
  renderMarkdown: (md: string) => (md ? `<p data-rendered="1">${md}</p>` : ""),
}));

import OcrPreviewModal from "../OcrPreviewModal";
import type { OcrJob } from "../../queries/useOcrJobs";

function makeJob(pageCount: number, overrides: Partial<OcrJob["result"]> = {}): OcrJob {
  return {
    id: "job-1",
    archiveId: "arch-1",
    type: "OCR",
    status: "COMPLETED",
    progress: 100,
    totalPages: pageCount,
    processedPages: pageCount,
    currentPage: null,
    modelName: "test-model",
    sourceFileName: "multi-page.pdf",
    contentHash: null,
    result: {
      hasUnverified: false,
      pageResults: Array.from({ length: pageCount }, (_, i) => ({
        pageNumber: i + 1, // 1-based server identity
        markdown: `PAGE_${i + 1}_TEXT`,
        imagePath: `/page/${i + 1}.png`,
        tokensUsed: 10,
        durationMs: 100,
      })),
      ...overrides,
    },
    error: null,
    createdBy: "u1",
    createdAt: "2026-08-30T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
  };
}

function renderModal(job: OcrJob) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OcrPreviewModal job={job} archiveId="arch-1" open onClose={jest.fn()} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem("token", "test-token");
});

describe("OcrPreviewModal per-page binding (UX-02)", () => {
  it("multi-page job: right pane initially shows ONLY page 1 text, not the concatenation", () => {
    renderModal(makeJob(3));
    // Both layouts (desktop + mobile) render the same slice — each shows only
    // page 1's text, and pages 2/3 never leak in
    expect(screen.getAllByText("PAGE_1_TEXT").length).toBe(2);
    expect(screen.queryByText("PAGE_2_TEXT")).toBeNull();
    expect(screen.queryByText("PAGE_3_TEXT")).toBeNull();
  });

  it("after goNext to index 1: right pane shows exactly page 2's markdown (same slice as left pane)", () => {
    renderModal(makeJob(3));
    // Two pagers (desktop + mobile layouts) — use the first (desktop). The
    // goNext button wraps the lucide ChevronRight icon (lucide-chevron-right).
    const nextButtons = document.querySelectorAll<HTMLButtonElement>(
      "button:has(svg.lucide-chevron-right)"
    );
    expect(nextButtons.length).toBe(2);
    fireEvent.click(nextButtons[0]);
    expect(screen.getAllByText("PAGE_2_TEXT").length).toBe(2);
    expect(screen.queryByText("PAGE_1_TEXT")).toBeNull();
    expect(screen.queryByText("PAGE_3_TEXT")).toBeNull();
    // Page counter reflects 2 of 3 in both layouts
    const counters = screen.getAllByText("ocr.preview.pageOf");
    expect(counters.length).toBe(2);
  });

  it("image URL is keyed by the slice's 1-based pageNumber, never the array index", () => {
    renderModal(makeJob(3));
    // Page 1 visible initially — src carries pageNumber 1
    let img = screen.getByRole("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/pages/1/image?token=");
    expect(img.getAttribute("src")).not.toContain("/pages/0/");
    // Advance two pages — src follows the slice's pageNumber (3), not index (2)
    const nextButtons = document.querySelectorAll<HTMLButtonElement>(
      "button:has(svg.lucide-chevron-right)"
    );
    fireEvent.click(nextButtons[0]);
    fireEvent.click(nextButtons[0]);
    img = screen.getByRole("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain("/pages/3/image?token=");
  });

  it("page with imagePath undefined: no-source placeholder while right pane still renders the markdown", () => {
    const job = makeJob(2);
    job.result!.pageResults![1]!.imagePath = undefined;
    renderModal(job);
    // Page 1 has an image
    expect(screen.getByRole("img")).toBeInTheDocument();
    // Advance to page 2 (no imagePath) — placeholder appears, markdown still renders
    const nextButtons = document.querySelectorAll<HTMLButtonElement>(
      "button:has(svg.lucide-chevron-right)"
    );
    fireEvent.click(nextButtons[0]);
    expect(screen.getByText("ocr.preview.noSourceImage")).toBeInTheDocument();
    expect(screen.getAllByText("PAGE_2_TEXT").length).toBe(2);
  });

  it("empty pageResults: right pane shows the no-markdown empty state (no crash)", () => {
    renderModal(makeJob(0));
    const emptyStates = screen.getAllByText("ocr.preview.noMarkdownExtracted");
    expect(emptyStates.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("pane-equality regression: right pane markdown === left pane slice's markdown for the same index", () => {
    const job = makeJob(3);
    const { container } = renderModal(job);
    // The single rendered markdown element must carry page 1's text at index 0
    const rendered = container.querySelector('[data-rendered="1"]');
    expect(rendered?.textContent).toBe("PAGE_1_TEXT");
    // AND the markdown source bound to the sanitizer is the per-page slice —
    // assert no all-pages concatenation marker leaked ("Page N" header prose)
    expect(rendered?.textContent).not.toContain("## Page");
  });
});
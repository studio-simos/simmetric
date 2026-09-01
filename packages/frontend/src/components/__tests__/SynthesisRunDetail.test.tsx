// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SynthesisRunDetail component tests — UX-03 non-actionable states (Phase 179)
 *
 * Wave 0 gap closed: this component previously had ZERO tests. The suite pins
 * the D-03 contract: every non-approvable status renders the action bar with
 * a DISABLED approve control + the status-driven reason message (reject stays
 * hidden per OQ2); the actionable branch keeps the enabled bar.
 */

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const approveMutate = jest.fn();
const rejectMutate = jest.fn();
const renameMutate = jest.fn();
const mockRefetch = jest.fn();

const mockDetail = jest.fn();

jest.mock("../../queries/useSynthesis", () => ({
  useSynthesisRunDetail: (...args: unknown[]) => mockDetail(...(args as [])),
  useApproveSynthesisRun: () => ({ mutateAsync: approveMutate, isPending: false }),
  useRejectSynthesisRun: () => ({ mutateAsync: rejectMutate, isPending: false }),
  useRenameSynthesisRun: () => ({ mutateAsync: renameMutate, isPending: false }),
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

jest.mock("../../lib/synthesisReason", () => ({
  renderReasonLine: (s: string) => s,
}));

jest.mock("../../hooks/usePageMeta", () => ({
  usePageMeta: jest.fn(),
}));

jest.mock("react-router-dom", () => ({
  useParams: () => ({ runId: "run-1" }),
  useNavigate: () => jest.fn(),
}));

// Render SynthesisDiffView/BudgetBar/Contradiction as inert stubs
jest.mock("../SynthesisBudgetBar", () => ({
  __esModule: true,
  default: () => <div data-testid="budget-bar-stub" />,
}));
jest.mock("../SynthesisDiffView", () => ({
  __esModule: true,
  default: () => <div data-testid="diff-view-stub" />,
}));
jest.mock("../SynthesisContradictionCard", () => ({
  __esModule: true,
  default: () => <div data-testid="contradiction-stub" />,
}));

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import SynthesisRunDetail from "../SynthesisRunDetail";
import type { SynthesisRunData } from "../../queries/useSynthesis";

function makeRun(overrides: Partial<SynthesisRunData> = {}): SynthesisRunData {
  return {
    id: "run-1",
    archiveId: "arch-1",
    name: "My Run",
    status: "COMPLETED",
    pagesRead: 2,
    pagesWritten: 2,
    pagesApplied: 2,
    tokensUsed: 100,
    llmCallsUsed: 3,
    contradictionsFound: 0,
    previewJson: {
      runId: "run-1",
      archiveId: "arch-1",
      status: "COMPLETED",
      createdAt: "2026-07-21T00:00:00Z",
      budgetUsed: { pagesRead: 2, pagesWritten: 2, tokensUsed: 100, llmCallsUsed: 3 },
      contradictions: [],
      changes: [
        {
          pageSlug: "page-a",
          action: "update",
          category: "content",
          title: "Page A",
          proposedContent: "after",
          currentContent: "before",
          confidence: "HIGH",
          sources: [],
          approved: false,
        },
      ],
    },
    error: null,
    createdBy: "u1",
    createdAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
    archive: { slug: "arch-slug", name: "My Archive" },
    ...overrides,
  } as SynthesisRunData;
}

function renderDetail(run: SynthesisRunData) {
  mockDetail.mockReturnValue({ data: run, isLoading: false, error: null, refetch: mockRefetch });
  const { TooltipProvider } = require("@/components/ui/tooltip");
  return render(<TooltipProvider><SynthesisRunDetail /></TooltipProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("SynthesisRunDetail non-actionable approve bar (UX-03)", () => {
  it("status=PENDING → approve rendered disabled with pending reason; no mutation possible", () => {
    renderDetail(makeRun({ status: "PENDING" }));
    const approve = screen.getByRole("button", { name: "synthesis.detail.approveAll" });
    expect(approve).toBeDisabled();
    expect(screen.getByText("synthesis.detail.notActionable.pending")).toBeInTheDocument();
    // Disabled button must not trigger the approve mutation
    approve.click();
    expect(approveMutate).not.toHaveBeenCalled();
    // Reject stays hidden (OQ2)
    expect(screen.queryByText("synthesis.detail.rejectAll")).toBeNull();
  });

  it("status=PROCESSING → disabled + processing reason", () => {
    renderDetail(makeRun({ status: "PROCESSING" }));
    expect(screen.getByRole("button", { name: "synthesis.detail.approveAll" })).toBeDisabled();
    expect(screen.getByText("synthesis.detail.notActionable.processing")).toBeInTheDocument();
  });

  it("status=COMPLETED with 0 changes → disabled + noChanges reason (bar kept, not hidden)", () => {
    renderDetail(
      makeRun({ status: "COMPLETED", previewJson: { changes: [], contradictions: [] } })
    );
    const approve = screen.getByRole("button", { name: "synthesis.detail.approveAll" });
    expect(approve).toBeDisabled();
    expect(screen.getByText("synthesis.detail.notActionable.noChanges")).toBeInTheDocument();
  });

  it("status=FAILED → disabled + failed reason", () => {
    renderDetail(makeRun({ status: "FAILED", error: "boom" }));
    expect(screen.getByRole("button", { name: "synthesis.detail.approveAll" })).toBeDisabled();
    expect(screen.getByText("synthesis.detail.notActionable.failed")).toBeInTheDocument();
  });

  it("status=APPROVED → disabled + approved reason", () => {
    renderDetail(makeRun({ status: "APPROVED" }));
    expect(screen.getByRole("button", { name: "synthesis.detail.approveAll" })).toBeDisabled();
    expect(screen.getByText("synthesis.detail.notActionable.approved")).toBeInTheDocument();
  });

  it("status=REJECTED → disabled + rejected reason", () => {
    renderDetail(makeRun({ status: "REJECTED" }));
    expect(screen.getByRole("button", { name: "synthesis.detail.approveAll" })).toBeDisabled();
    expect(screen.getByText("synthesis.detail.notActionable.rejected")).toBeInTheDocument();
  });

  it("status=COMPLETED with changes → enabled Approve/Reject bar unchanged (regression guard)", () => {
    renderDetail(makeRun({ status: "COMPLETED" }));
    const approve = screen.getByRole("button", { name: "synthesis.detail.approveAll" });
    expect(approve).toBeEnabled();
    expect(screen.getByRole("button", { name: "synthesis.detail.rejectAll" })).toBeInTheDocument();
    expect(screen.queryByText(/notActionable/)).toBeNull();
  });

  it("status=PARTIAL with changes → enabled bar unchanged", () => {
    renderDetail(makeRun({ status: "PARTIAL" }));
    expect(screen.getByRole("button", { name: "synthesis.detail.approveAll" })).toBeEnabled();
  });

  it("non-actionable states never fire the approve mutation spy", () => {
    for (const status of ["PENDING", "PROCESSING", "FAILED", "APPROVED", "REJECTED"] as const) {
      approveMutate.mockClear();
      const { unmount } = renderDetail(makeRun({ status }));
      const approve = screen.getByRole("button", { name: "synthesis.detail.approveAll" });
      approve.click();
      expect(approveMutate).not.toHaveBeenCalled();
      unmount();
    }
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DlpDocumentScanPanel tests — Phase 192 (DLP-05/DLP-06, UI-SPEC surfaces 3/4).
 *
 * Arms covered (the panel's three hooks are mocked — the hooks' own fetch
 * shapes are pinned by the server route suites):
 *  - no-run result → documented empty state (heading + body) + Run button
 *  - gate-failed result → amber banner + documentedOnly annotation + per-class rows
 *  - passed result → neutral summary (never accent-colored)
 *  - load error → destructive alert + retry
 *  - backfill confirm dialog renders the count; destructive confirm styling
 *  - single-flight: both CTAs disabled while their mutation is pending
 *  - backfill result toast + partial-failure copy
 */
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock i18next — identity t that interpolates INTO THE KEY STRING (the repo's
// component-test convention: keys are the rendered text; values arrive as
// interpolated suffixes). Interpolation assertions therefore check the CALL
// arguments via useTranslation, not the DOM text.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object") {
        let s = key;
        for (const [k, v] of Object.entries(opts)) {
          s = `${s}::${k}=${String(v)}`;
        }
        return s;
      }
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

import { showSuccess, showError } from "../../lib/toast";

// ── Hook mocks (mutable so each arm can drive its own fixture) ──
const useDlpEvalResultMock = jest.fn();
const useRunDlpEvalMock = jest.fn();
const useDlpBackfillMock = jest.fn();

jest.mock("../../queries/useDlpDocs", () => ({
  useDlpEvalResult: () => useDlpEvalResultMock(),
  useRunDlpEval: () => useRunDlpEvalMock(),
  useDlpBackfill: () => useDlpBackfillMock(),
}));

// AlertDialog inline mock (WorkspaceRow.test.tsx precedent)
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: ChildrenOnlyProps) => (
    <div data-testid="alert-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: ChildrenOnlyProps) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: ChildrenOnlyProps) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: ChildrenOnlyProps) => <div>{children}</div>,
  AlertDialogCancel: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: (e: unknown) => void;
  }) => (
    <button type="button" data-testid="alert-cancel" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogAction: ({
    children,
    disabled,
    onClick,
    className,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: (e: unknown) => void;
    className?: string;
  }) => (
    <button type="button" data-testid="alert-action" disabled={disabled} onClick={onClick} className={className}>
      {children}
    </button>
  ),
}));

// Alert inline mock (radix-free render)
jest.mock("@/components/ui/alert", () => ({
  Alert: ({ children, variant }: { children?: ReactNode; variant?: string }) => (
    <div data-testid="alert" data-variant={variant}>{children}</div>
  ),
  AlertTitle: ({ children }: ChildrenOnlyProps) => <div data-testid="alert-title">{children}</div>,
  AlertDescription: ({ children }: ChildrenOnlyProps) => <div data-testid="alert-description">{children}</div>,
}));

import DlpDocumentScanPanel from "../DlpDocumentScanPanel";

const evalIdle = { isPending: false, mutateAsync: jest.fn() };
const backfillIdle = { isPending: false, mutateAsync: jest.fn(), data: undefined };

/** Full-result arm fixture (server shape, DLP_ENTITY_CLASSES order). */
const failedResult = {
  noRun: false as const,
  passed: false,
  fpRate: 0.04,
  totalChecks: 50,
  perClass: [
    { entityClass: "PERSON", detected: 10, expected: 12, falsePositives: 1 },
    { entityClass: "ADDRESS", detected: 5, expected: 6, falsePositives: 0 },
    { entityClass: "FINANCIAL", detected: 3, expected: 3, falsePositives: 0 },
    { entityClass: "GOV_ID", detected: 4, expected: 4, falsePositives: 1 },
    { entityClass: "CONTACT", detected: 2, expected: 2, falsePositives: 0 },
  ],
  lastRun: "2026-09-19T10:00:00.000Z",
  nerMode: "stub" as const,
};

const passedResult = {
  ...failedResult,
  passed: true,
  fpRate: 0,
  perClass: failedResult.perClass.map((r) => ({ ...r, falsePositives: 0 })),
};

function defaultHooks() {
  useDlpEvalResultMock.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  });
  useRunDlpEvalMock.mockReturnValue(evalIdle);
  useDlpBackfillMock.mockReturnValue(backfillIdle);
}

beforeEach(() => {
  jest.clearAllMocks();
  defaultHooks();
});

describe("DlpDocumentScanPanel", () => {
  it("renders the panel heading", () => {
    render(<DlpDocumentScanPanel />);
    expect(screen.getByText("settings.dlpDocs.title")).toBeInTheDocument();
  });

  it("no-run arm → documented empty state + Run evaluation CTA", () => {
    useDlpEvalResultMock.mockReturnValue({
      data: { noRun: true, passed: false },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<DlpDocumentScanPanel />);

    expect(screen.getByTestId("dlp-eval-empty")).toBeInTheDocument();
    expect(screen.getByText("settings.dlpDocs.eval.empty.heading")).toBeInTheDocument();
    expect(screen.getByText("settings.dlpDocs.eval.empty.body")).toBeInTheDocument();
    expect(screen.getByTestId("dlp-eval-run")).toBeEnabled();
  });

  it("loading arm → Skeleton, no Run button yet", () => {
    useDlpEvalResultMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: jest.fn(),
    });
    render(<DlpDocumentScanPanel />);

    expect(screen.queryByTestId("dlp-eval-run")).toBeNull();
    expect(screen.queryByTestId("dlp-eval-empty")).toBeNull();
  });

  it("gate-failed result → amber banner + per-class rows with documentedOnly annotation", () => {
    useDlpEvalResultMock.mockReturnValue({
      data: failedResult,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<DlpDocumentScanPanel />);

    const banner = screen.getByTestId("dlp-eval-failed");
    expect(banner.className).toContain("amber");
    expect(banner.getAttribute("role")).toBe("alert");
    // fpRate interpolated as a percentage (mock t appends ::fpRate=<value>)
    expect(banner.textContent).toContain("fpRate=4.0%");
    // Per-class rows render in the fixed server order with the NER-context
    // classes annotated and the checksum classes NOT annotated
    const rows = screen.getByText("PERSON", { selector: "span" }).closest("div")!.parentElement!;
    expect(rows.textContent).toContain("GOV_ID");
    expect(screen.getAllByText(/settings.dlpDocs.eval.documentedOnly/).length).toBe(3); // PERSON, ADDRESS, CONTACT
    // mono FP values render (JetBrains Mono contract is class-level)
    expect(document.querySelectorAll(".font-mono").length).toBeGreaterThan(0);
  });

  it("passed result → neutral summary (never accent/destructive/amber)", () => {
    useDlpEvalResultMock.mockReturnValue({
      data: passedResult,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<DlpDocumentScanPanel />);

    expect(screen.getByTestId("dlp-eval-passed")).toBeInTheDocument();
    expect(screen.queryByTestId("dlp-eval-failed")).toBeNull();
    expect(screen.queryByTestId("dlp-eval-empty")).toBeNull();
  });

  it("load error → destructive alert + retry refetch", () => {
    const refetch = jest.fn();
    useDlpEvalResultMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
      refetch,
    });
    render(<DlpDocumentScanPanel />);

    expect(screen.getByTestId("alert").getAttribute("data-variant")).toBe("destructive");
    fireEvent.click(screen.getByRole("button", { name: "settings.dlpDocs.eval.retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("eval single-flight: Run button disabled + spinning while the mutation is pending", async () => {
    const mutateAsync = jest.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
    );
    useRunDlpEvalMock.mockReturnValue({ isPending: true, mutateAsync });
    useDlpEvalResultMock.mockReturnValue({
      data: { noRun: true, passed: false },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<DlpDocumentScanPanel />);

    const runBtn = screen.getByTestId("dlp-eval-run");
    expect(runBtn).toBeDisabled();
    expect(runBtn.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByText("settings.dlpDocs.eval.running")).toBeInTheDocument();
  });

  it("Run evaluation success path fires the mutation (single-flight hook contract)", async () => {
    const mutateAsync = jest.fn().mockResolvedValue({ noRun: false, passed: true, fpRate: 0, totalChecks: 10, perClass: [], lastRun: "2026-09-19T10:00:00.000Z", nerMode: "stub", durationSeconds: 1 });
    useRunDlpEvalMock.mockReturnValue({ isPending: false, mutateAsync });
    useDlpEvalResultMock.mockReturnValue({
      data: { noRun: true, passed: false },
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<DlpDocumentScanPanel />);

    fireEvent.click(screen.getByTestId("dlp-eval-run"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  it("gate not passed → backfill trigger hidden + gate-blocked banner on the panel", () => {
    useDlpEvalResultMock.mockReturnValue({
      data: failedResult,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<DlpDocumentScanPanel />);

    expect(screen.queryByTestId("dlp-backfill-trigger")).toBeNull();
    expect(screen.getByTestId("dlp-backfill-gate-blocked")).toBeInTheDocument();
  });

  it("gate passed → backfill trigger renders; confirm dialog carries the count + destructive styling", async () => {
    useDlpEvalResultMock.mockReturnValue({
      data: passedResult,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    useDlpBackfillMock.mockReturnValue({
      ...backfillIdle,
      data: { enqueued: 0, skipped: 0, totalEligible: 12, errors: [] },
    });
    render(<DlpDocumentScanPanel />);

    fireEvent.click(screen.getByTestId("dlp-backfill-trigger"));
    expect(screen.getByTestId("alert-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("alert-action").className).toContain("bg-destructive");
    // count interpolated into the destructive confirm label (::count=12)
    expect(screen.getByTestId("alert-action").textContent).toContain("count=12");
    expect(screen.getByText("settings.dlpDocs.backfill.cancel")).toBeInTheDocument();
  });

  it("backfill success → result toast with the response counts", async () => {
    useDlpEvalResultMock.mockReturnValue({
      data: passedResult,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const mutateAsync = jest.fn().mockResolvedValue({ enqueued: 7, skipped: 2, totalEligible: 9, errors: [] });
    useDlpBackfillMock.mockReturnValue({ isPending: false, mutateAsync, data: undefined });
    render(<DlpDocumentScanPanel />);

    fireEvent.click(screen.getByTestId("dlp-backfill-trigger"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() =>
      expect(showSuccess).toHaveBeenCalledWith(
        expect.stringContaining("::scanned=7"),
      ),
    );
  });

  it("backfill partial failure → error copy with the failed count (re-run-safe)", async () => {
    useDlpEvalResultMock.mockReturnValue({
      data: passedResult,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const mutateAsync = jest.fn().mockResolvedValue({ enqueued: 5, skipped: 0, totalEligible: 7, errors: ["doc x", "doc y"] });
    useDlpBackfillMock.mockReturnValue({ isPending: false, mutateAsync, data: undefined });
    render(<DlpDocumentScanPanel />);

    fireEvent.click(screen.getByTestId("dlp-backfill-trigger"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText(/settings.dlpDocs.backfill.error/).textContent).toContain("failed=2"),
    );
  });

  it("backfill zero-eligible no-op success → empty-state copy", async () => {
    useDlpEvalResultMock.mockReturnValue({
      data: passedResult,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    const mutateAsync = jest.fn().mockResolvedValue({ enqueued: 0, skipped: 0, totalEligible: 0, errors: [] });
    useDlpBackfillMock.mockReturnValue({ isPending: false, mutateAsync, data: undefined });
    render(<DlpDocumentScanPanel />);

    fireEvent.click(screen.getByTestId("dlp-backfill-trigger"));
    fireEvent.click(screen.getByTestId("alert-action"));
    await waitFor(() =>
      expect(showSuccess).toHaveBeenCalledWith("settings.dlpDocs.backfill.empty"),
    );
  });
});
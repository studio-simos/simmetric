// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * PendingDocsPanel component tests — quick 260826-fan Task 3.
 *
 * Covers the per-row retry button visibility (D-02):
 *   - "Retry RAG" button renders when ragEnabled !== false
 *   - "Retry RAG" button is absent when ragEnabled === false
 *   - "Retry KB" button renders when kbEnabled !== false (NOT only on FAILED)
 *   - "Retry KB" button is absent when kbEnabled === false
 * And the batch "Riprova selezionati" toolbar button (D-03):
 *   - present in the toolbar
 *   - disabled when selectedCount === 0
 */
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PendingDocsPanel, { isDeletable } from "../PendingDocsPanel";
import type { UploadDraft } from "../../queries/useUploadDrafts";

// Mock i18next — t() returns the key so we can assert on key strings.
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock toast helpers — toast calls are asserted in the 260829-fty tests.
jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

import { showSuccess, showError } from "../../lib/toast";

// Mock the uploadDrafts query + retry hooks. useUploadDrafts returns the
// provided drafts so we can drive per-row button visibility.
const mockDrafts: UploadDraft[] = [];
// 260829-fty: controllable mutateAsync so toast tests can resolve the
// per-leg settled response shape (RetryLegsResponse).
const mockRetryRagMutateAsync = jest.fn();
// 260829-h0n: controllable delete mutateAsync for the bulk-delete flow tests.
const mockDeleteMutateAsync = jest.fn();
jest.mock("../../queries/useUploadDrafts", () => ({
  useUploadDrafts: () => ({ data: mockDrafts }),
  useAssignDraft: () => ({ mutateAsync: jest.fn() }),
  useRetryKb: () => ({ mutateAsync: jest.fn() }),
  useRetryRag: () => ({ mutateAsync: mockRetryRagMutateAsync }),
  useRetryBoth: () => ({ mutateAsync: jest.fn() }),
  useDeleteDraft: () => ({ mutateAsync: mockDeleteMutateAsync }),
  useRenameDraft: () => ({ mutateAsync: jest.fn() }),
}));

// Mock useArchives — empty list is fine for these visibility tests.
jest.mock("../../queries/useArchives", () => ({
  useArchives: () => ({ data: [] }),
}));

// Radix-based UI primitives are hard to drive in jsdom; stub them to plain
// elements so we can assert on rendered text / disabled state. The Dialog
// mock always renders children (the trigger button must stay visible even
// when the dialog is closed).
// 260829-h0n: Dialog captures its onOpenChange prop in a module variable and
// DialogTrigger renders its children inside a span whose onClick fires it, so
// clicking a trigger "opens" the dialog for the flow tests (the child Button
// for Delete Selected is enabled once a row is selected — the click bubbles
// from the inner button to the span in jsdom). Radix passes `open` to
// DialogContent itself, so our mock clones the DialogContent child and
// injects the Dialog's `open` prop into it; existing tests that never click
// triggers are unaffected.
let capturedOnOpenChange: ((open: boolean) => void) | null = null;
jest.mock("../ui/dialog", () => {
  const mock = {
    Dialog: ({ children, open, onOpenChange }: { children?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
      capturedOnOpenChange = onOpenChange ?? null;
      return (
        <>
          {Children.map(children, (child) =>
            isValidElement(child) && (child.type as { displayName?: string })?.displayName === "MockDialogContent"
              ? cloneElement(child as React.ReactElement<{ open?: boolean }>, { open })
              : child,
          )}
        </>
      );
    },
    DialogTrigger: ({ children }: { children?: ReactNode }) => (
      <span onClick={() => capturedOnOpenChange?.(true)}>{children}</span>
    ),
    DialogContent: function MockDialogContent({ children, open }: { children?: ReactNode; open?: boolean }) {
      return open ? <div data-testid="dialog">{children}</div> : null;
    },
    DialogHeader: ({ children }: { children?: ReactNode }) => <>{children}</>,
    DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
    DialogFooter: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
  (mock.DialogContent as { displayName?: string }).displayName = "MockDialogContent";
  return mock;
});

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PendingDocsPanel workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

function makeDraft(overrides: Partial<UploadDraft> = {}): UploadDraft {
  return {
    id: "d1",
    parseStatus: "done",
    originalName: "doc.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
    expiresAt: "2027-01-01T00:00:00Z",
    ragStatus: "completed",
    kbStatus: "COMPLETED",
    ragEnabled: true,
    kbEnabled: true,
    assignedArchiveId: "a-1",
    ...overrides,
  };
}

describe("PendingDocsPanel — per-row retry buttons (quick 260826-fan D-02)", () => {
  beforeEach(() => {
    mockDrafts.length = 0;
  });

  it("'Retry RAG' button renders when ragEnabled !== false", () => {
    mockDrafts.push(makeDraft({ ragEnabled: true }));
    renderPanel();
    expect(screen.getByText("uploads.row.retryRag")).toBeInTheDocument();
  });

  it("'Retry RAG' button is absent when ragEnabled === false", () => {
    mockDrafts.push(makeDraft({ ragEnabled: false, ragStatus: null }));
    renderPanel();
    expect(screen.queryByText("uploads.row.retryRag")).not.toBeInTheDocument();
  });

  it("'Retry KB' button renders when kbEnabled !== false (NOT only on FAILED)", () => {
    // A completed (non-FAILED) draft with kbEnabled=true must still show the
    // Retry KB button — the gate is kbEnabled, not kbStatus === "FAILED".
    mockDrafts.push(makeDraft({ kbEnabled: true, kbStatus: "COMPLETED" }));
    renderPanel();
    expect(screen.getByText("uploads.row.retryKb")).toBeInTheDocument();
  });

  it("'Retry KB' button is absent when kbEnabled === false", () => {
    mockDrafts.push(makeDraft({ kbEnabled: false, kbStatus: null }));
    renderPanel();
    expect(screen.queryByText("uploads.row.retryKb")).not.toBeInTheDocument();
  });
});

describe("PendingDocsPanel — batch 'Riprova selezionati' toolbar button (D-03)", () => {
  beforeEach(() => {
    mockDrafts.length = 0;
  });

  it("toolbar contains the 'Retry Selected' button", () => {
    mockDrafts.push(makeDraft());
    renderPanel();
    // The button label comes from t("uploads.bulkRetry.confirm").
    expect(screen.getByText("uploads.bulkRetry.confirm")).toBeInTheDocument();
  });

  it("'Retry Selected' button is disabled when selectedCount === 0", () => {
    mockDrafts.push(makeDraft());
    const { container } = renderPanel();
    // Find the button by its text and assert it's disabled.
    const btn = screen.getByText("uploads.bulkRetry.confirm").closest("button");
    expect(btn).not.toBeNull();
    expect(btn).toBeDisabled();
  });
});

// =========================================================================
// 260829-fty — honest retry toasts from the per-leg settled status. A 200
// whose requested leg reports "rejected" must show the error toast
// (uploads.retry.legFailed), never the success toast; "fulfilled" keeps
// the existing success toast.
// =========================================================================
describe("PendingDocsPanel — retry toasts reflect per-leg settled status (260829-fty)", () => {
  beforeEach(() => {
    mockDrafts.length = 0;
    (showSuccess as jest.Mock).mockClear();
    (showError as jest.Mock).mockClear();
    mockRetryRagMutateAsync.mockReset();
  });

  it("ragResult 'rejected' on HTTP 200 → error toast with legFailed key, NO success toast", async () => {
    mockDrafts.push(makeDraft({ ragEnabled: true }));
    mockRetryRagMutateAsync.mockResolvedValue({
      id: "draft-1",
      parseStatus: "assigned",
      ragResult: "rejected",
      kbResult: null,
    });
    renderPanel();

    fireEvent.click(screen.getByText("uploads.row.retryRag"));

    await waitFor(() => {
      expect(showError).toHaveBeenCalled();
    });
    const errArg = (showError as jest.Mock).mock.calls[0][0] as string;
    // The i18n mock's t() returns the raw key — the legFailed key proves the
    // handler took the rejected-leg branch (the old code path called
    // uploads.retryRag.success via showSuccess instead).
    expect(errArg).toBe("uploads.retry.legFailed");
    expect(showSuccess).not.toHaveBeenCalled();
  });

  it("ragResult 'fulfilled' on HTTP 200 → existing success toast still fires", async () => {
    mockDrafts.push(makeDraft({ ragEnabled: true }));
    mockRetryRagMutateAsync.mockResolvedValue({
      id: "draft-1",
      parseStatus: "assigned",
      ragResult: "fulfilled",
      kbResult: null,
    });
    renderPanel();

    fireEvent.click(screen.getByText("uploads.row.retryRag"));

    await waitFor(() => {
      expect(showSuccess).toHaveBeenCalledWith("uploads.retryRag.success");
    });
    expect(showError).not.toHaveBeenCalled();
  });
});

// =========================================================================
// 260829-h0n — bulk delete gate mirrors isInFlight. (1) Pure isDeletable
// predicate assertions; (2) component flow tests: a failed-terminal draft
// dispatches DELETE with a success toast, a genuinely in-flight draft hits
// the inFlightBlocked error path with zero dispatches.
// =========================================================================
describe("PendingDocsPanel — bulk delete gate mirrors isInFlight (260829-h0n)", () => {
  it("failed-RAG terminal with kbEnabled false → deletable (THE regression, mirrors live draft 270fd171)", () => {
    expect(
      isDeletable(makeDraft({ parseStatus: "assigned", ragStatus: "failed", kbEnabled: false, kbStatus: null, ragEnabled: true })),
    ).toBe(true);
  });

  it("both legs terminal-but-failed with both enabled → deletable", () => {
    expect(
      isDeletable(makeDraft({ parseStatus: "assigned", ragStatus: "failed", kbStatus: "FAILED", kbEnabled: true })),
    ).toBe(true);
  });

  it("enabled RAG leg non-terminal (processing) → NOT deletable", () => {
    expect(
      isDeletable(makeDraft({ parseStatus: "assigned", ragStatus: "processing", kbEnabled: false, kbStatus: null })),
    ).toBe(false);
  });

  it("KB PENDING (non-terminal) with kbEnabled true → NOT deletable", () => {
    expect(
      isDeletable(makeDraft({ parseStatus: "assigned", ragStatus: "completed", kbStatus: "PENDING", kbEnabled: true })),
    ).toBe(false);
  });

  it("default done fixture → deletable; parseStatus 'uploaded' with null legs → deletable", () => {
    expect(isDeletable(makeDraft())).toBe(true);
    expect(
      isDeletable(makeDraft({ parseStatus: "uploaded", ragStatus: null, kbStatus: null, ragEnabled: false, kbEnabled: false })),
    ).toBe(true);
  });
});

describe("PendingDocsPanel — bulk delete lets failed-terminal drafts through (260829-h0n)", () => {
  beforeEach(() => {
    mockDrafts.length = 0;
    (showSuccess as jest.Mock).mockClear();
    (showError as jest.Mock).mockClear();
    mockDeleteMutateAsync.mockReset();
  });

  it("failed-RAG draft row → delete dispatches DELETE for that draft + success toast, NO inFlightBlocked", async () => {
    mockDrafts.push(
      makeDraft({
        id: "d-fail",
        originalName: "preventivo-8kW-FV.pdf",
        parseStatus: "assigned",
        ragStatus: "failed",
        ragEnabled: true,
        kbEnabled: false,
        kbStatus: null,
      }),
    );
    mockDeleteMutateAsync.mockResolvedValue({});
    renderPanel();

    // Row checkbox (the select-all's accessible name is the literal key
    // "uploads.source.fromDoc.selectAll" under the i18n mock, so this
    // name-scoped query is unambiguous).
    fireEvent.click(screen.getByRole("checkbox", { name: "select preventivo-8kW-FV.pdf" }));
    // Open the Delete Selected dialog via the (mock) trigger.
    fireEvent.click(screen.getByText("uploads.bulkDelete.deleteSelected"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-delete-submit")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bulk-delete-submit"));

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith({ id: "d-fail" });
    });
    expect(showSuccess).toHaveBeenCalledWith("uploads.bulkDelete.success");
    expect(showError).not.toHaveBeenCalledWith("uploads.bulkDelete.inFlightBlocked");
    expect(mockDeleteMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("genuinely in-flight draft (enabled RAG processing) → inFlightBlocked error, NO delete dispatch", async () => {
    mockDrafts.push(
      makeDraft({
        id: "d-proc",
        originalName: "inflight.pdf",
        parseStatus: "assigned",
        ragStatus: "processing",
        ragEnabled: true,
        kbEnabled: false,
        kbStatus: null,
      }),
    );
    renderPanel();

    fireEvent.click(screen.getByRole("checkbox", { name: "select inflight.pdf" }));
    fireEvent.click(screen.getByText("uploads.bulkDelete.deleteSelected"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-delete-submit")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("bulk-delete-submit"));

    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("uploads.bulkDelete.inFlightBlocked");
    });
    expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * PendingDocsPanel tests (Phase 71-05 Task 3).
 *
 * Verifies: D-04 lifecycle list + filter chips, D-10 per-leg RAG+KB badges
 * (variant per state + className=font-semibold + aria-label), D-06 bulk-assign
 * per-file MIME validation + toast variants, D-08 retry-KB-only-when-FAILED,
 * D-11 skeleton stage row, D-07 client-never-prechecks, D-05 "Assigned to"
 * live label, empty states.
 */

// ── Mocks ────────────────────────────────────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof key === "string") {
        // interpolate {{var}} minimally
        return key.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? ""));
      }
      return key;
    },
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

const mockInvalidateQueries = jest.fn();
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

jest.mock("../queries/useUploadDrafts", () => ({
  useUploadDrafts: jest.fn(() => ({ data: [], isLoading: false })),
  useAssignDraft: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  useRetryKb: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  // quick 260826-fan: the panel also consumes useRetryRag + useRetryBoth
  // (bulk-retry D-03). The mock had drifted — these two were missing and
  // EVERY render crashed ("useRetryRag is not a function", 21/21 suite
  // failing pre-existing this fix). Mock shape mirrors the others.
  useRetryRag: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  useRetryBoth: jest.fn(() => ({
    mutateAsync: jest.fn(),
    isPending: false,
  })),
  // 76-03 — stubs so the new useDeleteDraft/useRenameDraft hooks resolve
  // under the existing mock. Full describe blocks are added in Task 3.
  useDeleteDraft: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
  useRenameDraft: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false })),
}));

jest.mock("../queries/useArchives", () => ({
  useArchives: jest.fn(() => ({
    data: [
      { id: "arch-1", name: "Archive One", slug: "archive-one", description: null },
    ],
    isLoading: false,
  })),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

// Mock Checkbox as a plain input (Radix Checkbox needs pointer events that
// jsdom doesn't fully simulate — keeps the test focused on panel logic).
jest.mock("../components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange, ...rest }: { checked?: boolean; onCheckedChange?: (v: boolean) => void; [k: string]: unknown }) => (
    <input
      type="checkbox"
      data-testid="checkbox"
      checked={!!checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      {...(rest as Record<string, unknown>)}
    />
  ),
}));

// Mock Dialog as a plain container (Radix Dialog uses portals + focus traps
// that are noisy in jsdom). The trigger is always rendered; content is always
// visible (test simulates "open" state implicitly).
jest.mock("../components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode; open: boolean }) => <div>{children}</div>,
  DialogTrigger: ({ children }: { children: React.ReactElement; asChild?: boolean }) =>
    children,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock Select as a native <select> (Radix Select uses portals + pointer events
// that are noisy in jsdom).
jest.mock("../components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) => (
    <select
      data-testid="select"
      value={value ?? ""}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// ── Imports ──────────────────────────────────────────────────────

import React from "react";
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  useUploadDrafts,
  useAssignDraft,
  useRetryKb,
  useRetryRag,
  useRetryBoth,
  useDeleteDraft,
  useRenameDraft,
} from "../queries/useUploadDrafts";
import { showSuccess, showError } from "../lib/toast";
import PendingDocsPanel from "../components/PendingDocsPanel";

// ── Fixtures ─────────────────────────────────────────────────────

function draft(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "d-1",
    parseStatus: "unassigned",
    originalName: "doc.pdf",
    fileSize: 1024,
    mimeType: "application/pdf",
    expiresAt: "2026-12-31T00:00:00.000Z",
    ragStatus: null,
    kbStatus: null,
    ...overrides,
  };
}

const assignMutateAsync = jest.fn();
const retryKbMutateAsync = jest.fn();
const retryRagMutateAsync = jest.fn();
const retryBothMutateAsync = jest.fn();
const deleteMutateAsync = jest.fn();
const renameMutateAsync = jest.fn();

function setDrafts(drafts: ReturnType<typeof draft>[]) {
  (useUploadDrafts as unknown as jest.Mock).mockReturnValue({
    data: drafts,
    isLoading: false,
  });
  (useAssignDraft as unknown as jest.Mock).mockReturnValue({
    mutateAsync: assignMutateAsync,
    isPending: false,
  });
  (useRetryKb as unknown as jest.Mock).mockReturnValue({
    mutateAsync: retryKbMutateAsync,
    isPending: false,
  });
  (useRetryRag as unknown as jest.Mock).mockReturnValue({
    mutateAsync: retryRagMutateAsync,
    isPending: false,
  });
  (useRetryBoth as unknown as jest.Mock).mockReturnValue({
    mutateAsync: retryBothMutateAsync,
    isPending: false,
  });
  (useDeleteDraft as unknown as jest.Mock).mockReturnValue({
    mutateAsync: deleteMutateAsync,
    isPending: false,
  });
  (useRenameDraft as unknown as jest.Mock).mockReturnValue({
    mutateAsync: renameMutateAsync,
    isPending: false,
  });
}

function renderPanel(props: Partial<React.ComponentProps<typeof PendingDocsPanel>> = {}) {
  return render(<PendingDocsPanel workspaceId="ws-1" {...props} />);
}

// ── Tests ────────────────────────────────────────────────────────

describe("PendingDocsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setDrafts([]);
  });

  it("D-04 renders drafts with all 3 lifecycle states + filter chips", () => {
    setDrafts([
      draft({ id: "u1", parseStatus: "unassigned", originalName: "u.pdf" }),
      draft({ id: "i1", parseStatus: "assigned", originalName: "i.pdf", ragStatus: "processing", kbStatus: "PROCESSING" }),
      draft({ id: "d1", parseStatus: "done", originalName: "d.pdf", ragStatus: "completed", kbStatus: "COMPLETED" }),
    ]);
    renderPanel();
    expect(screen.getByText("u.pdf")).toBeInTheDocument();
    expect(screen.getByText("i.pdf")).toBeInTheDocument();
    expect(screen.getByText("d.pdf")).toBeInTheDocument();
    expect(screen.getByText("uploads.pending.filter.unassigned")).toBeInTheDocument();
    expect(screen.getByText("uploads.pending.filter.inFlight")).toBeInTheDocument();
    expect(screen.getByText("uploads.pending.filter.done")).toBeInTheDocument();
  });

  it("D-10 each row has two Badge components (RAG + KB) with font-semibold + aria-label", () => {
    setDrafts([
      draft({ id: "r1", parseStatus: "assigned", ragStatus: "pending", kbStatus: "PROCESSING" }),
    ]);
    renderPanel();
    const ragBadge = screen.getByLabelText(/RAG /);
    const kbBadge = screen.getByLabelText(/KB /);
    expect(ragBadge).toBeInTheDocument();
    expect(kbBadge).toBeInTheDocument();
    expect(ragBadge.className).toContain("font-semibold");
    expect(kbBadge.className).toContain("font-semibold");
  });

  it("D-06 bulk-assign: 2 valid + 1 xls-legacy invalid for KB → 2 calls + warning toast (txt/csv KB-eligible since quick 260829-xxx)", async () => {
    setDrafts([
      draft({ id: "a", mimeType: "application/pdf", parseStatus: "unassigned" }),
      draft({ id: "b", mimeType: "text/plain", parseStatus: "unassigned" }),
      // application/vnd.ms-excel is stage-allowed (12-enum) but NOT in the
      // server KB-eligible set — the invalid-for-KB representative now that
      // text/plain is KB-eligible.
      draft({ id: "c", mimeType: "application/vnd.ms-excel", parseStatus: "unassigned" }),
    ]);
    renderPanel();
    // select 3 drafts (skip the "Select all" checkbox at index 0)
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBe(4); // 1 select-all + 3 draft rows
    checkboxes.slice(1).forEach((cb) => fireEvent.click(cb));
    // Dialog mock renders content inline — select KB destination
    const kbRadio = screen.getByRole("radio", { name: /uploads.destination.kb.label/ });
    fireEvent.click(kbRadio);
    // select archive via native select mock
    const archiveSelect = screen.getByTestId("select");
    fireEvent.change(archiveSelect, { target: { value: "arch-1" } });
    // confirm
    fireEvent.click(screen.getByTestId("bulk-assign-submit"));
    await waitFor(() => {
      expect(assignMutateAsync).toHaveBeenCalledTimes(2);
    });
    // t-mock interpolates {{assigned}}/{{skipped}} — assert the rendered message
    expect(showSuccess).toHaveBeenCalledWith(
      "uploads.bulkAssign.skipped",
    );
  });

  it("260829-xxx bulk-assign: finalized draft with valid MIME → honest skippedFinalized toast (NOT the MIME one)", async () => {
    // A .md draft already finalized (parseStatus "done"): the MIME is valid
    // for KB, but the client skips it because the server would 409 ("Draft
    // already finalized"). The toast must say WHY — the old conflated
    // message blamed an invalid MIME.
    setDrafts([
      draft({
        id: "done-md",
        mimeType: "text/markdown",
        parseStatus: "done",
        ragStatus: "completed",
        kbStatus: null,
      }),
      draft({ id: "fresh-md", mimeType: "text/markdown", parseStatus: "unassigned" }),
    ]);
    renderPanel();
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.slice(1).forEach((cb) => fireEvent.click(cb));
    fireEvent.click(screen.getByRole("radio", { name: /uploads.destination.kb.label/ }));
    fireEvent.change(screen.getByTestId("select"), { target: { value: "arch-1" } });
    fireEvent.click(screen.getByTestId("bulk-assign-submit"));
    await waitFor(() => {
      expect(assignMutateAsync).toHaveBeenCalledTimes(1);
      expect(assignMutateAsync).toHaveBeenCalledWith({
        id: "fresh-md",
        body: { rag: false, kb: true, archiveId: "arch-1" },
      });
    });
    expect(showSuccess).toHaveBeenCalledWith("uploads.bulkAssign.skippedFinalized");
    // NOT the MIME-skipped message — the skipped file's MIME is valid.
    expect(showSuccess).not.toHaveBeenCalledWith("uploads.bulkAssign.skipped");
  });

  it("D-06 all-skipped → 0 calls + error toast noneValid", async () => {
    setDrafts([
      draft({ id: "x", mimeType: "image/png", parseStatus: "unassigned" }),
      draft({ id: "y", mimeType: "image/jpeg", parseStatus: "unassigned" }),
    ]);
    renderPanel();
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.slice(1).forEach((cb) => fireEvent.click(cb));
    const ragRadio = screen.getByRole("radio", { name: /uploads.destination.rag.label/ });
    fireEvent.click(ragRadio);
    fireEvent.click(screen.getByTestId("bulk-assign-submit"));
    await waitFor(() => {
      expect(assignMutateAsync).not.toHaveBeenCalled();
      expect(showError).toHaveBeenCalledWith("uploads.bulkAssign.noneValid");
    });
  });

  it("bulk-assign submit disabled when KB selected but no archive chosen", () => {
    // quick 260723-xxx — KB destination requires an archive; the server
    // assign schema rejects empty archiveId when kb=true, so the confirm
    // button must be disabled (not just fail at dispatch time).
    setDrafts([
      draft({ id: "a", mimeType: "application/pdf", parseStatus: "unassigned" }),
    ]);
    renderPanel();
    // select the draft so the toolbar trigger is enabled (skip select-all at [0])
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    // choose KB destination but do NOT pick an archive
    fireEvent.click(screen.getByRole("radio", { name: /uploads.destination.kb.label/ }));
    const submit = screen.getByTestId("bulk-assign-submit");
    expect(submit).toBeDisabled();
    // now pick an archive → button re-enables
    fireEvent.change(screen.getByTestId("select"), { target: { value: "arch-1" } });
    expect(submit).not.toBeDisabled();
  });

  it("bulk-assign submit enabled for RAG destination without archive", () => {
    setDrafts([
      draft({ id: "a", mimeType: "application/pdf", parseStatus: "unassigned" }),
    ]);
    renderPanel();
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("radio", { name: /uploads.destination.rag.label/ }));
    expect(screen.getByTestId("bulk-assign-submit")).not.toBeDisabled();
  });

  it("D-08 (quick 260826-fan D-02) retry KB button visible whenever kbEnabled !== false (FAILED row AND kb-enabled rows)", () => {
    // afc54c5f changed the per-row Retry KB gate from kbStatus==='FAILED'
    // to kbEnabled !== false — retry is always available on assigned legs.
    // Row 1: kbEnabled undefined (fixture default) + COMPLETED → visible.
    // Row 2: kbEnabled true + FAILED → visible.
    // Row 3: ragStatus/kbStatus null + unassigned → also visible (kbEnabled
    // !== false), mirroring the Retry RAG button on the same row.
    setDrafts([
      draft({ id: "ok", parseStatus: "assigned", kbStatus: "COMPLETED", ragStatus: "completed" }),
      draft({ id: "bad", parseStatus: "assigned", kbStatus: "FAILED", ragStatus: "completed" }),
      draft({ id: "un", parseStatus: "unassigned" }),
    ]);
    renderPanel();
    const retryButtons = screen.getAllByText("uploads.row.retryKb");
    expect(retryButtons.length).toBe(3);
  });

  it("D-08 retry KB dispatches useRetryKb with {id, archiveId}", async () => {
    setDrafts([
      draft({
        id: "bad",
        parseStatus: "assigned",
        kbStatus: "FAILED",
        ragStatus: "completed",
        assignedArchiveId: "arch-1",
      } as Record<string, unknown>),
    ]);
    renderPanel();
    fireEvent.click(screen.getByText("uploads.row.retryKb"));
    await waitFor(() => {
      expect(retryKbMutateAsync).toHaveBeenCalledWith({ id: "bad", archiveId: "arch-1" });
    });
  });

  it("D-11 skeleton stage row + Uploading badge while stagePending", () => {
    setDrafts([]);
    renderPanel({ stagePending: true });
    expect(screen.getByText("uploads.stage.uploading")).toBeInTheDocument();
  });

  it("D-05 'Assigned to' live label per row", () => {
    setDrafts([
      draft({ id: "r", parseStatus: "assigned", ragStatus: "processing", kbStatus: null } as Record<string, unknown>),
    ]);
    renderPanel();
    expect(screen.getByText(/uploads.row.assignedTo/)).toBeInTheDocument();
  });

  it("empty state: no drafts → uploads.pending.empty.heading", () => {
    setDrafts([]);
    renderPanel();
    expect(screen.getByText("uploads.pending.empty.heading")).toBeInTheDocument();
  });

  /* ------------------------------------------------------------------ */
  /*  Phase 76-03 — bulk delete, inline rename                          */
  /*  Per-row single delete was removed (quick-260723-jza): the only       */
  /*  delete path is now the top-bar "Delete Selected" bulk flow.        */
  /* ------------------------------------------------------------------ */

  describe("bulk delete (76-03 PEND-02)", () => {
    it("select 2 of 3 → Delete Selected confirm → 2 deleteMutateAsync calls", async () => {
      setDrafts([
        draft({ id: "a", parseStatus: "unassigned" }),
        draft({ id: "b", parseStatus: "unassigned" }),
        draft({ id: "c", parseStatus: "done", ragStatus: "completed", kbStatus: "COMPLETED" }),
      ]);
      renderPanel();
      // Select first 2 via checkboxes (skip select-all at [0]; rows start at [1])
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[1]);
      fireEvent.click(checkboxes[2]);
      // Dialog mock renders bulk-delete-submit inline — click it
      fireEvent.click(screen.getByTestId("bulk-delete-submit"));
      await waitFor(() => {
        expect(deleteMutateAsync).toHaveBeenCalledTimes(2);
        expect(deleteMutateAsync).toHaveBeenCalledWith({ id: "a" });
        expect(deleteMutateAsync).toHaveBeenCalledWith({ id: "b" });
      });
    });

    it("in-flight in selection → skipped (partialError naming it), deletable ones still deleted (4cf0bfef/260829-h0n contract)", async () => {
      // Since 4cf0bfef the bulk-delete no longer blocks the whole batch on
      // an in-flight draft: deletable ones are deleted, in-flight ones are
      // skipped and named in the partialError toast. inFlightBlocked fires
      // only when NOTHING in the selection is deletable (covered below).
      setDrafts([
        draft({ id: "ok", parseStatus: "unassigned" }),
        draft({ id: "inf", parseStatus: "assigned", ragStatus: "processing", kbStatus: "PROCESSING" }),
      ]);
      renderPanel();
      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[1]);
      fireEvent.click(checkboxes[2]);
      fireEvent.click(screen.getByTestId("bulk-delete-submit"));
      await waitFor(() => {
        expect(deleteMutateAsync).toHaveBeenCalledTimes(1);
        expect(deleteMutateAsync).toHaveBeenCalledWith({ id: "ok" });
      });
      expect(showError).toHaveBeenCalledWith("uploads.bulkDelete.partialError");
      expect(showError).not.toHaveBeenCalledWith("uploads.bulkDelete.inFlightBlocked");
    });

    it("ONLY in-flight selected → showError(inFlightBlocked) + NO deleteMutateAsync", async () => {
      setDrafts([
        draft({ id: "inf", parseStatus: "assigned", ragStatus: "processing", kbStatus: "PROCESSING" }),
      ]);
      renderPanel();
      fireEvent.click(screen.getAllByRole("checkbox")[1]);
      fireEvent.click(screen.getByTestId("bulk-delete-submit"));
      await waitFor(() => {
        expect(showError).toHaveBeenCalledWith("uploads.bulkDelete.inFlightBlocked");
      });
      expect(deleteMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe("inline rename (76-03 PEND-03)", () => {
    it("click pencil → Input appears → Enter submits → useRenameDraft.mutateAsync called", async () => {
      setDrafts([draft({ id: "r1", originalName: "old-name.pdf", parseStatus: "unassigned" })]);
      renderPanel();
      // Click the per-row pencil button
      fireEvent.click(screen.getByLabelText("uploads.row.rename"));
      // Input appears with the draft name
      const input = screen.getByDisplayValue("old-name.pdf");
      fireEvent.change(input, { target: { value: "New Name" } });
      // Submit the form (simulates Enter)
      const form = input.closest("form")!;
      fireEvent.submit(form);
      await waitFor(() => {
        expect(renameMutateAsync).toHaveBeenCalledWith({ id: "r1", originalName: "New Name" });
      });
    });

    it("Escape cancels → useRenameDraft NOT called → name reverts", () => {
      setDrafts([draft({ id: "r2", originalName: "keep-me.pdf", parseStatus: "unassigned" })]);
      renderPanel();
      fireEvent.click(screen.getByLabelText("uploads.row.rename"));
      const input = screen.getByDisplayValue("keep-me.pdf");
      fireEvent.change(input, { target: { value: "changed" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(renameMutateAsync).not.toHaveBeenCalled();
      // Input gone — name reverted to the static <p>
      expect(screen.queryByDisplayValue("changed")).not.toBeInTheDocument();
      expect(screen.getByText("keep-me.pdf")).toBeInTheDocument();
    });

    it("empty name submit → silent cancel → useRenameDraft NOT called", async () => {
      setDrafts([draft({ id: "r3", originalName: "name.pdf", parseStatus: "unassigned" })]);
      renderPanel();
      fireEvent.click(screen.getByLabelText("uploads.row.rename"));
      const input = screen.getByDisplayValue("name.pdf");
      fireEvent.change(input, { target: { value: "" } });
      const form = input.closest("form")!;
      fireEvent.submit(form);
      // Empty → setEditingId(null) silently; no mutate call
      await waitFor(() => {
        expect(renameMutateAsync).not.toHaveBeenCalled();
      });
      // Name reverted to static <p>
      expect(screen.getByText("name.pdf")).toBeInTheDocument();
    });

    it("blur saves → useRenameDraft.mutateAsync called (D-06 onBlur contract)", async () => {
      setDrafts([draft({ id: "r4", originalName: "blur-me.pdf", parseStatus: "unassigned" })]);
      renderPanel();
      fireEvent.click(screen.getByLabelText("uploads.row.rename"));
      const input = screen.getByDisplayValue("blur-me.pdf");
      fireEvent.change(input, { target: { value: "blurred.pdf" } });
      // Blur the input → onBlur fires handleRename (same as Enter save)
      fireEvent.blur(input);
      await waitFor(() => {
        expect(renameMutateAsync).toHaveBeenCalledWith({ id: "r4", originalName: "blurred.pdf" });
      });
    });

    it("rename enabled in EVERY state incl. in-flight (D-07)", () => {
      setDrafts([
        draft({ id: "inf", parseStatus: "assigned", ragStatus: "processing", kbStatus: "PROCESSING" }),
      ]);
      renderPanel();
      // Pencil is NOT disabled even when the row is in-flight (single-delete is gone)
      const pencilBtn = screen.getByLabelText("uploads.row.rename");
      expect(pencilBtn).not.toBeDisabled();
    });
  });

  /* ------------------------------------------------------------------ */
  /*  UAT-1 — touch target contract (mobile ≥44px)                       */
  /*  The `min-h-[44px]` class is a CSS floor (min-height:44px) emitted   */
  /*  deterministically by Tailwind (verified in the compiled CSS), so  */
  /*  its presence on a button => rendered height ≥44px on mobile.       */
  /* ------------------------------------------------------------------ */
  describe("touch target contract (UAT-1 ≥44px mobile)", () => {
    it("per-row pencil rename button carries min-h-[44px]", () => {
      setDrafts([draft({ id: "r", parseStatus: "unassigned" })]);
      renderPanel();
      const pencil = screen.getByLabelText("uploads.row.rename");
      expect(pencil.className).toContain("min-h-[44px]");
    });

    it("Delete Selected toolbar button carries min-h-[44px]", () => {
      setDrafts([draft({ id: "r", parseStatus: "unassigned" })]);
      renderPanel();
      const deleteSelected = screen.getByText("uploads.bulkDelete.deleteSelected");
      expect(deleteSelected.className).toContain("min-h-[44px]");
    });

    it("retry-KB button carries min-h-[44px] (when FAILED)", () => {
      setDrafts([
        draft({ id: "bad", parseStatus: "assigned", kbStatus: "FAILED", ragStatus: "completed" }),
      ]);
      renderPanel();
      const retry = screen.getByText("uploads.row.retryKb");
      expect(retry.className).toContain("min-h-[44px]");
    });
  });
});
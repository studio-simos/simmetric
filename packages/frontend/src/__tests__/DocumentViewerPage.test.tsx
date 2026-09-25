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
// Phase 192-08 (D-10): the viewer now consumes the DLP placeholder helper +
// useMe for the unmask gate; the mock must carry both seams.
// Phase 204 (DEBT-SW-05): the edit affordance consumes useUpdateDocumentText.
// The mutation hook stays REAL (jest.requireActual inside the factory — the
// factory hoists, so the resolution must happen lazily) so its onSuccess
// invalidation arm is exercisable — the invalidation target is observable
// through the useQueryClient mock below, and the apiPut call through the
// ../utils/api mock.
jest.mock("../queries/useDocuments", () => ({
  useDocumentText: (...args: unknown[]) => useDocumentTextMock(...args),
  hasDlpPlaceholders: (text: string | undefined) =>
    typeof text === "string" && /\[\s*[A-Z][A-Z_]*\s*_\s*\d+\s*\]/.test(text),
  useUpdateDocumentText: jest.requireActual("../queries/useDocuments").useUpdateDocumentText,
}));

jest.mock("../utils/api", () => ({
  apiGet: jest.fn(),
  apiPut: jest.fn(),
  apiPost: jest.fn(),
  apiPatch: jest.fn(),
  apiDelete: jest.fn(),
}));

// Phase 204 (DEBT-SW-05): mock useQueryClient so the mutation's
// invalidateQueries arm is observable (ArchivePageFullView.test.tsx
// precedent). Keep the rest of @tanstack/react-query real so
// QueryClientProvider still works.
const mockQueryClient = { invalidateQueries: jest.fn() };
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => mockQueryClient,
  };
});

// Mutable so CR-01 permission-gating tests can drive the fixture.
const useMeMock = jest.fn();
jest.mock("../queries/useAuth", () => ({
  useMe: () => useMeMock(),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { renderWithProviders } from "./test-utils";
import { showSuccess, showError } from "../lib/toast";
import { apiPut } from "../utils/api";
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
  // Default permission posture: dlp:unmask holder (CR-01 tests override).
  useMeMock.mockReturnValue({ data: { permissions: ["dlp:unmask"] }, isLoading: false, error: null });
  // Phase 204 (DEBT-SW-05): apiPut resolves the 202 mutation response by
  // default (the real hook's mutationFn rides it); per-test overrides flip
  // to rejection for the error arm.
  (apiPut as jest.Mock).mockResolvedValue({ documentId: "doc-1", status: "reindexing" });
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

// ═══════════════════════════════════════════════════════════════════
// Phase 204 (DEBT-SW-05, FEAT-01) — the edit affordance:
// pencil → textarea prefill → save (apiPut + invalidate + toast) →
// error toast + edit stays open → cancel discards.
// CR-01 (204-REVIEW): the pencil is DOM-absent for non-dlp:unmask users
// on entity-carrying documents, startEdit refuses to prefill the MASKED
// skeleton, and the prefill on entity-carrying documents rides the
// UNMASKED variant — saving must never persist the placeholder skeleton.
// ═══════════════════════════════════════════════════════════════════
describe("DocumentViewerPage — edit affordance (DEBT-SW-05)", () => {
  it("renders the edit pencil button on the completed viewer", () => {
    renderViewer();
    expect(screen.getByTestId("document-viewer-edit-btn")).toBeInTheDocument();
  });

  it("edit toggle: clicking the pencil shows a textarea prefilled with the served text", () => {
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    const textarea = screen.getByTestId("document-viewer-edit-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeInTheDocument();
    expect(textarea.value).toBe(completedFixture.text);
  });

  it("save: apiPut's PUT /documents/doc-1/text with { body } and exits edit mode on success", async () => {
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    const textarea = screen.getByTestId("document-viewer-edit-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "# Edited\n\nNew body." } });
    fireEvent.click(screen.getByTestId("document-viewer-save-btn"));
    await waitFor(() => {
      expect(apiPut).toHaveBeenCalledWith("/documents/doc-1/text", { body: "# Edited\n\nNew body." });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("document-viewer-edit-textarea")).not.toBeInTheDocument();
    });
  });

  it("save success: invalidates the document text queryKey (masked + unmask variants) and the doc list", async () => {
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    fireEvent.click(screen.getByTestId("document-viewer-save-btn"));
    await waitFor(() => {
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalled();
    });
    const invalidatedKeys = mockQueryClient.invalidateQueries.mock.calls.map(
      (c: unknown[]) => c[0]?.queryKey,
    );
    // The text query prefix (covers masked + unmask variants) AND the list.
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([
        ["documents", "text", "doc-1"],
        ["documents", "list"],
      ]),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("document-viewer-edit-textarea")).not.toBeInTheDocument();
    });
  });

  it("save success: shows the success toast (reindexing notice)", async () => {
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    fireEvent.click(screen.getByTestId("document-viewer-save-btn"));
    await waitFor(() => {
      expect(showSuccess).toHaveBeenCalledWith("documents.edit.reindexing");
    });
  });

  it("mutation error: showError toast + edit mode stays open", async () => {
    (apiPut as jest.Mock).mockRejectedValue(new Error("403"));
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    fireEvent.click(screen.getByTestId("document-viewer-save-btn"));
    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("documents.edit.failed");
    });
    // Edit mode persists — the user can retry or cancel.
    expect(screen.getByTestId("document-viewer-edit-textarea")).toBeInTheDocument();
  });

  it("cancel: exits edit mode discarding changes", () => {
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    const textarea = screen.getByTestId("document-viewer-edit-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "discarded draft" } });
    fireEvent.click(screen.getByTestId("document-viewer-cancel-btn"));
    expect(screen.queryByTestId("document-viewer-edit-textarea")).not.toBeInTheDocument();
    // Original read-mode content still present.
    expect(screen.getByText(/Some extracted text\./)).toBeInTheDocument();
  });

  it("i18n: no hardcoded save/cancel labels — all arms resolve via t() keys", () => {
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    expect(screen.getByTestId("document-viewer-save-btn")).toHaveTextContent("documents.edit.save");
    expect(screen.getByTestId("document-viewer-cancel-btn")).toHaveTextContent("documents.edit.cancel");
  });
});

// ═══════════════════════════════════════════════════════════════════
// CR-01 (204-REVIEW) — the masked-prefill one-way door. The masked served
// text contains placeholder tokens; saving that skeleton used to destroy
// the document + the entity map. The UI contract: pencil DOM-absent
// without dlp:unmask, editor blocked until the unmasked variant loads,
// prefill rides the UNMASKED text.
// ═══════════════════════════════════════════════════════════════════
describe("DocumentViewerPage — CR-01 masked-edit guard", () => {
  const MASKED_FIXTURE = {
    text: "Il cliente [PERSON_1] abita in [ADDRESS_1].",
    length: 42,
    name: "contratto.pdf",
    type: "pdf",
    status: "completed",
  };
  const UNMASKED_FIXTURE = {
    text: "Il cliente Mario Rossi abita in Via Roma 1.",
    length: 43,
    name: "contratto.pdf",
    type: "pdf",
    status: "completed",
  };

  function armViewer({
    permissions = ["dlp:unmask"],
    maskedText = MASKED_FIXTURE.text,
    unmaskedData,
  }: {
    permissions?: string[];
    maskedText?: string;
    unmaskedData?: { data: typeof MASKED_FIXTURE | undefined; isLoading: boolean; error: unknown; isError: boolean } | undefined;
  } = {}) {
    // The component calls useDocumentText twice: masked + unmask variants.
    // Route the calls by the unmask flag (second arg).
    useDocumentTextMock.mockImplementation((_id: unknown, unmask: boolean) => {
      if (!unmask) {
        return { data: { ...MASKED_FIXTURE, text: maskedText }, isLoading: false, error: null };
      }
      // Unmask variant: caller-provided arm or a not-yet-loaded default.
      return unmaskedData ?? { data: undefined, isLoading: false, error: null };
    });
    useMeMock.mockReturnValue({ data: { permissions }, isLoading: false, error: null });
  }

  it("pencil is ABSENT from the DOM for a user WITHOUT dlp:unmask on an entity-carrying document", () => {
    armViewer({ permissions: ["chat:write"] });
    renderViewer();
    expect(screen.queryByTestId("document-viewer-edit-btn")).not.toBeInTheDocument();
    // Editor unreachable — no way to prefill the masked skeleton.
    fireEvent.click(document.body); // no-op; the guard is DOM-absence
    expect(screen.queryByTestId("document-viewer-edit-textarea")).not.toBeInTheDocument();
  });

  it("pencil is PRESENT for a dlp:unmask holder on an entity-carrying document", () => {
    armViewer();
    renderViewer();
    expect(screen.getByTestId("document-viewer-edit-btn")).toBeInTheDocument();
  });

  it("startEdit BEFORE Show: blocked with documents.edit.maskedBlocked toast — no editor opens (masked text never prefilled)", async () => {
    armViewer(); // unmask variant not loaded (Show not clicked)
    renderViewer();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("documents.edit.maskedBlocked");
    });
    // No editor, and critically NO save with the masked skeleton.
    expect(screen.queryByTestId("document-viewer-edit-textarea")).not.toBeInTheDocument();
    expect(apiPut).not.toHaveBeenCalled();
  });

  it("startEdit after the UNMASKED variant loads (Show clicked): prefill is the UNMASKED text (never the masked skeleton)", async () => {
    armViewer({ unmaskedData: { data: UNMASKED_FIXTURE, isLoading: false, error: null } });
    renderViewer();
    // The unmask variant loads ONLY through the per-view Show toggle —
    // simulate the real flow: Show → unmasked text served → Edit.
    fireEvent.click(screen.getByText("documents.dlp.show"));
    await waitFor(() => {
      expect(screen.getByText(/Mario Rossi/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    const textarea = screen.getByTestId("document-viewer-edit-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(UNMASKED_FIXTURE.text);
    expect(textarea.value).not.toContain("[PERSON_1]");
  });

  it("startEdit on an entity-carrying doc whose unmask fetch FAILED: blocked (no masked prefill, no editor)", async () => {
    armViewer({ unmaskedData: { data: undefined, isLoading: false, error: new Error("boom"), isError: true } });
    renderViewer();
    // Show fails → the unmask-error banner shows; Edit must still refuse
    // (the masked skeleton is the only loaded variant).
    fireEvent.click(screen.getByText("documents.dlp.show"));
    await waitFor(() => {
      expect(screen.getByTestId("dlp-unmask-error")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    await waitFor(() => {
      expect(showError).toHaveBeenCalledWith("documents.edit.maskedBlocked");
    });
    expect(screen.queryByTestId("document-viewer-edit-textarea")).not.toBeInTheDocument();
  });

  it("clean document: pencil renders unconditionally and the editor prefills the served text (unchanged happy path)", () => {
    armViewer({ permissions: ["chat:write"], maskedText: completedFixture.text });
    renderViewer();
    expect(screen.getByTestId("document-viewer-edit-btn")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("document-viewer-edit-btn"));
    const textarea = screen.getByTestId("document-viewer-edit-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe(completedFixture.text);
  });
});
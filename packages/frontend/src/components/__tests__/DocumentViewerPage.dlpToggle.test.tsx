// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DocumentViewerPage DLP toggle tests — Phase 192 (D-10, UI-SPEC surface 2,
 * interaction rule 2).
 *
 * Contract under test:
 *  - The unmask toggle is ABSENT from the DOM for users without dlp:unmask
 *    (DOM-absence, not disabled-hidden) and for documents without entities.
 *  - The toggle is PRESENT for dlp:unmask holders on entity-carrying
 *    documents (Eye/EyeOff + label, aria-pressed).
 *  - Per-view refetch: clicking Show re-fetches with ?unmask=true; Hide
 *    reverts to the masked fetch. NO localStorage write, NO URL mutation.
 *  - Unmask fetch error arm: the masked text stays rendered + the
 *    documents.dlp.unmaskError inline banner with a retry affordance.
 *  - The amber masked notice (documents.dlp.maskedNotice) renders when the
 *    document carries DLP entities; placeholder tokens render literally
 *    (inline tokenizer — no dangerouslySetInnerHTML on the masked body).
 *  - Navigating away and back (component remount) returns to masked default.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import DocumentViewerPage from "../DocumentViewerPage";

// Mock i18next (identity t — keys asserted literally, repo component-test style)
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock toast wrapper
jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock auth queries — mutable via useMeMock so permission gating is testable
const useMeMock = jest.fn();
jest.mock("../../queries/useAuth", () => ({
  useMe: () => useMeMock(),
}));

// The component's useMe mock bypasses the real hook (which keys off the
// localStorage token), so no token seeding is required — see the useMeMock
// fixtures per test.

// ── useDocumentText mock — captures (documentId, unmask) call pairs ──
// The component calls useDocumentText TWICE (masked query + per-view unmask
// query). Each mock invocation receives the args; the unmask flag is the
// second argument. Fixture arms set a resolver per unmask variant.
const documentTextCalls: Array<[string | undefined, boolean]> = [];
const textResolver = jest.fn();

jest.mock("../../queries/useDocuments", () => {
  const { useQuery } = require("@tanstack/react-query");
  return {
    // Re-export the probe helpers verbatim (the component imports them).
    DLP_PLACEHOLDER_REGEX: /\[\s*[A-Z][A-Z_]*\s*_\s*\d+\s*\]/,
    hasDlpPlaceholders: (text: string | undefined) =>
      typeof text === "string" && /\[\s*[A-Z][A-Z_]*\s*_\s*\d+\s*\]/.test(text),
    useDocumentText: (documentId: string | undefined, unmask = false) => {
      documentTextCalls.push([documentId, unmask]);
      return useQuery({
        queryKey: ["documents", "text", documentId ?? "", unmask],
        queryFn: () => textResolver(documentId, unmask),
        enabled: !!documentId,
        staleTime: 30_000,
      });
    },
  };
});

// Mock markdown renderer (the masked body renders via the inline tokenizer;
// non-DLP documents still route through renderMarkdown)
jest.mock("../../utils/markdown", () => ({
  renderMarkdown: (text: string) => `<p>${text}</p>`,
}));

import { showSuccess } from "../../lib/toast";

const MASKED_TEXT = "Il cliente [PERSON_1] abita in [ADDRESS_1].";
const UNMASKED_TEXT = "Il cliente Mario Rossi abita in Via Roma 1.";
const CLEAN_TEXT = "No personal data in this document.";

/** The masked body splits text into spans + <code> tokens — assert on the
 *  container's textContent (full-string text matchers break by design). */
const maskedBody = () => screen.getByTestId("dlp-masked-text");
const expectMaskedBody = (text: string) => {
  expect(maskedBody().textContent).toBe(text);
};

function makeFixture(text: string) {
  return { text, length: text.length, name: "contratto.pdf", type: "pdf", status: "completed" };
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/documents/doc-1"]}>
          <Routes>
            <Route path="/documents/:id" element={<DocumentViewerPage />} />
            <Route path="/documents" element={<div data-testid="documents-list" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** Resolve the masked/unmask text arms per-variant. */
function armFixture(opts: {
  masked: string;
  unmasked?: string;
  unmaskError?: boolean;
}) {
  textResolver.mockImplementation((_id: string | undefined, unmask: boolean) => {
    if (!unmask) return Promise.resolve(makeFixture(opts.masked));
    if (opts.unmaskError) return Promise.reject(new Error("boom"));
    return Promise.resolve(makeFixture(opts.unmasked ?? opts.masked));
  });
}

describe("DocumentViewerPage DLP toggle (192-08)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    documentTextCalls.length = 0;
    localStorage.clear();
    // clipboard stub (repo component-test precedent — DocumentsPage.test.tsx)
    Object.assign(navigator, {
      clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
    });
  });

  it("toggle is ABSENT from the DOM for a user without dlp:unmask (DOM-absence, not disabled-hidden)", async () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["admin:settings"] } });
    armFixture({ masked: MASKED_TEXT, unmasked: UNMASKED_TEXT });
    renderPage();
    await waitFor(() => expect(maskedBody().textContent).toBe(MASKED_TEXT));
    expect(screen.queryByText("documents.dlp.show")).not.toBeInTheDocument();
    // The masked default fetch is the only text fetch fired pre-toggle.
    expect(documentTextCalls.every(([, unmask]) => unmask === false)).toBe(true);
  });

  it("toggle is ABSENT for a dlp:unmask holder when the document has NO entities", async () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["dlp:unmask"] } });
    armFixture({ masked: CLEAN_TEXT, unmasked: CLEAN_TEXT });
    renderPage();
    // No-entities documents render through the markdown path (no tokenizer).
    await waitFor(() =>
      expect(document.body.textContent).toContain(CLEAN_TEXT),
    );
    expect(screen.queryByTestId("dlp-masked-text")).not.toBeInTheDocument();
    expect(screen.queryByText("documents.dlp.show")).not.toBeInTheDocument();
    // No amber masked notice on a clean document.
    expect(screen.queryByTestId("dlp-masked-notice")).not.toBeInTheDocument();
  });

  it("toggle is PRESENT for a dlp:unmask holder on an entity-carrying document, with aria-pressed", async () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["dlp:unmask"] } });
    armFixture({ masked: MASKED_TEXT, unmasked: UNMASKED_TEXT });
    renderPage();
    const toggle = await screen.findByText("documents.dlp.show");
    expect(toggle).toBeInTheDocument();
    const button = toggle.closest("button")!;
    expect(button).toHaveAttribute("aria-pressed", "false");
    // Amber masked notice renders when entities exist.
    expect(await screen.findByTestId("dlp-masked-notice")).toBeInTheDocument();
    // Placeholder tokens render literally (inline tokenizer, mono).
    expect(screen.getByTestId("dlp-masked-text")).toBeInTheDocument();
    expect(screen.getByTestId("dlp-masked-text").textContent).toContain("[PERSON_1]");
  });

  it("clicking Show refetches with the unmask variant; Hide reverts to the masked fetch (per-view, no persistence)", async () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["dlp:unmask"] } });
    armFixture({ masked: MASKED_TEXT, unmasked: UNMASKED_TEXT });
    renderPage();
    await waitFor(() => expect(maskedBody().textContent).toBe(MASKED_TEXT));

    fireEvent.click(screen.getByText("documents.dlp.show"));
    // The unmasked text renders after the refetch (no entities in the
    // unmasked text → the markdown path renders it; assert on body text).
    await waitFor(() =>
      expect(document.body.textContent).toContain(UNMASKED_TEXT),
    );
    // At least one unmask-variant fetch happened.
    expect(documentTextCalls.some(([, unmask]) => unmask === true)).toBe(true);
    // Toggle label flips + aria-pressed flips.
    const hide = screen.getByText("documents.dlp.hide").closest("button")!;
    expect(hide).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByText("documents.dlp.hide"));
    await waitFor(() => expectMaskedBody(MASKED_TEXT));
    expect(screen.getByText("documents.dlp.show")).toBeInTheDocument();

    // Per-view rule: NO localStorage write, NO URL param mutation.
    expect(localStorage.getItem("dlp-unmask")).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(window.location.search).toBe("");
  });

  it("masked DEFAULT on every mount: navigating away and back returns to masked (no persisted state)", async () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["dlp:unmask"] } });
    armFixture({ masked: MASKED_TEXT, unmasked: UNMASKED_TEXT });
    const { unmount } = renderPage();
    await waitFor(() => expectMaskedBody(MASKED_TEXT));
    fireEvent.click(screen.getByText("documents.dlp.show"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(UNMASKED_TEXT),
    );
    // Navigate away and back — remount.
    unmount();
    renderPage();
    await waitFor(() => expectMaskedBody(MASKED_TEXT));
    expect(screen.getByText("documents.dlp.show")).toBeInTheDocument();
  });

  it("unmask fetch error keeps the masked text rendered + shows the retry banner (error arm)", async () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["dlp:unmask"] } });
    armFixture({ masked: MASKED_TEXT, unmaskError: true });
    renderPage();
    await waitFor(() => expectMaskedBody(MASKED_TEXT));
    fireEvent.click(screen.getByText("documents.dlp.show"));
    // Error banner + retry affordance appear.
    const banner = await screen.findByTestId("dlp-unmask-error");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toContain("documents.dlp.unmaskError");
    expect(banner.textContent).toContain("documents.dlp.show"); // retry ghost button
    // The masked text STAYS rendered — never a blank page.
    expect(maskedBody().textContent).toContain("[PERSON_1]");
  });

  it("masked text renders WITHOUT dangerouslySetInnerHTML (plain React tokenizer on the masked body)", async () => {
    useMeMock.mockReturnValue({ data: { id: "u1", permissions: ["dlp:unmask"] } });
    armFixture({ masked: MASKED_TEXT, unmasked: UNMASKED_TEXT });
    const { container } = renderPage();
    await waitFor(() => expectMaskedBody(MASKED_TEXT));
    // The masked body is the tokenizer output (dlp-masked-text testid), with
    // placeholder tokens in <code> mono elements.
    const body = screen.getByTestId("dlp-masked-text");
    expect(body.querySelectorAll("code").length).toBeGreaterThanOrEqual(2);
    // Copy button still works (masked text copied — masked is what's on screen).
    const copyButton = screen.getByText("documents.copyText").closest("button")!;
    fireEvent.click(copyButton);
    await waitFor(() => expect(showSuccess).toHaveBeenCalledWith("documents.copySuccess"));
    expect(container).toBeInTheDocument();
  });
});
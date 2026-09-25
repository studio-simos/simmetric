// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DocumentViewerPage long-text masked-render backstop — Phase 192 plan 09.
 *
 * UI-SPEC UI Considerations · long-text · S2 (the ONE held-out backstop row):
 * "What happens with unusually long text — truncation, wrapping, ellipsis,
 * or reflow?" — closed here by a held-out VISUAL/UI-state test, not pixels:
 *
 *  - A ~40KB masked text carrying 50+ interleaved [CLASS_N] placeholders
 *    renders with EVERY placeholder tokenized as its mono <code> span —
 *    the inline tokenizer is applied across the FULL text, not just the
 *    first N tokens (the last token in the fixture is asserted present).
 *  - The text container keeps the viewer's existing wrap/reflow behavior
 *    (`whitespace-pre-wrap break-words` inside the `overflow-y-auto` scroll
 *    shell) — no overflow-x clipping / truncation class is introduced.
 *  - The amber masked notice renders ABOVE the text as a normal-flow block
 *    (immediately-preceding sibling, no absolute/fixed positioning) — the
 *    two can never overlap regardless of text length.
 *  - The full text survives rendering byte-equal (textContent === fixture):
 *    nothing is truncated and every placeholder occurrence survives.
 *
 * Asserts the rendered state (presence of mono spans, container classes,
 * sibling order) — not pixel values.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
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

// Mock auth queries — dlp:unmask holder (the toggle-bearing arm; the backstop
// exercises the MASKED default view, so the unmask query stays disabled).
const useMeMock = jest.fn();
jest.mock("../../queries/useAuth", () => ({
  useMe: () => useMeMock(),
}));

// ── useDocumentText mock — masked arm only (this backstop never toggles) ──
const textResolver = jest.fn();

jest.mock("../../queries/useDocuments", () => {
  const { useQuery } = require("@tanstack/react-query");
  return {
    DLP_PLACEHOLDER_REGEX: /\[\s*[A-Z][A-Z_]*\s*_\s*\d+\s*\]/,
    hasDlpPlaceholders: (text: string | undefined) =>
      typeof text === "string" && /\[\s*[A-Z][A-Z_]*\s*_\s*\d+\s*\]/.test(text),
    useDocumentText: (documentId: string | undefined, unmask = false) => {
      return useQuery({
        queryKey: ["documents", "text", documentId ?? "", unmask],
        queryFn: () => textResolver(documentId, unmask),
        enabled: !!documentId,
        staleTime: 30_000,
      });
    },
    // Phase 204 (DEBT-SW-05): the edit affordance consumes the mutation seam
    // — this backstop suite never triggers it, so a resolved promise stub
    // keeps the hook contract whole.
    useUpdateDocumentText: () => ({
      mutateAsync: jest.fn().mockResolvedValue({ documentId: "doc", status: "reindexing" }),
      isPending: false,
    }),
  };
});

// Mock markdown renderer (unused on the masked arm; keep the module import safe)
jest.mock("../../utils/markdown", () => ({
  renderMarkdown: (text: string) => `<p>${text}</p>`,
}));

/** ~40KB masked fixture: 55 paragraph variants × 4 placeholders = 220 tokens,
 *  interleaved with long prose runs AND periodic long unbroken runs (the
 *  `break-words` stressor). Built programmatically per the plan. */
function buildLongMaskedFixture(): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  const paragraphs: string[] = [];
  const prose =
    "Il presente estratto riporta la conversazione acquisita durante la " +
    "perizia tecnica, con le diciture originali conservate integralmente " +
    "ai fini della controdeduzione e della successiva valutazione collegiale. " +
    "Si evidenzia inoltre che ogni rilevazione riportata è stata confrontata " +
    "con il verbale originario depositato in cancelleria, con riscontro " +
    "puntuale delle diciture contestate e delle relative integrazioni " +
    "successivamente acquisite dal consulente tecnico d'ufficio. ";
  for (let i = 1; i <= 55; i++) {
    const person = `[PERSON_${i}]`;
    const govId = `[GOV_ID_${i}]`;
    const address = `[ADDRESS_${i}]`;
    const financial = `[FINANCIAL_${i}]`;
    tokens.push(person, govId, address, financial);
    // Long unbroken run every 10th paragraph (no spaces — exercises break-words)
    const longRun =
      i % 10 === 0 ? ` RIF:${"A7X".repeat(80)};` : "";
    paragraphs.push(
      `Estratto ${i}. Il cliente ${person} — codice fiscale ${govId} — ` +
        `abita in ${address}; il bonifico sequestrato reca l'IBAN ${financial} ` +
        `e l'importo complessivo di 12.500,00 euro risulta intestato alla ` +
        `controparte interrogata nello stesso procedimento.${longRun} ${prose}`,
    );
  }
  // One 1200-char contiguous unbroken run at the end (worst-case reflow).
  paragraphs.push(`CODICE:${"Z9".repeat(600)} FINE.`);
  return { text: paragraphs.join("\n\n"), tokens };
}

const maskedBody = () => screen.getByTestId("dlp-masked-text");

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/documents/doc-long"]}>
          <Routes>
            <Route path="/documents/:id" element={<DocumentViewerPage />} />
            <Route path="/documents" element={<div data-testid="documents-list" />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("DocumentViewerPage long-text masked render (192-09 backstop, UI-SPEC long-text · S2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it(
    "a ~40KB masked text with 220 interleaved placeholders renders fully tokenized, wrapped, with the notice above and no overlap/clipping",
    async () => {
      useMeMock.mockReturnValue({
        data: { id: "u1", permissions: ["dlp:unmask"] },
      });
      const { text, tokens } = buildLongMaskedFixture();
      // Fixture sanity: ~40KB scale, 50+ placeholders (acceptance floor).
      expect(text.length).toBeGreaterThanOrEqual(40_000);
      expect(tokens.length).toBeGreaterThanOrEqual(50);

      textResolver.mockImplementation((_id: unknown, unmask: boolean) =>
        unmask
          ? Promise.reject(new Error("backstop never unmasks"))
          : Promise.resolve({
              text,
              length: text.length,
              name: "corpus-long.pdf",
              type: "pdf",
              status: "completed",
            }),
      );

      renderPage();

      // (a) EVERY placeholder token renders as its mono <code> span — the
      // tokenizer ran across the FULL text, not just the first N tokens.
      await waitFor(() => expect(maskedBody()).toBeInTheDocument());
      const codeTokens = maskedBody().querySelectorAll("code.font-mono");
      expect(codeTokens.length).toBe(tokens.length);
      // First AND last token present (the "not just the first N" proof).
      expect(codeTokens[0].textContent).toBe("[PERSON_1]");
      expect(codeTokens[codeTokens.length - 1].textContent).toBe(
        "[FINANCIAL_55]",
      );
      // Every rendered token is exactly a fixture token, in document order.
      const renderedTokens = Array.from(codeTokens).map(
        (el) => el.textContent ?? "",
      );
      expect(renderedTokens).toEqual(tokens);

      // Nothing truncated: the container's full text equals the fixture.
      expect(maskedBody().textContent).toBe(text);

      // (b) The container keeps the viewer's existing wrap/reflow behavior —
      // pre-wrap + break-words on the text block; the scroll shell scrolls
      // VERTICALLY and introduces no horizontal clipping/truncation class.
      expect(maskedBody().className).toContain("whitespace-pre-wrap");
      expect(maskedBody().className).toContain("break-words");
      expect(maskedBody().className).not.toContain("truncate");
      expect(maskedBody().className).not.toContain("overflow-x");
      const scrollShell = maskedBody().parentElement!;
      expect(scrollShell.className).toContain("overflow-y-auto");
      expect(scrollShell.className).not.toContain("overflow-x-hidden");
      expect(scrollShell.className).not.toContain("overflow-clip");
      // The outer Card keeps its pre-existing shell overflow only.
      expect(maskedBody().closest(".overflow-hidden")).not.toBeNull();

      // (c) The amber notice renders ABOVE the text without overlapping it:
      // it is the immediately-preceding sibling in normal flow (block-level,
      // static positioning — no absolute/fixed collision possible).
      const notice = screen.getByTestId("dlp-masked-notice");
      expect(notice).toBeInTheDocument();
      expect(notice.getAttribute("role")).toBe("status");
      expect(maskedBody().previousElementSibling).toBe(notice);
      expect(notice.className).not.toMatch(/\b(absolute|fixed)\b/);
      // Notice is fully inside the same scroll shell (scrolls WITH the text).
      expect(notice.parentElement).toBe(scrollShell);
    },
    30_000,
  );
});
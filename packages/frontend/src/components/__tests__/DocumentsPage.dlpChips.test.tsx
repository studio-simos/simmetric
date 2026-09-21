// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * DocumentsPage DLP chips tests — Phase 192 (DLP-03 visible closure, UI-SPEC
 * surface 3, interaction rule 3).
 *
 * Contract under test:
 *  - Each chip variant derives from the ADDITIVE scan fields (never from
 *    Document.status): queued/scanning → secondary scanPending/scanning,
 *    clean → outline clean, entities count → secondary entities
 *    (i18n pluralization), failed → destructive.
 *  - Chips render BESIDE statusBadge — never replacing it.
 *  - Zero arm: unscanned legacy docs (no dlpScanState) get NO chip.
 *  - Display-only: no click action; detail via Tooltip only.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import DocumentsPage from "../DocumentsPage";

// Mock i18next — identity t that interpolates INTO THE KEY STRING (the repo's
// component-test convention from DlpDocumentScanPanel.test.tsx)
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

// Mock toast wrapper
jest.mock("../../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock react-router-dom
const mockNavigate = jest.fn();
jest.mock("react-router-dom", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a data-testid={`link-${to}`} href={to}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
}));

// Mock ChatContext
jest.mock("../../contexts/ChatContext", () => ({
  useChatNav: () => ({ currentWorkspaceId: "ws-1", currentChatId: null }),
}));

// Mock auth queries — dlp:unmask holder (admin role auto-gains the permission)
jest.mock("../../queries/useAuth", () => ({
  useMe: () => ({
    data: { id: "user-1", permissions: ["admin:settings", "dlp:unmask"] },
    isLoading: false,
  }),
}));

// Mock API
const mockApiGet = jest.fn();
const mockApiPost = jest.fn();
jest.mock("../../utils/api", () => ({
  apiGet: (...args: Parameters<typeof mockApiGet>) => mockApiGet(...args),
  apiPost: (...args: Parameters<typeof mockApiPost>) => mockApiPost(...args),
  ApiError: class ApiError extends Error { status: number; details: unknown; constructor(s: number, m: string, d?: unknown) { super(m); this.status = s; this.details = d; } },
}));

// Mock workspace queries
jest.mock("../../queries/useWorkspaces", () => ({
  useWorkspaces: () => ({
    data: [{ id: "ws-1", name: "Test Workspace" }],
    isLoading: false,
  }),
}));

// Mock archive queries (KB-05 copy-to-archive dialog)
jest.mock("../../queries/useArchives", () => ({
  useArchives: () => ({ data: [], isLoading: false }),
}));

/** Base document row fixture (pre-DLP shape, additive fields layered on). */
function docFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "doc-1",
    workspaceId: "ws-1",
    name: "contratto.pdf",
    type: "pdf",
    chunkCount: 5,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    status: "completed",
    statusMessage: null,
    progress: 0,
    fileSize: 1024,
    createdAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

describe("DocumentsPage DLP chips (192-08)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders the queued chip (secondary, scanPending) beside the status badge", async () => {
    mockApiGet.mockResolvedValueOnce([
      docFixture({ id: "doc-q", dlpScanState: "queued" }),
    ]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByText("contratto.pdf")).toBeInTheDocument());
    expect(screen.getByText("documents.dlp.scanPending")).toBeInTheDocument();
    // statusBadge still renders BESIDE the chip (not replaced).
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("renders the scanning chip (secondary, scanning)", async () => {
    mockApiGet.mockResolvedValueOnce([
      docFixture({ id: "doc-s", dlpScanState: "scanning" }),
    ]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByText("documents.dlp.scanning")).toBeInTheDocument());
  });

  it("renders the entities-count chip with i18n pluralization interpolation", async () => {
    mockApiGet.mockResolvedValueOnce([
      docFixture({ id: "doc-e", dlpScanState: "scanned", dlpEntityCount: 3, dlpScannedAt: "2026-09-19T10:00:00Z" }),
    ]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("documents.dlp.entities::count=3")).toBeInTheDocument(),
    );
  });

  it("renders the failed chip (destructive variant)", async () => {
    mockApiGet.mockResolvedValueOnce([
      docFixture({ id: "doc-f", dlpScanState: "failed" }),
    ]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByText("documents.dlp.failed")).toBeInTheDocument());
    const chip = screen.getByText("documents.dlp.failed");
    expect(chip.className).toContain("destructive");
  });

  it("renders the clean chip (outline variant) for a scanned doc with zero entities", async () => {
    mockApiGet.mockResolvedValueOnce([
      docFixture({ id: "doc-c", dlpScanState: "clean", dlpEntityCount: 0, dlpScannedAt: "2026-09-19T10:00:00Z" }),
    ]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByText("documents.dlp.clean")).toBeInTheDocument());
    const chip = screen.getByTestId("dlp-chip");
    // data-variant attribute carries the badge variant (border-border styling).
    expect(chip).toHaveAttribute("data-variant", "outline");
  });

  it("zero arm: legacy docs without dlpScanState render NO DLP chip", async () => {
    mockApiGet.mockResolvedValueOnce([docFixture()]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByText("contratto.pdf")).toBeInTheDocument());
    expect(screen.queryByTestId("dlp-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dlp-chip-slot")).not.toBeInTheDocument();
    // statusBadge still present.
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it("statusBadge and the DLP chip coexist per row (beside, never replacing)", async () => {
    mockApiGet.mockResolvedValueOnce([
      docFixture({ id: "doc-1", dlpScanState: "scanned", dlpEntityCount: 2 }),
      docFixture({ id: "doc-2", name: "pulito.md", type: "md", dlpScanState: "clean" }),
      docFixture({ id: "doc-3", name: "vecchio.csv", type: "csv" }),
    ]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByText("contratto.pdf")).toBeInTheDocument());
    // Row 1: entities chip + status badge.
    expect(screen.getByText("documents.dlp.entities::count=2")).toBeInTheDocument();
    // Row 2: clean chip.
    expect(screen.getByText("documents.dlp.clean")).toBeInTheDocument();
    // Row 3: no chip.
    expect(screen.getAllByTestId("dlp-chip")).toHaveLength(2);
    // The status badges for all three rows still render.
    expect(screen.getAllByText("completed")).toHaveLength(3);
  });

  it("chips are display-only: no click handler on the chip wrapper", async () => {
    mockApiGet.mockResolvedValueOnce([
      docFixture({ dlpScanState: "scanned", dlpEntityCount: 2 }),
    ]);
    render(
      <TooltipProvider>
        <DocumentsPage />
      </TooltipProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("documents.dlp.entities::count=2")).toBeInTheDocument(),
    );
    const slot = screen.getByTestId("dlp-chip-slot");
    // The wrapper span carries no onClick (display-only, UI-SPEC rule 3).
    const clickSpy = jest.fn();
    fireEvent.click(slot, { detail: 0 });
    expect(clickSpy).not.toHaveBeenCalled();
    // The Badge element itself is not a button/link.
    expect(screen.getByTestId("dlp-chip").closest("button")).toBeNull();
    expect(screen.getByTestId("dlp-chip").closest("a")).toBeNull();
  });
});
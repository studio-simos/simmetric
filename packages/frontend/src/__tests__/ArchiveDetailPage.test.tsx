// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveDetailPage orchestrator smoke tests
 *
 * Verifies the refactored orchestrator mounts correctly and renders
 * the three key UI zones: full-width header, tab navigation, and sidebar.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("react-router-dom", () => ({
  ...jest.requireActual("react-router-dom"),
  useParams: () => ({ archiveId: "test-archive-id", slug: undefined }),
  useNavigate: () => jest.fn(),
}));

jest.mock("../utils/api", () => ({
  apiGet: jest.fn().mockResolvedValue(null),
  apiPost: jest.fn().mockResolvedValue(null),
  apiPut: jest.fn().mockResolvedValue(null),
  apiDelete: jest.fn().mockResolvedValue(null),
}));

jest.mock("../hooks/usePageMeta", () => ({
  usePageMeta: jest.fn(),
}));

jest.mock("../queries/useArchives", () => ({
  useArchive: () => ({
    data: {
      id: "test-archive-id",
      slug: "test-archive",
      name: "Test Archive",
      description: "A test archive",
      createdBy: "admin",
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    isLoading: false,
    error: null,
  }),
  useArchivePages: () => ({ data: [], isLoading: false }),
  useArchivePage: () => ({ data: null, isLoading: false, error: null }),
  useDeleteArchive: () => ({ mutateAsync: jest.fn() }),
  // Additional hooks used by sub-components (Rule 3)
  useArchiveConfig: () => ({ data: null, isLoading: false }),
  useUpdateArchiveConfig: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useTriggerIndexing: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCreatePage: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDeletePage: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useExportArchive: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUpdateArchive: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCreateArchive: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useUpdatePage: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useArchives: () => ({ data: [], isLoading: false }),
  // KB-05/KB-06 hooks added in Phase 64-06.
  // F72 72-04 removed the per-archive upload route + its mutation hook;
  // the copy-from-doc hook is still exported (72-VERIFICATION SC-4).
  useCopyDocToArchive: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock("../hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

// ── Rule 3: Mock dependencies of sub-components in inactive tabs ──
// Without QueryClientProvider, TanStack Query hooks inside sub-components
// would throw. Mock the hook modules directly instead of the components.

jest.mock("../queries/useOcrJobs", () => ({
  useOcrJobs: () => ({ data: [], isLoading: false }),
  // F72 72-04 removed the OCR + URL-ingestion create routes and their
  // mutation hooks; only the job-listing hook is still exported.
}));

jest.mock("../queries/useOcrModels", () => ({
  useOcrModels: () => ({ data: [], isLoading: false }),
  useOcrPreview: () => ({ data: null, isLoading: false }),
}));

jest.mock("../queries/useAuth", () => ({
  useMe: () => ({ data: { id: "user-1", name: "Test User", role: "admin" }, isLoading: false }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

jest.mock("../components/OcrModelSelector", () => ({
  default: () => null,
}));

jest.mock("../components/OcrModeSelector", () => ({
  default: () => null,
}));

jest.mock("../components/OcrCustomInstructions", () => ({
  default: () => null,
}));

jest.mock("../components/OcrJobCard", () => ({
  default: () => null,
}));

// Mock D3 (same as ArchiveGraphView.test.tsx) to avoid SVG issues
jest.mock("d3", () => {
  const createSel = () => {
    const s: Record<string, unknown> = {};
    const methods = [
      "selectAll", "data", "join", "append", "attr", "style", "text",
      "call", "transition", "duration", "on", "remove", "scaleExtent",
      "strength", "id", "radius", "distance", "force", "alphaTarget",
      "restart", "stop", "transform", "toString",
    ];
    for (const m of methods) {
      s[m] = jest.fn(() => s);
    }
    return s;
  };
  return {
    select: jest.fn(() => createSel()),
    zoom: jest.fn(() => createSel()),
    zoomIdentity: {},
    forceSimulation: jest.fn(() => createSel()),
    forceLink: jest.fn(() => createSel()),
    forceManyBody: jest.fn(() => createSel()),
    forceCenter: jest.fn(() => createSel()),
    forceCollide: jest.fn(() => createSel()),
    drag: jest.fn(() => createSel()),
  };
});

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ArchiveDetailPage from "../components/ArchiveDetailPage";

// ── Tests ────────────────────────────────────────────────────────

describe("ArchiveDetailPage", () => {
  function renderPage() {
    return render(
      <MemoryRouter>
        <ArchiveDetailPage />
      </MemoryRouter>
    );
  }

  it("renders header with archive name", () => {
    renderPage();
    // "Test Archive" appears in both breadcrumb and CardTitle
    const elements = screen.getAllByText("Test Archive");
    expect(elements.length).toBeGreaterThanOrEqual(2);
  });

  it("renders four tab triggers", () => {
    renderPage();
    expect(screen.getByText("archiveDetail.tabs.pages")).toBeInTheDocument();
    expect(screen.getByText("archiveDetail.tabs.jobs")).toBeInTheDocument();
    expect(screen.getByText("archiveDetail.tabs.graph")).toBeInTheDocument();
    expect(screen.getByText("archiveDetail.tabs.config")).toBeInTheDocument();
  });

  it("shows empty page prompt on pages tab when no slug", () => {
    renderPage();
    expect(screen.getByText("archives.selectPagePreview")).toBeInTheDocument();
  });
});

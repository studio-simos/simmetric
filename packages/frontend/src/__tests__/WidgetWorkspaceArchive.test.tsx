// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WidgetWorkspaceArchive + WidgetsPage tab-shell tests (188-02 tracer, Task 1).
 *
 * Mock idiom: WidgetDetailPage.test.tsx (module-level jest.mock BEFORE imports;
 * t() returns the key; react-router-dom partially required; query hooks mocked
 * wholesale). Fixtures cover a multi-project widget (appears under BOTH groups,
 * spec §5.1 M:N) and an effective-orphan-free grouped payload (orphans counted
 * in stats only).
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

const mockNavigate = jest.fn();
let mockSearchParams = new URLSearchParams();
const mockSetSearchParams = jest.fn((next: Record<string, string>) => {
  mockSearchParams = new URLSearchParams(next);
});

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("react-router-dom", () => ({
  ...jest.requireActual("react-router-dom"),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}));

// ── Archive fixtures (Plan 188-01 response shapes) ───────────────
//
// project-1 has widget-1 (2 workspaces); project-2 ALSO carries widget-1
// (multi-project M:N — must appear under BOTH groups); widget-orphan counts
// only in stats (orphans: 1) and never renders in the grouped view.

const FIXTURE_GROUPS = [
  {
    project: { id: "project-1", name: "Project One" },
    widgets: [
      {
        id: "widget-1",
        name: "Alpha Widget",
        isActive: true,
        workspaces: [
          { id: "ws-1", name: "Workspace One" },
          { id: "ws-2", name: "Workspace Two" },
        ],
      },
    ],
  },
  {
    project: { id: "project-2", name: "Project Two" },
    widgets: [
      {
        id: "widget-1",
        name: "Alpha Widget",
        isActive: true,
        workspaces: [{ id: "ws-3", name: "Workspace Three" }],
      },
    ],
  },
];

const FIXTURE_STATS = {
  totalWidgets: 2,
  totalWorkspacesLinked: 3,
  totalProjects: 2,
  orphans: 1,
};

const FIXTURE_FLAT = [
  {
    widgetId: "widget-1",
    widgetName: "Alpha Widget",
    widgetIsActive: true,
    workspaceId: "ws-1",
    workspaceName: "Workspace One",
    projectId: "project-1",
    projectName: "Project One",
  },
];

const mockFlatEnabled = jest.fn();

jest.mock("../queries/useWidgetWorkspaceArchive", () => ({
  useWidgetWorkspaceArchive: () => ({ data: FIXTURE_GROUPS, isLoading: false }),
  useFlatArchive: (_filters: Record<string, unknown>, enabled: boolean) => {
    mockFlatEnabled(enabled);
    return { data: FIXTURE_FLAT, isLoading: false };
  },
  useArchiveStats: () => ({ data: FIXTURE_STATS, isLoading: false }),
}));

jest.mock("../queries/useWidgets", () => ({
  useWidgets: () => ({
    data: [{ id: "widget-1", name: "Alpha Widget", isActive: true, workspaces: [] }],
    isLoading: false,
  }),
  useDeleteWidget: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock("../queries/useProjects", () => ({
  useProjects: () => ({
    data: [
      { id: "project-1", name: "Project One" },
      { id: "project-2", name: "Project Two" },
    ],
    isLoading: false,
  }),
}));

jest.mock("../hooks/useFeature", () => ({
  useFeature: () => true,
}));

jest.mock("../hooks/usePageMeta", () => ({
  usePageMeta: jest.fn(),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

// AlertDialog wrapper mock (repo precedent: ArchiveCard.test.tsx).
jest.mock("../components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="delete-dialog">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogAction: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import WidgetWorkspaceArchive from "../components/WidgetWorkspaceArchive";
import WidgetsPage from "../components/WidgetsPage";
import { buildArchiveCsv } from "../components/WidgetWorkspaceArchive";

// ── Helpers ───────────────────────────────────────────────────────

function renderArchive() {
  return render(
    <MemoryRouter>
      <WidgetWorkspaceArchive />
    </MemoryRouter>
  );
}

function renderPage(tab?: string) {
  mockSearchParams = new URLSearchParams(tab ? `tab=${tab}` : "");
  return render(
    <MemoryRouter>
      <WidgetsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockSetSearchParams.mockClear();
  mockSearchParams = new URLSearchParams();
  mockFlatEnabled.mockClear();
});

afterEach(() => {
  cleanup();
});

// ── WidgetWorkspaceArchive tests ─────────────────────────────────

describe("WidgetWorkspaceArchive", () => {
  it("renders the stats header numbers (totals + orphans)", () => {
    renderArchive();
    expect(screen.getByTestId("archive-stats")).toBeInTheDocument();
    expect(screen.getByTestId("stat-total-widgets")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-total-workspaces")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-total-projects")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-orphans")).toHaveTextContent("1");
  });

  it("renders project group headers with widget rows and workspace chips", () => {
    renderArchive();
    // Two project groups present.
    expect(screen.getByTestId("archive-project-project-1")).toHaveTextContent("Project One");
    expect(screen.getByTestId("archive-project-project-2")).toHaveTextContent("Project Two");
  });

  it("expanding a project group reveals its widget row with badge + workspace chips", () => {
    renderArchive();
    fireEvent.click(screen.getByTestId("archive-project-project-1"));
    // Widget row appears under the expanded group.
    const row = screen.getByTestId("archive-widget-row-widget-1");
    expect(row).toHaveTextContent("Alpha Widget");
    expect(row).toHaveTextContent("widgets.archive.activeBadge");
    // Linked-workspace chips carry only THAT project's workspaces.
    expect(row).toHaveTextContent("Workspace One");
    expect(row).toHaveTextContent("Workspace Two");
  });

  it("a multi-project widget appears under BOTH project groups (spec §5.1 M:N)", () => {
    renderArchive();
    fireEvent.click(screen.getByTestId("archive-project-project-1"));
    // widget-1 under project-1…
    expect(screen.getByTestId("archive-widget-row-widget-1")).toHaveTextContent("Workspace One");
    // …expand project-2: the SAME widget id appears there too (separate keys).
    fireEvent.click(screen.getByTestId("archive-project-project-2"));
    expect(screen.getAllByTestId(/^archive-widget-row-widget-1/)).toHaveLength(2);
  });

  it("an orphan widget never appears in the grouped view (stats-only visibility)", () => {
    renderArchive();
    fireEvent.click(screen.getByTestId("archive-project-project-1"));
    // The fixture has no orphan group: widget-orphan must not render anywhere.
    expect(screen.queryByText("Orphan Widget")).not.toBeInTheDocument();
    // Stats still show the orphan count.
    expect(screen.getByTestId("stat-orphans")).toHaveTextContent("1");
  });

  it("row click navigates to the /widgets/:id edit point (D-03 — no inline mutations)", () => {
    renderArchive();
    fireEvent.click(screen.getByTestId("archive-project-project-1"));
    fireEvent.click(screen.getByTestId("archive-widget-row-widget-1"));
    expect(mockNavigate).toHaveBeenCalledWith("/widgets/widget-1");
  });

  it("renders the attribution row with BOTH hardcoded product hrefs (D-13b)", () => {
    renderArchive();
    const attribution = screen.getByTestId("archive-attribution");
    expect(attribution).toBeInTheDocument();
    const links = attribution.querySelectorAll("a");
    const hrefs = Array.from(links).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://www.studiosimos.it");
    expect(hrefs).toContain("https://www.simmetricchat.com");
  });

  it("renders an explicit empty-state message when the archive has no groups", () => {
    const realUseArchive = jest.requireMock("../queries/useWidgetWorkspaceArchive");
    realUseArchive.useWidgetWorkspaceArchive = () => ({ data: [], isLoading: false });
    renderArchive();
    expect(screen.getByText("widgets.archive.emptyState")).toBeInTheDocument();
    realUseArchive.useWidgetWorkspaceArchive = () => ({ data: FIXTURE_GROUPS, isLoading: false });
  });

  it("renders zeros in the stats header when stats are absent (empty DB)", () => {
    const realUseArchive = jest.requireMock("../queries/useWidgetWorkspaceArchive");
    realUseArchive.useArchiveStats = () => ({ data: undefined, isLoading: false });
    renderArchive();
    expect(screen.getByTestId("stat-total-widgets")).toHaveTextContent("0");
    expect(screen.getByTestId("stat-orphans")).toHaveTextContent("0");
    realUseArchive.useArchiveStats = () => ({ data: FIXTURE_STATS, isLoading: false });
  });
});

// ── Flat view + CSV (Task 2) ─────────────────────────────────────

describe("WidgetWorkspaceArchive — flat toggle + CSV (D-07)", () => {
  it("does NOT invoke the flat query while the grouped view is active (lazy fetch)", () => {
    renderArchive();
    expect(mockFlatEnabled).toHaveBeenLastCalledWith(false);
    // Grouped content visible, flat table absent.
    expect(screen.getByTestId("archive-grouped-view")).toBeInTheDocument();
    expect(screen.queryByTestId("archive-flat-view")).not.toBeInTheDocument();
  });

  it("toggling to flat enables the flat query and renders the flat table rows", async () => {
    renderArchive();
    fireEvent.click(screen.getByText("widgets.archive.viewFlat"));
    await waitFor(() => {
      expect(mockFlatEnabled).toHaveBeenLastCalledWith(true);
    });
    const flatView = screen.getByTestId("archive-flat-view");
    expect(flatView).toBeInTheDocument();
    // One row per widgetId × workspaceId from the fixture.
    expect(screen.getByTestId("archive-flat-row-widget-1-ws-1")).toBeInTheDocument();
    expect(screen.getByTestId("archive-flat-row-widget-1-ws-1")).toHaveTextContent("Project One");
    expect(screen.getByTestId("archive-flat-row-widget-1-ws-1")).toHaveTextContent("Alpha Widget");
    expect(screen.getByTestId("archive-flat-row-widget-1-ws-1")).toHaveTextContent("Workspace One");
  });

  it("CSV export exists ONLY in the flat view; grouped has no export button", async () => {
    renderArchive();
    expect(screen.queryByTestId("archive-export-csv")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("widgets.archive.viewFlat"));
    await waitFor(() => {
      expect(screen.getByTestId("archive-export-csv")).toBeInTheDocument();
    });
  });

  it("CSV download writes the escaped blob and triggers the anchor click with the archive filename", async () => {
    // jsdom does not implement URL.createObjectURL/revokeObjectURL — stub
    // them directly (spyOn requires the property to exist).
    const createObjectURLMock = jest.fn(() => "blob:mock-url");
    const revokeObjectURLMock = jest.fn();
    const urlRecord = URL as unknown as Record<string, unknown>;
    const originalCreateObjectURL = urlRecord.createObjectURL;
    const originalRevokeObjectURL = urlRecord.revokeObjectURL;
    urlRecord.createObjectURL = createObjectURLMock;
    urlRecord.revokeObjectURL = revokeObjectURLMock;
    // Capture the detached temp anchor's click (EventLogPanel idiom).
    const clickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    try {
      renderArchive();
      fireEvent.click(screen.getByText("widgets.archive.viewFlat"));
      await waitFor(() => {
        expect(screen.getByTestId("archive-export-csv")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("archive-export-csv"));

      await waitFor(() => {
        expect(createObjectURLMock).toHaveBeenCalled();
      });

      // Blob content: header row + flat rows, quote-escaped. The jest jsdom
      // Blob exposes only slice/size/type (no .text()) — assert size + type
      // here; the exact CSV content is pinned by the buildArchiveCsv tests.
      const blobArg = createObjectURLMock.mock.calls[0]?.[0] as Blob | undefined;
      expect(blobArg).toBeDefined();
      const expected =
        '"projectName","widgetName","widgetIsActive","workspaceName"\n' +
        '"Project One","Alpha Widget","true","Workspace One"';
      expect(blobArg!.type).toBe("text/csv;charset=utf-8;");
      expect(blobArg!.size).toBe(expected.length);

      // The temp anchor carries the CSV filename and its click was triggered.
      const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement | undefined;
      expect(anchor).toBeDefined();
      expect(anchor!.download).toMatch(/^widget-workspace-archive-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(revokeObjectURLMock).toHaveBeenCalledWith("blob:mock-url");
    } finally {
      urlRecord.createObjectURL = originalCreateObjectURL;
      urlRecord.revokeObjectURL = originalRevokeObjectURL;
      clickSpy.mockRestore();
    }
  });

  it("CSV escaping doubles embedded quotes (EventLogPanel idiom)", () => {
    const csv = buildArchiveCsv([
      {
        widgetId: "w1",
        widgetName: 'Quote "Widget"',
        widgetIsActive: false,
        workspaceId: "ws-1",
        workspaceName: 'Workspace "A"',
        projectId: "p1",
        projectName: 'Proj "X"',
      },
    ]);
    expect(csv).toContain('"Proj ""X"""');
    expect(csv).toContain('"Quote ""Widget"""');
    expect(csv).toContain('"Workspace ""A"""');
  });
});

// ── WidgetsPage tab shell (Task 1) ───────────────────────────────

describe("WidgetsPage tab shell", () => {
  it("defaults to the list tab and renders the card grid (archive unmounted)", () => {
    renderPage();
    expect(screen.getByText("Alpha Widget")).toBeInTheDocument();
    // No forceMount: the inactive archive tab is unmounted from the DOM.
    expect(screen.queryByTestId("archive-grouped-view")).not.toBeInTheDocument();
  });

  it("deep-links ?tab=archive and renders the archive view", () => {
    renderPage("archive");
    expect(screen.getByTestId("archive-stats")).toBeInTheDocument();
    expect(screen.getByTestId("archive-grouped-view")).toBeInTheDocument();
  });

  it("clicking the archive tab trigger writes ?tab=archive to the URL (radix activates on mouseDown)", () => {
    renderPage();
    fireEvent.mouseDown(screen.getByText("widgets.archive.tabLabel"));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ tab: "archive" }, { replace: true });
  });

  it("falls back to the list tab for an invalid ?tab value", () => {
    renderPage("bogus");
    expect(screen.getByText("Alpha Widget")).toBeInTheDocument();
    expect(screen.queryByTestId("archive-stats")).not.toBeInTheDocument();
  });
});
// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WidgetDetailPage + WidgetsPage tests (128-01 tracer, updated 128-03 T2)
 *
 * 128-03 restructure: the Tabs moved INTO WidgetForm's <form> (OQ2 final) —
 * the page no longer renders panels/triggers. Tab-trigger, panel, shell, and
 * leads-table assertions now live in WidgetForm.test.tsx. This file keeps the
 * page's routing/guard/param-handling coverage: ?tab= round-trip + deep-link
 * (asserted via the WidgetForm mock's tab prop), invalid-tab fallback, create
 * mode, dirty-guard, and the list page's Create/Manage navigation.
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

const mockNavigate = jest.fn();
let mockSearchParams = new URLSearchParams();
const mockSetSearchParams = jest.fn((next: Record<string, string>) => {
  mockSearchParams = new URLSearchParams(next);
});
let mockPathname = "/widgets/widget-1";
let mockWidgetEnabled = true;

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("react-router-dom", () => ({
  ...jest.requireActual("react-router-dom"),
  useParams: () => ({ id: "widget-1" }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: mockPathname }),
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
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

const mockWidget = {
  id: "widget-1",
  name: "Test Widget",
  welcomeMessage: null,
  fallbackMessage: null,
  position: "bottom-right",
  isActive: true,
  logoUrl: null,
  primaryColor: null,
  botName: null,
  avatarUrl: null,
  allowedOrigins: null,
  autoOpenDelay: null,
  autoOpenUrlPatterns: null,
  exitIntentEnabled: false,
  exitIntentCooldownMs: 1800000,
  leadCaptureEnabled: false,
  leadCapturePrompt: null,
  createdBy: "admin",
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  workspaces: [],
  _count: { sessions: 0, leads: 1 },
  // D-06 additive fields
  localizedTexts: null,
  suggestedQuestions: null,
  credits: null,
  fallbackLocale: null,
};

jest.mock("../queries/useWidgets", () => ({
  useWidgets: () => ({ data: [mockWidget], isLoading: false }),
  useWidgetLeads: () => ({
    data: { leads: [{ id: "lead-1", widgetId: "widget-1", sessionId: null, name: "Jane", email: "lead@example.com", transcript: [], createdAt: "2026-01-02T00:00:00.000Z" }], total: 1, page: 1, limit: 20 },
    isLoading: false,
  }),
  useWidgetLead: () => ({ data: null }),
  useExportLeadsCsv: () => ({ mutateAsync: jest.fn() }),
  useCreateWidget: () => ({ mutateAsync: jest.fn() }),
  useUpdateWidget: () => ({ mutateAsync: jest.fn() }),
  useUpdateWidgetWorkspaces: () => ({ mutateAsync: jest.fn() }),
  useDeleteWidget: () => ({ mutateAsync: jest.fn() }),
}));

jest.mock("../hooks/useFeature", () => ({
  useFeature: () => mockWidgetEnabled,
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

// WidgetForm stub (128-03): renders the 5 tab triggers (so the ?tab= round-trip
// stays clickable) and captures tab/onDirtyChange/onSave for assertions.
let mockCapturedOnDirtyChange: ((dirty: boolean) => void) | null = null;
let mockCapturedTab: string | null = null;
let mockCapturedOnSave: ((createdId?: string) => void) | null = null;
jest.mock("../components/WidgetForm", () => ({
  __esModule: true,
  default: ({ widget, tab, onTabChange, onDirtyChange, onSave }: { widget?: { name: string } | null; tab?: string; onTabChange?: (tab: string) => void; onDirtyChange?: (dirty: boolean) => void; onSave?: (createdId?: string) => void }) => {
    mockCapturedOnDirtyChange = onDirtyChange ?? null;
    mockCapturedTab = tab ?? null;
    mockCapturedOnSave = onSave ?? null;
    return (
      <div data-testid="widget-form">
        {widget ? widget.name : "create-mode"}
        <div data-testid="tab-triggers">
          {["settings", "localization", "questions", "credits", "leads"].map((t) => (
            <button key={t} onMouseDown={() => onTabChange?.(t)}>{`widgets.tabs.${t}`}</button>
          ))}
        </div>
      </div>
    );
  },
}));

// AlertDialog wrapper mock (repo precedent: ArchiveCard.test.tsx) — renders
// inline when open so tests can click Cancel/Action.
jest.mock("../components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="discard-dialog">{children}</div>
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
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import WidgetDetailPage from "../components/WidgetDetailPage";
import WidgetsPage from "../components/WidgetsPage";

// ── Helpers ───────────────────────────────────────────────────────

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/widgets/widget-1"]}>
      <WidgetDetailPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockSetSearchParams.mockClear();
  mockSearchParams = new URLSearchParams();
  mockPathname = "/widgets/widget-1";
  mockWidgetEnabled = true;
  mockCapturedOnDirtyChange = null;
  mockCapturedTab = null;
  mockCapturedOnSave = null;
});

afterEach(() => {
  cleanup();
});

// ── WidgetDetailPage tests ───────────────────────────────────────

describe("WidgetDetailPage", () => {
  it("passes the widget to WidgetForm (settings panel shows widget name)", () => {
    renderDetail();
    expect(screen.getByTestId("widget-form")).toHaveTextContent("Test Widget");
  });

  it("clicking a tab trigger writes ?tab=<tab> to the URL (round-trip via WidgetForm's onTabChange)", () => {
    renderDetail();
    // Radix TabsTrigger activates on onMouseDown (verified in installed source)
    fireEvent.mouseDown(screen.getByText("widgets.tabs.leads"));
    expect(mockSetSearchParams).toHaveBeenCalledWith({ tab: "leads" }, { replace: true });
  });

  it("deep-links to ?tab=leads and passes the resolved tab to WidgetForm", () => {
    mockSearchParams = new URLSearchParams("tab=leads");
    renderDetail();
    expect(mockCapturedTab).toBe("leads");
  });

  it("falls back to the settings tab for an invalid ?tab value", () => {
    mockSearchParams = new URLSearchParams("tab=bogus");
    renderDetail();
    expect(mockCapturedTab).toBe("settings");
  });

  it("renders create mode (no widget prop) on /widgets/new", () => {
    mockPathname = "/widgets/new";
    renderDetail();
    expect(screen.getByTestId("widget-form")).toHaveTextContent("create-mode");
  });

  // ── Dirty-guard (D-02, SC3) ─────────────────────────────────────

  it("opens the discard AlertDialog on back-to-list click when the form is dirty", () => {
    renderDetail();
    act(() => mockCapturedOnDirtyChange?.(true));
    fireEvent.click(screen.getByText(/breadcrumb\.widgets/));
    expect(screen.getByTestId("discard-dialog")).toBeInTheDocument();
    expect(screen.getByText("workspace.unsavedNavigateTitle")).toBeInTheDocument();
    expect(screen.getByText("workspace.unsavedNavigateBody")).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("confirming Discard navigates to the pending path; Keep editing stays", () => {
    renderDetail();
    act(() => mockCapturedOnDirtyChange?.(true));
    fireEvent.click(screen.getByText(/breadcrumb\.widgets/));
    // Keep editing (Cancel) closes the dialog and stays
    fireEvent.click(screen.getByText("common.cancel"));
    expect(screen.queryByTestId("discard-dialog")).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    // Try again, then Discard navigates (replace:true so the watcher does
    // not re-trigger on the confirm's own navigation)
    fireEvent.click(screen.getByText(/breadcrumb\.widgets/));
    fireEvent.click(screen.getByText("workspace.discard"));
    expect(mockNavigate).toHaveBeenCalledWith("/widgets", { replace: true });
  });

  it("pathname change while dirty (location watcher) opens the dialog with the pending path stored", () => {
    const { rerender } = renderDetail();
    act(() => mockCapturedOnDirtyChange?.(true));
    // Simulate browser back/forward or sidebar navigation: pathname changes
    act(() => {
      mockPathname = "/widgets";
    });
    rerender(
      <MemoryRouter initialEntries={["/widgets/widget-1"]}>
        <WidgetDetailPage />
      </MemoryRouter>
    );
    expect(screen.getByTestId("discard-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("workspace.discard"));
    expect(mockNavigate).toHaveBeenCalledWith("/widgets", { replace: true });
  });

  it("navigates immediately (no dialog) when the form is not dirty", () => {
    renderDetail();
    fireEvent.click(screen.getByText(/breadcrumb\.widgets/));
    expect(screen.queryByTestId("discard-dialog")).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith("/widgets");
  });

  // ── Browser-native reload guard (G-128-5) ────────────────────────
  //
  // react-router's useBeforeUnload registers the callback directly on
  // window.addEventListener("beforeunload", ...). The callback identity
  // changes with isDirty (useCallback dep), so the effect re-registers —
  // always invoke the LAST registered handler to get the current closure.

  function getBeforeUnloadHandler(
    spy: jest.SpyInstance
  ): ((event: BeforeUnloadEvent) => void) | undefined {
    const calls = spy.mock.calls.filter(([type]) => type === "beforeunload");
    return calls[calls.length - 1]?.[1] as ((event: BeforeUnloadEvent) => void) | undefined;
  }

  it("calls event.preventDefault() on beforeunload when the form is dirty (G-128-5)", () => {
    const addEventListenerSpy = jest.spyOn(window, "addEventListener");
    renderDetail();
    act(() => mockCapturedOnDirtyChange?.(true));
    const handler = getBeforeUnloadHandler(addEventListenerSpy);
    expect(handler).toBeDefined();
    const event = { preventDefault: jest.fn(), returnValue: "" } as unknown as BeforeUnloadEvent;
    handler!(event);
    // Chrome 60+ requires preventDefault() for the native reload prompt —
    // returnValue alone is ignored.
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does not call preventDefault on beforeunload when the form is clean (G-128-5)", () => {
    const addEventListenerSpy = jest.spyOn(window, "addEventListener");
    renderDetail();
    const handler = getBeforeUnloadHandler(addEventListenerSpy);
    expect(handler).toBeDefined();
    const event = { preventDefault: jest.fn(), returnValue: "" } as unknown as BeforeUnloadEvent;
    handler!(event);
    // Clean pages must stay a no-op so the browser never prompts.
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  // ── Save navigation (G-128-4) ────────────────────────────────────

  it("edit save stays in the current tab — no navigation (G-128-4)", () => {
    renderDetail();
    expect(mockCapturedOnSave).not.toBeNull();
    act(() => mockCapturedOnSave?.(undefined));
    // The admin must stay in the widget edit area (current tab, ?tab= URL
    // param untouched) — previously onSave navigated back to /widgets.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("create save navigates to /widgets/:id (G-128-4 keeps create routing)", () => {
    mockPathname = "/widgets/new";
    renderDetail();
    expect(mockCapturedOnSave).not.toBeNull();
    act(() => mockCapturedOnSave?.("new-1"));
    expect(mockNavigate).toHaveBeenCalledWith("/widgets/new-1", { replace: true });
  });
});

// ── WidgetsPage tests ──────────────────────────────────────────────

describe("WidgetsPage", () => {
  it("renders the widget grid with the widget name", () => {
    render(
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    );
    expect(screen.getByText("Test Widget")).toBeInTheDocument();
  });

  it("Create button navigates to /widgets/new", () => {
    render(
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("settings.widget.createButton"));
    expect(mockNavigate).toHaveBeenCalledWith("/widgets/new");
  });

  it("Edit/Manage button navigates to /widgets/:id", () => {
    render(
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("common.edit"));
    expect(mockNavigate).toHaveBeenCalledWith("/widgets/widget-1");
  });

  it("card click navigates to /widgets/:id", () => {
    render(
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole("button", { name: /Edit widget: Test Widget/ }));
    expect(mockNavigate).toHaveBeenCalledWith("/widgets/widget-1");
  });
});

describe("WidgetsPage (Community read-only)", () => {
  beforeEach(() => {
    mockWidgetEnabled = false;
  });

  it("renders the read-only grid with the widget name and disabled banner when widget_enabled=false", () => {
    render(
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    );
    expect(screen.getByText("Test Widget")).toBeInTheDocument();
    expect(screen.getByText("widgets.disabledBanner")).toBeInTheDocument();
  });

  it("does not render Create, Edit, or Delete buttons when widget_enabled=false", () => {
    render(
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    );
    expect(screen.queryByText("settings.widget.createButton")).toBeNull();
    expect(screen.queryByText("common.edit")).toBeNull();
    expect(screen.queryByText("common.delete")).toBeNull();
  });

  it("card click does not navigate when widget_enabled=false", () => {
    render(
      <MemoryRouter>
        <WidgetsPage />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText("Test Widget"));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

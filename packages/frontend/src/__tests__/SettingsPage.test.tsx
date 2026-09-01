// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsPage tests — tab rendering, switching, and error banner
 */
import type { ReactNode } from "react";
import type { ChildrenOnlyProps } from "../__tests__/mockComponentTypes";
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsPage from "../components/SettingsPage";

function renderWithProvider(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// Mutable mock references
const mockLogoutMutate = jest.fn();
const mockFetchSettings = jest.fn();
const mockUseIsMobile = jest.fn().mockReturnValue(false);
const mockUseMe = jest.fn();
const mockUseSettingsStore = jest.fn();
const mockUseFeature = jest.fn().mockReturnValue(true);

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock toast wrapper
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// Mock page meta hook
jest.mock("../hooks/usePageMeta", () => ({
  usePageMeta: jest.fn(),
}));

// Mock react-router-dom
// Return a STABLE URLSearchParams reference so the `[searchParams]` dependency
// in SettingsPage's mount effect does not change on every render (a fresh
// instance per render triggers an infinite setState/re-render loop).
const mockSearchParams = new URLSearchParams();
const mockSetSearchParams = jest.fn();
jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
}));

// Mock useFeature hook (Phase 147 Plan 02: also mock useLicenseTier, now
// imported by SettingsPage for the backups enterprise gate).
jest.mock("../hooks/useFeature", () => ({
  useFeature: (...args: Parameters<typeof mockUseFeature>) => mockUseFeature(...args),
  useLicenseTier: () => "community",
}));

// Mock useIsMobile hook
jest.mock("../hooks/use-mobile", () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock auth queries
jest.mock("../queries/useAuth", () => ({
  useMe: (...args: Parameters<typeof mockUseMe>) => mockUseMe(...args),
  useLogout: () => ({ mutate: mockLogoutMutate, mutateAsync: jest.fn() }),
}));

// Mock settings query
jest.mock("../queries/useSettings", () => ({
  useSettings: () => mockUseSettingsStore(),
  useSettingsHelpers: () => ({
    getValue: jest.fn(() => ""),
    isReadOnly: jest.fn(() => false),
  }),
  useUpdateSettings: () => jest.fn(() => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
  })),
}));

// Phase 180 dead-code sweep: the react-resizable-panels mock was REMOVED —
// the dependency (and its sole consumer ui/resizable.tsx) are gone.

// Mock Radix Tabs to respond to click events in jsdom
// { virtual: true } is required because @radix-ui/react-tabs is no longer a
// direct dependency (replaced by the `radix-ui` umbrella package), but this
// test still mocks the old module path for jsdom compatibility.
jest.mock("@radix-ui/react-tabs", () => {
  const React = require("react");
  const TabContext = React.createContext({ value: "", onValueChange: null });

  return {
    Root: ({ children, value, onValueChange }: { children?: ReactNode; value?: string; onValueChange?: (value: string) => void }) => (
      <TabContext.Provider value={{ value, onValueChange }}>
        {children}
      </TabContext.Provider>
    ),
    List: ({ children }: ChildrenOnlyProps) => <div role="tablist">{children}</div>,
    Trigger: ({ children, value: tabValue }: { children?: ReactNode; value?: string }) => {
      const ctx = React.useContext(TabContext);
      return (
        <button
          role="tab"
          data-state={ctx.value === tabValue ? "active" : "inactive"}
          onClick={() => ctx.onValueChange && ctx.onValueChange(tabValue)}
        >
          {children}
        </button>
      );
    },
    Content: ({ children, value: tabValue }: { children?: ReactNode; value?: string }) => {
      const ctx = React.useContext(TabContext);
      if (ctx.value !== tabValue) return null;
      return <div role="tabpanel">{children}</div>;
    },
  };
}, { virtual: true });

// Mock all Settings sub-components as simple divs. SettingsProfile and
// SettingsGeneral were split into named sub-section components (Profilo and
// Avanzate now host their granular pieces under different menu voices).
jest.mock("../components/SettingsProfile", () => ({
  SettingsProfilePersonal: () => (
    <div data-testid="settings-personal">SettingsProfilePersonal</div>
  ),
  SettingsProfileInstructions: () => (
    <div data-testid="settings-instructions">SettingsProfileInstructions</div>
  ),
  SettingsProfileChatData: () => (
    <div data-testid="settings-chatdata">SettingsProfileChatData</div>
  ),
}));
jest.mock("../components/SettingsGeneral", () => ({
  SettingsGeneralDlp: () => <div data-testid="settings-dlp">SettingsGeneralDlp</div>,
  SettingsGeneralLanguages: () => (
    <div data-testid="settings-languages">SettingsGeneralLanguages</div>
  ),
  SettingsGeneralResetDb: () => (
    <div data-testid="settings-resetdb">SettingsGeneralResetDb</div>
  ),
}));
jest.mock("../components/SettingsProviders", () => () => (
  <div data-testid="settings-providers">SettingsProviders</div>
));
jest.mock("../components/SettingsMcpConnections", () => () => (
  <div data-testid="settings-mcpconnections">SettingsMcpConnections</div>
));
jest.mock("../components/SettingsWebSearch", () => () => (
  <div data-testid="settings-websearch">SettingsWebSearch</div>
));
jest.mock("../components/SettingsLLM", () => () => (
  <div data-testid="settings-llm">SettingsLLM</div>
));
jest.mock("../components/SettingsVectorDB", () => () => (
  <div data-testid="settings-vectordb">SettingsVectorDB</div>
));
jest.mock("../components/SettingsRoles", () => () => (
  <div data-testid="settings-roles">SettingsRoles</div>
));
jest.mock("../components/SettingsUsers", () => () => (
  <div data-testid="settings-users">SettingsUsers</div>
));
jest.mock("../components/SettingsApiKeys", () => () => (
  <div data-testid="settings-apikeys">SettingsApiKeys</div>
));
// The "llm" tab renders SettingsLLM + SettingsOcr + SettingsSynthesis together,
// and the maintenance/backups tabs render SettingsMaintenance/SettingsBackups.
// Stub them all so their internal useSettings hooks don't break unrelated tests.
jest.mock("../components/SettingsOcr", () => () => (
  <div data-testid="settings-ocr">SettingsOcr</div>
));
jest.mock("../components/SettingsSynthesis", () => () => (
  <div data-testid="settings-synthesis">SettingsSynthesis</div>
));
jest.mock("../components/SettingsMaintenance", () => () => (
  <div data-testid="settings-maintenance">SettingsMaintenance</div>
));
jest.mock("../components/SettingsBackups", () => () => (
  <div data-testid="settings-backups">SettingsBackups</div>
));
// Phase 70 added SettingsSecurityNonAdminUpload under the Security tab; it
// imports useSettingsHelpers from ../queries/useSettings. Mocking it as a div
// (consistent with the file's mock-all-sub-components-as-divs pattern above)
// prevents the useSettingsHelpers-is-undefined crash on Security tab mount
// without weakening any real assertion. The useSettings mock factory at
// :70-72 stays unchanged (the sub-component mock short-circuits the hook
// call before it ever reaches the real module).
jest.mock("../components/SettingsSecurityNonAdminUpload", () => ({
  SettingsSecurityNonAdminUpload: () => (
    <div data-testid="settings-nonadmin-upload">SettingsSecurityNonAdminUpload</div>
  ),
}));
// Feature 3.4b: SettingsAppearance is a sub-section of the General tab area.
// Mocked because its real impl requires the ThemeProvider context.
jest.mock("../components/SettingsAppearance", () => () => (
  <div data-testid="settings-appearance">SettingsAppearance</div>
));

describe("SettingsPage", () => {
  const defaultUser = {
    id: "u1",
    username: "admin",
    roles: [{ name: "admin" }],
    permissions: [
      "admin:settings",
      "admin:users",
      "admin:roles",
      "provider:read",
      "provider:write",
    ],
  };

  const defaultSettingsState = {
    data: [],
    isLoading: false,
    error: null,
    refetch: mockFetchSettings,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockUseIsMobile.mockReturnValue(false);
    mockFetchSettings.mockResolvedValue(undefined);
    mockUseMe.mockReturnValue({ data: defaultUser });
    mockUseSettingsStore.mockImplementation(() => defaultSettingsState);
  });

  it("renders TabsList with visible tabs based on permissions", () => {
    renderWithProvider(<SettingsPage />);

    // 5 top-level tabs (Profilo / LLM Providers / Appearance / Security /
    // Advanced). The default admin user has permissions for all 5.
    expect(screen.getByText("settings.tabs.profile")).toBeInTheDocument();
    expect(screen.getByText("settings.tabs.llmProviders")).toBeInTheDocument();
    expect(screen.getByText("settings.tabs.appearance")).toBeInTheDocument();
    expect(screen.getByText("settings.tabs.security")).toBeInTheDocument();
    expect(screen.getByText("settings.tabs.advanced")).toBeInTheDocument();
    // Legacy per-sub-section tab labels are NOT top-level tabs anymore — they
    // live as sub-sections inside the 5 tabs.
    expect(screen.queryByText("settings.tabs.providers")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tabs.general")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tabs.rolesPermissions")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.tabs.widgets")).not.toBeInTheDocument();
  });

  it("reads lastSettingsSection from localStorage on mount", () => {
    // "llm" is now a canonical top-level tab (LLM Providers), so it activates
    // directly and renders the LLM + OCR + Synthesis sub-sections.
    localStorage.setItem("lastSettingsSection", "llm");
    renderWithProvider(<SettingsPage />);

    expect(screen.getByTestId("settings-llm")).toBeInTheDocument();
  });

  it("maps a legacy localStorage section onto a canonical tab on mount", () => {
    // Legacy "roles" sub-section key → Security tab (Roles sub-section).
    localStorage.setItem("lastSettingsSection", "roles");
    renderWithProvider(<SettingsPage />);

    expect(screen.getByTestId("settings-roles")).toBeInTheDocument();
    // Security tab also mounts the non-admin upload sub-section (Phase 70);
    // assert it renders alongside the roles sub-section.
    expect(screen.getByTestId("settings-nonadmin-upload")).toBeInTheDocument();
    // Persisted value is normalized to the canonical key.
    expect(localStorage.getItem("lastSettingsSection")).toBe("security");
  });

  it("switches tab content when clicking a TabsTrigger", () => {
    renderWithProvider(<SettingsPage />);

    // Default tab is Profilo, which renders the Personal info sub-section.
    expect(screen.getByTestId("settings-personal")).toBeInTheDocument();

    // Click on Advanced tab → renders Vector DB sub-section (admin:settings).
    fireEvent.click(screen.getByText("settings.tabs.advanced"));
    expect(screen.getByTestId("settings-vectordb")).toBeInTheDocument();
  });

  it("persists active tab to localStorage on tab change", () => {
    renderWithProvider(<SettingsPage />);

    fireEvent.click(screen.getByText("settings.tabs.advanced"));
    expect(localStorage.getItem("lastSettingsSection")).toBe("advanced");

    fireEvent.click(screen.getByText("settings.tabs.llmProviders"));
    expect(localStorage.getItem("lastSettingsSection")).toBe("llm");
  });

  it("renders error banner when settings query errors", () => {
    const apiErr = new (require("../utils/api").ApiError)(500, "Failed to load settings");
    mockUseSettingsStore.mockImplementation(() => ({
      ...defaultSettingsState,
      error: apiErr,
    }));

    renderWithProvider(<SettingsPage />);
    expect(screen.getByText("settings.errorServer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  it("renders mobile hamburger menu instead of a tablist when isMobile is true", () => {
    mockUseIsMobile.mockReturnValue(true);

    renderWithProvider(<SettingsPage />);

    // In mobile mode the tabs collapse into a hamburger menu (Sheet), so there
    // is no horizontal tablist; the menu is opened via the hamburger button.
    // The i18n mock returns the key itself, so the hamburger button's
    // aria-label is "settings.openTabsMenu".
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "settings.openTabsMenu" }),
    ).toBeInTheDocument();
  });
});

// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Feature 8 integration test (8.9) — verifies the cross-component contract
 * introduced by Slices A/B/C in ONE place, exercising the real components
 * together (not stubbed) under a shared QueryClient + window event bus +
 * localStorage.
 *
 * Contract under test:
 *  - Slice B move: SettingsGeneral holds NO branding controls; SettingsAppearance
 *    holds the branding section (app name / subtitle / icon). Both rendered as
 *    real components in the same harness — the unit tests cover each in
 *    isolation, this confirms they coexist under one query client.
 *  - Slice C end-to-end: an icon uploaded in SettingsAppearance dispatches a
 *    `branding-changed` window event carrying a cache-busting `iconBust` token;
 *    the AppSidebar header `<img>` (driven by an App.tsx-style listener that
 *    holds the raw URL) re-renders with `?t=<bust>` appended so the freshly
 *    written icon at the same path busts the browser cache. This event flow is
 *    NOT covered by any unit test — it is the integration gap this file closes.
 *
 * Mocking strategy: query/auth/feature/theme/toast/i18n hooks are mocked at the
 * module boundary (same pattern as SettingsAppearance.test / AppSidebar.test);
 * the `branding-changed` event, localStorage bust, and component wiring are the
 * REAL code paths under test.
 */
import "@testing-library/jest-dom";
import { useEffect, useState } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Shared mocks ----------------------------------------------------------

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    // t returns the key verbatim so i18n label keys are assertable as text.
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// ThemeContext — SettingsAppearance calls useTheme().
let mockThemeValue = "dark";
jest.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: mockThemeValue, setTheme: jest.fn() }),
}));

// Settings query hooks — shared by SettingsGeneral + SettingsAppearance.
const mockGetValue = jest.fn();
const mockIsReadOnly = jest.fn(() => false);
const mockIsEnvOverridden = jest.fn(() => false);
const mockUpdateSettings = jest.fn();
const mockUploadIcon = jest.fn();
const mockDeleteIcon = jest.fn();
jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => ({ getValue: mockGetValue, isReadOnly: mockIsReadOnly, isEnvOverridden: mockIsEnvOverridden }),
  useUpdateSettings: () => ({ mutateAsync: mockUpdateSettings }),
  useUploadBrandingIcon: () => ({ mutateAsync: mockUploadIcon }),
  useDeleteBrandingIcon: () => ({ mutateAsync: mockDeleteIcon }),
}));

// Auth — SettingsGeneral calls useMe().
const mockUseMe = jest.fn();
jest.mock("../queries/useAuth", () => ({
  useMe: (...args: unknown[]) => mockUseMe(...(args as [])),
}));

// Feature flag — SettingsAppearance gates branding on white_label.
const mockUseFeature = jest.fn(() => true);
jest.mock("../hooks/useFeature", () => ({
  useFeature: (flag: string) => mockUseFeature(flag),
}));

// Toast — SettingsAppearance + SettingsGeneral surface toasts.
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
}));

// UpgradePrompt — SettingsAppearance renders it when white_label is off.
jest.mock("../components/UpgradePrompt", () => ({
  __esModule: true,
  default: ({ feature }: { feature: string }) => (
    <div data-testid="upgrade-prompt" data-feature={feature} />
  ),
}));

// i18n module — SettingsGeneral imports the language catalog helpers.
jest.mock("../i18n", () => ({
  ALL_LANGUAGES: [
    { code: "en", name: "English" },
    { code: "it", name: "Italiano" },
  ],
  getEnabledLanguages: () => ["en", "it"],
  setEnabledLanguages: jest.fn(),
}));

// --- AppSidebar peripheral mocks (same passthrough pattern as AppSidebar.test) ---

jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: "/" }),
}));

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-testid="collapsible" data-open={open ? "true" : "false"}>
      {open ? children : null}
    </div>
  ),
  CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => (
    <button data-testid="collapsible-trigger">{children}</button>
  ),
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
}));

jest.mock("@/components/ui/select", () => ({
  Select: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <div data-testid="select" data-value={value}>
      <select value={value}>{children}</select>
    </div>
  ),
  SelectTrigger: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
    <button data-testid="select-trigger" role="combobox" {...rest}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span data-testid="select-value">{placeholder}</span>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-content">{children}</div>
  ),
  SelectItem: ({ children, value }: { children: React.ReactNode; value?: string }) => (
    <option value={value} data-testid="select-item">{children}</option>
  ),
  SelectSeparator: () => <div data-testid="select-separator" />,
}));

// --- Real components under test -------------------------------------------

import { SettingsGeneralDlp } from "../components/SettingsGeneral";
import SettingsAppearance from "../components/SettingsAppearance";
import AppSidebar, { type AppSidebarProps } from "../components/AppSidebar";

const ICON_URL = "/branding/app-icon.png";

function sidebarProps(overrides: Partial<AppSidebarProps> = {}): AppSidebarProps {
  return {
    appName: "Simmetric",
    primaryColor: "#4c6ef5",
    appSubtitle: undefined,
    appIconUrl: undefined,
    isEnterprise: false,
    isAdmin: false,
    menuSections: ["chat", "documents"],
    currentWorkspaceId: null,
    selectedProjectId: "",
    setSelectedProjectId: jest.fn(),
    selectedWorkspaceId: "",
    setSelectedWorkspaceId: jest.fn(),
    setWorkspaceId: jest.fn(),
    license: { tier: "community" },
    t: (key: string) => key,
    sidebarOpen: true,
    setSidebarOpen: jest.fn(),
    projects: [],
    workspaces: [],
    ...overrides,
  };
}

/**
 * Mirrors App.tsx's `branding-changed` listener: holds the RAW icon URL in
 * state, updates it when SettingsAppearance dispatches the event, and passes
 * it down to the real AppSidebar — which applies the cache-bust itself. This
 * is the exact wiring Slice C introduced (URL stays raw at the App level;
 * bust is applied at the render site).
 */
function AppShell({ initialIconUrl }: { initialIconUrl?: string }) {
  const [appIconUrl, setAppIconUrl] = useState(initialIconUrl ?? "");
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.appIconUrl !== undefined) setAppIconUrl(detail.appIconUrl);
    };
    window.addEventListener("branding-changed", handler);
    return () => window.removeEventListener("branding-changed", handler);
  }, []);
  return <AppSidebar {...sidebarProps({ appIconUrl: appIconUrl || undefined })} />;
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

function renderWithClient(ui: React.ReactElement) {
  const client = makeClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("Feature 8 — integration (8.9)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThemeValue = "dark";
    mockGetValue.mockReturnValue("");
    mockIsReadOnly.mockReturnValue(false);
    mockUseFeature.mockReturnValue(true);
    mockUpdateSettings.mockResolvedValue({ updated: [], rejected: [] });
    mockUploadIcon.mockResolvedValue({ url: ICON_URL });
    mockDeleteIcon.mockResolvedValue({ message: "Icon removed" });
    mockUseMe.mockReturnValue({
      data: { id: "u1", username: "admin", roles: [{ name: "admin" }], permissions: ["admin:settings"] },
    });
    localStorage.clear();
  });

  afterEach(() => cleanup());

  describe("Slice B — branding moved General → Appearance", () => {
    it("SettingsGeneral renders NO branding controls (name/subtitle/icon/primaryColor)", () => {
      renderWithClient(<SettingsGeneralDlp />);

      // The four branding labels all moved to SettingsAppearance (Slice B).
      expect(screen.queryByText("settings.generalTab.appNameLabel")).not.toBeInTheDocument();
      expect(screen.queryByText("settings.generalTab.primaryColorLabel")).not.toBeInTheDocument();
      expect(screen.queryByText("settings.generalTab.appIconLabel")).not.toBeInTheDocument();
      expect(screen.queryByText("settings.generalTab.appSubtitleLabel")).not.toBeInTheDocument();
      // No branding Save button.
      expect(screen.queryByRole("button", { name: /settings\.saveChanges/i })).not.toBeInTheDocument();
    });

    it("SettingsAppearance renders the branding section (name/subtitle/icon)", () => {
      renderWithClient(<SettingsAppearance />);

      // Branding labels now live under settings.appearance.branding.* (Slice B).
      expect(screen.getByText("settings.appearance.branding.appNameLabel")).toBeInTheDocument();
      expect(screen.getByText("settings.appearance.branding.appSubtitleLabel")).toBeInTheDocument();
      expect(screen.getByText("settings.appearance.branding.appIconLabel")).toBeInTheDocument();
      // Upload + remove controls present (empty preview → only upload button).
      expect(screen.getByRole("button", { name: "settings.appearance.branding.appIconUpload" })).toBeInTheDocument();
    });
  });

  describe("Slice C — icon upload refreshes AppSidebar via branding-changed + cache-bust", () => {
    it("AppSidebar shows the raw icon URL before any upload (no cache-bust yet)", () => {
      // AppShell seeds the raw URL from settings (mirrors fetchBranding); with
      // no prior upload localStorage bust is 0 → src stays raw.
      renderWithClient(<AppShell initialIconUrl={ICON_URL} />);

      const sidebarImg = document.querySelector(`img.app-icon[alt="Simmetric"]`) as HTMLImageElement | null;
      expect(sidebarImg).not.toBeNull();
      expect(sidebarImg!.getAttribute("src")).toBe(ICON_URL);
    });

    it("uploading an icon in SettingsAppearance busts AppSidebar's header <img> src end-to-end", async () => {
      // Render both together: SettingsAppearance (the producer of the event)
      // and AppSidebar (the consumer). They share the window event bus.
      renderWithClient(
        <>
          <AppShell initialIconUrl={ICON_URL} />
          <SettingsAppearance />
        </>,
      );

      // Sanity: sidebar icon starts at the raw URL (no bust).
      const sidebarBefore = document.querySelector(`img.app-icon[alt="Simmetric"]`) as HTMLImageElement;
      expect(sidebarBefore.getAttribute("src")).toBe(ICON_URL);

      // Stub the hidden file input and trigger the upload handler.
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [{ type: "image/png", size: 1000 }],
        configurable: true,
      });
      fireEvent.change(fileInput);

      await waitFor(() => {
        expect(mockUploadIcon).toHaveBeenCalled();
      });

      // After upload: AppSidebar's header <img> must carry the cache-bust query
      // — this is the cross-component contract. The raw URL is threaded through
      // the App.tsx-style listener (AppShell) and the bust is applied by
      // AppSidebar's own branding-changed listener.
      await waitFor(() => {
        const sidebarAfter = document.querySelector(`img.app-icon[alt="Simmetric"]`) as HTMLImageElement;
        const src = sidebarAfter.getAttribute("src");
        expect(src).toMatch(new RegExp(`^${ICON_URL.replace(/\//g, "\\/")}\\?t=\\d+$`));
      });

      // The SettingsAppearance live previews must ALSO carry the bust (two imgs
      // share the alt text — the upload widget + the live header preview).
      const previewImgs = screen.getAllByAltText("settings.appearance.branding.appIconLabel");
      expect(previewImgs.length).toBe(2);
      previewImgs.forEach((img) => {
        expect(img.getAttribute("src")).toMatch(/\?t=\d+$/);
      });

      // The bust is persisted to localStorage so a reload keeps requesting the
      // fresh URL (Slice C design).
      const stored = localStorage.getItem("branding-icon-bust");
      expect(stored).not.toBeNull();
      expect(Number(stored)).toBeGreaterThan(0);
    });
  });
});
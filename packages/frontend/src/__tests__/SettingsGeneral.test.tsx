// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsGeneral tests — DLP toggle + Reset Database dialog.
 *
 * Feature 8 Slice B moved the branding controls (app name / subtitle / icon /
 * primary color / live preview) to SettingsAppearance, so this file no longer
 * asserts any branding inputs — those live in SettingsAppearance.test.tsx now.
 * What remains here is the DLP toggle (Switch) and the admin-only destructive
 * Reset Database dialog with its typed "RESET" confirmation gate.
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsGeneralDlp, SettingsGeneralResetDb } from "../components/SettingsGeneral";

function renderWithProvider(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// Mutable mock references
const mockUpdateSettings = jest.fn();
const mockGetValue = jest.fn().mockReturnValue("");
const mockUseMe = jest.fn();

// Mock i18next
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock settings query hooks — branding icon hooks are not used by General
// anymore but the mock keeps the module shape stable.
jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => ({ getValue: mockGetValue, isReadOnly: () => false }),
  useUpdateSettings: () => ({ mutateAsync: mockUpdateSettings }),
  useUploadBrandingIcon: () => ({ mutateAsync: jest.fn().mockResolvedValue({ url: "/branding/app-icon.png" }) }),
  useDeleteBrandingIcon: () => ({ mutateAsync: jest.fn().mockResolvedValue({ message: "Icon removed" }) }),
}));

// Mock auth queries
jest.mock("../queries/useAuth", () => ({
  useMe: (...args: Parameters<typeof mockUseMe>) => mockUseMe(...args),
}));

// Mock i18n module
jest.mock("../i18n", () => ({
  ALL_LANGUAGES: [
    { code: "en", name: "English" },
    { code: "de", name: "Deutsch" },
    { code: "es", name: "Español" },
    { code: "fr", name: "Français" },
    { code: "it", name: "Italiano" },
    { code: "ru", name: "Русский" },
    { code: "zh", name: "中文" },
  ],
  getEnabledLanguages: () => ["en", "de", "es", "fr", "it", "ru", "zh"],
  setEnabledLanguages: jest.fn(),
}));

// Mock apiGet for the DLP bypass roles multi-select (GET /roles — the list
// the admin Roles tab fetches too).
jest.mock("../utils/api", () => ({
  apiGet: jest.fn().mockResolvedValue([
    { id: "r1", name: "admin" },
    { id: "r2", name: "user" },
    { id: "r3", name: "trusted_analyst" },
  ]),
}));

describe("SettingsGeneral", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetValue.mockReturnValue("");
    mockUseMe.mockReturnValue({
      data: { id: "u1", username: "admin", roles: [{ name: "admin" }], permissions: ["admin:settings"] },
    });
  });

  it("renders DLP toggle as Switch", () => {
    renderWithProvider(<SettingsGeneralDlp />);

    expect(screen.getByText("settings.generalTab.dlp.sectionTitle")).toBeInTheDocument();
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThanOrEqual(1);
  });

  // 260829-n95 (spec §2.2): the DLP bypass section appears when DLP is
  // enabled and the role checkbox persists the FULL JSON-array body shape
  // `DLP_BYPASS_ROLES = JSON.stringify(selectedNames)`.
  it("renders DLP bypass role multi-select when DLP enabled and pins JSON save shape", async () => {
    // DLP enabled + existing bypass list with one role
    mockGetValue.mockImplementation((key: string) =>
      key === "DLP_ENABLED" ? "true" : key === "DLP_BYPASS_ROLES" ? '["trusted_analyst"]' : "",
    );
    renderWithProvider(<SettingsGeneralDlp />);

    // Bypass section renders once DLP is on
    expect(await screen.findByTestId("dlp-bypass-section")).toBeInTheDocument();
    expect(screen.getByText("settings.generalTab.dlp.bypass.title")).toBeInTheDocument();

    // Checkbox per role, with the persisted role pre-checked
    const analyst = screen.getByRole("checkbox", { name: "trusted_analyst" });
    expect(analyst).toBeChecked();
    const user = screen.getByRole("checkbox", { name: "user" });
    expect(user).not.toBeChecked();

    // Toggle "user" on → updateSettings receives the FULL JSON-array body
    mockUpdateSettings.mockResolvedValueOnce({ updated: [], rejected: [] });
    fireEvent.click(screen.getByRole("checkbox", { name: "user" }));

    await waitFor(() =>
      expect(mockUpdateSettings).toHaveBeenCalledWith([
        { key: "DLP_BYPASS_ROLES", value: JSON.stringify(["trusted_analyst", "user"]) },
      ]),
    );
  });

  it("hides the bypass section when DLP is disabled", () => {
    mockGetValue.mockReturnValue("false");
    renderWithProvider(<SettingsGeneralDlp />);
    expect(screen.queryByTestId("dlp-bypass-section")).not.toBeInTheDocument();
  });

  it("does not render branding inputs after Feature 8 Slice B move (8.5/8.6)", () => {
    renderWithProvider(<SettingsGeneralDlp />);

    // App name / primary color / app icon labels moved to SettingsAppearance.
    expect(screen.queryByLabelText("settings.generalTab.appNameLabel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("settings.generalTab.primaryColorLabel")).not.toBeInTheDocument();
    expect(screen.queryByText("settings.generalTab.appIconLabel")).not.toBeInTheDocument();
    // No branding Save button.
    expect(screen.queryByRole("button", { name: /settings.saveChanges/i })).not.toBeInTheDocument();
  });

  it("opens Reset Database dialog and requires RESET confirmation", () => {
    renderWithProvider(<SettingsGeneralResetDb />);

    const resetButton = screen.getByRole("button", { name: /settings.generalTab.resetDatabaseButton/i });
    fireEvent.click(resetButton);

    // Dialog title should appear (using heading role to disambiguate from section heading)
    expect(screen.getByRole("heading", { name: "settings.generalTab.resetDatabase" })).toBeInTheDocument();

    const confirmInput = screen.getByPlaceholderText("RESET");
    expect(confirmInput).toBeInTheDocument();

    // After opening dialog, there are two buttons with this label: opener + dialog action
    const dialogButtons = screen.getAllByRole("button", { name: /settings.generalTab.resetDatabaseButton/i });
    // The dialog action button is the last one
    const destructiveButton = dialogButtons[dialogButtons.length - 1];
    // Should be disabled because confirmation text is empty
    expect(destructiveButton).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: "RESET" } });
    expect(destructiveButton).not.toBeDisabled();
  });
});
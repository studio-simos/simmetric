// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsMaintenanceReaper tests — upload-draft reaper system-config section.
 *
 * Covers the admin-config surface for the `upload_draft_reaper_enabled` /
 * `upload_draft_reaper_cron` SystemConfig keys (server-side defaults shipped
 * in 260829-kkn): render, toggle save posts the enabled key, cron save posts
 * the cron key, and the client-side cron shape pre-check blocks an
 * empty/obviously-typoed value before any request is made.
 *
 * Mock shape mirrors SettingsGeneral.test.tsx (useSettingsHelpers +
 * useUpdateSettings mocked at the query-hook module level, i18next returns
 * raw keys).
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsMaintenanceReaper } from "../components/SettingsMaintenance";

function renderWithProvider(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// Mutable mock references
const mockUpdateSettings = jest.fn().mockResolvedValue({ updated: [], rejected: [] });
// Backed by a mutable map so getValue reflects what the component reads.
const mockSettings = new Map<string, string>([
  ["upload_draft_reaper_enabled", "true"],
  ["upload_draft_reaper_cron", "0 3 * * *"],
]);

// Mock i18next — t() returns raw keys (same convention as SettingsGeneral.test.tsx)
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

// Mock settings query hooks
jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => ({
    getValue: (key: string) => mockSettings.get(key) ?? "",
    isReadOnly: () => false,
  }),
  useUpdateSettings: () => ({ mutateAsync: mockUpdateSettings }),
}));

// Toasts are side-effect-only for these tests.
jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
  showInfo: jest.fn(),
  toastWithAction: jest.fn(),
}));

describe("SettingsMaintenanceReaper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSettings.set("upload_draft_reaper_enabled", "true");
    mockSettings.set("upload_draft_reaper_cron", "0 3 * * *");
    mockUpdateSettings.mockResolvedValue({ updated: [], rejected: [] });
  });

  it("renders title, description, enabled label and cron field", () => {
    renderWithProvider(<SettingsMaintenanceReaper />);

    expect(screen.getByText("settings.maintenance.reaperTitle")).toBeInTheDocument();
    expect(
      screen.getByText(/settings.maintenance.reaperDescription/)
    ).toBeInTheDocument();
    expect(screen.getByText("settings.maintenance.reaperEnabled")).toBeInTheDocument();
    expect(screen.getByLabelText("settings.maintenance.reaperCron")).toHaveValue(
      "0 3 * * *"
    );
    // Enabled default comes from the (mocked) settings store: "true"
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBe(1);
    expect(switches[0]).toBeChecked();
  });

  it("toggle save posts upload_draft_reaper_enabled", async () => {
    renderWithProvider(<SettingsMaintenanceReaper />);

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1));
    expect(mockUpdateSettings).toHaveBeenCalledWith([
      { key: "upload_draft_reaper_enabled", value: "false" },
    ]);
  });

  it("cron save posts upload_draft_reaper_cron", async () => {
    renderWithProvider(<SettingsMaintenanceReaper />);

    const input = screen.getByLabelText("settings.maintenance.reaperCron");
    fireEvent.change(input, { target: { value: "30 4 * * 1" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings.maintenance.reaperSaveCron" })
    );

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1));
    expect(mockUpdateSettings).toHaveBeenCalledWith([
      { key: "upload_draft_reaper_cron", value: "30 4 * * 1" },
    ]);
  });

  it("empty cron shows client-side validation error and does not save", async () => {
    renderWithProvider(<SettingsMaintenanceReaper />);

    const input = screen.getByLabelText("settings.maintenance.reaperCron");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings.maintenance.reaperSaveCron" })
    );

    expect(
      screen.getByText("settings.maintenance.reaperCronInvalid")
    ).toBeInTheDocument();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it("invalid cron shape (too few fields) shows validation error and does not save", async () => {
    renderWithProvider(<SettingsMaintenanceReaper />);

    const input = screen.getByLabelText("settings.maintenance.reaperCron");
    fireEvent.change(input, { target: { value: "0 3 * *" } });
    fireEvent.click(
      screen.getByRole("button", { name: "settings.maintenance.reaperSaveCron" })
    );

    expect(
      screen.getByText("settings.maintenance.reaperCronInvalid")
    ).toBeInTheDocument();
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });
});
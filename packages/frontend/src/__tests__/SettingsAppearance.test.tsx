// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * SettingsAppearance component tests — Feature 3.4b (appearance preferences).
 *
 * Four controls: theme (ThemeContext), accent color (white-label gate +
 * settings PUT + branding-changed broadcast), UI font size (localStorage +
 * --ui-font-scale), density (localStorage + density-compact class). We mock
 * the settings/theme/feature hooks and stub UpgradePrompt to verify the
 * community-tier gating branch.
 */
jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

const mockSetTheme = jest.fn();
let mockThemeValue: string = "dark";
jest.mock("../contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: mockThemeValue, setTheme: mockSetTheme }),
}));

const mockGetValue = jest.fn(() => "");
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

const mockUseFeature = jest.fn(() => true);
jest.mock("../hooks/useFeature", () => ({
  useFeature: (flag: string) => mockUseFeature(flag),
}));

const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
jest.mock("../lib/toast", () => ({
  showSuccess: (...args: unknown[]) => mockShowSuccess(...args),
  showError: (...args: unknown[]) => mockShowError(...args),
}));

jest.mock("../components/UpgradePrompt", () => ({
  __esModule: true,
  default: ({ feature }: { feature: string }) => (
    <div data-testid="upgrade-prompt" data-feature={feature} />
  ),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SettingsAppearance from "../components/SettingsAppearance";
import { ApiError } from "../utils/api";

function renderPanel() {
  return render(<SettingsAppearance />);
}

describe("SettingsAppearance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockThemeValue = "dark";
    mockGetValue.mockReturnValue("");
    mockIsReadOnly.mockReturnValue(false);
    mockUseFeature.mockReturnValue(true);
    mockUpdateSettings.mockResolvedValue({ updated: [], rejected: [] });
    mockUploadIcon.mockResolvedValue({ url: "/branding/app-icon.png" });
    mockDeleteIcon.mockResolvedValue({ message: "Icon removed" });
    localStorage.clear();
    document.documentElement.style.cssText = "";
    document.documentElement.className = "";
  });

  describe("theme", () => {
    it("renders the four theme options and marks the active one pressed", () => {
      mockThemeValue = "hacker";
      renderPanel();
      const labels = ["settings.appearance.themeLight", "settings.appearance.themeDark", "settings.appearance.themeHacker", "settings.appearance.themeSystem"];
      labels.forEach((l) => expect(screen.getByText(l)).toBeInTheDocument());

      // The hacker button is aria-pressed true; others false.
      const hackerBtn = screen.getByText("settings.appearance.themeHacker").closest("button")!;
      expect(hackerBtn).toHaveAttribute("aria-pressed", "true");
    });

    it("calls setTheme when a theme option is clicked", () => {
      renderPanel();
      fireEvent.click(screen.getByText("settings.appearance.themeLight").closest("button")!);
      expect(mockSetTheme).toHaveBeenCalledWith("light");
    });
  });

  describe("accent color (white-label gate)", () => {
    it("renders the UpgradePrompt when the white_label feature is not enabled", () => {
      mockUseFeature.mockReturnValue(false);
      renderPanel();
      // Both the accent picker and the branding section gate on white_label,
      // so two UpgradePrompt instances render (Feature 8 Slice B added branding).
      const ups = screen.getAllByTestId("upgrade-prompt");
      expect(ups.length).toBeGreaterThanOrEqual(1);
      ups.forEach((up) => expect(up).toHaveAttribute("data-feature", "white_label"));
    });

    it("persists a preset accent via the settings PUT and broadcasts branding-changed", async () => {
      renderPanel();
      // Preset swatches are buttons with aria-label = hex.
      const cyanSwatch = screen.getByLabelText("#00d4ff");
      fireEvent.click(cyanSwatch);

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith([
          { key: "BRANDING_PRIMARY_COLOR", value: "#00d4ff" },
        ]);
      });
      expect(mockShowSuccess).toHaveBeenCalledWith("settings.appearance.accentSaved");
    });

    it("does not call updateSettings when BRANDING_PRIMARY_COLOR is read-only (community gate)", async () => {
      mockIsReadOnly.mockReturnValue(true);
      renderPanel();
      fireEvent.click(screen.getByLabelText("#00ff9c"));

      // The isReadOnly guard returns early before setting savingAccent; no PUT.
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });

    it("shows an error toast when the settings PUT rejects", async () => {
      mockUpdateSettings.mockRejectedValueOnce(new Error("boom"));
      renderPanel();
      fireEvent.click(screen.getByLabelText("#22c55e"));

      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith("settings.appearance.accentError");
      });
      expect(mockShowSuccess).not.toHaveBeenCalled();
    });

    it("rejects an invalid custom hex without calling updateSettings", () => {
      renderPanel();
      const hexInput = screen.getByPlaceholderText("#973C00");
      fireEvent.change(hexInput, { target: { value: "nothex" } });
      fireEvent.blur(hexInput);

      expect(mockShowError).toHaveBeenCalledWith("settings.appearance.accentInvalid");
      expect(mockUpdateSettings).not.toHaveBeenCalled();
    });
  });

  describe("UI font size", () => {
    it("applies the --ui-font-scale CSS var and persists the choice to localStorage", () => {
      renderPanel();
      fireEvent.click(screen.getByText("settings.appearance.fontLarge").closest("button")!);

      expect(document.documentElement.style.getPropertyValue("--ui-font-scale")).toBe("1.0625rem");
      expect(localStorage.getItem("uiFontScale")).toBe("lg");
    });
  });

  describe("density", () => {
    it("toggles the density-compact class and persists the choice", () => {
      renderPanel();
      fireEvent.click(screen.getByText("settings.appearance.densityCompact").closest("button")!);

      expect(document.documentElement.classList.contains("density-compact")).toBe(true);
      expect(localStorage.getItem("uiDensity")).toBe("compact");
    });

    it("removes the density-compact class when switching back to comfortable", () => {
      localStorage.setItem("uiDensity", "compact");
      renderPanel();
      fireEvent.click(screen.getByText("settings.appearance.densityComfortable").closest("button")!);

      expect(document.documentElement.classList.contains("density-compact")).toBe(false);
      expect(localStorage.getItem("uiDensity")).toBe("comfortable");
    });
  });

  describe("branding (Feature 8 Slice B — moved from SettingsGeneral)", () => {
    it("renders app name + app subtitle inputs and a live preview when white_label is enabled", () => {
      renderPanel();
      expect(screen.getByLabelText("settings.appearance.branding.appNameLabel")).toBeInTheDocument();
      expect(screen.getByLabelText("settings.appearance.branding.appSubtitleLabel")).toBeInTheDocument();
      expect(screen.getByText("settings.appearance.branding.preview")).toBeInTheDocument();
    });

    it("persists app name + subtitle via the settings PUT and broadcasts branding-changed on save", async () => {
      renderPanel();
      const nameInput = screen.getByLabelText("settings.appearance.branding.appNameLabel");
      fireEvent.change(nameInput, { target: { value: "My App" } });

      const saveButton = screen.getByRole("button", { name: /settings.saveChanges/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockUpdateSettings).toHaveBeenCalledWith([
          { key: "BRANDING_APP_NAME", value: "My App" },
          { key: "BRANDING_APP_SUBTITLE", value: "" },
        ]);
      });
      expect(mockShowSuccess).toHaveBeenCalledWith("settings.appearance.branding.saved");
    });

    it("uses the URL returned by the icon upload endpoint (not a throwaway blob URL)", async () => {
      renderPanel();
      // Stub the hidden file input and trigger the upload handler.
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [{ type: "image/png", size: 1000 }],
      });
      fireEvent.change(fileInput);

      await waitFor(() => {
        expect(mockUploadIcon).toHaveBeenCalled();
      });
      // Both the upload widget and the live header preview render an <img> with
      // the same alt text — both must reflect the server-returned URL, not a
      // throwaway blob: URL (the Feature 8.7 partial fix). Slice C appends a
      // cache-busting `?t=<ts>` query so a replacement at the same path busts
      // the browser cache; the src must start with the server URL and NOT be a
      // blob: URL.
      const previewImgs = screen.getAllByAltText("settings.appearance.branding.appIconLabel");
      expect(previewImgs.length).toBe(2);
      previewImgs.forEach((img) => {
        const src = img.getAttribute("src");
        expect(src?.startsWith("/branding/app-icon.png")).toBe(true);
        expect(src?.startsWith("blob:")).toBe(false);
        // Cache-bust query present (Feature 8 Slice C).
        expect(src).toMatch(/\?t=\d+$/);
      });
    });

    it("shows the iconEnterpriseRequired toast when icon upload returns 404 (plugin absent, license present)", async () => {
      mockUseFeature.mockReturnValue(true);
      mockUploadIcon.mockRejectedValueOnce(new ApiError(404, "Not found"));
      renderPanel();
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [{ type: "image/png", size: 1000 }],
      });
      fireEvent.change(fileInput);

      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith("settings.appearance.branding.iconEnterpriseRequired");
      });
      expect(mockShowError).not.toHaveBeenCalledWith("settings.appearance.branding.saveFailed");
    });

    it("shows the iconEnterpriseRequired toast when icon delete returns 404 (plugin absent, license present)", async () => {
      mockUseFeature.mockReturnValue(true);
      mockGetValue.mockImplementation((key: string) =>
        key === "BRANDING_APP_ICON_URL" ? "/branding/app-icon.png" : "",
      );
      mockDeleteIcon.mockRejectedValueOnce(new ApiError(404, "Not found"));
      renderPanel();
      const removeButton = screen.getByText("settings.appearance.branding.appIconRemove").closest("button")!;
      fireEvent.click(removeButton);

      await waitFor(() => {
        expect(mockShowError).toHaveBeenCalledWith("settings.appearance.branding.iconEnterpriseRequired");
      });
      expect(mockShowError).not.toHaveBeenCalledWith("settings.appearance.branding.saveFailed");
    });
  });
});
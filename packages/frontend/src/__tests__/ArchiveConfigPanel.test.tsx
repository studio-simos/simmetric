// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ArchiveConfigPanel — auto-index toggle tests.
 *
 * Regression for quick 260725-uu1: the auto-index toggle must use the Switch UI
 * component (role="switch", data-checked:bg-primary) instead of a custom
 * button with hardcoded bg-blue-600/bg-gray-300, so it respects the user's
 * BRANDING_PRIMARY_COLOR (Settings → Aspetto → Colore principale).
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArchiveConfigPanel } from "../components/ArchiveConfigPanel";

const apiPut = jest.fn();

jest.mock("../utils/api", () => ({
  apiPut: (...args: unknown[]) => apiPut(...(args as [string, unknown])),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
}));

jest.mock("../lib/toast", () => ({
  showSuccess: jest.fn(),
  showError: jest.fn(),
}));

jest.mock("../queries/useArchives", () => ({
  useArchive: () => ({ data: { id: "arc1", autoIndex: false } }),
  useArchiveConfig: () => ({
    data: {
      agentPersona: "balanced",
      purpose: "",
      scope: "",
      linkingDensity: { min: 0.005, max: 0.15 },
    },
  }),
  useUpdateArchiveConfig: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useTriggerIndexing: () => ({ mutateAsync: jest.fn() }),
}));

function renderPanel() {
  return render(<ArchiveConfigPanel archiveId="arc1" />);
}

describe("ArchiveConfigPanel auto-index toggle", () => {
  it("renders a Switch (role=switch) for auto-index, not a custom button", () => {
    renderPanel();
    const sw = screen.getByRole("switch");
    expect(sw).toBeInTheDocument();
    // data-state reflects the unchecked initial autoIndex (false)
    expect(sw).toHaveAttribute("data-state", "unchecked");
  });

  it("uses primary color (no hardcoded bg-blue-600/bg-gray-300)", () => {
    renderPanel();
    const sw = screen.getByRole("switch");
    const cls = sw.getAttribute("class") ?? "";
    expect(cls).not.toMatch(/bg-blue-600/);
    expect(cls).not.toMatch(/bg-gray-300/);
    // Switch UI component applies data-checked:bg-primary
    expect(cls).toMatch(/data-checked:bg-primary|peer group\/switch/);
  });

  it("calls apiPut to toggle autoIndex on click", async () => {
    apiPut.mockResolvedValueOnce(undefined);
    renderPanel();
    const sw = screen.getByRole("switch");
    fireEvent.click(sw);
    await waitFor(() => {
      expect(apiPut).toHaveBeenCalledWith("/archives/arc1", { autoIndex: true });
    });
  });
});
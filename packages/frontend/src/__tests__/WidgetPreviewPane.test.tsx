// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * WidgetPreviewPane tests (128-02 T3)
 *
 * Covers: iframe src construction with encodeURIComponent on every param
 * (T-128-04), the 500ms debounced src update (OQ4), the create-mode
 * placeholder (D-05), and the same-origin widgetServiceUrl resolution
 * (151-02, G-151-1a — src is window.location.origin, never SERVER_URL).
 */

// ── Mocks (must be BEFORE any imports) ──────────────────────────

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: jest.fn() },
  }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

// getValue: () => "" forces the same-origin fallback
// (resolveWidgetServiceUrl("", window.location.origin)).
jest.mock("../queries/useSettings", () => ({
  useSettingsHelpers: () => ({ getValue: () => "", isReadOnly: () => false }),
}));

// ── Imports ──────────────────────────────────────────────────────

import "@testing-library/jest-dom";
import { render, screen, cleanup, act } from "@testing-library/react";
import WidgetPreviewPane from "../components/WidgetPreviewPane";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe("WidgetPreviewPane", () => {
  it("builds the iframe src with encoded query overrides (edit mode)", () => {
    render(
      <WidgetPreviewPane
        widgetId="widget-1"
        primaryColor="#4c6ef5"
        position="bottom-right"
        locale="it"
      />
    );
    const iframe = screen.getByTitle("Widget preview");
    expect(iframe).toHaveAttribute(
      "src",
      "http://localhost/widget/widget-1?primaryColor=%234c6ef5&position=bottom-right&locale=it"
    );
  });

  it("updates the src (debounced 500ms) when watched values change", () => {
    jest.useFakeTimers();
    const { rerender } = render(
      <WidgetPreviewPane widgetId="widget-1" primaryColor="#4c6ef5" position="bottom-right" />
    );
    const initialSrc = screen.getByTitle("Widget preview").getAttribute("src");
    rerender(
      <WidgetPreviewPane widgetId="widget-1" primaryColor="#ff0000" position="bottom-right" />
    );
    // Before the debounce elapses the src is unchanged
    expect(screen.getByTitle("Widget preview").getAttribute("src")).toBe(initialSrc);
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.getByTitle("Widget preview").getAttribute("src")).toContain(
      "primaryColor=%23ff0000"
    );
  });

  it("renders the placeholder state (no iframe) when widgetId is null (create mode)", () => {
    render(<WidgetPreviewPane widgetId={null} />);
    expect(screen.getByText("widgets.preview.placeholder")).toBeInTheDocument();
    expect(screen.queryByTitle("Widget preview")).not.toBeInTheDocument();
  });

  it("resolves the widget service URL same-origin when WIDGET_SERVICE_URL is unset", () => {
    render(
      <WidgetPreviewPane widgetId="widget-1" primaryColor="#4c6ef5" position="bottom-right" />
    );
    expect(screen.getByTitle("Widget preview").getAttribute("src")).toContain(
      "http://localhost/widget/widget-1"
    );
  });

  // Quick 260826-hx5 (D-02): ?autoOpenDelay query override.
  it("appends ?autoOpenDelay when the prop is a non-empty numeric string", () => {
    render(
      <WidgetPreviewPane
        widgetId="widget-1"
        primaryColor="#4c6ef5"
        position="bottom-right"
        autoOpenDelay="5"
      />
    );
    expect(screen.getByTitle("Widget preview").getAttribute("src")).toContain(
      "&autoOpenDelay=5"
    );
  });

  it("omits ?autoOpenDelay when the prop is empty/undefined (Pitfall 3)", () => {
    render(
      <WidgetPreviewPane widgetId="widget-1" primaryColor="#4c6ef5" position="bottom-right" />
    );
    expect(screen.getByTitle("Widget preview").getAttribute("src")).not.toContain(
      "autoOpenDelay"
    );
  });
});

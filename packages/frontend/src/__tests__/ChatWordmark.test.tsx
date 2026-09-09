// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * ChatWordmark tests — UI revision R-2.
 *
 * The wordmark must be MONOCHROME (no text-primary classes, no glitch
 * classes) and white-label aware (appName prop wins over i18n app.name).
 */
import "@testing-library/jest-dom";
import { render, screen, cleanup } from "@testing-library/react";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en", t: (key: string, fallback?: string) => fallback ?? key },
  }),
}));

import ChatWordmark from "../components/chat/ChatWordmark";

afterEach(() => {
  cleanup();
});

describe("ChatWordmark", () => {
  it("renders the app name as an h2 heading", () => {
    render(<ChatWordmark appName="Custom Brand" />);
    expect(screen.getByText("Custom Brand").tagName).toBe("H2");
  });

  it("falls back to i18n app.name when appName is not provided", () => {
    render(<ChatWordmark />);
    // t mock returns the key verbatim when no fallback is provided
    expect(screen.getByText("app.name").tagName).toBe("H2");
  });

  it("renders the Monogram S-mark", () => {
    render(<ChatWordmark />);
    const monogram = screen.getByLabelText("Simmetric Chat");
    expect(monogram.tagName).toBe("svg");
  });

  it("renders the subtitle", () => {
    render(<ChatWordmark />);
    expect(
      screen.getByText("Ask anything, or pick a quick start below."),
    ).toBeInTheDocument();
  });

  it("renders the optional status line", () => {
    render(<ChatWordmark statusLine="READY" />);
    expect(screen.getByText("READY")).toBeInTheDocument();
  });

  it("is monochrome: no text-primary, no glitch-text classes anywhere", () => {
    const { container } = render(<ChatWordmark statusLine="READY" />);
    const withPrimary = container.querySelectorAll(
      ".text-primary, .glitch-text",
    );
    expect(withPrimary.length).toBe(0);
  });

  it("uses foreground-based classes for the heading (monochrome contract)", () => {
    render(<ChatWordmark />);
    const heading = screen.getByText("app.name");
    expect(heading.className).toContain("text-foreground/90");
  });

  it("white-label: BRANDING_APP_NAME wins over i18n app.name", () => {
    render(<ChatWordmark appName="Acme Assistant" />);
    expect(screen.getByText("Acme Assistant")).toBeInTheDocument();
    // The i18n fallback is NOT rendered alongside the custom name
    expect(screen.queryByText("app.name")).not.toBeInTheDocument();
  });
});
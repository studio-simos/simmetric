// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import "@testing-library/jest-dom";
import { screen, fireEvent } from "@testing-library/react";
import { ChatEmptyState } from "../ChatEmptyState";
import { renderWithProviders } from "../../../__tests__/test-utils";

jest.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === "string") return opts;
      if (opts && typeof opts === "object" && "defaultValue" in opts) {
        return String(opts.defaultValue).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts[k] ?? ""));
      }
      return key;
    },
  }),
}));

describe("ChatEmptyState", () => {
  it("renders the terminal status-board header and 4 cards", () => {
    renderWithProviders(<ChatEmptyState />);
    expect(screen.getByText("SIMMETRIC CHAT // READY")).toBeInTheDocument();
    expect(screen.getByText("Ask anything, or pick a quick start below.")).toBeInTheDocument();
    expect(screen.getByText("Ask about your documents")).toBeInTheDocument();
    expect(screen.getByText("Search knowledge base")).toBeInTheDocument();
    expect(screen.getByText("Available skills")).toBeInTheDocument();
    expect(screen.getByText("Token usage today")).toBeInTheDocument();
  });

  it("shows '—' for document count when not provided", () => {
    renderWithProviders(<ChatEmptyState />);
    expect(screen.getByText("— indexed")).toBeInTheDocument();
  });

  it("shows the document count when provided", () => {
    renderWithProviders(<ChatEmptyState documentCount={5} />);
    expect(screen.getByText("5 indexed")).toBeInTheDocument();
  });

  it("fires onQuickAction with a context-aware prompt for the documents card", () => {
    const onQuickAction = jest.fn();
    renderWithProviders(<ChatEmptyState onQuickAction={onQuickAction} />);
    fireEvent.click(screen.getByText("Ask about your documents"));
    expect(onQuickAction).toHaveBeenCalledWith("Summarize the key points of my indexed documents");
  });

  it("fires onQuickAction for the knowledge-base card", () => {
    const onQuickAction = jest.fn();
    renderWithProviders(<ChatEmptyState onQuickAction={onQuickAction} />);
    fireEvent.click(screen.getByText("Search knowledge base"));
    expect(onQuickAction).toHaveBeenCalledWith("Search the knowledge base for: ");
  });

  it("renders the footer model badge (defaults to 'Select model')", () => {
    renderWithProviders(<ChatEmptyState />);
    expect(screen.getByText("Select model")).toBeInTheDocument();
  });

  it("renders the AIR-GAPPED badge only when airGapped is true", () => {
    const { rerender } = renderWithProviders(<ChatEmptyState />);
    expect(screen.queryByText("AIR-GAPPED")).not.toBeInTheDocument();
    rerender(<ChatEmptyState airGapped />);
    expect(screen.getByText("AIR-GAPPED")).toBeInTheDocument();
  });
});
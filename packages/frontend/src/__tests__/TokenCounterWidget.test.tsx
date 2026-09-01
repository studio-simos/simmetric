// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TokenCounterWidget component tests — Feature 3.6 (compact top-bar readout).
 *
 * Reuses the Feature 2 `useSessionTokens` aggregation. Verifies the muted
 * (no-data) state, the formatted IN/OUT readout, the responsive class
 * (`hidden lg:flex` — the widget is desktop-only), the aria-label, and the
 * title tooltip text.
 */
const mockUseSessionTokens = jest.fn();

jest.mock("../queries/useChatTokens", () => ({
  useSessionTokens: (...args: unknown[]) => mockUseSessionTokens(...args),
}));

import { render, screen } from "@testing-library/react";
import TokenCounterWidget from "../components/TokenCounterWidget";

describe("TokenCounterWidget", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the IN/OUT labels and aria-label even with no data", () => {
    mockUseSessionTokens.mockReturnValue({ data: undefined, isLoading: false });

    render(<TokenCounterWidget workspaceId="ws-1" />);

    // Always-present structural labels
    expect(screen.getByText("IN")).toBeInTheDocument();
    expect(screen.getByText("OUT")).toBeInTheDocument();
    expect(screen.getByLabelText("Session token usage")).toBeInTheDocument();
  });

  it("shows muted em-dashes when there is no usage (muted state)", () => {
    mockUseSessionTokens.mockReturnValue({
      data: { totalInput: 0, totalOutput: 0, total: 0 },
      isLoading: false,
    });

    const { container } = render(<TokenCounterWidget workspaceId="ws-1" />);
    // The two value slots render the em-dash placeholder when hasData=false.
    const dashes = container.querySelectorAll(".tabular-nums");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText("Session token usage").textContent).toContain("—");
    // The muted class (opacity-40) is applied when there is no data.
    expect(screen.getByLabelText("Session token usage").className).toContain("opacity-40");
    expect(screen.getByLabelText("Session token usage").title).toBe("No token usage yet");
  });

  it("renders formatted token totals and a descriptive title when data exists", () => {
    mockUseSessionTokens.mockReturnValue({
      data: { totalInput: 1500, totalOutput: 2500, total: 4000 },
      isLoading: false,
    });

    render(<TokenCounterWidget workspaceId="ws-1" />);

    expect(screen.getByText("1.5k")).toBeInTheDocument();
    expect(screen.getByText("2.5k")).toBeInTheDocument();
    const widget = screen.getByLabelText("Session token usage");
    expect(widget.className).not.toContain("opacity-40");
    // The title uses toLocaleString(), whose thousands-grouping depends on the
    // ICU data of the runtime: a dev jsdom with minimal ICU returns the bare
    // number ("1500"), while the CI runner (Node 24 full-ICU) groups ("1,500").
    // Assert the structure with an OPTIONAL thousands separator so the test is
    // stable across both environments without weakening what it verifies.
    expect(widget.title).toMatch(/^Today — in: 1,?500 {2}out: 2,?500$/);
  });

  it("is muted while loading (opacity-40) even with a workspace", () => {
    mockUseSessionTokens.mockReturnValue({ data: undefined, isLoading: true });

    render(<TokenCounterWidget workspaceId="ws-1" />);
    expect(screen.getByLabelText("Session token usage").className).toContain("opacity-40");
  });

  it("applies the responsive `hidden min-[375px]:flex` class (shows at ≥375px)", () => {
    // Commit 30c5572fb moved the breakpoint from lg:flex (desktop-only) to
    // min-[375px]:flex so the IN/OUT readout is visible on phones too.
    mockUseSessionTokens.mockReturnValue({ data: undefined, isLoading: false });

    render(<TokenCounterWidget workspaceId="ws-1" />);
    const widget = screen.getByLabelText("Session token usage");
    expect(widget.className).toContain("hidden");
    expect(widget.className).toContain("min-[375px]:flex");
  });

  it("merges a custom className", () => {
    mockUseSessionTokens.mockReturnValue({ data: undefined, isLoading: false });

    render(<TokenCounterWidget workspaceId="ws-1" className="ml-2" />);
    expect(screen.getByLabelText("Session token usage").className).toContain("ml-2");
  });
});
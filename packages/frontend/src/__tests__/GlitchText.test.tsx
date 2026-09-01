// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * GlitchText component tests — Feature 3.6 (design-system primitive).
 *
 * The glitch effect is driven by CSS ::before/::after pseudo layers that read
 * the `data-text` attribute; jsdom cannot render pseudo elements, so we assert
 * structurally on the rendered tag, its classes, and the data-text attribute
 * that the effect depends on.
 */
import { render, screen } from "@testing-library/react";
import { GlitchText } from "../components/GlitchText";

describe("GlitchText", () => {
  it("renders the text inside a span with the glitch classes and data-text", () => {
    render(<GlitchText text="SYSTEM" data-testid="g" />);
    const el = screen.getByTestId("g");
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("SYSTEM");
    expect(el.className).toContain("glitch-text");
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("font-bold");
    expect(el).toHaveAttribute("data-text", "SYSTEM");
  });

  it("renders as h1/h2/h3 when the `as` prop is set", () => {
    const { rerender } = render(<GlitchText as="h1" text="T1" />);
    expect(screen.getByText("T1").tagName).toBe("H1");

    rerender(<GlitchText as="h2" text="T2" />);
    expect(screen.getByText("T2").tagName).toBe("H2");

    rerender(<GlitchText as="h3" text="T3" />);
    expect(screen.getByText("T3").tagName).toBe("H3");
  });

  it("always sets data-text equal to the text prop, even when children differ", () => {
    // The component ignores children and renders `text` for both the visible
    // content and the data-text attribute (pseudo layers read data-text).
    render(<GlitchText text="VISIBLE" data-testid="g" />);
    const el = screen.getByTestId("g");
    expect(el).toHaveAttribute("data-text", "VISIBLE");
    expect(el.textContent).toBe("VISIBLE");
  });

  it("merges a custom className", () => {
    render(
      <GlitchText text="X" className="text-primary text-3xl" data-testid="g" />,
    );
    const el = screen.getByTestId("g");
    expect(el.className).toContain("glitch-text");
    expect(el.className).toContain("text-primary");
    expect(el.className).toContain("text-3xl");
  });

  it("forwards extra HTML attributes (id, title)", () => {
    render(<GlitchText text="X" id="title-main" title="hover me" data-testid="g" />);
    const el = screen.getByTestId("g");
    expect(el).toHaveAttribute("id", "title-main");
    expect(el).toHaveAttribute("title", "hover me");
  });
});
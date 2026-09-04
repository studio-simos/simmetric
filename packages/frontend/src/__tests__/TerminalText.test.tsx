// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * TerminalText component tests — Feature 6.3 (CVA primitive).
 */
import { render, screen } from "@testing-library/react";
import { TerminalText, terminalTextVariants } from "../components/TerminalText";

describe("TerminalText", () => {
  it("renders a span with font-mono class by default", () => {
    render(<TerminalText data-testid="t">ls -la</TerminalText>);
    const el = screen.getByTestId("t");
    expect(el.tagName).toBe("SPAN");
    expect(el.className).toContain("font-mono");
  });

  it("applies the muted tone by default", () => {
    render(<TerminalText data-testid="t">x</TerminalText>);
    expect(screen.getByTestId("t").className).toContain("text-muted-foreground");
  });

  it("applies the accent tone class", () => {
    render(<TerminalText tone="accent" data-testid="t">x</TerminalText>);
    expect(screen.getByTestId("t").className).toContain(
      "text-[var(--color-hacker-neon-green)]",
    );
  });

  it("prefixes the block cursor ▌ when prompt is true", () => {
    render(<TerminalText prompt data-testid="t">ready</TerminalText>);
    expect(screen.getByTestId("t").textContent).toContain("▌");
    expect(screen.getByTestId("t").textContent).toContain("ready");
  });

  it("does not prefix the cursor when prompt is false", () => {
    render(<TerminalText data-testid="t">ready</TerminalText>);
    expect(screen.getByTestId("t").textContent).not.toContain("▌");
  });

  it("renders as <p> when as='p'", () => {
    render(<TerminalText as="p" data-testid="t">x</TerminalText>);
    expect(screen.getByTestId("t").tagName).toBe("P");
  });

  it("renders as <div> when as='div'", () => {
    render(<TerminalText as="div" data-testid="t">x</TerminalText>);
    expect(screen.getByTestId("t").tagName).toBe("DIV");
  });

  it("merges a custom className", () => {
    render(<TerminalText className="text-xs" data-testid="t">x</TerminalText>);
    const el = screen.getByTestId("t");
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("text-xs");
  });

  it("forwards arbitrary props (id, title)", () => {
    render(<TerminalText id="tt" title="hint" data-testid="t">x</TerminalText>);
    const el = screen.getByTestId("t");
    expect(el).toHaveAttribute("id", "tt");
    expect(el).toHaveAttribute("title", "hint");
  });

  it("exports terminalTextVariants", () => {
    expect(typeof terminalTextVariants).toBe("function");
  });
});
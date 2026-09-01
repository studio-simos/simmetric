// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * KbdHint component tests — Feature 6.3 (CVA primitive).
 */
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { KbdHint } from "../components/KbdHint";

describe("KbdHint", () => {
  it("renders a <p> with the base kbd-hint classes", () => {
    render(<KbdHint data-testid="k">hint</KbdHint>);
    const el = screen.getByTestId("k");
    expect(el.tagName).toBe("P");
    expect(el.className).toContain("chat-kbd-hint");
    expect(el.className).toContain("mt-1.5");
    expect(el.className).toContain("text-[11px]");
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("text-muted-foreground");
    expect(el.className).toContain("transition-opacity");
    expect(el.className).toContain("duration-300");
  });

  it("is opacity-100 when visible=true (default)", () => {
    render(<KbdHint data-testid="k">x</KbdHint>);
    expect(screen.getByTestId("k").className).toContain("opacity-100");
  });

  it("is opacity-0 when visible=false", () => {
    render(<KbdHint visible={false} data-testid="k">x</KbdHint>);
    expect(screen.getByTestId("k").className).toContain("opacity-0");
  });

  it("is aria-hidden by default", () => {
    render(<KbdHint data-testid="k">x</KbdHint>);
    expect(screen.getByTestId("k")).toHaveAttribute("aria-hidden", "true");
  });

  it("renders children", () => {
    render(<KbdHint>⏎ Send</KbdHint>);
    expect(screen.getByText("⏎ Send")).toBeInTheDocument();
  });

  it("merges a custom className", () => {
    render(<KbdHint className="ml-2" data-testid="k">x</KbdHint>);
    const el = screen.getByTestId("k");
    expect(el.className).toContain("chat-kbd-hint");
    expect(el.className).toContain("ml-2");
  });

  it("forwards the ref to the underlying <p>", () => {
    const ref = createRef<HTMLParagraphElement>();
    render(<KbdHint ref={ref}>x</KbdHint>);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("P");
  });
});
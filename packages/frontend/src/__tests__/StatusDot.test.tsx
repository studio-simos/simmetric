// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * StatusDot component tests — Feature 6.3 (CVA primitive).
 * Structural assertions: variant class composition, size class, data-status,
 * ref forwarding, aria-hidden default, className merge.
 */
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { StatusDot, statusDotVariants } from "../components/StatusDot";

describe("StatusDot", () => {
  it("renders a span with rounded-full base class and data-status", () => {
    render(<StatusDot status="connected" data-testid="d" />);
    const el = screen.getByTestId("d");
    expect(el.tagName).toBe("SPAN");
    expect(el.className).toContain("rounded-full");
    expect(el).toHaveAttribute("data-status", "connected");
  });

  it("applies the connected bg class", () => {
    render(<StatusDot status="connected" data-testid="d" />);
    expect(screen.getByTestId("d").className).toContain(
      "bg-[var(--color-hacker-neon-green)]",
    );
  });

  it("applies the error bg class", () => {
    render(<StatusDot status="error" data-testid="d" />);
    expect(screen.getByTestId("d").className).toContain("bg-destructive");
  });

  it("applies the pending bg class", () => {
    render(<StatusDot status="pending" data-testid="d" />);
    expect(screen.getByTestId("d").className).toContain(
      "bg-[var(--color-hacker-neon-amber)]",
    );
  });

  it("applies size sm / md classes", () => {
    const { rerender } = render(<StatusDot size="sm" data-testid="d" />);
    expect(screen.getByTestId("d").className).toContain("size-1.5");
    rerender(<StatusDot size="md" data-testid="d" />);
    expect(screen.getByTestId("d").className).toContain("size-2.5");
  });

  it("defaults to disconnected when no status provided", () => {
    render(<StatusDot data-testid="d" />);
    const el = screen.getByTestId("d");
    expect(el.className).toContain("bg-muted-foreground");
    expect(el).toHaveAttribute("data-status", "disconnected");
  });

  it("is aria-hidden by default", () => {
    render(<StatusDot data-testid="d" />);
    expect(screen.getByTestId("d")).toHaveAttribute("aria-hidden", "true");
  });

  it("forwards the ref to the underlying span", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<StatusDot ref={ref} />);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("SPAN");
  });

  it("merges a custom className", () => {
    render(<StatusDot className="ml-1" data-testid="d" />);
    const el = screen.getByTestId("d");
    expect(el.className).toContain("ml-1");
    expect(el.className).toContain("rounded-full");
  });

  it("exports statusDotVariants", () => {
    expect(typeof statusDotVariants).toBe("function");
  });
});
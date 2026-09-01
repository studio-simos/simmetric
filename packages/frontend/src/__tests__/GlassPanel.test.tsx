// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * GlassPanel component tests — Feature 3.6 (design-system primitive).
 *
 * Structural assertions: the component is a thin forwardRef wrapper that
 * applies the `glass-panel` class and forwards everything else, so we verify
 * class composition, ref/prop forwarding, and children rendering.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { GlassPanel } from "../components/GlassPanel";

describe("GlassPanel", () => {
  it("renders a div with the glass-panel base class", () => {
    render(<GlassPanel data-testid="gp">content</GlassPanel>);
    const el = screen.getByTestId("gp");
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("glass-panel");
  });

  it("renders its children", () => {
    render(
      <GlassPanel>
        <span>inner</span>
      </GlassPanel>,
    );
    expect(screen.getByText("inner")).toBeInTheDocument();
  });

  it("forwards the ref to the underlying div", () => {
    const ref = createRef<HTMLDivElement>();
    render(<GlassPanel ref={ref}>x</GlassPanel>);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("DIV");
  });

  it("merges a custom className (append, does not drop glass-panel)", () => {
    render(
      <GlassPanel className="w-72 border-l" data-testid="gp">
        x
      </GlassPanel>,
    );
    const el = screen.getByTestId("gp");
    expect(el.className).toContain("glass-panel");
    expect(el.className).toContain("w-72");
    expect(el.className).toContain("border-l");
  });

  it("forwards arbitrary div props (onClick, id, title)", () => {
    const onClick = jest.fn();
    render(
      <GlassPanel id="panel-1" title="hint" onClick={onClick} data-testid="gp">
        x
      </GlassPanel>,
    );
    const el = screen.getByTestId("gp");
    expect(el).toHaveAttribute("id", "panel-1");
    expect(el).toHaveAttribute("title", "hint");
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
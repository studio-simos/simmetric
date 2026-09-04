// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * NeonButton component tests — Feature 3.6 (design-system primitive).
 *
 * Structural assertions only: the component is a styled forwardRef button, so
 * we verify class composition (glow), inline style per color/variant, prop
 * forwarding, and ref forwarding. No snapshot — consistent with the repo's
 * existing interaction/structural test style.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { NeonButton } from "../components/NeonButton";

describe("NeonButton", () => {
  it("renders a button with type=button by default", () => {
    render(<NeonButton>Save</NeonButton>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("type", "button");
  });

  it("applies the neon-glow-green class and solid fill for the default (green) color", () => {
    render(<NeonButton>Go</NeonButton>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn.className).toContain("neon-glow-green");
    expect(btn.style.backgroundColor).toBe("rgb(0, 255, 156)"); // #00ff9c
    expect(btn.style.color).toBe("rgb(10, 14, 20)"); // #0a0e14
    expect(btn.style.border).toContain("rgb(0, 255, 156)");
  });

  it("applies neon-glow-cyan for the cyan color", () => {
    render(<NeonButton color="cyan">C</NeonButton>);
    const btn = screen.getByRole("button", { name: "C" });
    expect(btn.className).toContain("neon-glow-cyan");
    expect(btn.style.backgroundColor).toBe("rgb(0, 212, 255)"); // #00d4ff
  });

  it("omits the glow class for colors without a dedicated glow (magenta, amber)", () => {
    const { rerender } = render(<NeonButton color="magenta">M</NeonButton>);
    let btn = screen.getByRole("button", { name: "M" });
    expect(btn.className).not.toContain("neon-glow-green");
    expect(btn.className).not.toContain("neon-glow-cyan");
    expect(btn.style.backgroundColor).toBe("rgb(255, 0, 170)"); // #ff00aa

    rerender(<NeonButton color="amber">A</NeonButton>);
    btn = screen.getByRole("button", { name: "A" });
    expect(btn.style.backgroundColor).toBe("rgb(255, 170, 0)"); // #ffaa00
  });

  it("renders outline-only (ghost) variant with transparent background and neon text", () => {
    render(
      <NeonButton color="cyan" variant="ghost">
        Ghost
      </NeonButton>,
    );
    const btn = screen.getByRole("button", { name: "Ghost" });
    expect(btn.style.backgroundColor).toBe("transparent");
    expect(btn.style.color).toBe("rgb(0, 212, 255)"); // hex text
    expect(btn.style.border).toContain("rgb(0, 212, 255)");
    expect(btn.className).toContain("hover:bg-[rgba(255,255,255,0.05)]");
  });

  it("forwards the ref to the underlying button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<NeonButton ref={ref}>Ref</NeonButton>);
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("BUTTON");
  });

  it("forwards arbitrary button props (aria-label, onClick) and the disabled flag", () => {
    const onClick = jest.fn();
    const { rerender } = render(
      <NeonButton onClick={onClick} disabled aria-label="Confirm">
        Ok
      </NeonButton>,
    );
    const btn = screen.getByLabelText("Confirm");
    expect(btn).toBeDisabled();
    // A disabled button does not dispatch its click handler (browser default).
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();

    // Re-enable and click → handler fires once.
    rerender(
      <NeonButton onClick={onClick} aria-label="Confirm">
        Ok
      </NeonButton>,
    );
    fireEvent.click(screen.getByLabelText("Confirm"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("merges a custom className and lets style overrides win", () => {
    render(
      <NeonButton className="custom-cls" style={{ borderRadius: "8px" }}>
        X
      </NeonButton>,
    );
    const btn = screen.getByRole("button", { name: "X" });
    expect(btn.className).toContain("custom-cls");
    expect(btn.style.borderRadius).toBe("8px");
  });
});
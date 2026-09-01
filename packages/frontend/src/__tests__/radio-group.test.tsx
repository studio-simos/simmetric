// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * Tests for the shadcn radio-group primitive (Phase 71-04 Task 2).
 *
 * Structural assertions: the primitive is a thin forwardRef wrapper over
 * `@radix-ui/react-radio-group` (the SPECIFIC package — NOT the `radix-ui`
 * umbrella, per memory radix-umbrella-slot-root-pattern). We verify named
 * exports, ARIA roles delegated by Radix, shadcn styling classes, and the
 * import source (static file check + typecheck).
 */
import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";

import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";

describe("radio-group primitive (shadcn)", () => {
  it("exports RadioGroup + RadioGroupItem as named exports", () => {
    // React 19 forwardRef objects are callable functions with a displayName.
    expect(typeof RadioGroup).toBe("function");
    expect(typeof RadioGroupItem).toBe("function");
    expect(RadioGroup.displayName).toBe("RadioGroup");
    expect(RadioGroupItem.displayName).toBe("RadioGroupItem");
  });

  it("RadioGroup renders a div with role=radiogroup (Radix ARIA)", () => {
    render(
      <RadioGroup defaultValue="a" loop={false}>
        <RadioGroupItem value="a" id="rg-a" />
      </RadioGroup>
    );
    const group = screen.getByRole("radiogroup");
    expect(group.tagName).toBe("DIV");
  });

  it("RadioGroupItem renders a button with role=radio (Radix ARIA)", () => {
    render(
      <RadioGroup defaultValue="a" loop={false}>
        <RadioGroupItem value="a" id="rg-a" />
      </RadioGroup>
    );
    const radio = screen.getByRole("radio", { checked: true });
    expect(radio.tagName).toBe("BUTTON");
    expect(radio).toHaveAttribute("value", "a");
  });

  it("imports from @radix-ui/react-radio-group (specific package, NOT umbrella)", () => {
    const src = readFileSync(
      resolve(__dirname, "../components/ui/radio-group.tsx"),
      "utf8"
    );
    expect(src).toMatch(/from ["']@radix-ui\/react-radio-group["']/);
    expect(src).not.toMatch(/from ["']radix-ui["']/);
  });

  it("applies shadcn styling classes (grid gap-2 root + rounded-full border item)", () => {
    render(
      <RadioGroup defaultValue="a" loop={false}>
        <RadioGroupItem value="a" id="rg-a" />
      </RadioGroup>
    );
    const group = screen.getByRole("radiogroup");
    expect(group.className).toContain("grid");
    expect(group.className).toContain("gap-2");

    const radio = screen.getByRole("radio", { checked: true });
    expect(radio.className).toContain("aspect-square");
    expect(radio.className).toContain("h-4");
    expect(radio.className).toContain("w-4");
    expect(radio.className).toContain("rounded-full");
    expect(radio.className).toContain("border");
  });
});
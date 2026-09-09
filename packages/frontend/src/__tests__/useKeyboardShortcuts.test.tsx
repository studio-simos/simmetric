// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

/**
 * useKeyboardShortcuts tests — UI revision R-4 nav overlay shortcut.
 *
 * Cmd/Ctrl+/ toggles the nav overlay; Cmd+K palette and Cmd+Shift+M
 * comparison are unchanged (regression guards).
 */
import "@testing-library/jest-dom";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

function fireKey(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) {
  const event = new KeyboardEvent("keydown", {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

describe("useKeyboardShortcuts", () => {
  const setup = () => {
    const onOpenPalette = jest.fn();
    const onOpenComparison = jest.fn();
    const onOpenNavOverlay = jest.fn();
    renderHook(() =>
      useKeyboardShortcuts({ onOpenPalette, onOpenComparison, onOpenNavOverlay }),
    );
    return { onOpenPalette, onOpenComparison, onOpenNavOverlay };
  };

  it("Cmd+/ toggles the nav overlay and prevents default", () => {
    const { onOpenNavOverlay } = setup();
    const e = fireKey({ key: "/", metaKey: true });
    expect(onOpenNavOverlay).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("Ctrl+/ toggles the nav overlay", () => {
    const { onOpenNavOverlay } = setup();
    fireKey({ key: "/", ctrlKey: true });
    expect(onOpenNavOverlay).toHaveBeenCalledTimes(1);
  });

  it("does nothing for / without modifier", () => {
    const { onOpenNavOverlay } = setup();
    fireKey({ key: "/" });
    expect(onOpenNavOverlay).not.toHaveBeenCalled();
  });

  it("keeps Cmd+K palette behavior (regression)", () => {
    const { onOpenPalette } = setup();
    fireKey({ key: "k", metaKey: true });
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it("keeps Cmd+Shift+M comparison behavior (regression)", () => {
    const { onOpenComparison } = setup();
    fireKey({ key: "m", metaKey: true, shiftKey: true });
    expect(onOpenComparison).toHaveBeenCalledTimes(1);
  });
});
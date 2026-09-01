// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import { renderHook, act } from "@testing-library/react";
import React from "react";
import { ThemeProvider, useTheme, type Theme } from "../contexts/ThemeContext";

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark", "theme-hacker");
});

describe("themeStore", () => {
  it("should persist theme selection to localStorage", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setTheme("dark");
    });
    expect(localStorage.getItem("theme")).toBe("dark");
  });

  it("should default to system theme on first load", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.theme).toBe("system");
  });

  it("should switch between light, dark, and system modes", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => {
      result.current.setTheme("dark" as Theme);
    });
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
    act(() => {
      result.current.setTheme("light" as Theme);
    });
    expect(result.current.theme).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
    act(() => {
      result.current.setTheme("system" as Theme);
    });
    expect(result.current.theme).toBe("system");
  });
});
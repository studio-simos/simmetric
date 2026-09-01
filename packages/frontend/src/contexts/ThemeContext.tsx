// Simmetric Chat — Copyright (C) 2026 Simmetric Chat
// SPDX-License-Identifier: AGPL-3.0-or-later
// This file is part of the Simmetric Chat community build.
// See LICENSE and NOTICE at the repository root for full terms.

import React, { createContext, useContext, useState, useEffect } from "react";

export type Theme = "light" | "dark" | "hacker" | "system";
export type ResolvedTheme = "light" | "dark" | "hacker";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const VALID_THEMES: Theme[] = ["light", "dark", "hacker", "system"];

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") return getSystemTheme();
  if (theme === "hacker") return "hacker";
  return theme; // light | dark
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  html.classList.toggle("dark", resolved === "dark" || resolved === "hacker");
  html.classList.toggle("theme-hacker", resolved === "hacker");
}

// Synchronous FOUC-safe initialization at module level
const rawSaved = typeof localStorage !== "undefined" ? localStorage.getItem("theme") : null;
const initialTheme: Theme =
  rawSaved && VALID_THEMES.includes(rawSaved as Theme) ? (rawSaved as Theme) : "system";
const initialResolved = resolveTheme(initialTheme);
applyTheme(initialResolved);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(initialResolved);

  const setTheme = (next: Theme) => {
    const resolved = resolveTheme(next);
    applyTheme(resolved);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("theme", next);
    }
    setThemeState(next);
    setResolvedTheme(resolved);
  };

  useEffect(() => {
    const listener = (e: MediaQueryListEvent) => {
      if (theme === "system") {
        const resolved = e.matches ? "dark" : "light";
        applyTheme(resolved);
        setResolvedTheme(resolved);
      }
    };
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}